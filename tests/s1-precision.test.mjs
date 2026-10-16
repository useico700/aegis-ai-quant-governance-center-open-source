import test from 'node:test';
import assert from 'node:assert/strict';
import { units, decimal, align, extractRules, validateRules, freshRules, referenceCalibration, alignTrigger, calibrateEntryPlan, quoteView, formatPrice } from '../lib/s1-precision.mjs';
import { sanitizeS1 } from '../lib/s1-monitor.mjs';
const now = Date.parse('2026-09-10T09:00:00Z');
const rule = { symbol:'SOLUSDT', observedAt:new Date(now).toISOString(),venue:'BINANCE_USDM_MAINNET',status:'TRADING',price:{min:'0.42',max:'6857',step:'0.01'},lot:{min:'0.01',max:'1000000',step:'0.01'},marketLot:{min:'0.01',max:'80000',step:'0.01'},minNotional:'5',multiplierUp:'1.15',multiplierDown:'0.85',orderTypes:['LIMIT','MARKET','STOP_MARKET','TAKE_PROFIT_MARKET'] };
const plan = { symbol:'SOLUSDT',direction:'LONG',orderType:'LIMIT',price:'150.1234',quantity:'1.239',stopPrice:'145.1234',riskBudget:'10',feeSlippagePerUnit:'0.2',markPrice:'150',bid:'149.99',ask:'150.01',lastPrice:'150',workingType:'MARK_PRICE',marketObservedAt:new Date(now).toISOString() };
test('display quote uses exact mainnet grid, rejects stale/misaligned/crossed data',()=>{
  const input={symbol:'SOLUSDT',bidPrice:'150.1000',askPrice:'150.1100',time:now};
  const q=quoteView(input,rule,'SOLUSDT',now);
  assert.equal(formatPrice(q.bidPrice,q.tickSize),'150.10');
  assert.equal(q.executionQualified,false);
  for(const change of [{time:now-90001},{bidPrice:'150.1050'},{bidPrice:'151'},{symbol:'BTCUSDT'}]) assert.throws(()=>quoteView({...input,...change},rule,'SOLUSDT',now));
});
test('quote and calibration are carried in the same sanitized snapshot',()=>{
  const quote=quoteView({symbol:'SOLUSDT',bidPrice:'150.1',askPrice:'150.11',time:now},rule,'SOLUSDT',now);
  const input={accountLabel:'S1',mode:'SCAN_ONLY',realOrdersAllowed:false,newEntriesBlocked:true,sourceAsOf:new Date(now).toISOString(),sequence:1,universe:['SOLUSDT'],precision:{source:'BINANCE_USDM_MAINNET_EXCHANGE_INFO',rules:[rule]},marketQuotes:[quote]};
  const clean=sanitizeS1(input,now);
  assert.equal(clean.marketQuotes[0].bidPrice,'150.1'); assert.equal(clean.precision.rules[0].price.step,'0.01');
  assert.equal(sanitizeS1({...input,sourceAsOf:new Date(now+90001).toISOString()},now+90001).marketQuotes[0].status,'UNAVAILABLE');
});
test('decimal integer arithmetic and plain strings do not leak IEEE float artifacts',()=>{
  assert.equal(decimal(units('1e-8')),'0.00000001');
  assert.equal(align(0.1+0.2,{min:'0',max:'1',step:'0.1'},'DOWN'),'0.3');
  for(const value of [NaN,Infinity,-1,'abc','1e-100','1'.repeat(100)]) assert.throws(()=>units(value));
});
test('step, not decimal count: SOL four-digit metadata still has a 0.01 tick',()=>{
  const p=referenceCalibration('150.1234',rule,'SOLUSDT',now);
  assert.equal(p.lower,'150.12'); assert.equal(p.upper,'150.13'); assert.equal(p.executable,false);
  assert.throws(()=>align('150.1234',rule.price,'EXACT'),/STEP/);
});
test('arbitrary tick and min-offset grids are exact, with no rounding past max',()=>{
  const f={min:'0.03',max:'1.03',step:'0.05'};
  assert.equal(align('0.17',f,'DOWN'),'0.13'); assert.equal(align('0.17',f,'UP'),'0.18');
  assert.throws(()=>align('1.029',{...f,max:'1.029'},'UP'),/OUT_OF_RANGE/);
  assert.throws(()=>align('0.01',f,'UP'),/RANGE/);
});
test('zero/missing filters and foreign or stale rules fail closed',()=>{
  assert.throws(()=>validateRules({...rule,price:{...rule.price,step:'0'}}));
  assert.throws(()=>freshRules(rule,'BTCUSDT',now),/MISMATCH/);
  assert.throws(()=>freshRules(rule,'SOLUSDT',now+300001),/STALE/);
  assert.throws(()=>freshRules(rule,'SOLUSDT',now-5001),/STALE/);
  assert.equal(referenceCalibration(150,undefined,'SOLUSDT',now).status,'UNAVAILABLE');
});
test('long/short limits and protective stops align conservatively without risk widening',()=>{
  const long=calibrateEntryPlan(plan,rule,now);
  assert.equal(long.status,'CALIBRATED_PRECISION_ONLY'); assert.equal(long.price,'150.12'); assert.equal(long.stopPrice,'145.13'); assert.equal(long.quantity,'1.23'); assert.equal(long.estimatedRisk,'6.3837');
  const short=calibrateEntryPlan({...plan,direction:'SHORT',stopPrice:'155.1234'},rule,now);
  assert.equal(short.price,'150.13'); assert.equal(short.stopPrice,'155.12');
  assert.equal(long.submissionAllowed,false); assert.equal(short.executable,false);
});
test('stop/TP towards-market rounding cannot cross the trigger reference',()=>{
  assert.equal(alignTrigger('155.1234',rule,'LONG','TAKE_PROFIT','150',now),'155.12');
  assert.equal(alignTrigger('145.1234',rule,'SHORT','TAKE_PROFIT','150',now),'145.13');
  assert.throws(()=>alignTrigger('149.999',rule,'LONG','STOP','150',now),/CROSSED/);
  assert.throws(()=>alignTrigger('150.001',rule,'SHORT','STOP','150',now),/CROSSED/);
});
test('minimum notional failure never silently increases quantity or budget',()=>{
  assert.equal(calibrateEntryPlan({...plan,quantity:'0.019'},rule,now).reason,'MIN_NOTIONAL_REJECTED_NO_UPSIZE');
  assert.equal(calibrateEntryPlan({...plan,riskBudget:'1'},rule,now).reason,'RISK_BUDGET_EXCEEDED');
  assert.equal(calibrateEntryPlan({...plan,quantity:'0.001'},rule,now).status,'REJECTED');
});
test('market quantity uses MARKET_LOT_SIZE, omits price and applies notional at mark',()=>{
  const result=calibrateEntryPlan({...plan,orderType:'MARKET'},rule,now);
  assert.equal(result.status,'CALIBRATED_PRECISION_ONLY'); assert.equal(result.price,undefined); assert.equal(result.referenceEntryPrice,'150.01');
  assert.equal(calibrateEntryPlan({...plan,orderType:'MARKET',quantity:'80001'},rule,now).status,'REJECTED');
  assert.equal(calibrateEntryPlan({...plan,orderType:'MARKET',quantity:'0.03',bid:'200',ask:'201',stopPrice:'145'},rule,now).reason,'MIN_NOTIONAL_REJECTED_NO_UPSIZE');
});
test('stale market, crossed quotes, unknown direction/type and percent-band violations reject',()=>{
  for(const change of [{marketObservedAt:new Date(now-5001).toISOString()},{bid:'151',ask:'150'},{direction:null},{orderType:'TRAILING_STOP_MARKET'},{price:'200'},{workingType:'UNKNOWN'}]) assert.equal(calibrateEntryPlan({...plan,...change},rule,now).status,'REJECTED');
});
test('changed tick immediately recalibrates the original value rather than prior rounded value',()=>{
  assert.equal(referenceCalibration('150.1234',{...rule,price:{min:'0.4',max:'6857',step:'0.1'}},'SOLUSDT',now).lower,'150.1');
  assert.equal(plan.price,'150.1234');
});
test('only mainnet exchangeInfo metadata produces rules; missing/duplicate filters reject',()=>{
  const symbol={symbol:'SOLUSDT',quoteAsset:'USDT',marginAsset:'USDT',contractType:'PERPETUAL',status:'TRADING',pricePrecision:4,orderTypes:rule.orderTypes,filters:[{filterType:'PRICE_FILTER',minPrice:'0.4200',maxPrice:'6857',tickSize:'0.0100'},{filterType:'LOT_SIZE',minQty:'0.01',maxQty:'1000000',stepSize:'0.01'},{filterType:'MARKET_LOT_SIZE',minQty:'0.01',maxQty:'80000',stepSize:'0.01'},{filterType:'MIN_NOTIONAL',notional:'5'},{filterType:'PERCENT_PRICE',multiplierUp:'1.15',multiplierDown:'0.85'}]};
  assert.equal(extractRules({symbols:[symbol]},'SOLUSDT',rule.observedAt).price.step,'0.01');
  assert.throws(()=>extractRules({symbols:[{...symbol,status:'BREAK'}]},'SOLUSDT',rule.observedAt));
  assert.throws(()=>extractRules({symbols:[{...symbol,filters:symbol.filters.slice(1)}]},'SOLUSDT',rule.observedAt));
});
test('API carries only sanitized fresh same-universe rules and never grants submission',()=>{
  const input={accountLabel:'S1',mode:'SCAN_ONLY',realOrdersAllowed:false,newEntriesBlocked:true,sourceAsOf:new Date(now).toISOString(),sequence:1,universe:['SOLUSDT'],precision:{source:'BINANCE_USDM_MAINNET_EXCHANGE_INFO',rules:[{...rule,secret:'bad'}],submissionAllowed:true}};
  const view=sanitizeS1(input,now).precision;
  assert.equal(view.rules.length,1); assert.equal(view.rules[0].secret,undefined); assert.equal(view.submissionAllowed,false);
  assert.equal(sanitizeS1({...input,sourceAsOf:new Date(now+300001).toISOString()},now+300001).precision.rules.length,0);
});
test('many decimal values satisfy direction and grid invariants without float modulus',()=>{
  for(let i=1;i<=400;i++){
    const price=decimal(units('100')+BigInt(i)*123456789000000n);
    const down=units(align(price,rule.price,'DOWN')),up=units(align(price,rule.price,'UP'));
    assert.ok(down<=units(price)&&up>=units(price));
    assert.equal((down-units(rule.price.min))%units(rule.price.step),0n);
    assert.equal((up-units(rule.price.min))%units(rule.price.step),0n);
  }
});
