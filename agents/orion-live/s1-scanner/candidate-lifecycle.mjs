import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { structuralPivots, fourHourLineageHypotheses } from '../../orion-v2/paper/paper-engine.mjs';
import { geometricPairs, untouchedPxReview, UNTOUCHED_REVISION } from './intersection-geometry.mjs';
import { findReviewedConvergencePlan } from './candidate-discovery.mjs';
import { advancePxFirstClose, pxFirstCloseSignal } from '../../shared/px-first-close.mjs';
import { prioritizePlanQueue, resolveEntryConditionRace, MAX_RETAINED_PLANS_PER_SYMBOL } from './engine.mjs';
import { selectDistinctIntersections, equivalentIntersection } from './candidate-selection.mjs';
import { invariant } from '../s1-execution/common.mjs';

export const S1_CANDIDATE_REVIEW_REVISION = 'S1-R22-QUALITY-DEDUP-3';
const digest = value => createHash('sha256').update(value).digest('hex');
const anchorsKey = anchors => JSON.stringify(anchors?.map(a => [a.type, a.time, a.price]));
const finite = Number.isFinite;

// Match the existing R22 execution windows. Historical opportunities are never
// moved to a later bar to make a retired signal executable again.
export function candidateExpiry(plan, now) {
  invariant(finite(now), 'CANDIDATE_CLOCK_INVALID');
  if (!finite(plan?.intersectionTime) || !finite(plan?.createdAt)) return 'CANDIDATE_TIME_UNVERIFIED';
  const signal = pxFirstCloseSignal(plan);
  if (signal.terminal) return signal.reason;
  if (now - plan.intersectionTime > 1800000) return 'R22_CROSS_EXPIRED';
  if (signal.accepted && (!finite(signal.bar?.closeTime) || now - signal.bar.closeTime > 180000)) return 'R22_CONFIRMATION_EXPIRED';
  return null;
}

// S1 geometric eligibility; line penetration does not invalidate an intersection.
// Shared V2/S2 discovery stays unchanged. Px touch is reviewed separately.
export function structureReviewer(bars4h, bars1h, strategy, now) {
  const policy = strategy.pivots.fourHour;
  const high = structuralPivots(bars4h, 'HIGH', policy), low = structuralPivots(bars4h, 'LOW', policy);
  const lineages = new Map();
  for (const [pivots, opposite, direction] of [[high, low, -1], [low, high, 1]]) {
    const pairs = geometricPairs(pivots, opposite, bars4h, direction, policy)
      .filter(pair => pair.hierarchyMultiplier >= policy.minimumRealtimeHierarchyMultiplier);
    for (const pair of fourHourLineageHypotheses(pairs, policy)) {
      lineages.set(anchorsKey([pair.first, pair.second]), pair.lineageStatus);
    }
  }
  const contexts = [[bars4h, policy], [bars1h, strategy.pivots.oneHour]].map(([bars, p]) => {
    const visible = bars.slice(-p.searchWindowBars);
    invariant(visible.length && visible.every(b => finite(b.closeTime) && b.closeTime <= now), 'STRUCTURE_HISTORY_UNVERIFIED');
    const range = Math.max(...visible.map(b => b.high)) - Math.min(...visible.map(b => b.low));
    invariant(finite(range) && range >= 0, 'STRUCTURE_HISTORY_UNVERIFIED');
    const tolerance = range * p.maximumIntermediateViolationFractionOfVisibleRange;
    invariant(finite(tolerance) && tolerance >= 0, 'STRUCTURE_TOLERANCE_UNVERIFIED');
    return { bars: visible, tolerance };
  });
  return plan => {
    if (plan.anchors?.length !== 4) return { reason: 'STRUCTURE_ANCHORS_UNVERIFIED' };
    const lineageStatus = lineages.get(anchorsKey(plan.anchors.slice(0, 2)));
    if (!lineageStatus) return { reason: 'FOUR_HOUR_LINEAGE_SUPERSEDED' };
    for (let i = 0; i < 2; i++) {
      const [first, second] = plan.anchors.slice(i * 2, i * 2 + 2), context = contexts[i];
      if (first.type !== second.type || !['LOW', 'HIGH'].includes(first.type) || !(second.time > first.time)) return { reason: 'STRUCTURE_ANCHORS_UNVERIFIED' };
      for (const anchor of [first, second]) {
        const bar = context.bars.find(b => b.openTime === anchor.time);
        if (!bar || bar[anchor.type === 'LOW' ? 'low' : 'high'] !== anchor.price || !(anchor.confirmedAt < now)) return { reason: 'STRUCTURE_ANCHORS_UNVERIFIED' };
      }

    }
    return { reason: null, lineageStatus };
  };
}

export function reviewCandidateQueue({ symbol, existing, bars15m, bars1h, bars4h, now, strategy, retiredIds = {} }) {
  invariant(Array.isArray(existing) && existing.every(p => p.symbol === symbol), 'CANDIDATE_QUEUE_INVALID');
  invariant(retiredIds && typeof retiredIds === 'object' && !Array.isArray(retiredIds)
    && Object.values(retiredIds).every(at => finite(at) && at <= now), 'CANDIDATE_RETIREMENT_INDEX_INVALID');
  const review = structureReviewer(bars4h, bars1h, strategy, now), retired = [], retained = [];
  const diagnostics = { revision: S1_CANDIDATE_REVIEW_REVISION, rejectionReasons: {} };
  const reject = reason => { diagnostics.rejectionReasons[reason] = (diagnostics.rejectionReasons[reason] ?? 0) + 1; };
  const retire = (plan, reason, evidence = null) => retired.push({ revision: S1_CANDIDATE_REVIEW_REVISION, id: plan.id, symbol, retiredAt: now, reason, evidence, plan: structuredClone(plan) });
  for (const original of existing) {
    // A previously persisted retirement is never undone by rediscovery/restart.
    if (Object.hasOwn(retiredIds, original.id)) continue;
    const expired = candidateExpiry(original, now);
    if (expired) { retire(original, expired); continue; }
    let plan = original;
    const committed = now >= plan.intersectionTime - strategy.intersection.commitmentLeadHours * 3600000;
    if (!committed) {
      const result = review(plan);
      if (result.reason) { retire(plan, result.reason, result.evidence); continue; }
      plan = { ...plan, fourHourLineStatus: result.lineageStatus };
    }
    // Preserve legacy already-committed policy. New-policy candidates retain
    // their touch requirement through the cross, including the commitment window.
    if (!committed || plan.candidateGeometryRevision === UNTOUCHED_REVISION) {
      const touch = untouchedPxReview(plan, bars1h, bars15m, now);
      if (touch.reason) { retire(plan, touch.reason, touch.evidence); continue; }
      plan = { ...plan, pxTouchReview: touch.evidence };
    }
    retained.push({ ...plan, committed, frozen: now >= plan.lockedBarOpenTime });
  }
  // Retire/advance before capacity admission: old locks cannot fill all slots.
  const advanced = [];
  for (const plan of retained) {
    const next = advancePxFirstClose(plan, bars15m, now, strategy.signal), expired = candidateExpiry(next, now);
    if (expired) retire(next, expired); else advanced.push(next);
  }
  const queue = resolveEntryConditionRace(advanced);
  const kept = new Set(queue.map(p => p.id));
  for (const plan of advanced) if (!kept.has(plan.id)) retire(plan, 'NEWER_READY_CANDIDATE_WON_ENTRY_RACE');
  const selected = selectDistinctIntersections(queue, now, strategy);
  for (const { plan, representative } of selected.suppressed) retire(plan, 'DUPLICATE_INTERSECTION_CLUSTER', {
    ...selected.policy, representativeId: representative.id,
    representativeIntersectionTime: representative.intersectionTime, representativeIntersectionPrice: representative.intersectionPrice,
    selectedBy: 'CONFIRMATION_CONTINUITY_THEN_STABILITY_ANCHOR_QUALITY_SENSITIVITY',
  });
  queue.splice(0, queue.length, ...selected.queue);
  diagnostics.selection = { ...selected.policy, inputCount: advanced.length, retainedCount: queue.length,
    duplicateCount: selected.suppressed.length, protectedConfirmationCount: queue.filter(p => now >= p.lockedBarOpenTime).length };
  const retiredThisCycle = new Set(retired.map(r => r.id));
  const geometry = new Set(queue.map(p => anchorsKey(p.anchors)));
  const discovered = findReviewedConvergencePlan({ symbol, bars15m, bars1h, bars4h, now, strategy,
    geometricOnly: true, diagnostics,
    candidateFilter: plan => {
      const reason = Object.hasOwn(retiredIds, plan.id) || retiredThisCycle.has(plan.id) ? 'ALREADY_RETIRED'
        : geometry.has(anchorsKey(plan.anchors)) ? 'ALREADY_RETAINED'
        : queue.some(p => equivalentIntersection(plan, p, selected.policy)) ? 'DUPLICATE_INTERSECTION_CLUSTER' : review(plan).reason;
      if (reason) { reject(reason); return false; }
      const touch = untouchedPxReview(plan, bars1h, bars15m, now);
      if (touch.reason) { reject(touch.reason); return false; }
      plan.pxTouchReview = touch.evidence;
      if (Object.hasOwn(retiredIds, plan.previousPolicyGeometryId)) plan.reassessedRetiredGeometryId = plan.previousPolicyGeometryId;
      return true;
    } });
  // A genuinely full valid queue defers discovery rather than marking the
  // symbol stale. Deferral is not a tombstone; it can be admitted next cycle.
  const deferred = discovered && queue.length >= MAX_RETAINED_PLANS_PER_SYMBOL ? discovered.id : null;
  if (discovered && !deferred) queue.push(advancePxFirstClose(discovered, bars15m, now, strategy.signal));
  return { queue: prioritizePlanQueue(queue), retired, deferred, diagnostics, revision: S1_CANDIDATE_REVIEW_REVISION };
}

// Write immutable evidence before removing anything from the active state.
// A crash before the state commit can retry this archive safely.
export async function archiveCandidateRetirements(root, records) {
  if (!records.length) return;
  const directory = path.join(root, 'archive', 'candidate-retirements');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const record of records) {
    invariant(typeof record.id === 'string' && record.plan?.id === record.id && record.revision === S1_CANDIDATE_REVIEW_REVISION, 'CANDIDATE_ARCHIVE_INVALID');
    const target = path.join(directory, `${digest(record.id)}.json`), payload = JSON.stringify(record);
    const envelope = JSON.stringify({ sha256: digest(payload), payload }) + '\n';
    // Publish a fully fsynced file with an exclusive link: a crash cannot leave
    // a partial receipt at the final path or overwrite an older receipt.
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(envelope); await handle.sync();
      await handle.close(); handle = null;
      await fs.link(temporary, target);
    }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const saved = JSON.parse(await fs.readFile(target, 'utf8'));
      invariant(saved.sha256 === digest(saved.payload), 'CANDIDATE_ARCHIVE_CORRUPT');
      const prior = JSON.parse(saved.payload);
      invariant(prior.id === record.id && prior.plan?.id === record.id && prior.revision === record.revision, 'CANDIDATE_ARCHIVE_CONFLICT');
    } finally { await handle?.close(); await fs.rm(temporary, { force: true }); }
  }
  const dir = await fs.open(directory, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
