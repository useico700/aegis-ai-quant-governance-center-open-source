import { ENTRY_CONFIRMATION_REVISION } from '../../agents/shared/entry-confirmation.mjs';

export const ENTRY_WAIT_TEXT = Object.freeze({
 ENTRY_CONFIRMATION_POLICY_INVALID:'入场规则待同步',
 ENTRY_CONFIRMATION_CLOCK_OR_SIGNAL_INVALID:'原信号时间待核对',
 ENTRY_CONFIRMATION_COST_OR_PRICE_INVALID:'价格或成本证据暂缺',
 ENTRY_CONFIRMATION_ENTRY_BARS_WAIT:'等待最新入场周期完整收线',
 ENTRY_CONFIRMATION_ROOM_BARS_WAIT:'等待最近 6 小时完整行情',
 ENTRY_CONFIRMATION_QUOTE_WAIT:'等待最新盘口',
 ENTRY_CONFIRMATION_LOSS_EVIDENCE_WAIT:'最近退出记录待核对',
 ENTRY_CONFIRMATION_POST_LOSS_BAR_WAIT:'上次亏损后，等待一根新 K 线',
 ENTRY_CONFIRMATION_FRESH_BREAK_WAIT:'等待新 K 线顺势突破前一根',
 ENTRY_CONFIRMATION_BREAK_LEVEL_LOST_WAIT:'突破后价格回落，等待重新站稳',
 ENTRY_CONFIRMATION_WAIT_ROOM_OR_BREAKOUT:'前方空间不足以覆盖成本，等待突破',
 ENTRY_CONFIRMATION_EVIDENCE_INVALID:'入场证据待核对',
});
export const entryWaitText = reason => ENTRY_WAIT_TEXT[reason] ?? '等待入场证据';

// A checked empty history is distinct from an unavailable/incomplete history.
// Funding must be complete too: unknown costs must never manufacture a win.
export function latestLossExit(positions,{symbol,direction,now,complete=true}) {
 if(!complete)return {evidenceComplete:false};
 const own=positions.filter(p=>p.symbol===symbol&&p.direction===direction&&p.status==='CLOSED');
 if(own.some(p=>!Number.isSafeInteger(p.closedAt)||p.closedAt<=0||p.closedAt>now))return {evidenceComplete:false};
 own.sort((a,b)=>b.closedAt-a.closedAt||String(a.id).localeCompare(String(b.id)));
 const latest=own[0];if(!latest)return null;
 if(own[1]?.closedAt===latest.closedAt||latest.accountingComplete!==true
   ||latest.fundingAttributionComplete!==true||latest.netPnlIncludingKnownFundingUsdt==null
   ||!Number.isFinite(Number(latest.netPnlIncludingKnownFundingUsdt)))return {evidenceComplete:false};
 if(Number(latest.netPnlIncludingKnownFundingUsdt)>=0)return null;
 if(latest.exitAttribution!=='OWNED_STOP'&&latest.exitAttribution!=='OWNED_OTHER')return {evidenceComplete:false};
 if(latest.exitAttribution==='OWNED_OTHER')return null;
 return {closedAt:latest.closedAt,planId:latest.id,evidenceComplete:true,reason:'OWNED_STOP_CLOSED_NET_LOSS'};
}
export function entryQualitySummary(result,managementRevision=null) {
 if(!result)return null;
 return {revision:ENTRY_CONFIRMATION_REVISION,status:result.status,reason:result.reason,
  firstHarvestR:result.allowed?Math.min(.5,result.firstHarvestTarget?.estimatedTargetNetR??.5):null,
  targetPrice:result.firstHarvestTarget?.targetPrice??null,referencePrice:result.firstHarvestTarget?.referencePrice??null,
  managementRevision};
}
