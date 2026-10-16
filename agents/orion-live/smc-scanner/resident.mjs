import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { SMC_S1_ENTRY_REVISION, smcS1Candidate } from '../../../lib/smc-s1-entry.mjs';
import {packSmcSnapshot} from '../../../lib/smc-snapshot-wire.mjs';
import {build4hFvgEvidence} from '../../../lib/smc-target-path.mjs';
import {applyCandidateTargetPath} from '../../../lib/smc-target-path-candidate.mjs';
import {derive15mFvgEntryProposals} from '../../../lib/smc-fvg-entry.mjs';
import { closedKlinesAtRequest } from '../../../lib/smc-market-evidence.mjs';
import { updateIntersectionClock } from '../../../lib/smc-intersection-clock.mjs';
import { dualFrameCandidate } from '../../../lib/smc-dual-frame-entry.mjs';
import { observeIntersectionSafely } from '../../../lib/smc-intersection-observation.mjs';
import { stopSafetyContext, evaluateStopSafety } from '../../../lib/smc-stop-safety.mjs';
import fs from 'node:fs/promises';
import { scanSmcSymbol, SMC_SCAN_POLICY as policy } from '../../../lib/smc-scanner.mjs';
import { sanitizeSmcScan } from '../../../lib/smc-scan-snapshot.mjs';
import { updateRecentInvalidations } from '../../../lib/smc-recent-invalidations.mjs';
import { openProductionReadAdmission } from '../s2-execution/host-admission.mjs';
import { admittedReadJson } from '../s2-execution/admitted-http.mjs';
import { SMC_CONTEXT_POLICY, scanContextFrame, assembleStructureContext } from '../../../lib/smc-structure-context.mjs';
import { emptyLifecycleState, validateLifecycleState, reconcilePlanLifecycle, lifecycleSourceIsActive, candidateLifecyclePlan } from '../../../lib/smc-plan-lifecycle.mjs';
import { deriveStructurePlans } from '../../../lib/smc-structure-plan.mjs';

const root = '/var/lib/aegis/smc-scanner', controlPath = '/etc/aegis/smc-scanner-control/authorization.json';
const origin = 'https://your-cockpit.example.invalid';
async function authorized() {
  const c = JSON.parse(await fs.readFile(controlPath, 'utf8'));
  if (c.enabled !== true || c.orderAuthority !== false || c.revision !== policy.revision || JSON.stringify(c.universe) !== JSON.stringify(policy.universe)) throw new Error('SMC_SCAN_NOT_AUTHORIZED');
}
await authorized();
// Reuse the existing paused scanner's exclusive, durable read-admission slot.
// This prevents the legacy scanner and SMC from owning that slot concurrently.
const admission = await openProductionReadAdmission('CANDIDATE_SCANNER');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; admission.stop(); });
const paths = new Set(['/fapi/v1/time', '/fapi/v1/exchangeInfo', '/fapi/v1/klines', '/fapi/v1/ticker/bookTicker']);
async function get(path, query = {}) {
  await authorized();
  if (!paths.has(path)) throw new Error('SMC_READ_PATH_DENIED');
  const url = new URL(path, 'https://demo-fapi.binance.com');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const response = await admittedReadJson(url, { method: 'GET' }, { admission, timeoutMs: 10000 });
  if (!response.ok) throw new Error(`PUBLIC_HTTP_${response.status}`);
  return response.payload;
}
const atomic = async (name, value) => { await fs.writeFile(`${root}/${name}.tmp`, JSON.stringify(value), { mode: 0o600 }); await fs.rename(`${root}/${name}.tmp`, `${root}/${name}`); };
async function readPreviousSnapshot() {
  try { return JSON.parse(await fs.readFile(`${root}/latest.json`, 'utf8')); } catch { return null; }
}
const cache = new Map(); let rules = null, rulesAt = 0;
async function bars(symbol, interval, now) {
  const width = SMC_CONTEXT_POLICY.frames[interval].widthMs, boundary = Math.floor(now / width), key = `${symbol}:${interval}`;
  if (cache.get(key)?.boundary === boundary) return cache.get(key).rows;
  const limit = SMC_CONTEXT_POLICY.frames[interval].historyBars;
  const rows = closedKlinesAtRequest(await get('/fapi/v1/klines', { symbol, interval, limit }), now, width);
  cache.set(key, { boundary, rows }); return rows;
}
async function publish(snapshot) {
  const bad=[];const walk=(v,p)=>{if(typeof v==='number'&&!Number.isFinite(v))bad.push({path:p,value:String(v)});else if(v&&typeof v==='object')for(const [k,x]of Object.entries(v))walk(x,p+'.'+k);};walk(snapshot,'snapshot');if(bad.length)await atomic('wire-diagnostic.json',{sourceAsOf:snapshot.sourceAsOf,bad});
  const bypass = process.env.S2_MONITOR_BYPASS_TOKEN ?? process.env.S1_MONITOR_BYPASS_TOKEN;
  if (!process.env.S2_MONITOR_INGEST_TOKEN || !bypass) throw new Error('PUBLISH_CONFIG_MISSING');
  const response = await fetch(`${origin}/api/smc-opportunities`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.S2_MONITOR_INGEST_TOKEN}`, 'oai-sites-authorization': `Bearer ${bypass}` }, body: JSON.stringify(packSmcSnapshot(snapshot)) });
  if (!response.ok) throw new Error(`PUBLISH_HTTP_${response.status}`);
  const receipt = await response.json(); if (!['SYNCED', 'OLDER_SNAPSHOT_IGNORED'].includes(receipt.status)) throw new Error('PUBLISH_RECEIPT_INVALID');
  await atomic('publish.json', { ...receipt, at: new Date().toISOString() });
}
async function readOwnerSelections() {
  const checkedAt = Date.now();
  try {
    const bypass = process.env.S2_MONITOR_BYPASS_TOKEN ?? process.env.S1_MONITOR_BYPASS_TOKEN;
    if (!process.env.S2_MONITOR_INGEST_TOKEN || !bypass) throw new Error('OWNER_SELECTION_CONFIG_MISSING');
    const response = await fetch(`${origin}/api/smc-manual-candidates?service=1`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${process.env.S2_MONITOR_INGEST_TOKEN}`, 'oai-sites-authorization': `Bearer ${bypass}` } });
    if (!response.ok) throw new Error(`OWNER_SELECTION_HTTP_${response.status}`);
    const body = await response.json();
    if (body?.status !== 'OK' || !Array.isArray(body.candidates)) throw new Error('OWNER_SELECTION_PAYLOAD_INVALID');
    const candidates = body.candidates.map(row => ({ symbol: row.symbol, direction: row.direction,
      selectedAt: Number(row.createdAt), autoTradingEnabled: row.autoTradingEnabled === true }));
    if (candidates.length > policy.universe.length * 2 || candidates.some(row => !policy.universe.includes(row.symbol)
      || !['LONG', 'SHORT'].includes(row.direction) || !Number.isFinite(row.selectedAt)
      || typeof row.autoTradingEnabled !== 'boolean' || row.selectedAt > checkedAt + 5000)) {
      throw new Error('OWNER_SELECTION_SCOPE_INVALID');
    }
    return { candidates, feed: { status: 'READY', checkedAt, count: candidates.length } };
  } catch (error) {
    return { candidates: [], feed: { status: 'UNAVAILABLE', checkedAt, count: 0,
      reason: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'OWNER_SELECTION_READ_FAILED' } };
  }
}
let previousSnapshot = await readPreviousSnapshot();
let lifecycleState;
try { lifecycleState = validateLifecycleState(JSON.parse(await fs.readFile(`${root}/plan-lifecycle.json`, 'utf8'))); }
catch (error) { if (error.code !== 'ENOENT') throw error; lifecycleState = emptyLifecycleState(); }
try {
  while (!stopping) {
    const started = Date.now(), results = [], errors = [];
    const ownerSelections = await readOwnerSelections();
    try {
      await authorized();
      const clock = await get('/fapi/v1/time');
      if (!Number.isSafeInteger(clock.serverTime) || Math.abs(clock.serverTime - Date.now()) > 5000) throw new Error('CLOCK_SKEW');
      if (!rules || Date.now() - rulesAt > 300000) { rules = await get('/fapi/v1/exchangeInfo'); rulesAt = Date.now(); }
      for (const symbol of policy.universe) {
        if (stopping) break;
        if (Date.now() - started > 120000) { errors.push({ symbol: 'GLOBAL', reason: 'SCAN_DEADLINE' }); break; }
        try {
          const now = Date.now(), rule = rules.symbols?.find(r => r.symbol === symbol && r.status === 'TRADING' && r.contractType === 'PERPETUAL' && r.quoteAsset === 'USDT');
          if (!rule) throw new Error('SYMBOL_NOT_TRADING');
          const h = await bars(symbol, '4h', now), m = await bars(symbol, '15m', now);
          // Freeze legacy candidate geometry/target inputs; the extra 4H history
          // extends descriptive context, never an expired candidate's lifespan.
          const input = { symbol, bars4h: h.slice(-policy.historyBars4h), bars15m: m, quote: null, tickSize: rule.filters.find(f => f.filterType === 'PRICE_FILTER')?.tickSize, now: Date.now(),
            ownerSelections: ownerSelections.candidates.filter(row => row.symbol === symbol) };
          const result = {symbol,candidates:[],rejected:{}};
          results.push(result);
          let checkpoints = {};
          try { checkpoints = JSON.parse(await fs.readFile(`${root}/${symbol}-context-v2-checkpoint.json`, 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') checkpoints = { invalid: true }; }
          const frames = {}, contextEvidence = {}, next = { ...checkpoints };
          for (const timeframe of ['4h','15m']) {
            try {
              if (checkpoints.invalid) throw new Error('CONTEXT_CHECKPOINT_UNREADABLE');
              const rows = timeframe === '4h' ? h : timeframe === '15m' ? m : await bars(symbol, timeframe, Date.now());
              contextEvidence[timeframe] = rows;
              const context = scanContextFrame({ symbol, timeframe, rows, tick: Number(input.tickSize), now: Date.now(), checkpoint: checkpoints[timeframe] });
              frames[timeframe] = context.feature; next[timeframe] = context.checkpoint;
              if (context.sourceRecovery) {
                const receipt = {symbol,timeframe,observedAt:Date.now(),...context.sourceRecovery};
                receipt.archive = `source-recovery-${symbol}-${timeframe}-${receipt.observedAt}.json`;
                await atomic(receipt.archive,{receipt,before:checkpoints[timeframe],after:context.checkpoint});
                await fs.appendFile(`${root}/source-recoveries-${new Date().toISOString().slice(0,10)}.jsonl`,JSON.stringify(receipt)+'\n',{mode:0o600});
              }
            } catch (error) {
              frames[timeframe] = { timeframe, role: SMC_CONTEXT_POLICY.frames[timeframe].role, status: 'UNAVAILABLE',
                reason: /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'CONTEXT_READ_FAILED' };
              const existing = errors.find(e => e.symbol === symbol);
              if (!existing) errors.push({symbol,reason:`${timeframe.toUpperCase()}_${frames[timeframe].reason}`});
              if (/PUBLIC_HTTP_(418|429)|READ_BUDGET_|SHARED_BUDGET_|RESIDENT_READ_/.test(error.message)) throw error;
            }
          }
          result.structureContext = assembleStructureContext(frames, Date.now());
          input.structureContext = result.structureContext;
          const quote = await get('/fapi/v1/ticker/bookTicker', { symbol });
          if (quote.symbol !== symbol) throw new Error('QUOTE_SYMBOL_MISMATCH');
          input.quote = quote; input.now = Date.now();
          Object.assign(result,scanSmcSymbol(input));
          // Legacy models remain a diagnostic baseline. Prospective automatic
          // candidates use the owner's local SMC/candle model; intersection markers never gate it.
          result.baselineCandidateCount = result.candidates.length;
          result.candidates = [];
          result.stopSafetyContext = stopSafetyContext(input);
          await atomic(`${symbol}-evidence.json`, input);
          for (const c of result.candidates) c.stopSafety = evaluateStopSafety({ context: result.stopSafetyContext, symbol,
            direction:c.direction, entry:c.entry, stop:c.stop, bid:Number(quote.bidPrice), ask:Number(quote.askPrice),
            tick:Number(quote.bidPrice), riskCostPerUnit:c.riskPerUnit-Math.abs(c.entry-c.stop), now:input.now });
          result.candidates = result.candidates.filter(c => {
            if(c.stopSafety.ready) return true;
            const reason=c.stopSafety.reason; result.rejected[reason]=(result.rejected[reason]??0)+1; return false;
          });
          let external;
          try { external = validateLifecycleState(JSON.parse(await fs.readFile('/var/lib/aegis/smc-execution/opportunity-terminals.json', 'utf8'))); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          const planningNow = Date.now();
          const marker = await observeIntersectionSafely(async () => {
          let priorClock;
          try { priorClock = JSON.parse(await fs.readFile(`${root}/${symbol}-intersection-clock-v1.json`, 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          const clock = updateIntersectionClock({ state: priorClock, symbol, rows: contextEvidence, tick: Number(input.tickSize), now: planningNow });
          await atomic(`${symbol}-intersection-clock-v1.json`, clock.state);
          if (clock.updates.length) await fs.appendFile(`${root}/intersections-${new Date(planningNow).toISOString().slice(0,10)}.jsonl`,
            JSON.stringify({ symbol, observedAt: planningNow, events: clock.updates }) + '\n', { mode: 0o600 });
            return clock.projection;
          });
          result.intersectionClock = marker.clock;
          result.intersectionObservation = marker.observation;
          const lifecycleMarket = { symbol, quote, bars: m.filter(b => Number(b[6]) < planningNow), now: planningNow, external };
          const priorPlans = previousSnapshot?.results?.find(r => r.symbol === symbol)?.structurePlans ?? [];
          lifecycleState = reconcilePlanLifecycle(lifecycleState, { ...lifecycleMarket, plans: [...priorPlans, ...(previousSnapshot?.results?.find(r => r.symbol === symbol)?.candidates ?? []).map(candidateLifecyclePlan)] });
          const targetPathEvidence=build4hFvgEvidence({...input,now:planningNow});
          result.candidates=result.candidates.flatMap(c=>{const projected=applyCandidateTargetPath(c,targetPathEvidence,Number(input.tickSize),planningNow);if(!projected.candidate)result.rejected[projected.targetPath.reason]=(result.rejected[projected.targetPath.reason]??0)+1;return projected.candidate?[projected.candidate]:[];});
          const earlyFvg=derive15mFvgEntryProposals({...input,now:planningNow});
          await atomic(`${symbol}-early-fvg-observation.json`,{symbol,observedAt:planningNow,orderAuthority:false,proposals:earlyFvg});
          result.structurePlans = deriveStructurePlans({ ...input, discoveryRevision: 'SMC-TIMED-ENTRY-1', targetPolicyRevision: 'SMC-TARGET-4H-2', riskScopeRevision: 'SMC-PLAN-RISK-1', entryPolicyRevision: 'SMC-ENTRY-PATHS-2', now: planningNow, structureContext: result.structureContext, lifecycleState });
          result.modelAssessments = [];
          if (policy.entryPolicyRevision===SMC_S1_ENTRY_REVISION) {
            if(!marker.clock)throw new Error('SMC_PX_INTERSECTION_UNAVAILABLE');
            const window=marker.clock.active;
            if(window) {
              const promoted=smcS1Candidate({symbol,window,bars15m:m.slice(-320),evidence:targetPathEvidence,
                quote:{bid:Number(quote.bidPrice),ask:Number(quote.askPrice),time:Number(quote.time)},now:planningNow});
              result.modelAssessments.push({direction:promoted.candidate?.direction??null,...promoted.assessment});
              if(promoted.candidate) {
                const selection=input.ownerSelections.find(row=>row.direction===promoted.candidate.direction);
                const selected=selection?smcS1Candidate({symbol,window,bars15m:m.slice(-320),evidence:targetPathEvidence,
                  quote:{bid:Number(quote.bidPrice),ask:Number(quote.askPrice),time:Number(quote.time)},now:planningNow,selection}):promoted;
                if(selected.candidate)result.candidates.push(selected.candidate);
              }
            }else result.modelAssessments.push({revision:SMC_S1_ENTRY_REVISION,ready:false,reasons:['SMC_PX_WAIT_INTERSECTION']});
          } else for (const plan of result.structurePlans) {
            const promoted = dualFrameCandidate(plan, result.structureContext, m,
              { bid: Number(quote.bidPrice), ask: Number(quote.askPrice), time: Number(quote.time) }, planningNow,
              input.ownerSelections.find(s => s.direction === plan.direction) ?? null,targetPathEvidence);
            result.modelAssessments.push({ planId: plan.id, direction: plan.direction, ...promoted.assessment });
            const c = promoted.candidate;
            if (c && !result.candidates.some(existing => existing.direction === c.direction)) {
              c.stopSafety = evaluateStopSafety({ context: result.stopSafetyContext, symbol, direction: c.direction, tradePlan:c.sourcePlan,
                entry: c.entry, stop: c.stop, bid: Number(quote.bidPrice), ask: Number(quote.askPrice),
                tick: Number(quote.bidPrice), riskCostPerUnit: c.riskPerUnit - Math.abs(c.entry-c.stop), now: planningNow });
              if (c.stopSafety.ready) result.candidates.push(c);
              else result.modelAssessments.at(-1).reasons.push(`STOP_SAFETY_${c.stopSafety.reason}`);
            }
          }
          if (new Set(result.candidates.map(c => c.direction)).size > 1) {
            result.candidates = [];
            for (const a of result.modelAssessments) { a.ready = false; a.reasons.push('JEV_LOCAL_DIRECTION_CONFLICT'); }
          }
          lifecycleState = reconcilePlanLifecycle(lifecycleState, { ...lifecycleMarket, plans: [...result.structurePlans, ...result.candidates.map(candidateLifecyclePlan)] });
          result.candidates = result.candidates.filter(p => lifecycleSourceIsActive(candidateLifecyclePlan(p), { state: lifecycleState, now: planningNow }));
          result.structurePlans = result.structurePlans.filter(p => lifecycleSourceIsActive(p, { state: lifecycleState, now: planningNow }));
          result.planningQuote = { bid: Number(quote.bidPrice), ask: Number(quote.askPrice), time: Number(quote.time) };
          result.planTerminals = Object.values(lifecycleState.records).filter(r => r.plan.symbol === symbol && r.terminal).slice(-16);
          await atomic('plan-lifecycle.json', lifecycleState);
          await atomic(`${symbol}-context-evidence.json`, { revision: SMC_CONTEXT_POLICY.revision, symbol,
            tick: Number(input.tickSize), observedAt: result.structureContext.observedAt, rows: contextEvidence });
          if (!checkpoints.invalid) await atomic(`${symbol}-context-v2-checkpoint.json`, next);
        } catch (error) {
          const partial = results.findIndex(r => r.symbol === symbol); if (partial >= 0) results.splice(partial, 1);
          errors.push({ symbol, reason: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'SCAN_FAILED' });
          if (/PUBLIC_HTTP_(418|429)|READ_BUDGET_|SHARED_BUDGET_|RESIDENT_READ_/.test(error.message)) break;
        }
      }
    } catch (error) { errors.push({ symbol: 'GLOBAL', reason: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'SCAN_FAILED' }); }
    const recentInvalidations = updateRecentInvalidations(previousSnapshot, results, Date.now());
    const snapshot = sanitizeSmcScan({ revision: policy.revision, mode: policy.mode, orderAuthority: false,
      sourceAsOf: new Date().toISOString(), universe: policy.universe, results, recentInvalidations,
      ownerSelectionFeed: ownerSelections.feed, errors });
    await atomic('latest.json', snapshot);
    await fs.appendFile(`${root}/opportunity-funnel-${snapshot.sourceAsOf.slice(0,10)}.jsonl`, JSON.stringify({
      at: snapshot.sourceAsOf, contract: policy.entryPolicyRevision===SMC_S1_ENTRY_REVISION?'SMC-S1-PX-1':'SMC-CONTRACT-4', models: snapshot.results.map(r => ({ symbol: r.symbol,
        candidates: r.candidates.map(c => ({ id: c.id, model: c.modelRevision ?? 'BREAKOUT_FVG', stage: c.status })),
        assessments: r.modelAssessments, rejected: r.rejected })) }) + '\n', { mode: 0o600 });
    await fs.appendFile(`${root}/context-${snapshot.sourceAsOf.slice(0, 10)}.jsonl`, JSON.stringify({
      at: snapshot.sourceAsOf, revision: SMC_CONTEXT_POLICY.revision, orderAuthority: false,
      contexts: snapshot.results.map(row => ({ symbol: row.symbol, context: row.structureContext })) }) + '\n', { mode: 0o600 });
    await fs.appendFile(`${root}/entry-reviews-${snapshot.sourceAsOf.slice(0, 10)}.jsonl`, JSON.stringify({
      at: snapshot.sourceAsOf, revision: 'SMC-ENTRY-REVIEW-2', orderAuthority: false,
      plans: snapshot.results.flatMap(row => (row.structurePlans ?? []).map(p => ({ id: p.id, symbol: p.symbol,
        direction: p.direction, entry: p.entry, stop: p.stop, target: p.target, review: p.entryReview }))) }) + '\n', { mode: 0o600 });
    previousSnapshot = snapshot;
    await fs.appendFile(`${root}/cycles.jsonl`, JSON.stringify({ at: snapshot.sourceAsOf, status: snapshot.status, scanned: results.length, candidates: snapshot.candidates.map(c => ({ id: c.id, status: c.status, netR: c.netR, candidateSource: c.candidateSource })), errors }) + '\n', { mode: 0o600 });
    try { await publish(snapshot); } catch (error) { await atomic('publish.json', { status: 'FAILED', reason: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'PUBLISH_FAILED', at: new Date().toISOString() }); }
    process.stdout.write(JSON.stringify({ at: snapshot.sourceAsOf, status: snapshot.status, scanned: results.length, candidates: snapshot.candidates.length, errors }) + '\n');
    if (process.argv.includes('--once')) break;
    // Align the existing five-minute read cadence just after 15M bar closes so
    // an immediate second-bar reversal is observable before its entry window ages.
    const clockNow = Date.now();
    const nextBoundary = Math.floor((clockNow - 5000) / policy.cycleIntervalMs + 1) * policy.cycleIntervalMs + 5000;
    const delay = errors.length ? 180000 : Math.max(1000, nextBoundary - clockNow);
    for (let waited = 0; waited < delay && !stopping; waited += 1000) await new Promise(resolve => setTimeout(resolve, 1000));
  }
} finally { await admission.close(); }
