import fs from 'node:fs';
import crypto from 'node:crypto';
import { compareStructureRecognition, scanWithStructureExperience } from './scan.mjs';
const [hPath, mPath, output] = process.argv.slice(2);
if (!hPath || !mPath || !output) throw new Error('Usage: node run.mjs 4h.json 15m.json output.json');
const hBytes = fs.readFileSync(hPath), mBytes = fs.readFileSync(mPath);
const h = JSON.parse(hBytes), m = JSON.parse(mBytes);
if (h.interval !== '4h' || m.interval !== '15m' || h.symbol !== m.symbol) throw new Error('DATASET_SCOPE_INVALID');
const now = h.bars.at(-1).closeTime + 1, tick = 0.1;
const rows = bars => bars.map(b => [b.openTime, b.open, b.high, b.low, b.close, b.volume, b.closeTime]);
const result = {
  revision: 'SMC-MAIN-SEQUENCE-R1', datasetSymbol: h.symbol,
  firstCloseAt: h.bars[0].closeTime, lastCloseAt: h.bars.at(-1).closeTime,
  sourceHashes: { h4: crypto.createHash('sha256').update(hBytes).digest('hex'),
    m15: crypto.createHash('sha256').update(mBytes).digest('hex') },
  historicalData: true, productionMutated: false, jevDisposition: 'NO_RUNTIME_EFFECT_OFFLINE_RESEARCH_ONLY',
  diagnostic: compareStructureRecognition(h.bars, tick),
  scan: scanWithStructureExperience({ symbol: h.symbol, bars4h: rows(h.bars.slice(-360)),
    bars15m: rows(m.bars.filter(b => b.closeTime < now).slice(-1500)), now,
    tickSize: String(tick), quote: null }),
};
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, diagnostic: { ...result.diagnostic, mainEvents: undefined,
  baselineEvents: undefined }, candidateCount: result.scan.candidates.length }));
