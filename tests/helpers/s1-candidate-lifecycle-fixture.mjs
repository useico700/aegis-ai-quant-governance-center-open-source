export const hour = 3600000, now = 20 * hour;
export function fixture() {
 const make = (count, width, changes={}) => Array.from({length:count},(_,i)=>({openTime:i*width,closeTime:(i+1)*width-1,open:90,high:100,low:85,close:92,...changes[i]}));
 const bars4h=make(5,4*hour,{1:{high:110},2:{high:98,low:70},3:{high:105,low:82}});
 const bars1h=make(20,hour,{2:{high:96,low:80},4:{high:110,low:90},6:{high:98,low:82}});
 const bars15m=make(80,hour/4);
 const scale={leftBars:1,rightBars:1,hierarchyWindowMultipliers:[1],minimumRealtimeHierarchyMultiplier:1,minimumAnchorSeparationBars:1,searchWindowBars:100,minimumAnchorProminenceFractionOfVisibleRange:0,minimumPairMoveFractionOfVisibleRange:0,minimumPairSpanFractionOfSearchWindow:0,maximumIntermediateViolationFractionOfVisibleRange:0.003};
 const strategy={pivots:{fourHour:{...scale},oneHour:{...scale}},intersection:{fourHourPairCandidates:4,oneHourPairCandidates:4,minimumSlopeDifferencePer15m:1e-12,minimumDiscoveryLeadHours:2,maximumLeadHours:72,commitmentLeadHours:2,ambiguousBoundaryMs:0}};
 return {symbol:'BTCUSDT',now,bars4h,bars1h,bars15m,strategy,existing:[]};
}
