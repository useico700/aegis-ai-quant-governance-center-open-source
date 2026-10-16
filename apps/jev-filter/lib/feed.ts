import type { Payload, Observation } from './payload';
export type LogRow = Observation & { account: 'S1' | 'S2'; accountAsOf: string; key: string };
export function cursorFor(value: { account: string; asOf: string }) { return `${value.asOf}|${value.account}`; }
export function parseCursor(value: string | null) {
  if (!value) return null;
  const [asOf, account, extra] = value.split('|');
  if (extra !== undefined || !['S1', 'S2'].includes(account) || !Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf) throw new Error('INVALID_CURSOR');
  return { asOf, account };
}
export function mergeFeed(previous: LogRow[], batches: Payload[]): LogRow[] {
  const rows = new Map(previous.map(row => [row.key, row]));
  for (const batch of batches) for (const row of batch.observations) {
    const key = `${batch.account}|${batch.asOf}|${row.id}`;
    rows.set(key, { ...row, account: batch.account, accountAsOf: batch.asOf, key });
  }
  return [...rows.values()].sort((a, b) => b.accountAsOf.localeCompare(a.accountAsOf) || a.account.localeCompare(b.account) || a.id.localeCompare(b.id));
}
export function filterFeed(rows: LogRow[], account: string, direction: string, verdict: string, query: string) {
  const term = query.trim().toUpperCase();
  return rows.filter(row => (account === 'ALL' || row.account === account) && (direction === 'ALL' || row.direction === direction)
    && (verdict === 'ALL' || (verdict.startsWith('JUDGE_') ? row.judge?.verdict === verdict.slice(6) : verdict === 'UNAVAILABLE' ? row.status !== 'EVALUATED' || !row.directional || row.directional.status !== 'EVALUATED' : row.directional?.label === verdict))
    && (!term || row.symbol.includes(term) || row.id.toUpperCase().includes(term)));
}
