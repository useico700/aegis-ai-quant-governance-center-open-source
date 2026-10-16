import { spawnSync } from 'node:child_process';
import { invariant } from './common.mjs';

// Credential-free synthetic acceptance only. Not a trading entry point.
invariant(!Object.keys(process.env).some(key => /BN.*(KEY|SECRET).*PROD|BINANCE.*(KEY|SECRET)/i.test(key)), 'OFFLINE_TEST_CREDENTIAL_ENV_FORBIDDEN');
const files = ['s1-bootstrap-receipt', 's1-host-admission', 's1-admitted-http', 's1-shared-read-budget', 's1-ops-monitor', 's1-audit-backup', 's1-activity-monitor', 's2-execution', 's2-execution-evidence', 's1-trial-budget', 's1-position-lifecycle', 's2-execution-engine',
  's1-sqlite-journal', 's1-streams', 's1-segmented-evidence', 's1-retention-coordination', 's1-resident', 's1-frame-provider', 's1-entry-evidence', 's1-r21-dispatch', 's1-readonly-ports', 's1-request-budget', 's1-owned-mutation', 's1-account-activity', 's1-external-recovery', 's1-read-cutover', 's1-cutover-store', 's1-supervisor', 's1-cutover-host-boundary'];
files.push('s1-native-cutover-actions', 's1-read-admission-observer', 's1-read-cutover-preflight');
files.push('s1-child-exit-witness', 's2-scanner-stop-witness', 's1-legacy-application-stop');
files.push('s1-flock-signal');
files.push('s2-scanner-retry');
files.push('s1-entry-calendar-cache');
files.push('s1-reader-stream-lifecycle');
files.push('s1-read-budget-migration', 's1-coordinated-read-budget');
files.push('s1-intent-read-bridge', 's1-coordinated-auxiliary-ports', 's1-coordinated-read-session');
files.push('s1-coordinated-fee-provider');
files.push('s1-coordinated-account-cache');
files.push('s1-coordinated-production-reader');
files.push('s1-coordinated-public-reads');
files.push('s1-mixed-read-workload');
files.push('s1-read-deadline-planner');
files.push('s1-shadow-shutdown');
files.push('s1-iq1-live-entry');
files.push('s1-coordinated-host-admission');
files.push('s1-coordinated-reader-resident');
files.push('s1-coordinated-scanner-resident');
files.push('s1-coordinated-shadow-host');
files.push('s1-native-resident-trio');
files.push('orion-live-binance-prod2-readonly');
// The expanded synthetic suite exceeds 120s on some local runs. Bound each
// test as well as the whole suite; these are test-runner limits, not venue I/O,
// evidence-freshness or production shutdown deadlines.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=60000',
  ...files.map(name => `tests/${name}.test.mjs`)], { stdio: 'inherit', timeout: 180000 });
process.exitCode = result.status ?? 1;
