import { sanitizeS1 } from './s1-monitor.mjs';
import { sanitizeS1ExecutionLedger, summarizeS1Fills } from './s1-execution-ledger.mjs';
const S2_THREE_PERCENT_ADMISSION_REVISION = 'S2-PX-BAND-3PCT-P5-20260921';
const S2_Z_STRUCTURE_REVISION = 'S2-15M-Z-FIRST-1H-PX-1';
const S2_Z_DISPLAY_NAME = '15M Z · 1H 多线 Px · 5M 确认';
const S2_BASE_IMPLEMENTATION_REVISION = 'MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION';
const SHARED_P5_REVISION = 'S1-S2-PX-BAND-RISK-ONLY-P5-20260920';
export { summarizeS1Fills as summarizeS2Fills };
export function sanitizeS2(input, now = Date.now()) {
  if (input?.accountLabel !== 'S2' || input.realOrdersAllowed !== false || input.newEntriesBlocked !== true) throw new Error('S2_SCOPE_MISMATCH');
  if (input.mode === 'SCAN_ONLY') {
    const snapshot = sanitizeS1({...input, accountLabel:'S1'}, now);
    return {...snapshot, accountLabel:'S2', mode:'SCAN_ONLY', revision:input.runtimeId==='S2-S1-R22-CLONE-20261013' ? S2_BASE_IMPLEMENTATION_REVISION : 'MTFX-0.5.0-R22.4-PX-RIGHT-SIDE-LIVE-BAND'};
  }
  if (input.mode !== 'ACCOUNT_READ_ONLY') throw new Error('S2_SCOPE_MISMATCH');
  const snapshot = sanitizeS1({...input, accountLabel:'S1', mode:'SCAN_ONLY', universe:[], candidates:[], marketQuotes:[]}, now);
  return {...snapshot, accountLabel:'S2', mode:'ACCOUNT_READ_ONLY', revision:null, eventGate:undefined, precision:undefined, lastSuccessfulScanAt:null, scannedSymbols:0, recovery:{restartEnabled:true, stateRecovered:input.recovery?.stateRecovered === true}};
}
export function sanitizeS2Ledger(input, now = Date.now()) {
  if (input?.accountLabel !== 'S2' || input.venue !== 'BINANCE_USDM_MAINNET') throw new Error('S2_LEDGER_SCOPE_MISMATCH');
  if (input.execution == null) {
    const ledger = sanitizeS1ExecutionLedger({...input, accountLabel:'S1', execution:{}, attribution:'EXTERNAL_UNATTRIBUTED'}, now);
    return {...ledger, accountLabel:'S2', execution:null};
  }
  const execution = input.execution;
  const runtime = execution.strategyRuntime;
  if (runtime?.displayName === 'R22 · S2 live risk') {
    if (execution.accountLabel !== 'S2' || execution.service !== 'aegis-s2-execution'
      || runtime.accountLabel !== 'S2' || runtime.structureRevision != null) throw new Error('S2_EXECUTION_SCOPE_MISMATCH');
    const ledger = sanitizeS1ExecutionLedger({...input, accountLabel:'S1', execution:{...execution,
      accountLabel:'S1', service:'aegis-s1-execution', strategyRuntime:{...runtime, accountLabel:'S1', displayName:'R22 · S1 live risk'}}}, now);
    return {...ledger, accountLabel:'S2', execution:{...ledger.execution, service:'aegis-s2-execution', strategyRuntime:{...ledger.execution.strategyRuntime, displayName:runtime.displayName}}};
  }
  const p5 = runtime?.displayName === 'Px 2% · P5'
    && runtime.entryAdmissionRevision === SHARED_P5_REVISION;
  const zStructure = runtime?.displayName === S2_Z_DISPLAY_NAME
    && runtime.structureRevision === S2_Z_STRUCTURE_REVISION
    && runtime.baseImplementationRevision === S2_BASE_IMPLEMENTATION_REVISION
    && runtime.entryAdmissionRevision === S2_THREE_PERCENT_ADMISSION_REVISION;
  const s2ThreePercent = (runtime?.displayName === 'Px 3% · P5'
    && runtime.entryAdmissionRevision === S2_THREE_PERCENT_ADMISSION_REVISION) || zStructure;
  const c1 = runtime?.displayName === 'R22.4 + IQ1 P4 + C1 · 1H / 15M / 5M';
  const legacy = runtime?.displayName === 'R22.4 + IQ1 P4 · 1H / 15M / 5M';
  if (execution.accountLabel !== 'S2' || execution.service !== 'aegis-s2-execution'
    || runtime?.accountLabel !== 'S2' || (runtime.structureRevision != null && !zStructure) || !(p5 || s2ThreePercent || c1 || legacy)) {
    throw new Error('S2_EXECUTION_SCOPE_MISMATCH');
  }
  const risk = runtime.riskPolicy;
  if (s2ThreePercent && (risk?.perTradeFraction !== '0.04' || risk?.portfolioFraction !== '0.12' || (zStructure && risk?.maximumLeverage !== 25))) {
    throw new Error('S2_EXECUTION_RISK_POLICY_INVALID');
  }
  const ledger = sanitizeS1ExecutionLedger({
    ...input,
    accountLabel:'S1',
    execution:{...execution, service:'aegis-s1-execution', strategyRuntime:{...runtime, accountLabel:'S1',
      riskPolicy:s2ThreePercent ? {...risk, perTradeFraction:'0.02', portfolioFraction:'0.10'} : risk,
      entryAdmissionRevision:s2ThreePercent ? SHARED_P5_REVISION : runtime.entryAdmissionRevision,
      displayName:p5 || s2ThreePercent ? 'Px 2% · P5' : c1 ? 'R22.4 + IQ1 P4 + C1' : 'R22.4 + IQ1 P4'}},
  }, now, { runtimeProfile:'S2_ADAPTER' });
  return {...ledger, accountLabel:'S2', execution:{...ledger.execution, service:'aegis-s2-execution', strategyRuntime:{...ledger.execution.strategyRuntime,
    ...(zStructure ? {structureRevision:S2_Z_STRUCTURE_REVISION,baseImplementationRevision:S2_BASE_IMPLEMENTATION_REVISION} : {}),
    displayName:runtime.displayName, entryAdmissionRevision:runtime.entryAdmissionRevision ?? null,
    riskPolicy:s2ThreePercent ? {...ledger.execution.strategyRuntime.riskPolicy,
      perTradeFraction:risk.perTradeFraction, portfolioFraction:risk.portfolioFraction} : ledger.execution.strategyRuntime.riskPolicy}}};
}
