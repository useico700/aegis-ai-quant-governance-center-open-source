// Quant-server only; read-only private monitor contract check, never prints secrets.
import fs from 'node:fs/promises';
const { referenceCalibration, quoteView } = await import('/opt/aegis/s1-scanner/current/lib/s1-precision.mjs');
const env=Object.fromEntries((await fs.readFile('/etc/aegis/s1-scanner-monitor.env','utf8')).trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
const headers={'oai-sites-authorization':`Bearer ${env.S1_MONITOR_BYPASS_TOKEN}`};
const r=await fetch(env.S1_MONITOR_URL,{headers,signal:AbortSignal.timeout(12000)}), data=await r.json(), s=data.snapshot;
const page=await fetch(new URL('/s1',env.S1_MONITOR_URL),{headers,signal:AbortSignal.timeout(12000)}), html=await page.text();
const now=Date.now();
const candidates=s.candidates.map(row=>({symbol:row.symbol,...referenceCalibration(row.intersectionPrice,s.precision?.rules.find(rule=>rule.symbol===row.symbol),row.symbol,now)}));
const quotes=(s.marketQuotes??[]).map(q=>quoteView({...q,time:Date.parse(q.exchangeTime)},s.precision?.rules.find(rule=>rule.symbol===q.symbol),q.symbol,now));
const result={checkedAt:new Date(now).toISOString(),http:r.status,pageHttp:page.status,quoteHeading:html.includes('盘口报价'),calibrationHeading:html.includes('对齐参考价'),status:data.status,sourceAsOf:s.sourceAsOf,sequence:s.sequence,ruleCount:s.precision?.rules.length,quoteCount:quotes.length,candidates,quotes,executionBlocked:s.newEntriesBlocked&&s.realOrdersAllowed===false,publish:s.publish};
console.log(JSON.stringify(result,null,2));
if(r.status!==200||page.status!==200||!result.quoteHeading||!result.calibrationHeading||result.ruleCount!==10||result.quoteCount!==10||data.status!=='OK'||candidates.some(c=>c.status!=='REFERENCE_ONLY')||!result.executionBlocked)process.exitCode=1;
