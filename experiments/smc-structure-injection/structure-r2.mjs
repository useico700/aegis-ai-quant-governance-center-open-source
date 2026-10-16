// R1 remains frozen. R2 reuses its causal swing points and repairs episode semantics.
import { detectMainStructure, sequenceContext, parameters } from './structure.mjs';
import { scanSmcSymbol } from '../../lib/smc-scanner.mjs';

export const revision = 'SMC-MAIN-SEQUENCE-R2';
export const episodePolicy = Object.freeze({
  establishment: 'CONFIRMED_SEQUENCE_AND_FRESH_CLOSE_BREAK',
  recovery: 'TWO_NEW_HIGHS_TWO_NEW_LOWS_AFTER_TRANSITION_AND_FRESH_BREAK',
  protection: 'CONFIRMED_OPPOSITE_EXTREME_AFTER_BROKEN_ENDPOINT',
  migration: 'SAME_DIRECTION_BOS_ONLY_NO_LOOSENING_NO_RETIRED_ENDPOINT',
  deduplication: 'ONE_FIRST_BREAK_PER_ENDPOINT_DIRECTION',
});

function priorAtr(bars, index) {
  let sum = 0;
  for (let i = index - 14; i < index; i++) sum += Math.max(bars[i].high - bars[i].low,
    Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  return sum / 14;
}

// Explicit points are accepted for reproducible state-machine fixtures. Production research
// calls detectMainStructureR2, which validates bars and derives these points causally.
export function replayMainEpisodes(bars, points, tick, options = {}) {
  const p = { ...parameters, ...options };
  const events = [], snapshots = [], migrations = [], consumed = new Set(), retired = new Set();
  let bias = 'UNKNOWN', protectedPoint = null, episodeId = null, transitionStartedAt = null;
  for (let i = Math.max(15, p.warmup); i < bars.length; i++) {
    const bar = bars[i], previous = bars[i - 1];
    const known = points.filter(point => point.confirmedAt < bar.openTime);
    const sequence = sequenceContext(known, tick);
    const buffer = Math.max(p.breakTicks * tick, p.breakBufferAtr * priorAtr(bars, i));
    const priorBias = bias, priorProtection = protectedPoint?.id ?? null;
    const crossed = (point, direction) => direction === 'LONG'
      ? bar.close > point.price + buffer && previous.close <= point.price + buffer
      : bar.close < point.price - buffer && previous.close >= point.price - buffer;
    let triggerId = null;
    const protectionBroken = protectedPoint && (bias === 'BULLISH'
      ? bar.close < protectedPoint.price - buffer : bias === 'BEARISH' && bar.close > protectedPoint.price + buffer);
    if (protectionBroken) {
      const direction = bias === 'BULLISH' ? 'SHORT' : 'LONG';
      const key = `${protectedPoint.id}:${direction}`;
      if (retired.has(protectedPoint.id) || consumed.has(key)) throw new Error('PROTECTION_REUSED_AFTER_BREAK');
      triggerId = `${revision}:CHOCH:${bar.closeTime}:${direction}`;
      events.push({ id: triggerId, eventType: 'MAIN_CHOCH', direction, index: i, at: bar.closeTime,
        level: protectedPoint.price, endpointId: protectedPoint.id, priorBias, episodeId });
      consumed.add(key); retired.add(protectedPoint.id);
      transitionStartedAt = bar.closeTime; bias = 'TRANSITION'; protectedPoint = null;
    } else {
      for (const direction of ['LONG', 'SHORT']) {
        const long = direction === 'LONG', targetBias = long ? 'BULLISH' : 'BEARISH';
        const point = known.filter(point => point.kind === (long ? 'HIGH' : 'LOW')).at(-1);
        if (!point || consumed.has(`${point.id}:${direction}`) || !crossed(point, direction)) continue;
        consumed.add(`${point.id}:${direction}`);
        const currentTrend = ['BULLISH', 'BEARISH'].includes(bias);
        const recoveryPoints = transitionStartedAt === null ? known : known.filter(point =>
          point.time > transitionStartedAt && point.confirmedAt > transitionStartedAt);
        const recoverySequence = sequenceContext(recoveryPoints, tick);
        const mayEstablish = !currentTrend && recoverySequence.bias === targetBias;
        // Protection refers to the pullback between the broken external endpoint and BOS.
        const possible = known.filter(candidate => candidate.kind === (long ? 'LOW' : 'HIGH')
          && candidate.time > point.time && !retired.has(candidate.id)
          && !consumed.has(`${candidate.id}:${long ? 'SHORT' : 'LONG'}`)
          && (long ? candidate.price < bar.close - buffer : candidate.price > bar.close + buffer));
        const selected = possible.reduce((best, candidate) => !best || (long
          ? candidate.price < best.price : candidate.price > best.price) ? candidate : best, null);
        const mayMigrate = bias === targetBias && selected && (!protectedPoint || (long
          ? selected.price >= protectedPoint.price : selected.price <= protectedPoint.price));
        const eventType = mayEstablish && selected ? 'MAIN_TREND_CONFIRMED'
          : bias === targetBias ? 'MAIN_BOS' : currentTrend ? 'INTERNAL_BREAK' : 'UNCONFIRMED_BREAK';
        const eventId = `${revision}:${eventType}:${bar.closeTime}:${direction}`;
        const oldEpisodeId = episodeId;
        if (mayEstablish && selected) {
          episodeId = `${revision}:EPISODE:${bar.closeTime}:${direction}`;
          bias = targetBias; protectedPoint = selected;
        } else if (mayMigrate) protectedPoint = selected;
        events.push({ id: eventId, eventType, direction, index: i, at: bar.closeTime,
          level: point.price, endpointId: point.id, priorBias, episodeId,
          priorEpisodeId: oldEpisodeId, protectedPointId: protectedPoint?.id ?? null,
          recoveryEndpointIds: mayEstablish ? recoverySequence.endpointIds : [] });
        if ((protectedPoint?.id ?? null) !== priorProtection || bias !== priorBias) triggerId = eventId;
      }
    }
    if (bias !== priorBias || (protectedPoint?.id ?? null) !== priorProtection) {
      migrations.push({ at: bar.closeTime, priorBias, newBias: bias, priorProtectedPointId: priorProtection,
        newProtectedPointId: protectedPoint?.id ?? null, protectedPivotAvailableAt: protectedPoint?.confirmedAt ?? null,
        promotedByBosId: bias === 'TRANSITION' ? null : triggerId, triggerId, episodeId,
        transitionStartedAt, promotionEffectiveAt: bar.closeTime });
    }
    snapshots.push({ at: bar.closeTime, bias, parentBias: bias, localLegBias: sequence.bias,
      protectedPointId: protectedPoint?.id ?? null, episodeId, transitionStartedAt, pointCount: known.length });
  }
  return { events, snapshots, migrations, retiredEndpointIds: [...retired] };
}

export function detectMainStructureR2(bars, tick, options = {}) {
  const raw = detectMainStructure(bars, tick, options);
  return { revision, swingRevision: raw.revision, parameters: raw.parameters, episodePolicy,
    points: raw.points, sequence: raw.sequence, ...replayMainEpisodes(bars, raw.points, tick, options),
    orderAuthority: false };
}

export function scanWithStructureExperienceR2(input) {
  const scan = scanSmcSymbol(input);
  const bars = input.bars4h.filter(row => Number(row[6]) < input.now).map(row => ({
    openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), volume: Number(row[5]), closeTime: Number(row[6]) }));
  const main = detectMainStructureR2(bars, Number(input.tickSize));
  const annotate = row => {
    const at = row.structure?.bosAt ?? row.breakAt, openAt = at - 14400000 + 1;
    const state = main.snapshots.filter(state => state.at < openAt).at(-1);
    const event = main.events.find(event => event.at === at && event.direction === row.direction);
    return { ...row, researchStructure: { revision, parentTimeframe: '4H',
      parentBias: state?.parentBias ?? 'UNKNOWN', localLegBias: state?.localLegBias ?? 'UNKNOWN',
      structureTriggerDirection: row.direction, structureTriggerTimeframe: '4H',
      entryConfirmationState: row.entryConfirmation?.state ?? null,
      episodeId: state?.episodeId ?? null, protectedPointId: state?.protectedPointId ?? null,
      classification: event?.eventType ?? 'INTERNAL_OR_UNCONFIRMED',
      admissionChanged: false, calibratedWinProbability: null } };
  };
  return { ...scan, candidates: scan.candidates.map(annotate), structures: scan.structures.map(annotate),
    researchMainStructure: main, researchOnly: true, orderAuthority: false };
}
