import { entryBandFraction } from './entry-band.mjs';
import { evaluateEntryConfirmation } from '../../agents/shared/entry-confirmation.mjs';
import { entryWaitText, entryQualitySummary } from './entry-quality.mjs';
import { usesS2Z, checkS2Z, compactZStructure, structureWaitText, S2_Z_DECISION_REVISION } from './structure-quality.mjs';
import { sha } from './filter-core.mjs';

export const DECISION_REVISION = 'JEV-P5-PLAN-DECISION-3';
export const S1_IQ1_DECISION_REVISION = 'JEV-R221-IQ1-PRE-GATE-DECISION-1';
export const DECISION_THRESHOLD = 0.6;
const FEE = 0.0005;
const SLIPPAGE = 0.0005;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const unavailable = (reason, target = null) => ({revision:DECISION_REVISION,status:'WAITING',verdict:'WAIT',score:null,
  evaluatedAt:null,model:null,inputHash:null,reason,target});

// The question is about the current P5 plan, not a generic ATR move. Market
// facts and the signal gate stay in code; Jev receives only an eligible plan.
export function strategyOpportunity(account, candidate, plan, quote, policy, now, oneHourBars = null, confirmationEvidence = null) {
  const zPolicy=usesS2Z(account,policy),s1Iq1=account==='S1'&&policy?.entryQualityPolicy?.revision==='V2-IQ1-P1-20260915';
  const revision=zPolicy?S2_Z_DECISION_REVISION:s1Iq1?S1_IQ1_DECISION_REVISION:DECISION_REVISION;
  let structure=null;
  const waiting=(reason,target=null)=>({...unavailable(reason,target),revision,...(structure?{structure}: {})});
  if(!['S1','S2'].includes(account)||!candidate||!plan||candidate.id!==plan.id||candidate.symbol!==plan.symbol)
    return waiting('原策略计划暂不可用');
  if(policy?.strategy?.structureRevision&&!zPolicy)return waiting('策略结构版本待核对');
  if(zPolicy){
    if(candidate.px!==plan.intersectionPrice)return waiting('计划交点证据不一致');
    const checked=checkS2Z(plan,now,confirmationEvidence?.bars15m,oneHourBars);structure=checked.summary;
    if(!checked.allowed)return waiting(structureWaitText(checked.reason));
  }
  if(candidate.stage!=='LOCKED'||(!zPolicy&&plan.fourHourLineStatus!=='ACTIVE_4H_TREND'))return waiting('等待原策略信号');
  const opportunity=plan.pxEntryState?.opportunity;
  if(!opportunity||(!s1Iq1&&plan.pxEntryState.revision!==policy?.strategy?.signal?.entryAdmissionRevision)
    ||plan.pxEntryState.invalidatedAt!==null||opportunity.direction!==candidate.direction
    ||!finite(opportunity.closedAt)||opportunity.closedAt>=now||!finite(plan.createdAt)||plan.createdAt>opportunity.closedAt)
    return waiting('等待原策略信号');
  const bid=Number(quote?.bid),ask=Number(quote?.ask),d=candidate.direction==='LONG'?1:-1;
  const quoteAt=Date.parse(quote?.asOf);
  if(!(bid>0&&ask>=bid&&finite(quoteAt)&&quoteAt<=now&&now-quoteAt<=60_000))return waiting('盘口证据暂缺');
  const rawEntry=d===1?ask:bid;
  const px=Number(candidate.px),distance=d*(rawEntry/px-1);
  if(!(px>0&&distance>0&&((s1Iq1&&finite(Number(opportunity.bar?.close))
    &&Math.abs(rawEntry/Number(opportunity.bar.close)-1)*10000<=Number(policy.entryQualityPolicy.maximumDecisionCloseDisplacementBps))
    ||(!s1Iq1&&distance<=entryBandFraction(account)+1e-12))))
    return waiting(s1Iq1?'等待回到确认收盘 50bp 执行区':`等待同侧 Px ${account==='S1'?2:3}% 区`);
  const buffer=Number(policy?.strategy?.signal?.crossCloseBufferBps);
  if(policy?.strategy?.implementationRevision!=='MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION'||!finite(buffer)||buffer<0||buffer>100)
    return waiting('策略版本或止损规则待核对');
  const stop=px*(1-d*buffer/10_000),entry=rawEntry*(1+d*SLIPPAGE),stopExit=stop*(1-d*SLIPPAGE);
  const initialRiskPerUnit=d*(entry-stopExit)+entry*FEE+stopExit*FEE;
  if(!(d*(entry-stop)>0&&initialRiskPerUnit>0))return waiting('初始止损无效');
  const targetExit=(initialRiskPerUnit+entry*(d+FEE))/(d-FEE);
  const targetPrice=targetExit/(1-d*SLIPPAGE);
  if(!(targetPrice>0&&d*(targetPrice-rawEntry)>0))return waiting('净 1R 目标无效');
  let confirmation=null;
  if(policy.entryConfirmationPolicy) {
    confirmation=evaluateEntryConfirmation({policy:policy.entryConfirmationPolicy,now,direction:d,signalClosedAt:opportunity.closedAt,
      entryBars:confirmationEvidence?.entryBars,bars1h:oneHourBars,quote,entryPrice:rawEntry,modeledEntry:entry,stopPrice:stop,
      initialRiskPerUnit,takerFeeRate:FEE,adverseSlippageRate:SLIPPAGE,tickSize:confirmationEvidence?.tickSize,
      lastLossExit:confirmationEvidence?.lastLossExit});
    confirmation={...confirmation,lossContextObservedAt:confirmationEvidence?.lossContextObservedAt??null};
    if(!confirmation.allowed)return {...waiting(entryWaitText(confirmation.reason)),entryConfirmation:confirmation,
      entryQuality:entryQualitySummary(confirmation,policy.managementPolicy?.revision)};
  }
  const horizonMinutes=account==='S1'?180:60;
  const closedHours=Array.isArray(oneHourBars) ? oneHourBars.filter(bar=>Number.isFinite(bar?.closeTime)
    && bar.closeTime<quoteAt && Number.isFinite(bar?.high) && Number.isFinite(bar?.low)).slice(-12) : [];
  const oneHourExtremePrice=closedHours.length===12
    ? d===1?Math.max(...closedHours.map(bar=>bar.high)):Math.min(...closedHours.map(bar=>bar.low)) : null;
  const oneHourRoomR=oneHourExtremePrice===null?null:Number((d*(oneHourExtremePrice-rawEntry)/initialRiskPerUnit).toFixed(4));
  return {revision,...(structure?{structure,structureContext:compactZStructure(plan)}:{}),status:'READY',verdict:'WAIT',score:null,evaluatedAt:null,model:null,inputHash:null,
    reason:'等待 JEV 判定',entryConfirmation:confirmation,entryQuality:entryQualitySummary(confirmation,policy.managementPolicy?.revision),target:{referencePrice:rawEntry,entryPrice:entry,initialStop:stop,netOneRPrice:targetPrice,
      favorablePrice:targetPrice,adversePrice:stop,initialRiskPerUnit,entryInterval:account==='S1'?'15m':'5m',
      horizonMinutes,observedAt:quote.asOf,deadlineAt:new Date(quoteAt+horizonMinutes*60_000).toISOString(),
      strategyRevision:policy.strategy.implementationRevision,planId:plan.id,signalClosedAt:opportunity.closedAt,
      ...(s1Iq1?{entryQualityRevision:policy.entryQualityPolicy.revision,executionRevision:policy.entryQualityPolicy.executionRevision}:{}),
      oneHourLookbackBars:oneHourExtremePrice===null?null:12,oneHourExtremePrice,oneHourRoomR}};
}

export function decisionQuestion(key) {
  return {type:'noul',instructions:`For candidate ${key}, judge this one prospective P5 plan only. At the supplied current executable quote, will the preset direction reach target.netOneRPrice before target.initialStop within target.horizonMinutes? The +1R target includes the supplied fee and adverse-slippage assumptions. Consider target.oneHourRoomR: the direction-adjusted room from the executable quote to the prior 12 fully closed 1h bars' extreme, divided by cost-inclusive initial risk per unit. Small or negative room can indicate nearby prior resistance/support, but ten completed replay trades did not validate a numeric cutoff; never treat 0.5R or 1R as a proven hard gate. Null means unknown. entryQuality.firstHarvestR is a separate early partial-profit target; it does not replace the net +1R model question. Use only contemporaneous closed-bar technical, liquidity, funding, open-interest and available valuation evidence. Do not infer missing news, future prices, fills, queue priority, or an actual trading permission.`,
    criteria:{true:'The strategy-relative net +1R price is touched first before the deadline.',false:'The initial stop is touched first or +1R is not reached by the deadline.'}};
}

export function scoreDecision(opportunity, answer, evaluatedAt, input) {
  if(opportunity.status!=='READY')return opportunity;
  const p=answer?.type==='noul'?answer.noul:null;
  if(!finite(p)||p<0||p>1)return {...opportunity,status:'UNAVAILABLE',reason:'模型结果暂缺'};
  const verdict=p>=DECISION_THRESHOLD?'YES':p<=1-DECISION_THRESHOLD?'NO':'WAIT';
  return {...opportunity,status:'EVALUATED',verdict,score:Number((p*100).toFixed(1)),evaluatedAt,model:'jev-1.13.0',
    inputHash:sha(input),reason:verdict==='YES'?'模型看好计划净 1R 路径':verdict==='NO'?'模型不看好计划净 1R 路径':'方向证据相持'};
}
