import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createAuditBackup, drillAuditRestore } from './audit-backup.mjs';

// Fixed-source, credential-free maintenance only. Neither branch activates a
// runtime, contacts an exchange or restores over the live ledger. The parent
// enforces a wall-clock limit even during synchronous SQLite replay.
try {
  if (os.hostname() !== 'aegis-demo-host' || process.getuid() !== 993 || process.env.AEGIS_PRODUCTION_HOST_ID !== 'demo-server') throw new Error('BACKUP_QUANT_SERVER_REQUIRED');
  if (Object.keys(process.env).some(k => /BN.*(KEY|SECRET).*PROD|BINANCE.*(KEY|SECRET)|NODE_OPTIONS/i.test(k))) throw new Error('BACKUP_CREDENTIAL_ENV_FORBIDDEN');
  if (process.argv.length === 2) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--isolated-worker'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', AEGIS_PRODUCTION_HOST_ID: 'demo-server' },
      timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 32768, encoding: 'utf8',
    });
    if (child.status !== 0 || child.error || child.signal) throw new Error('BACKUP_DRILL_CHILD_FAILED_OR_TIMED_OUT');
    const result = JSON.parse(child.stdout);
    if (result.status !== 'ISOLATED_RESTORE_VERIFIED_NOT_ACTIVATED' || result.financialMutationsPerformed !== false) throw new Error('BACKUP_DRILL_RESULT_INVALID');
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (process.argv.length === 3 && process.argv[2] === '--isolated-worker') {
    const backup = await createAuditBackup({ sourceRoot: '/var/lib/aegis/s1-shadow/audit', backupRoot: '/var/lib/aegis/s1-backups' });
    const result = await drillAuditRestore({ directory: backup.directory, expectedManifestSha256: backup.manifestSha256 });
    process.stdout.write(JSON.stringify({ ...result, generation: path.basename(backup.directory), databaseBytes: backup.manifest.bytes,
      offServerCopyVerified: false, automaticBackupScheduleEnabled: false }) + '\n');
  } else throw new Error('BACKUP_DRILL_ARGUMENTS_INVALID');
} catch {
  // Never print database payloads, filesystem exception context or env values.
  process.stderr.write('S1_AUDIT_BACKUP_DRILL_FAILED_REVIEW_REQUIRED\n'); process.exitCode = 1;
}
