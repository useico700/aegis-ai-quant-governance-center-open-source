import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const assert = (condition, reason) => { if (!condition) throw new Error(reason); };
const kinds = ['source', 'continuation'];
export const S2_Z_STATE_MAX_BYTES = 64 * 1024 ** 2;
export const S2_Z_STATE_WRITE_BUDGET_BYTES = 60 * 1024 ** 2;
export const S2_Z_PLAN_MAX_RESERVED_BYTES = 8 * 1024 ** 2;
export const S2_Z_PROOF_TUPLE_MAX_BYTES = 256;
const PLAN_METADATA_RESERVE = 16 * 1024, STATE_METADATA_RESERVE = 1024 ** 2;
const bytes = value => Buffer.byteLength(JSON.stringify(value));

// The scanner is the sole state writer. References deduplicate native evidence
// on disk only; consumers restore actual bars before any structure validation.
function mapPlans(state, transform) {
  const output = { ...state };
  for (const field of ['planQueues', 'pendingZDiscoveries']) {
    if (state[field] == null) continue;
    assert(typeof state[field] === 'object' && !Array.isArray(state[field]), 'S2_Z_STATE_QUEUES_INVALID');
    output[field] = Object.fromEntries(Object.entries(state[field]).map(([symbol, plans]) => {
      assert(Array.isArray(plans) && plans.length <= 20, 'S2_Z_STATE_QUEUE_CAPACITY');
      return [symbol, plans.map(transform)];
    }));
  }
  if (state.plans != null) {
    assert(typeof state.plans === 'object' && !Array.isArray(state.plans), 'S2_Z_STATE_PLANS_INVALID');
    output.plans = Object.fromEntries(Object.entries(state.plans).map(([symbol, plan]) => [symbol, transform(plan)]));
  }
  return output;
}

export function hydrateS2ZState(state) {
  assert(state && typeof state === 'object' && !Array.isArray(state), 'S2_Z_STATE_INVALID');
  assert(state.zStateCodecVersion == null || state.zStateCodecVersion === 1, 'S2_Z_STATE_CODEC_VERSION');
  const bundles = state.zSources ?? {};
  assert(bundles && typeof bundles === 'object' && !Array.isArray(bundles)
    && Object.keys(bundles).length <= 820, 'S2_Z_STATE_BUNDLE_CAPACITY');
  const verified = new Map();
  const output = mapPlans(state, plan => {
    if (!plan?.zStructure) return plan;
    const zStructure = { ...plan.zStructure };
    for (const kind of kinds) {
      const ref = zStructure[`${kind}Ref`];
      if (ref == null) continue;
      assert(state.zStateCodecVersion === 1 && zStructure[kind] == null
        && typeof ref === 'string' && new RegExp(`^${kind}:[a-f0-9]{64}$`).test(ref), 'S2_Z_STATE_REFERENCE_INVALID');
      if (!verified.has(ref)) {
        assert(Object.hasOwn(bundles, ref) && bundles[ref] && typeof bundles[ref] === 'object', 'S2_Z_STATE_PROOF_MISSING');
        assert(ref === `${kind}:${digest(bundles[ref])}`, 'S2_Z_STATE_PROOF_HASH_MISMATCH');
        verified.set(ref, bundles[ref]);
      }
      zStructure[kind] = verified.get(ref);
      delete zStructure[`${kind}Ref`];
    }
    return { ...plan, zStructure };
  });
  delete output.zSources;
  delete output.zStateCodecVersion;
  return output;
}

export function packS2ZState(state) {
  const full = hydrateS2ZState(state), zSources = Object.create(null);
  const output = mapPlans(full, plan => {
    if (!plan?.zStructure) return plan;
    const zStructure = { ...plan.zStructure };
    for (const kind of kinds) {
      assert(zStructure[kind] && typeof zStructure[kind] === 'object', 'S2_Z_STATE_NATIVE_PROOF_REQUIRED');
      const ref = `${kind}:${digest(zStructure[kind])}`;
      zSources[ref] = zStructure[kind];
      zStructure[`${kind}Ref`] = ref;
      delete zStructure[kind];
    }
    return { ...plan, zStructure };
  });
  assert(Object.keys(zSources).length <= 820, 'S2_Z_STATE_BUNDLE_CAPACITY');
  return { ...output, zStateCodecVersion: 1, zSources };
}

function uniquePlans(state) {
  const plans = new Map();
  for (const group of ['planQueues', 'pendingZDiscoveries']) for (const queue of Object.values(state[group] ?? {}))
    for (const plan of queue) if (plan.zStructure) plans.set(plan.id, plan);
  for (const plan of Object.values(state.plans ?? {})) if (plan?.zStructure && !plans.has(plan.id)) plans.set(plan.id, plan);
  return [...plans.values()];
}

export function estimateS2ZStateCapacity(state) {
  const full = hydrateS2ZState(state), reservations = [];
  for (const plan of uniquePlans(full)) {
    let remainingTuples = 0;
    assert(Number.isFinite(plan.intersectionTime) && plan.intersectionTime > 0, 'S2_Z_CAPACITY_INTERSECTION_INVALID');
    for (const [field, interval] of [['bars15m', 900000], ['bars1h', 3600000]]) {
      const source = plan.zStructure.source?.[field], continuation = plan.zStructure.continuation?.[field];
      assert(Array.isArray(source) && source.length && Array.isArray(continuation), 'S2_Z_CAPACITY_SOURCE_INVALID');
      for (const row of [...source, ...continuation]) assert(Array.isArray(row) && row.length === 5 &&
        row.every(v => typeof v === 'number' && Number.isFinite(v)) && bytes(row) + 1 <= S2_Z_PROOF_TUPLE_MAX_BYTES, 'S2_Z_CAPACITY_TUPLE_INVALID');
      const lastOpen = Math.max(source.at(-1)[0], continuation.at(-1)?.[0] ?? -1);
      const requiredLastOpen = (Math.ceil((plan.intersectionTime + 1) / interval) - 2) * interval;
      const missing = Math.max(0, (requiredLastOpen - lastOpen) / interval);
      assert(Number.isSafeInteger(missing), 'S2_Z_CAPACITY_FUTURE_INVALID');
      remainingTuples += missing;
    }
    const continuationReserveBytes = remainingTuples * S2_Z_PROOF_TUPLE_MAX_BYTES;
    assert(Number.isSafeInteger(continuationReserveBytes), 'S2_Z_CAPACITY_FUTURE_INVALID');
    reservations.push({ id: plan.id, symbol: plan.symbol, remainingTuples, continuationReserveBytes,
      metadataReserveBytes: PLAN_METADATA_RESERVE, reservedPlanBytes: bytes(plan) + continuationReserveBytes + PLAN_METADATA_RESERVE });
  }
  const packedBytes = bytes(packS2ZState(full));
  const futureAndMetadataBytes = reservations.reduce((sum, p) => sum + p.continuationReserveBytes + p.metadataReserveBytes, STATE_METADATA_RESERVE);
  return { packedBytes, reservedBytes: packedBytes + futureAndMetadataBytes, metadataReserveBytes: STATE_METADATA_RESERVE,
    maximumWriteBudgetBytes: S2_Z_STATE_WRITE_BUDGET_BYTES, maximumReadBytes: S2_Z_STATE_MAX_BYTES, reservations };
}

// This is a storage admission decision, never a market/strategy rejection.
// Existing complete proof cannot be evicted to make space for a newer Z.
export function reserveS2ZStateCapacity(state, previousState, { now = Date.now() } = {}) {
  const output = hydrateS2ZState(state), previous = hydrateS2ZState(previousState);
  output.zCapacity = { ...output.zCapacity };
  const previousIds = new Set(uniquePlans(previous).map(p => p.id)), archive = [];
  const candidates = uniquePlans(output).filter(p => !previousIds.has(p.id)).sort((a, b) =>
    Number(b.zStructure.z?.points?.D?.time ?? 0) - Number(a.zStructure.z?.points?.D?.time ?? 0) ||
    a.intersectionTime - b.intersectionTime || a.id.localeCompare(b.id));
  const remove = plan => {
    for (const group of ['planQueues', 'pendingZDiscoveries']) output[group] = Object.fromEntries(Object.entries(output[group] ?? {})
      .map(([symbol, queue]) => [symbol, queue.filter(p => p.id !== plan.id)]));
    output.plans = { ...output.plans };
    if (output.plans[plan.symbol]?.id === plan.id) {
      if (output.planQueues[plan.symbol]?.length) output.plans[plan.symbol] = output.planQueues[plan.symbol][0];
      else delete output.plans[plan.symbol];
    }
    archive.push({ eventId: `${plan.id}:S2_Z_STORAGE_WAIT:${plan.zStructure.geometryHash}`, reason: 'S2_Z_STORAGE_WAIT', archivedAt: now,
      plan: { id: plan.id, symbol: plan.symbol, structureRevision: plan.structureRevision, createdAt: plan.createdAt,
        intersectionTime: plan.intersectionTime, intersectionPrice: plan.intersectionPrice, geometryHash: plan.zStructure.geometryHash,
        evidenceHash: plan.zStructure.evidenceHash, anchors: plan.anchors, zPoints: plan.zStructure.z?.points,
        executionEligible: false, terminal: false } });
  };
  let estimate = estimateS2ZStateCapacity(output);
  for (const row of estimate.reservations.filter(row => row.reservedPlanBytes > S2_Z_PLAN_MAX_RESERVED_BYTES)) {
    assert(!previousIds.has(row.id), 'S2_Z_EXISTING_STORAGE_RESERVATION_INVALID');
    const index = candidates.findIndex(p => p.id === row.id); if (index >= 0) remove(candidates.splice(index, 1)[0]);
  }
  if (archive.length) estimate = estimateS2ZStateCapacity(output);
  // Re-encode in bounded batches, not once per removed candidate. Conservatively
  // subtract only guaranteed future/metadata savings until the next measurement.
  let estimatedBytes = estimate.reservedBytes, removedSinceMeasure = 0;
  const byId = new Map(estimate.reservations.map(row => [row.id, row]));
  while (estimatedBytes > S2_Z_STATE_WRITE_BUDGET_BYTES && candidates.length) {
    const plan = candidates.pop(), row = byId.get(plan.id); remove(plan);
    estimatedBytes -= row.continuationReserveBytes + row.metadataReserveBytes;
    removedSinceMeasure++;
    if (removedSinceMeasure >= 16 || estimatedBytes <= S2_Z_STATE_WRITE_BUDGET_BYTES || !candidates.length) {
      estimate = estimateS2ZStateCapacity(output); estimatedBytes = estimate.reservedBytes; removedSinceMeasure = 0;
    }
  }
  estimate = estimateS2ZStateCapacity(output);
  assert(estimate.reservedBytes <= S2_Z_STATE_WRITE_BUDGET_BYTES && estimate.packedBytes < S2_Z_STATE_MAX_BYTES,
    'S2_Z_EXISTING_STORAGE_CAPACITY_WAIT');
  output.zStorageCapacity = { checkedAt: now, packedBytes: estimate.packedBytes, reservedBytes: estimate.reservedBytes,
    maximumWriteBudgetBytes: S2_Z_STATE_WRITE_BUDGET_BYTES, maximumReadBytes: S2_Z_STATE_MAX_BYTES, waitingThisScan: archive.length };
  for (const symbol of Object.keys(output.zCapacity ?? {})) output.zCapacity[symbol] = { ...output.zCapacity[symbol],
    active: output.planQueues?.[symbol]?.length ?? 0, pending: output.pendingZDiscoveries?.[symbol]?.length ?? 0,
    storageWait: archive.filter(r => r.plan.symbol === symbol).length };
  return { state: output, archive, estimate };
}

export function structureArchiveBatches(records) {
  const batches = []; let batch = [], total = 0;
  for (const record of records) {
    const size = bytes(record) + 1;
    assert(size <= S2_Z_PLAN_MAX_RESERVED_BYTES, 'S2_Z_ARCHIVE_RECORD_CAPACITY');
    if (batch.length && total + size > S2_Z_PLAN_MAX_RESERVED_BYTES) { batches.push(batch); batch = []; total = 0; }
    batch.push(record); total += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
