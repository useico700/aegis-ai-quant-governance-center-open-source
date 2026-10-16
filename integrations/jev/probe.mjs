import { evaluate } from './evaluate.mjs';
// Synthetic, non-account-specific connectivity check. No exchange API is called.
const now = Date.now();
const bars = Object.fromEntries(Object.entries({ '4h': 14400000, '1h': 3600000, '15m': 900000 }).map(([interval, width]) => {
  const end = Math.floor(now / width) * width;
  return [interval, Array.from({ length: 24 }, (_, i) => ({ openTime: end - (24 - i) * width, closeTime: end - (23 - i) * width - 1, open: 100, high: 101, low: 99, close: 100, volume: 100 }))];
}));
const result = await evaluate({ accountLabel: 'S1', asOf: now, candidate: { symbol: 'BTCUSDT', direction: null, px: 100, intersectionTime: now }, quote: { bid: 99.9, ask: 100.1, asOf: now }, bars });
process.stdout.write(JSON.stringify({ syntheticProbe: true, ...result }) + '\n');
if (result.status !== 'EVALUATED') process.exitCode = 1;
