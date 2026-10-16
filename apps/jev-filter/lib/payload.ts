import { sanitizeResearch, type Research } from './research.ts';
import { sanitizeJudge, type Judge } from './judge.ts';
import { sanitizeDecision, type Decision } from './decision.ts';
export type Label = "FOCUS" | "WATCH" | "CAUTION" | "INSUFFICIENT";
export type DirectionalLabel = "EDGE" | "LEAN" | "FLAT" | "AVOID";
export type MetricName = "pxDistancePct" | "rsi14" | "ema20SlopePct" | "atr14Pct" | "volumeRatio" | "quoteVolumeUsd24h" | "priceChangePct24h" | "fundingPct" | "openInterestUsd" | "oiChangePct1h" | "spreadBps" | "marketCapUsd" | "fdvToCap" | "circulatingRatio";
export type Directional = {
  schemaVersion: 1; status: "EVALUATED" | "UNAVAILABLE"; label: DirectionalLabel;
  probabilityPct: number | null; p05R: number | null; p1R: number | null; pStop: number | null; pTimeout: number | null; evR: number | null;
  confidence: number | null; model: string | null; evaluatedAt: string | null;
};
export type Observation = {
  id: string; symbol: string; direction: "LONG" | "SHORT"; stage: "LOCKED" | "ARRIVED" | "UPCOMING";
  px: number; intersectionTime: string; observedAt: string;
  status: "EVALUATED" | "UNAVAILABLE"; label: Label; confidence: number | null;
  model: string | null; evaluatedAt: string | null; evidenceHash: string | null;
  directional: Directional | null;
  judge?: Judge | null;
  decision?: Decision | null;
  metrics: Record<MetricName, number | null>;
  sources: { binanceAt: string | null; coingeckoAt: string | null };
};
export type Payload = { schemaVersion: 1; mode: "OBSERVE_ONLY"; orderAuthority: false; account: "S1" | "S2"; asOf: string; sourceAsOf: string; observations: Observation[]; research?: Research | null };
export type SmcAssessment = { revision: "JEV-SMC-ASSESS-3"; verdict: "YES" | "NO" | "WAIT"; evidenceScore: number | null; estimatedProbability: number | null; probabilityStatus: "HEURISTIC_UNCALIBRATED" | "UNRATED_MODEL"; confidence: number; marketState: "TRIGGER_CONFIRMED" | "MICRO_STRUCTURE_PENDING" | "LIQUIDITY_SWEEP_PENDING" | "VALUE_LOCATION_PENDING" | "COMPRESSION_PENDING" | "FALSE_BREAK_WATCH" | "NEAR_TRIGGER" | "APPROACHING"; strategyImpact: "SUPPORTIVE" | "MIXED" | "ADVERSE"; drivers: Array<{ key: string; label: string; impact: "POSITIVE" | "NEUTRAL" | "NEGATIVE"; points: number; value: unknown }>; featureVector: Record<string, unknown>; modelFeedback: { status: "FEATURE_VECTOR_READY" | "PARTIAL_EVIDENCE"; executionAuthority: false } };
export type SmcCandidate = { modelRevision?: string | null; entryPolicyRevision?: string | null; targetPathRevision?: string | null; referenceTarget?: number | null; targetPath?: Record<string, unknown> | null; id: string; symbol: string; direction: "LONG" | "SHORT"; sourceStatus: "ARMED_CE_CLOSE" | "WAIT_15M_MICRO_STRUCTURE_SHIFT" | "WAIT_CE_REENTRY" | "WAIT_LIQUIDITY_SWEEP_RECLAIM" | "WAIT_VALUE_LOCATION" | "WAIT_15M_EXPANSION_CONFIRMATION" | "ENTRY_BAND_ACTIVE" | "WAIT_SECOND_BAR_CE_REVERSAL" | "WAIT_SECOND_BAR_PRICE" | "SECOND_BAR_REVERSE_READY"; observedAt: number; confirmationAt: number; entry: number; stop: number; target: number; netR: number; structureGrade: "A" | "B" | null; structureQualityModel: string | null; candidateSource: "AUTOMATIC" | "OWNER_SELECTED"; ownerSelectedAt: number | null; researchCohort: "AUTOMATIC_DISCOVERY" | "OWNER_SELECTED_STRUCTURE"; researchState: string; entryMode: string | null; reversal: { firstBarAt: number; secondBarAt: number; secondClose: number; oldStop: number; revisedStop: number; plannedStopSwept: boolean } | null; poiLifecycle: Record<string, unknown> | null; entryLiquidity: Record<string, unknown> | null; entryLocation: Record<string, unknown> | null; entryRegime: Record<string, unknown> | null; entryMicroStructure: Record<string, unknown> | null; assessment: SmcAssessment; probability: number | null; probabilityStatus: "HEURISTIC_UNCALIBRATED" | "UNRATED_MODEL"; executionAuthority: false };
export type SmcStructureContext = { symbol: string; context: { revision: string; structureLookbackDays: number; admissionEffect: 'NONE'; orderAuthority: false; calibratedWinProbability: null; relationships: Record<string, string>; frames: Record<string, {status: string; bias?: string; availableAt?: number}> } };
export type SmcPayload = { sourceHealth?: {status: "HEALTHY" | "DEGRADED"; errors: {symbol: string; reason: string}[]} | null; opportunityReviews?: { symbol: string; futureCount: number; activeWindow: { opensAt: number; expiresAt: number } | null; models: { direction: string; ready: boolean; reasons: string[]; baselineEligible: boolean }[] }[]; conditionalPlanCount: number; structureContexts?: SmcStructureContext[]; schemaVersion: 1; account: "SMC"; observerRevision: "JEV-SMC-OUTCOME-14" | "JEV-SMC-OUTCOME-15" | "JEV-SMC-OUTCOME-16" | "JEV-SMC-OUTCOME-17" | "JEV-SMC-OUTCOME-18" | "JEV-SMC-OUTCOME-19" | "JEV-SMC-OUTCOME-20" | "JEV-SMC-OUTCOME-21" | "JEV-SMC-OUTCOME-22" | "JEV-SMC-OUTCOME-23"; mode: "OBSERVE_ONLY"; orderAuthority: false; strategyRevision: "SMC-EXEC-11"; scannerRevision: "SMC-SCAN-13"; asOf: string; sourceAsOf: string | null; sourceStatus: "READY" | "STALE" | "INVALID"; candidates: SmcCandidate[]; research: { entryPolicyRevision: string | null; targetPathRevision: string | null; structureHierarchyRevision: string | null; structureContextRevision: string | null; conditionalPlanRevision: string | null; opportunitySearchRevision: string | null; planLifecycleRevision: string | null; stopSafetyRevision: string | null; stopSlippageBps: number | null; conditionalEntryReviewRevision: string | null; conditionalTimingPolicy: string | null; status: "ACTIVE_HEURISTIC_ASSESSMENT"; probabilityGateActive: false; frozenCount: number; outcomeDefinition: string; historicalBackfill: false; structureLookbackBars4h: number; activePlanHorizonBars4h: number; ownerSelectedPlanHorizonBars4h: number; ownerSelectedOutcomeSegregation: true; promotionReviewMinimumIndependentOutcomes: number }; shadow: { status: "OBSERVE_ONLY"; simulatedEntryAllowed: false; liveOrderAuthority: false; reason: string } };

const symbols = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "ZECUSDT", "HYPEUSDT", "LINKUSDT", "AAVEUSDT"]);
const metricNames: MetricName[] = ["pxDistancePct", "rsi14", "ema20SlopePct", "atr14Pct", "volumeRatio", "quoteVolumeUsd24h", "priceChangePct24h", "fundingPct", "openInterestUsd", "oiChangePct1h", "spreadBps", "marketCapUsd", "fdvToCap", "circulatingRatio"];
const labels = new Set<Label>(["FOCUS", "WATCH", "CAUTION", "INSUFFICIENT"]);
const directionalLabels = new Set<DirectionalLabel>(["EDGE", "LEAN", "FLAT", "AVOID"]);
const stamp = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function sanitizeSmcPayload(input: unknown, now = Date.now()): SmcPayload {
  const value=record(input), asOf=stamp(value.asOf), sourceAsOf=value.sourceAsOf===null?null:stamp(value.sourceAsOf);
  if(value.schemaVersion!==1||value.account!=="SMC"||!["JEV-SMC-OUTCOME-14","JEV-SMC-OUTCOME-15","JEV-SMC-OUTCOME-16","JEV-SMC-OUTCOME-17","JEV-SMC-OUTCOME-18","JEV-SMC-OUTCOME-19","JEV-SMC-OUTCOME-20","JEV-SMC-OUTCOME-21","JEV-SMC-OUTCOME-22","JEV-SMC-OUTCOME-23"].includes(String(value.observerRevision))||value.mode!=="OBSERVE_ONLY"||value.orderAuthority!==false
    ||value.strategyRevision!=="SMC-EXEC-11"||value.scannerRevision!=="SMC-SCAN-13"||!asOf||Date.parse(asOf)>now+30_000||now-Date.parse(asOf)>30*60_000
    ||!['READY','STALE','INVALID'].includes(String(value.sourceStatus)))throw new Error('JEV_SMC_SCOPE_INVALID');
  if(value.sourceStatus==='READY'&&(!sourceAsOf||now-Date.parse(sourceAsOf)>420_000||Date.parse(sourceAsOf)>now+5000))throw new Error('JEV_SMC_TIME_INVALID');
  if(!Array.isArray(value.candidates)||value.candidates.length>30)throw new Error('JEV_SMC_ROWS_INVALID');
  const seen=new Set<string>();
  const candidates=value.candidates.map(raw=>{const row=record(raw), observedAt=number(row.observedAt), confirmationAt=number(row.confirmationAt), entry=number(row.entry), stop=number(row.stop), target=number(row.target), netR=number(row.netR);
    const unrated = ['SMC-CONTINUATION-1','SMC-CONTINUATION-2','SMC-TIMED-ENTRY-1','SMC-LOCAL-ENTRY-1','SMC-LOCAL-ENTRY-2'].includes(String(row.modelRevision)) && row.probabilityStatus==='UNRATED_MODEL';
    if(typeof row.id!=='string'||row.id.length<1||row.id.length>240||seen.has(row.id)||typeof row.symbol!=='string'||!symbols.has(row.symbol)
      ||!['LONG','SHORT'].includes(String(row.direction))||!['ARMED_CE_CLOSE','WAIT_15M_MICRO_STRUCTURE_SHIFT','WAIT_CE_REENTRY','WAIT_LIQUIDITY_SWEEP_RECLAIM','WAIT_VALUE_LOCATION','WAIT_15M_EXPANSION_CONFIRMATION','ENTRY_BAND_ACTIVE','WAIT_SECOND_BAR_CE_REVERSAL','WAIT_SECOND_BAR_PRICE','SECOND_BAR_REVERSE_READY'].includes(String(row.sourceStatus))
      ||observedAt===null||confirmationAt===null||entry===null||stop===null||target===null||netR===null||entry<=0||stop<=0||target<=0||netR<2
      ||!['A','B',null].includes(row.structureGrade as 'A'|'B'|null)||!['AUTOMATIC','OWNER_SELECTED'].includes(String(row.candidateSource))
      ||(row.candidateSource==='OWNER_SELECTED' ? number(row.ownerSelectedAt)===null : row.ownerSelectedAt!==null)
      ||row.researchCohort!==(row.candidateSource==='OWNER_SELECTED'?'OWNER_SELECTED_STRUCTURE':'AUTOMATIC_DISCOVERY')
      ||(unrated ? row.probability!==null : number(row.probability)===null||number(row.probability)!<.25||number(row.probability)!>.8||row.probabilityStatus!=='HEURISTIC_UNCALIBRATED')||row.executionAuthority!==false)throw new Error('JEV_SMC_CANDIDATE_INVALID');
    const assessmentRaw=record(row.assessment), assessmentProbability=number(assessmentRaw.estimatedProbability), evidenceScore=number(assessmentRaw.evidenceScore), confidence=number(assessmentRaw.confidence), modelFeedback=record(assessmentRaw.modelFeedback);
    if(assessmentRaw.revision!=='JEV-SMC-ASSESS-3'||!['YES','NO','WAIT'].includes(String(assessmentRaw.verdict))||(unrated ? assessmentRaw.evidenceScore!==null||assessmentRaw.estimatedProbability!==null||assessmentRaw.probabilityStatus!=='UNRATED_MODEL' : evidenceScore===null||evidenceScore<0||evidenceScore>100||assessmentProbability===null||assessmentProbability<.25||assessmentProbability>.8||assessmentRaw.probabilityStatus!=='HEURISTIC_UNCALIBRATED')||assessmentProbability!==number(row.probability)
      ||confidence===null||confidence<0||confidence>1||!['TRIGGER_CONFIRMED','MICRO_STRUCTURE_PENDING','LIQUIDITY_SWEEP_PENDING','VALUE_LOCATION_PENDING','COMPRESSION_PENDING','FALSE_BREAK_WATCH','NEAR_TRIGGER','APPROACHING'].includes(String(assessmentRaw.marketState))
      ||!['SUPPORTIVE','MIXED','ADVERSE'].includes(String(assessmentRaw.strategyImpact))||!Array.isArray(assessmentRaw.drivers)||assessmentRaw.drivers.length>4
      ||assessmentRaw.drivers.some(rawDriver=>{const d=record(rawDriver);return typeof d.key!=='string'||typeof d.label!=='string'||d.label.length>60||!['POSITIVE','NEUTRAL','NEGATIVE'].includes(String(d.impact))||number(d.points)===null;})
      ||!['FEATURE_VECTOR_READY','PARTIAL_EVIDENCE'].includes(String(modelFeedback.status))||modelFeedback.executionAuthority!==false)throw new Error('JEV_SMC_ASSESSMENT_INVALID');
    const assessment={revision:'JEV-SMC-ASSESS-3',verdict:assessmentRaw.verdict,evidenceScore,estimatedProbability:assessmentProbability,probabilityStatus:unrated?'UNRATED_MODEL':'HEURISTIC_UNCALIBRATED',confidence,marketState:assessmentRaw.marketState,strategyImpact:assessmentRaw.strategyImpact,drivers:assessmentRaw.drivers,featureVector:record(assessmentRaw.featureVector),modelFeedback:{status:modelFeedback.status,executionAuthority:false}} as SmcAssessment;
    const reversalRaw=record(row.reversal);
    const reversal=['firstBarAt','secondBarAt','secondClose','oldStop','revisedStop'].every(k=>number(reversalRaw[k])!==null) && typeof reversalRaw.plannedStopSwept==='boolean'
      ? {firstBarAt:number(reversalRaw.firstBarAt)!,secondBarAt:number(reversalRaw.secondBarAt)!,secondClose:number(reversalRaw.secondClose)!,oldStop:number(reversalRaw.oldStop)!,revisedStop:number(reversalRaw.revisedStop)!,plannedStopSwept:reversalRaw.plannedStopSwept as boolean} : null;
    if(row.entryMode==='CLOSED_15M_SECOND_BAR_CE_REVERSAL' && row.sourceStatus!=='WAIT_SECOND_BAR_CE_REVERSAL' && !reversal)throw new Error('JEV_SMC_REVERSAL_EVIDENCE_INVALID');
    const targetPath=record(row.targetPath),path2=row.entryPolicyRevision==='SMC-ENTRY-PATHS-2';
    if(path2&&(row.targetPathRevision!=='SMC-TARGET-PATH-1'||targetPath.revision!=='SMC-TARGET-PATH-1'
      ||targetPath.ready!==true||targetPath.orderAuthority!==false||targetPath.entry!==entry
      ||targetPath.admissionTarget!==target||targetPath.netR!==netR||number(row.referenceTarget)===null))throw new Error('JEV_SMC_TARGET_PATH_INVALID');
    seen.add(row.id);return {entryPolicyRevision:typeof row.entryPolicyRevision==='string'?row.entryPolicyRevision:null,
      targetPathRevision:path2?'SMC-TARGET-PATH-1':null,referenceTarget:number(row.referenceTarget),targetPath:path2?targetPath:null,modelRevision:typeof row.modelRevision==='string'?row.modelRevision:null,id:row.id,symbol:row.symbol,direction:row.direction,sourceStatus:row.sourceStatus,observedAt,confirmationAt,entry,stop,target,netR,
      structureGrade:row.structureGrade,structureQualityModel:typeof row.structureQualityModel==='string'?row.structureQualityModel:null,
      candidateSource:row.candidateSource,ownerSelectedAt:number(row.ownerSelectedAt),researchCohort:row.researchCohort,
      researchState:typeof row.researchState==='string'?row.researchState:'',entryMode:typeof row.entryMode==='string'?row.entryMode:null,reversal,
      poiLifecycle:row.poiLifecycle&&typeof row.poiLifecycle==='object'?record(row.poiLifecycle):null,
      entryLiquidity:row.entryLiquidity&&typeof row.entryLiquidity==='object'?record(row.entryLiquidity):null,
      entryLocation:row.entryLocation&&typeof row.entryLocation==='object'?record(row.entryLocation):null,
      entryRegime:row.entryRegime&&typeof row.entryRegime==='object'?record(row.entryRegime):null,
      entryMicroStructure:row.entryMicroStructure&&typeof row.entryMicroStructure==='object'?record(row.entryMicroStructure):null,
      assessment,probability:number(row.probability),probabilityStatus:unrated?'UNRATED_MODEL':'HEURISTIC_UNCALIBRATED',executionAuthority:false} as SmcCandidate;});
  const research=record(value.research), shadow=record(value.shadow);
  const frozenCount=number(research.frozenCount),lookback=number(research.structureLookbackBars4h),horizon=number(research.activePlanHorizonBars4h),ownerHorizon=number(research.ownerSelectedPlanHorizonBars4h),minimum=number(research.promotionReviewMinimumIndependentOutcomes);
  if(research.status!=='ACTIVE_HEURISTIC_ASSESSMENT'||research.probabilityGateActive!==false||research.historicalBackfill!==false||typeof research.outcomeDefinition!=='string'||research.outcomeDefinition.length>1000
    ||frozenCount===null||lookback===null||horizon===null||ownerHorizon===null||research.ownerSelectedOutcomeSegregation!==true||minimum===null||shadow.status!=='OBSERVE_ONLY'||shadow.simulatedEntryAllowed!==false||shadow.liveOrderAuthority!==false||typeof shadow.reason!=='string')throw new Error('JEV_SMC_RESEARCH_INVALID');
  const structureContexts = (Array.isArray(value.structureContexts) ? value.structureContexts : []).slice(0,10).map(raw => {
    const row = record(raw), context = record(row.context);
    if(typeof row.symbol !== 'string' || !/^[A-Z0-9]{3,20}$/.test(row.symbol) || !['SMC-CONTEXT-1','SMC-CONTEXT-2'].includes(String(context.revision))
      || context.admissionEffect !== 'NONE' || context.orderAuthority !== false || context.calibratedWinProbability !== null
      || context.structureLookbackDays !== 120) throw new Error('SMC_CONTEXT_INVALID');
    const rawFrames = record(context.frames), frames: SmcStructureContext['context']['frames'] = {};
    for(const tf of (context.timeframeProfile==='SMC-4H15M-1'?['4h','15m']:['4h','1h','15m','5m'])) { const f = record(rawFrames[tf]);
      if(!['READY','UNAVAILABLE'].includes(String(f.status))) throw new Error('SMC_CONTEXT_FRAME_INVALID');
      if(f.status === 'READY' && (!['UNKNOWN','TRANSITION','BULLISH','BEARISH'].includes(String(f.bias)) || number(f.availableAt) === null || Number(f.availableAt) > now)) throw new Error('SMC_CONTEXT_FRAME_INVALID');
      frames[tf] = {status: String(f.status), ...(f.status === 'READY' ? {bias: String(f.bias), availableAt: Number(f.availableAt)} : {})};
    }
    const relationships: Record<string,string> = {}; const rel = record(context.relationships);
    for(const tf of (context.timeframeProfile==='SMC-4H15M-1'?['15m']:['1h','15m','5m'])) relationships[tf] = ['ALIGNED','CONFLICT','UNKNOWN'].includes(String(rel[tf])) ? String(rel[tf]) : 'UNKNOWN';
    return {symbol: row.symbol, context: {...(context.timeframeProfile==='SMC-4H15M-1'?{timeframeProfile:'SMC-4H15M-1'}:{}),revision:String(context.revision),structureLookbackDays:120,admissionEffect:'NONE',orderAuthority:false,calibratedWinProbability:null,relationships,frames}} as SmcStructureContext;
  });
  const opportunityReviews = (Array.isArray(value.opportunityReviews) ? value.opportunityReviews : []).slice(0,10).map(raw => {
    const row=record(raw), clock=record(row.clock), active=record(clock.active);
    if(typeof row.symbol!=='string'||!symbols.has(row.symbol)||row.orderAuthority!==false)throw new Error('JEV_OPPORTUNITY_SCOPE');
    return {symbol:row.symbol,futureCount:Math.max(0,number(clock.futureCount)??0),activeWindow:number(active.opensAt)!==null&&number(active.expiresAt)!==null?{opensAt:number(active.opensAt)!,expiresAt:number(active.expiresAt)!}:null,
      models:(Array.isArray(row.models)?row.models:[]).slice(0,2).map(rawModel=>{const m=record(rawModel);return {direction:String(m.direction),ready:m.ready===true,baselineEligible:m.baselineEligible===true,reasons:(Array.isArray(m.reasons)?m.reasons:[]).slice(0,12).map(String)};})};
  });
  const health = record(value.sourceHealth);
  const sourceHealth = ["HEALTHY","DEGRADED"].includes(String(health.status)) ? {status:health.status as "HEALTHY" | "DEGRADED",errors:Array.isArray(health.errors) ? health.errors.slice(0,11).map(record).filter(e=>typeof e.symbol==='string' && typeof e.reason==='string').map(e=>({symbol:String(e.symbol).slice(0,20),reason:String(e.reason).slice(0,160)})) : []} : null;
  return {sourceHealth,opportunityReviews,structureContexts,schemaVersion:1,account:'SMC',observerRevision:value.observerRevision as SmcPayload['observerRevision'],mode:'OBSERVE_ONLY',orderAuthority:false,strategyRevision:'SMC-EXEC-11',scannerRevision:'SMC-SCAN-13',asOf,sourceAsOf,sourceStatus:value.sourceStatus as SmcPayload['sourceStatus'],candidates,conditionalPlanCount:Math.max(0,Math.min(20,number(research.conditionalPlanCount)??0)),
    research:{entryPolicyRevision:['SMC-ENTRY-PATHS-1','SMC-ENTRY-PATHS-2'].includes(String(research.entryPolicyRevision))?String(research.entryPolicyRevision):null,targetPathRevision:research.targetPathRevision==='SMC-TARGET-PATH-1'?'SMC-TARGET-PATH-1':null,structureHierarchyRevision:research.structureHierarchyRevision === 'SMC-HIERARCHY-1' ? 'SMC-HIERARCHY-1' : null,structureContextRevision:research.structureContextRevision === 'SMC-CONTEXT-2' ? 'SMC-CONTEXT-2' : null,conditionalPlanRevision:research.conditionalPlanRevision === 'SMC-STRUCTURE-PLAN-2' ? 'SMC-STRUCTURE-PLAN-2' : null,opportunitySearchRevision:research.opportunitySearchRevision === 'SMC-OPPORTUNITY-SEARCH-1' ? 'SMC-OPPORTUNITY-SEARCH-1' : null,planLifecycleRevision:research.planLifecycleRevision === 'SMC-PLAN-LIFECYCLE-1' ? 'SMC-PLAN-LIFECYCLE-1' : null,stopSafetyRevision:research.stopSafetyRevision === 'SMC-STOP-SAFETY-3' ? 'SMC-STOP-SAFETY-3' : null,stopSlippageBps:research.stopSlippageBps === 10 ? 10 : null,conditionalEntryReviewRevision:['SMC-ENTRY-REVIEW-2','SMC-ENTRY-REVIEW-3'].includes(String(research.conditionalEntryReviewRevision)) ? String(research.conditionalEntryReviewRevision) : null,conditionalTimingPolicy:['CLOSED_5M_RETEST_REJECTION_PRIOR_CONFIRMED_PIVOT_CROSS_RECOGNITION_ONLY','CONTINUATION2_4H_PARENT_LOCAL_SCOPE_POST_PLAN_5M_TRIGGER_NET2_STOP_SAFETY','TIMED_ENTRY1_PREKNOWN_INTERSECTION_POST_WINDOW_LOCAL_SMC_CANDLE_NET2_STRUCTURE_STOP_UNCHANGED','LOCAL_ENTRY1_SMC_CANDLE_NET2_INTERSECTION_MARKER_ONLY','LOCAL_ENTRY2_4H15M_SMC_CANDLE_NET2_INTERSECTION_MARKER_ONLY','PATH2_CAUSAL_MODEL_LOCATION_TARGET_PATH_NET2_INTERSECTION_MARKER_ONLY'].includes(String(research.conditionalTimingPolicy)) ? String(research.conditionalTimingPolicy) : null,status:'ACTIVE_HEURISTIC_ASSESSMENT',probabilityGateActive:false,frozenCount,outcomeDefinition:research.outcomeDefinition,historicalBackfill:false,structureLookbackBars4h:lookback,activePlanHorizonBars4h:horizon,ownerSelectedPlanHorizonBars4h:ownerHorizon,ownerSelectedOutcomeSegregation:true,promotionReviewMinimumIndependentOutcomes:minimum},
    shadow:{status:'OBSERVE_ONLY',simulatedEntryAllowed:false,liveOrderAuthority:false,reason:shadow.reason}};
}
export function sanitizePayload(input: unknown, now = Date.now()): Payload {
  const value = input as Record<string, unknown> | null;
  if (!value || value.schemaVersion !== 1 || value.mode !== "OBSERVE_ONLY" || value.orderAuthority !== false) throw new Error("JEV_SCOPE_INVALID");
  const account = value.account;
  if (account !== "S1" && account !== "S2") throw new Error("JEV_ACCOUNT_INVALID");
  const asOf = stamp(value.asOf), sourceAsOf = stamp(value.sourceAsOf);
  if (!asOf || !sourceAsOf || Date.parse(asOf) > now + 30_000 || now - Date.parse(asOf) > 30 * 60_000 || now - Date.parse(sourceAsOf) > 180_000 || Math.abs(Date.parse(asOf) - Date.parse(sourceAsOf)) > 180_000) throw new Error("JEV_TIME_INVALID");
  const rawRows = value.observations;
  if (!Array.isArray(rawRows) || rawRows.length > 30) throw new Error("JEV_ROWS_INVALID");
  const seen = new Set<string>();
  const observations: Observation[] = rawRows.map((raw: unknown) => {
    const row = raw as Record<string, unknown>;
    if (!row || typeof row.id !== "string" || row.id.length < 1 || row.id.length > 200 || seen.has(row.id)) throw new Error("JEV_ID_INVALID");
    seen.add(row.id);
    if (typeof row.symbol !== "string" || !symbols.has(row.symbol) || (row.direction !== "LONG" && row.direction !== "SHORT") || !["LOCKED", "ARRIVED", "UPCOMING"].includes(String(row.stage))) throw new Error("JEV_CANDIDATE_INVALID");
    const px = number(row.px), observedAt = stamp(row.observedAt), intersectionTime = stamp(row.intersectionTime);
    if (px === null || px <= 0 || !observedAt || !intersectionTime || Date.parse(observedAt) > now + 30_000) throw new Error("JEV_CANDIDATE_INVALID");
    if (row.status !== "EVALUATED" && row.status !== "UNAVAILABLE") throw new Error("JEV_STATUS_INVALID");
    if (!labels.has(row.label as Label)) throw new Error("JEV_LABEL_INVALID");
    const confidence = number(row.confidence);
    if (confidence !== null && (confidence < 0 || confidence > 1)) throw new Error("JEV_CONFIDENCE_INVALID");
    const model = typeof row.model === "string" && /^jev-[a-zA-Z0-9.-]{1,80}$/.test(row.model) ? row.model : null;
    const evaluatedAt = stamp(row.evaluatedAt);
    if (row.status === "EVALUATED" && (!model || !evaluatedAt || confidence === null)) throw new Error("JEV_EVALUATION_INVALID");
    const evidenceHash = typeof row.evidenceHash === "string" && /^[a-f0-9]{64}$/.test(row.evidenceHash) ? row.evidenceHash : null;
    const supplied = row.metrics as Record<string, unknown> | null;
    const metrics = Object.fromEntries(metricNames.map(key => [key, number(supplied?.[key])])) as Record<MetricName, number | null>;
    const sources = row.sources as Record<string, unknown> | null;
    const suppliedDirectional = row.directional as Record<string, unknown> | null;
    let directional: Directional | null = null;
    if (suppliedDirectional) {
      if (suppliedDirectional.schemaVersion !== 1 || (suppliedDirectional.status !== "EVALUATED" && suppliedDirectional.status !== "UNAVAILABLE") || !directionalLabels.has(suppliedDirectional.label as DirectionalLabel)) throw new Error("JEV_DIRECTIONAL_INVALID");
      const modelName = typeof suppliedDirectional.model === "string" && /^jev-[a-zA-Z0-9.-]{1,80}$/.test(suppliedDirectional.model) ? suppliedDirectional.model : null;
      const evaluatedAtDirectional = stamp(suppliedDirectional.evaluatedAt);
      const confidenceDirectional = number(suppliedDirectional.confidence);
      if (suppliedDirectional.status === "EVALUATED" && (!modelName || !evaluatedAtDirectional || confidenceDirectional === null)) throw new Error("JEV_DIRECTIONAL_INVALID");
      const probabilityPct = number(suppliedDirectional.probabilityPct), p05R = number(suppliedDirectional.p05R), p1R = number(suppliedDirectional.p1R), pStop = number(suppliedDirectional.pStop), pTimeout = number(suppliedDirectional.pTimeout), evR = number(suppliedDirectional.evR);
      if ([probabilityPct, p05R, p1R, pStop, pTimeout].some(item => item !== null && (item < 0 || item > 100)) || (evR !== null && (evR < -5 || evR > 5)) || (confidenceDirectional !== null && (confidenceDirectional < 0 || confidenceDirectional > 1))) throw new Error("JEV_DIRECTIONAL_RANGE_INVALID");
      directional = { schemaVersion: 1, status: suppliedDirectional.status, label: suppliedDirectional.label as DirectionalLabel, probabilityPct, p05R, p1R, pStop, pTimeout, evR, confidence: confidenceDirectional, model: modelName, evaluatedAt: evaluatedAtDirectional };
    }
    return { id: row.id, symbol: row.symbol, direction: row.direction, stage: row.stage, px, intersectionTime, observedAt,
      status: row.status, label: row.label as Label, confidence, model, evaluatedAt, evidenceHash, metrics,
      directional, judge: sanitizeJudge(row.judge, account, row.direction, now), decision: sanitizeDecision(row.decision,account,row.direction,row.id,now), sources: { binanceAt: stamp(sources?.binanceAt), coingeckoAt: stamp(sources?.coingeckoAt) } } as Observation;
  });
  return { schemaVersion: 1, mode: "OBSERVE_ONLY", orderAuthority: false, account, asOf, sourceAsOf, observations, research: sanitizeResearch(value.research, account, now) };
}
