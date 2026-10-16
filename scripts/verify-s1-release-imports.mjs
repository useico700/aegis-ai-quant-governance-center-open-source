import { execFileSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';

// Inspect immutable build archives without executing a resident or extracting
// files. This proves static relative import closure, not runtime readiness.
for (const archive of process.argv.slice(2)) {
  if (!/^aegis-(s1-scanner|s1-execution-prep|binance-prod-readonly)-\d{8}T\d{6}Z-[a-f0-9]{12}\.tar\.gz$/.test(path.basename(archive))) throw new Error('RELEASE_ARCHIVE_SCOPE');
  const read = file => execFileSync('/usr/bin/tar', ['-xOf', archive, './' + file], { maxBuffer: 8 * 1024 ** 2 });
  const manifestBytes = read('release-manifest.json');
  const manifest = JSON.parse(manifestBytes), entries = new Map(manifest.files.map(f => [f.path, f]));
  if (manifest.realOrdersAllowed !== false || manifest.secretsIncluded !== false || manifest.historicalRuntimeIncluded !== false) throw new Error('RELEASE_BOUNDARY');
  let modules = 0, relativeImports = 0;
  for (const [name, item] of entries) {
    const body = read(name);
    if (body.length !== item.bytes || crypto.createHash('sha256').update(body).digest('hex') !== item.sha256) throw new Error('RELEASE_SOURCE_DIGEST');
    if (!name.endsWith('.mjs')) continue;
    modules++;
    const source = body.toString('utf8');
    const imports = [...source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)].map(m => m[1]);
    for (const specifier of imports) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) throw new Error('RELEASE_NON_BUNDLED_IMPORT');
      relativeImports++;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
      if (!entries.has(target)) throw new Error(`RELEASE_STATIC_IMPORT_MISSING:${name}:${target}`);
    }
  }
  process.stdout.write(JSON.stringify({ releaseId: manifest.releaseId,
    manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
    modules, relativeImports, staticImportClosureVerified: true, runtimeReady: false }) + '\n');
}
