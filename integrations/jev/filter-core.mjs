import { createHash } from 'node:crypto';

export const MODEL = 'jev-1.13.0';
export const REVISION = 'JEV-DIRECTIONAL-PROBABILITY-1';
export function publicWeightWindow(state, at, observedWeight = null) {
  const minute = Math.floor(at / 60_000);
  const prior = state?.minute === minute ? state.usedWeight : 0;
  return { minute, usedWeight: Number.isFinite(observedWeight) && observedWeight >= 0
    ? Math.max(prior, observedWeight) : prior };
}
export const COIN_IDS = Object.freeze({ BTCUSDT:'bitcoin', ETHUSDT:'ethereum', SOLUSDT:'solana', XRPUSDT:'ripple', BNBUSDT:'binancecoin', DOGEUSDT:'dogecoin', ZECUSDT:'zcash', HYPEUSDT:'hyperliquid', LINKUSDT:'chainlink', AAVEUSDT:'aave' });
export const OPTIONS = Object.freeze({
  focus:'Several independent, current technical, liquidity and derivatives observations support watching this candidate; no supplied evidence indicates a prominent counter-signal. This is NOT a trade instruction or profit forecast.',
  watch:'The evidence is mixed or only mildly supportive. Continue observing without claiming a strong confluence.',
  caution:'Current evidence contains a notable opposing momentum, crowding, liquidity, or valuation concern.',
  insufficient:'Required evidence is missing, stale, contradictory or cannot support a grounded comparison.'
});
export const OUTCOME_OPTIONS = Object.freeze({
  one_r_first:'The preset direction is likely to follow through far enough to reach a strategy-style +1R objective before an initial stop, timeout, or invalidation.',
  half_r_only:'The preset direction is more likely to show useful initial follow-through around +0.5R, but full +1R follow-through is uncertain.',
  stop_first:'The current evidence favors adverse movement, stop-first risk, or invalidation before useful directional follow-through.',
  timeout_chop:'The most likely path is congestion, delayed follow-through, or no clean directional resolution within the strategy horizon.'
});
const finite = v => typeof v === 'number' && Number.isFinite(v);
const numeric = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const round = (v, digits=4) => finite(v) ? Number(v.toFixed(digits)) : null;
const pct = (a,b) => finite(a) && finite(b) && b !== 0 ? (a / b - 1) * 100 : null;
export const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function selectCandidates(snapshot, now = Date.now(), { allPlans = false } = {}) {
  const sourceTime=Date.parse(snapshot?.sourceAsOf);
  if (!['S1','S2'].includes(snapshot?.accountLabel) || snapshot?.mode !== 'SCAN_ONLY' || !Number.isFinite(sourceTime) || now-sourceTime>180_000 || sourceTime>now+5_000) return [];
  const eligible = (Array.isArray(snapshot.candidates) ? snapshot.candidates : []).filter(row =>
    row && typeof row.id === 'string' && row.id.length <= 200 && COIN_IDS[row.symbol] && ['LONG','SHORT'].includes(row.direction)
    && finite(row.intersectionPrice) && row.intersectionPrice>0 && !row.stale
    && !['INVALIDATED','EXPIRED','CONFIRMED_EXPIRED','NON_CAUSAL_OBSERVATION'].includes(row.status));
  const quotes = new Map((snapshot.marketQuotes ?? []).filter(row => COIN_IDS[row.symbol]).map(row => [row.symbol,row]));
  const grouped = new Map();
  for (const row of eligible) {
    const stage = row.status === 'FIRST_CLOSE_LOCKED' ? 'LOCKED' : Date.parse(row.intersectionTime) <= now ? 'ARRIVED' : 'UPCOMING';
    const q = quotes.get(row.symbol);
    const bid = numeric(q?.bidPrice), ask = numeric(q?.askPrice);
    const market = bid && ask ? (bid+ask)/2 : null;
    const distance = market ? Math.abs(market/row.intersectionPrice-1) : Infinity;
    // Prefer the structure closest to today's price. Stage breaks near ties;
    // an old locked structure must not hide a newer, materially closer one.
    const score = distance + ({LOCKED:0,ARRIVED:0.001,UPCOMING:0.002})[stage];
    const groupKey = allPlans ? row.id : row.symbol;
    const current = grouped.get(groupKey);
    if (!current || score < current.score) grouped.set(groupKey,{row,stage,score});
  }
  return [...grouped.values()].map(({row,stage})=>({ id:row.id,symbol:row.symbol,direction:row.direction,stage,px:row.intersectionPrice,intersectionTime:row.intersectionTime,observedAt:row.observedAt ?? snapshot.sourceAsOf, ...(row.structureRevision?{structureRevision:row.structureRevision}:{}) }));
}

export function parseBars(rows, interval, now = Date.now()) {
  const width = { '5m':300_000, '15m':900_000, '1h':3_600_000, '4h':14_400_000 }[interval];
  if (!width || !Array.isArray(rows)) return null;
  const parsed = rows.map(row => ({ openTime:numeric(row?.[0]),open:numeric(row?.[1]),high:numeric(row?.[2]),low:numeric(row?.[3]),close:numeric(row?.[4]),volume:numeric(row?.[5]),closeTime:numeric(row?.[6]) }))
    .filter(row => row.openTime!==null && row.closeTime===row.openTime+width-1 && row.closeTime<now && row.low>0 && row.low<=Math.min(row.open,row.close) && row.high>=Math.max(row.open,row.close) && row.volume>=0).slice(-50);
  if (parsed.length < 30 || now - parsed.at(-1).closeTime > width + 60_000) return null;
  for(let i=1;i<parsed.length;i++)if(parsed[i].openTime-parsed[i-1].openTime!==width)return null;
  return parsed;
}

function ema(values, period) {
  if(values.length<period+5)return null;
  let value=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  const output=[];
  for(const next of values.slice(period)){value=next*(2/(period+1))+value*(1-2/(period+1));output.push(value);}
  return output;
}
function rsi(closes) {
  if(closes.length<16)return null;
  const delta=closes.slice(-15).map((v,i)=>i===0?0:v-closes.at(-15+i-1)).slice(1);
  const up=delta.reduce((a,b)=>a+Math.max(b,0),0)/14, down=delta.reduce((a,b)=>a+Math.max(-b,0),0)/14;
  return down===0?up===0?50:100:100-100/(1+up/down);
}
function atr(bars) {
  if(bars.length<15)return null;
  const recent=bars.slice(-14);
  return recent.reduce((sum,bar,index)=>{
    const prev=bars[bars.length-15+index].close;
    return sum+Math.max(bar.high-bar.low,Math.abs(bar.high-prev),Math.abs(bar.low-prev));
  },0)/14/recent.at(-1).close*100;
}
export function buildMetrics({ candidate, bars, quote, ticker, premium, openInterest, oiHistory, coin }) {
  const entry=bars?.[candidate.account==='S2'?'5m':'15m'] ?? null;
  const hour=bars?.['1h'] ?? null;
  const closes=entry?.map(row=>row.close) ?? [];
  const hourEma=hour?ema(hour.map(row=>row.close),20):null;
  const price=numeric(quote?.bid) && numeric(quote?.ask) ? (numeric(quote.bid)+numeric(quote.ask))/2 : null;
  const funding=numeric(premium?.lastFundingRate);
  const oi=numeric(openInterest?.openInterest);
  const history=Array.isArray(oiHistory)?oiHistory.filter(row=>numeric(row?.sumOpenInterestValue)!==null).slice(-2):[];
  const oiBefore=numeric(history.at(-2)?.sumOpenInterestValue),oiAfter=numeric(history.at(-1)?.sumOpenInterestValue);
  const cap=numeric(coin?.market_cap),fdv=numeric(coin?.fully_diluted_valuation),circulating=numeric(coin?.circulating_supply),total=numeric(coin?.max_supply)??numeric(coin?.total_supply);
  return {
    pxDistancePct:round(price===null?null:(candidate.direction==='LONG'?price/candidate.px-1:1-price/candidate.px)*100,3),
    rsi14:round(rsi(closes),1), ema20SlopePct:round(hourEma&&hourEma.length>5?pct(hourEma.at(-1),hourEma.at(-6)):null,3),
    atr14Pct:round(entry?atr(entry):null,3), volumeRatio:round(entry&&entry.length>=21?entry.at(-1).volume/(entry.slice(-21,-1).reduce((a,b)=>a+b.volume,0)/20):null,2),
    quoteVolumeUsd24h:round(numeric(ticker?.quoteVolume),0),priceChangePct24h:round(numeric(ticker?.priceChangePercent),2),
    fundingPct:round(funding===null?null:funding*100,4),openInterestUsd:round(oi!==null&&price!==null?oi*price:null,0),oiChangePct1h:round(pct(oiAfter,oiBefore),2),
    spreadBps:round(price===null?null:(numeric(quote.ask)-numeric(quote.bid))/price*10_000,2),
    marketCapUsd:round(cap,0),fdvToCap:round(cap&&fdv?fdv/cap:null,2),circulatingRatio:round(circulating&&total?circulating/total*100:null,1)
  };
}

export function questionFor(candidateKey) {
  return { type:'choice', instructions:`Classify the independent evidence confluence for candidate ${candidateKey} only. Evaluate the supplied direction using current closed-bar technical features, derivatives positioning, liquidity, and available token supply/valuation. Treat missing fields as unknown. Never infer a win probability or make an entry/exit decision.`, criteria:OPTIONS };
}
export function outcomeQuestionFor(candidateKey) {
  return { type:'choice', instructions:`Estimate the most plausible strategy-relative outcome bucket for candidate ${candidateKey}. Use the candidate's preset direction and the supplied current evidence only. The framing is research-only: compare whether the candidate is more likely to reach +1R, only show +0.5R follow-through, hit an initial stop first, or stall/timeout. Do not output a trade instruction, expected return promise, or live sizing recommendation.`, criteria:OUTCOME_OPTIONS };
}
export function readChoiceAnswer(answer, options) {
  if(answer?.type!=='choice'||!Object.hasOwn(options,answer.choice)||!finite(answer.confidence)||answer.confidence<0||answer.confidence>1)return null;
  const probabilities=answer.probabilities;
  if(!probabilities||Object.keys(options).some(key=>!finite(probabilities[key])||probabilities[key]<0||probabilities[key]>1)||Math.abs(Object.keys(options).reduce((a,key)=>a+probabilities[key],0)-1)>0.001)return null;
  return {choice:answer.choice,confidence:answer.confidence,probabilities:Object.fromEntries(Object.keys(options).map(key=>[key,probabilities[key]]))};
}
export function readAnswer(answer) {
  return readChoiceAnswer(answer, OPTIONS);
}
export function readOutcomeAnswer(answer) {
  return readChoiceAnswer(answer, OUTCOME_OPTIONS);
}
export function buildDirectionalLayer(answer, evaluatedAt = null) {
  if(!answer)return null;
  const p=answer.probabilities;
  const p05=round((p.one_r_first*0.88 + p.half_r_only*0.64 + p.timeout_chop*0.24 + p.stop_first*0.10)*100,1);
  const p1=round((p.one_r_first*0.74 + p.half_r_only*0.29 + p.timeout_chop*0.09 + p.stop_first*0.04)*100,1);
  const pStop=round((p.one_r_first*0.12 + p.half_r_only*0.24 + p.timeout_chop*0.22 + p.stop_first*0.76)*100,1);
  const pTimeout=round(Math.max(0,100-p1-pStop),1);
  const evR=round((p1/100)*1 + Math.max(0,(p05-p1)/100)*0.35 - (pStop/100)*1 - (pTimeout/100)*0.05,3);
  const label=evR>=0.22&&p1>=55?'EDGE':evR>=0.05&&p1>=45?'LEAN':evR>=-0.08?'FLAT':'AVOID';
  return {schemaVersion:1,status:'EVALUATED',label,probabilityPct:p1,p05R:p05,p1R:p1,pStop,pTimeout,evR,confidence:round(answer.confidence,3),model:MODEL,evaluatedAt};
}

export function summarizeBars(bars) {
  if(!bars || bars.length<30)return null;
  const closes=bars.map(b=>b.close), trend=ema(closes,20), last=bars.at(-1);
  const atrPct=atr(bars);
  return {close:last.close,closeTime:last.closeTime,rsi14:round(rsi(closes),1),atrPct:round(atrPct,4),atrPrice:atrPct*last.close/100,
    ema20SlopePct:round(pct(trend.at(-1),trend.at(-6)),4),priceVsEmaPct:round(pct(last.close,trend.at(-1)),4),
    change3BarsPct:round(pct(last.close,closes.at(-4)),4),volumeRatio:round(last.volume/(bars.slice(-21,-1).reduce((s,b)=>s+b.volume,0)/20),3)};
}
