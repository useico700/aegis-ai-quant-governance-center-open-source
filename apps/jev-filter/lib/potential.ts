import type { Payload } from './payload';
import { mergeFeed, type LogRow } from './feed.ts';
import { entryBandPct } from './entry-band.ts';

export const POTENTIAL_POLICY = { snapshotAgeMs: 20 * 60_000, evaluationAgeMs: 30 * 60_000, minP1R: 45, minEV: 0.05, edgeP1R: 55, edgeEV: 0.22 } as const;
export type Potential = LogRow & { tier: 'EDGE' | 'LEAN'; conflict: boolean; note: string; reasons: string[]; risks: string[] };
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const fresh = (stamp: string | null | undefined, now: number, age: number) => {
  const delta = stamp ? now - Date.parse(stamp) : NaN;
  return Number.isFinite(delta) && delta >= -30_000 && delta <= age;
};
export function buildPotentialPool(accounts: Record<string, Payload>, now: number) {
  // Only current snapshots enter the pool. Historical logs are never a ranking input.
  const current = mergeFeed([], Object.values(accounts).filter(p => (p.account === 'S1' || p.account === 'S2') && p.mode === 'OBSERVE_ONLY' && p.orderAuthority === false));
  const eligibleSources = current.filter(r => fresh(r.accountAsOf, now, POTENTIAL_POLICY.snapshotAgeMs)
    && fresh(accounts[r.account]?.sourceAsOf, now, POTENTIAL_POLICY.snapshotAgeMs));
  const qualified: Potential[] = [];
  for (const row of eligibleSources) {
    const d = row.directional, m = row.metrics;
    if (row.status !== 'EVALUATED' || !['FOCUS','WATCH'].includes(row.label) || d?.status !== 'EVALUATED') continue;
    if (!fresh(row.evaluatedAt, now, POTENTIAL_POLICY.evaluationAgeMs) || !fresh(d.evaluatedAt, now, POTENTIAL_POLICY.evaluationAgeMs)
      || !fresh(row.sources.binanceAt, now, POTENTIAL_POLICY.snapshotAgeMs)) continue;
    if (![d.p1R,d.pStop,d.evR,d.confidence,m.pxDistancePct].every(finite)) continue;
    if (d.p1R! < POTENTIAL_POLICY.minP1R || d.evR! < POTENTIAL_POLICY.minEV || d.p1R! <= d.pStop!) continue;
    const tier = d.p1R! >= POTENTIAL_POLICY.edgeP1R && d.evR! >= POTENTIAL_POLICY.edgeEV ? 'EDGE' : 'LEAN';
    const conflict = eligibleSources.some(other => other.symbol === row.symbol && other.direction !== row.direction);
    const reasons = [`方向估计领先止损 ${(d.p1R! - d.pStop!).toFixed(1)} 个百分点`, '模型 EV 为正'];
    const risks: string[] = [];
    if (finite(m.ema20SlopePct)) {
      const aligned = row.direction === 'LONG' ? m.ema20SlopePct > 0 : m.ema20SlopePct < 0;
      if (aligned) reasons.push('1H EMA 斜率同向'); else risks.push('1H EMA 未同向');
    }
    if (finite(m.volumeRatio) && m.volumeRatio >= 1) reasons.push(`量比 ${m.volumeRatio.toFixed(2)}`);
    if (finite(m.fundingPct) && (row.direction === 'LONG' ? m.fundingPct > 0 : m.fundingPct < 0)) risks.push('当前资金费方向为支付侧');
    if (!fresh(row.sources.coingeckoAt, now, 24 * 60 * 60_000) || !finite(m.marketCapUsd)) risks.push('基本面数据缺失或过时');
    if (conflict) risks.push('当前同币候选方向分歧');
    const band = entryBandPct(row.account);
    const note = conflict ? '先复核方向分歧' : row.stage === 'UPCOMING' ? '等待交汇' : m.pxDistancePct! <= 0 ? '等待回到 Px 同侧' : m.pxDistancePct! > band ? '等待靠近 Px' : '优先复核入场条件';
    if (m.pxDistancePct! > band) risks.push(`已在 Px ${band}% 区外`);
    if (m.pxDistancePct! <= 0) risks.push('未在 Px 方向同侧');
    qualified.push({ ...row, tier, conflict, note, reasons, risks });
  }
  qualified.sort((a,b) => (a.tier === b.tier ? 0 : a.tier === 'EDGE' ? -1 : 1) || b.directional!.evR! - a.directional!.evR! || b.directional!.p1R! - a.directional!.p1R! || a.key.localeCompare(b.key));
  const seen = new Set<string>();
  const rows = qualified.filter(r => { const key = `${r.account}:${r.symbol}`; if (seen.has(key)) return false; seen.add(key); return true; });
  return { rows, currentCount: current.length, freshCount: eligibleSources.length };
}
