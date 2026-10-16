import policy from './smc-s1-policy.json' with { type: 'json' };
import { netLiquidationR, stopForAggregateNetRFloor, updateHourlyStructureTrail } from '../agents/orion-v2/paper/paper-engine.mjs';
import { r21AtrTrail } from '../agents/shared/r21-profit-protection.mjs';
export const SMC_S1_TRAIL_REVISION = policy.trailRevision;
const check = (ok, code) => { if (!ok) throw new Error(code); };

// Stops only. Stage observations never assert that a partial exit occurred.
// The shared S1 structure/ATR functions receive an ephemeral eligibility view;
// their legacy partial flags are never persisted into this full-position policy.
export function smcS1TrailProposal({ plan, position, quote, bars, runtime, now }) {
  check(plan.smcTrailPolicy === SMC_S1_TRAIL_REVISION && position.accountingComplete === true
    && position.status === 'OPEN', 'SMC_S1_TRAIL_SCOPE');
  check(quote && [quote.marketTime,quote.receivedAt].every(t => Number.isFinite(t) && t <= now + 1000 && now - t <= 2000)
    && quote.persisted === true && quote.continuity === true, 'SMC_S1_TRAIL_QUOTE_STALE');
  check([quote.bid,quote.ask].every(v => Number.isFinite(Number(v)) && Number(v)>0)
    && Number(quote.ask)>=Number(quote.bid), 'SMC_S1_TRAIL_QUOTE_INVALID');
  const executable = Number(position.direction === 1 ? quote.bid : quote.ask);
  const netR = netLiquidationR(position, executable, runtime);
  check(Number.isFinite(netR), 'SMC_S1_TRAIL_NET_R_INVALID');
  const prior = position.smcS1Protection ?? { stage: 0, maximumNetR: 0 };
  const maximumNetR = Math.max(prior.maximumNetR, netR);
  const stage = Math.max(prior.stage, netR >= 2 ? 3 : netR >= 1 ? 2 : netR >= .5 ? 1 : 0);
  let proposed = { ...position, smcS1Protection: { revision: SMC_S1_TRAIL_REVISION, stage, maximumNetR },
    maximumNetExcursionR: Math.max(Number(position.maximumNetExcursionR ?? 0), maximumNetR) };
  const choose = candidate => { if (Number.isFinite(candidate) && candidate > 0)
    proposed.stop = position.direction === 1 ? Math.max(Number(proposed.stop),candidate) : Math.min(Number(proposed.stop),candidate); };
  choose(Number(position.desiredStop));
  if (stage) {
    // Solve against actual entire remaining quantity, actual booked PnL, fees
    // and funding. No hypothetical40/25/20% realization or paper capital.
    const funded = { ...position, cumulativeRealizedNetPnl: Number(position.cumulativeRealizedNetPnl)
      + Number(position.fundingNetUsdt ?? 0) };
    check(Number.isFinite(funded.cumulativeRealizedNetPnl), 'SMC_S1_TRAIL_ACCOUNTING_INCOMPLETE');
    choose(stopForAggregateNetRFloor(funded,runtime,stage===1 ? .15 : .6));
  }
  if (stage >= 3) {
    for (const [key,width] of [['bars1h',3600000],['bars15m',900000]]) {
      const rows = bars?.[key];
      check(Array.isArray(rows) && rows.length && rows.every((b,i) => b.closeTime < now
        && b.closeTime === b.openTime + width - 1 && (!i || b.openTime === rows[i-1].openTime + width))
        && now - rows.at(-1).closeTime <= width + 30000, 'SMC_S1_TRAIL_BARS_STALE_OR_GAPPED');
    }
    const view = { ...proposed, secondPartialTaken: true, runnerMaximumNetExcursionR: maximumNetR };
    const structural = updateHourlyStructureTrail(view,bars.bars1h,{pivots:{oneHour:policy.hourlyPivots}}).position;
    const trailed = r21AtrTrail(structural,bars.bars15m,policy.atrTrailPolicy).position;
    choose(Number(trailed.stop));
    for (const key of ['lastTrailingStructureConfirmedAt','trailingStructure','lastR21AtrTrailBarCloseTime','r21AtrTrail'])
      if (trailed[key] !== undefined) proposed[key] = trailed[key];
  }
  return { changed: Number(proposed.stop)!==Number(position.stop), stateChanged: JSON.stringify(prior)!==JSON.stringify(proposed.smcS1Protection),
    proposed, netR, action:'TIGHTEN_STOP_ONLY' };
}
