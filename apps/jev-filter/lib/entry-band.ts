// S1's value is display-only for frozen legacy P5 rows. Current S1 IQ1 has no
// Px distance gate; the active decision view names its 50bp close guard instead.
export const entryBandPct = (account: string) => account === 'S2' ? 3 : 2;
