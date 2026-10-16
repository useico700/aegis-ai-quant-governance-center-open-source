export function usesS1Structure(accountLabel, execution) {
  const r = execution?.strategyRuntime;
  return accountLabel === 'S1' || accountLabel === 'S2' && r?.displayName === 'R22 · S2 live risk' && r?.executionRevision === 'MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION' && r?.entryQualityPolicyRevision === 'S1-R22-ROLLBACK-20261010';
}

export function applyV2FinalCandidateWindows(candidates, execution, now, accountLabel) {
  if(!usesS1Structure(accountLabel, execution) || !['S1-IQ1-P1-PAPER-FINAL-20261010','S1-R22-ROLLBACK-20261010'].includes(execution?.strategyRuntime?.entryQualityPolicyRevision))return candidates;
  return candidates.map(row=>{
    const cross=Date.parse(row.intersectionTime??''), close=Date.parse(row.directionClosedAt??'');
    if(Number.isFinite(cross) && now-cross>1800000)return {...row,status:'EXPIRED',reason:'V2_CROSS_WINDOW_EXPIRED'};
    if(row.status==='FIRST_CLOSE_LOCKED'){
      if(!Number.isFinite(close))return {...row,status:'NON_CAUSAL_OBSERVATION',reason:'V2_CONFIRMATION_TIME_UNVERIFIED'};
      if(now-close>180000)return {...row,status:'CONFIRMED_EXPIRED',reason:'V2_CONFIRMATION_WINDOW_EXPIRED'};
    }
    return row;
  });
}

const terminalStatuses = new Set([
  "EXPIRED",
  "CONFIRMED_EXPIRED",
  "NON_CAUSAL_OBSERVATION",
  "INVALIDATED",
]);

export function candidateInputState(execution, executionFresh, now) {
  const source = execution?.candidateSource;
  const age = now - source?.checkedAt;
  if (!executionFresh || !source || !Number.isFinite(age) || age < -30000 || age > 180000) return 'UNKNOWN';
  if (source.state === 'READY' && (!Number.isFinite(source.observedAt) || now - source.observedAt < -30000 || now - source.observedAt > 180000)) return 'UNKNOWN';
  return source.state === 'UNAVAILABLE' ? 'UNAVAILABLE' : source.state === 'READY' ? 'READY' : 'UNKNOWN';
}

// Browser-only presentation memory; never written to monitor or execution APIs.
export function candidateDisplayView({ snapshot, reference, accountLabel, execution, executionFresh, now, monitorError = false }) {
  const age = now - Date.parse(snapshot?.sourceAsOf ?? '');
  const monitorHealthy = !monitorError && snapshot?.status === 'HEALTHY' && Number.isFinite(age) && age >= -30000 && age <= 180000;
  const inputState = monitorHealthy ? candidateInputState(execution, executionFresh, now) : 'UNAVAILABLE';
  const current = applyV2FinalCandidateWindows(Array.isArray(snapshot?.candidates) ? snapshot.candidates : [],execution,now,accountLabel);
  const known = reference?.accountLabel === accountLabel ? reference : null;
  if (inputState === 'READY') {
    return { inputState, candidates: current, partialScan: false,
      reference: known?.sourceAsOf === snapshot.sourceAsOf ? known : { accountLabel, sourceAsOf: snapshot.sourceAsOf,
        candidates: current.filter(row => row.status === 'FIRST_CLOSE_LOCKED').map(row => ({ ...row })) } };
  }
  const rows = new Map((known?.candidates ?? []).map(row => [row.id, row]));
  // Explicit new terminal states win; missing rows are not proof of invalidation.
  for (const row of current) rows.set(row.id, row);
  const terminated = new Set(current.filter(row => terminalStatuses.has(row.status)).map(row => row.id));
  const retained = known?.candidates.filter(row => !terminated.has(row.id));
  const nextReference = known && retained.length !== known.candidates.length ? { ...known, candidates: retained } : known;
  return { inputState, candidates: applyV2FinalCandidateWindows([...rows.values()],execution,now,accountLabel), partialScan: !monitorHealthy, reference: nextReference };
}

export function partitionCandidateFunnel(candidates, now, snapshotStale = false) {
  const result = { locked: [], arrived: [], upcoming: [], inactive: [], unknown: [] };
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (snapshotStale || candidate?.stale || terminalStatuses.has(candidate?.status)) {
      result.inactive.push(candidate);
      continue;
    }
    if (candidate?.status === "FIRST_CLOSE_LOCKED") {
      result.locked.push(candidate);
      continue;
    }
    const intersectionAt = Date.parse(candidate?.intersectionTime);
    if (!Number.isFinite(intersectionAt) || !Number.isFinite(now) || now <= 0) {
      result.unknown.push(candidate);
      continue;
    }
    (intersectionAt <= now ? result.arrived : result.upcoming).push(candidate);
  }
  return result;
}

export function groupCandidateStructures(candidates, stage) {
  const groups = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const key = `${stage}:${candidate?.symbol ?? "UNKNOWN"}:${stage === "locked" ? "PRIORITY" : candidate?.direction ?? "PENDING"}`;
    const existing = groups.get(key);
    if (existing) existing.plans.push(candidate);
    else groups.set(key, {
      key,
      stage,
      symbol: candidate?.symbol ?? "UNKNOWN",
      direction: candidate?.direction ?? null,
      plans: [candidate],
    });
  }
  return [...groups.values()];
}
