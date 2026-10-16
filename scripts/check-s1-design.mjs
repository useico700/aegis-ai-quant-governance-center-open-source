// Run on demo-server only. Read-only, no credentials in output.
import fs from 'node:fs/promises';
const env = Object.fromEntries((await fs.readFile('/etc/aegis/s1-scanner-monitor.env','utf8')).trim().split('\n').map(line=>{ const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)]; }));
const headers = {'oai-sites-authorization':`Bearer ${env.S1_MONITOR_BYPASS_TOKEN}`};
const get = async path => { const r=await fetch(new URL(path,env.S1_MONITOR_URL),{headers,signal:AbortSignal.timeout(15000)}); if(!r.ok) throw new Error(`HTTP_${r.status}`); return r; };
const html=await (await get('/s1')).text();
const monitor=await (await get('/api/s1-monitor')).json();
const calendar=await (await get('/api/s1-risk-calendar')).json();
const result={checkedAt:new Date().toISOString(),pageHttp:200,signalFlowMarkup:html.includes('多空信号流'),countdownMarkup:html.includes('到达倒计时'),status:monitor.status,sourceAsOf:monitor.snapshot?.sourceAsOf,sequence:monitor.snapshot?.sequence,eventGate:monitor.snapshot?.eventGate,account:monitor.snapshot?.account,publish:monitor.snapshot?.publish,candidates:monitor.snapshot?.candidates.map(({symbol,status,direction,stale})=>({symbol,status,direction,stale})),calendar:{checkedAt:calendar.checkedAt,sources:calendar.sources,count:calendar.events.length,nextEvents:calendar.events.slice(0,3)}};
console.log(JSON.stringify(result,null,2));
if(!result.signalFlowMarkup||!result.countdownMarkup||monitor.status!=='OK'||!result.eventGate)process.exitCode=1;
