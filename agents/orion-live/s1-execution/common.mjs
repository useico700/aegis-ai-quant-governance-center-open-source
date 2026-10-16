import crypto from 'node:crypto';

export const REVISION = 'MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION';
export const EXECUTION_REVISION = 'MTFX-0.5.0-R22.1-ENTRY-PROTECTION-CONSISTENCY';
export const ENTRY_QUALITY_REVISION = 'V2-IQ1-P1-20260915';
export const CANDIDATE_LIFECYCLE_REVISION = 'S1-S2-CQ3-READY-WINS-ENTRY-RACE-20260917';
export const UNIVERSE = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'ZECUSDT', 'HYPEUSDT', 'LINKUSDT', 'AAVEUSDT']);
export const invariant = (condition, code) => { if (!condition) throw new Error(code); };
export const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const clientId = (kind, identity) => `s1_${kind}_${hash(identity).slice(0, 26)}`;
export const fresh = (at, now, maximum) => Number.isFinite(at) && at <= now && now - at <= maximum;
export const closeSide = positionSide => positionSide === 'LONG' ? 'SELL' : 'BUY';
export const entrySide = positionSide => positionSide === 'LONG' ? 'BUY' : 'SELL';
export const terminal = status => ['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED', 'ABSENT_VERIFIED'].includes(status);
