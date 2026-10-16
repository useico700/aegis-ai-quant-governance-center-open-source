// Quant-server read-only verification. No order endpoints, credentials or writes.
import fs from 'node:fs/promises';
const { referenceCalibration, align } = await import('/opt/aegis/s1-scanner/current/lib/s1-precision.mjs');
const s = JSON.parse(await fs.readFile('/var/lib/aegis/s1-scanner/latest.json','utf8'));
const now = Date.now();
const results = s.candidates.map(row => {
  const rule = s.precision?.rules?.find(item => item.symbol === row.symbol);
  const calibrated = referenceCalibration(row.intersectionPrice,rule,row.symbol,now);
  if (calibrated.status === 'REFERENCE_ONLY') { align(calibrated.lower,rule.price,'EXACT'); align(calibrated.upper,rule.price,'EXACT'); }
  return {symbol:row.symbol,id:row.id,raw:row.intersectionPrice,stale:row.stale,...calibrated};
});
const result = { checkedAt:new Date(now).toISOString(),sourceAsOf:s.sourceAsOf,sequence:s.sequence,mode:s.mode,status:s.status,realOrdersAllowed:s.realOrdersAllowed,newEntriesBlocked:s.newEntriesBlocked,recovery:s.recovery,account:s.account,ruleCount:s.precision?.rules?.length,precisionErrors:s.precision?.errors,results,marketQuotes:s.marketQuotes,publish:s.publish };
console.log(JSON.stringify(result,null,2));
if (now-Date.parse(s.sourceAsOf)>90000||s.status!=='HEALTHY'||result.ruleCount!==10||results.some(row=>row.stale||row.status!=='REFERENCE_ONLY')||s.marketQuotes?.length!==10||s.marketQuotes.some(q=>q.status!=='QUOTED'||now-Date.parse(q.exchangeTime)>90000)||s.realOrdersAllowed!==false||s.newEntriesBlocked!==true) process.exitCode=1;
