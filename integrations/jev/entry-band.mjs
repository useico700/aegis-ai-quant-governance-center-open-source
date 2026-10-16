// S2 remains an active P5 executable-quote band. S1 is retained only for
// frozen legacy P5 samples/rows; current S1 R22.1 + IQ1 has no Px distance gate.
export const ENTRY_BAND_BPS=Object.freeze({S1:200,S2:300});
export function entryBandFraction(account) {
 const bps=ENTRY_BAND_BPS[account];
 if(!Number.isFinite(bps))throw Error('JEV_ENTRY_BAND_ACCOUNT_UNKNOWN');
 return bps/10000;
}
