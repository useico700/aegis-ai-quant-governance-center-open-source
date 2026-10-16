import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from 'node:fs/promises';
import path from 'node:path';
import { readBootstrapReceipt } from './bootstrap-receipt.mjs';
import { CoordinatedReadBudget } from './coordinated-read-budget.mjs';
import { CoordinatedReadSession } from './coordinated-read-session.mjs';
import { SHARED_READ_CONSUMERS } from './shared-read-budget.mjs';
import { assertSharedAdmissionHost, SHARED_READ_ROOT } from './host-admission.mjs';
import { invariant } from './common.mjs';

// Unlike the general offline v2 component, this boundary must preserve an
// existing production budget. A fresh v2 bootstrap is never a migration.
class MigratedReadBudget extends CoordinatedReadBudget {
  #bootstrap; #migration = null;
  constructor(root, consumer, receipt, options) {
    super(root, consumer, options); this.#bootstrap = structuredClone(receipt);
  }
  validateAdditionalState(context) {
    super.validateAdditionalState(context);
    // The inherited transaction has already validated the bounded migration
    // schema, state/counter floors and current clock. Do this before recovery
    // or owner enrollment, and again before COMMIT on every transaction.
    const serialized = this.db.prepare('SELECT migration FROM meta WHERE id=1').get().migration;
    invariant(serialized !== null, 'COORDINATED_HOST_MIGRATION_REQUIRED');
    const migration = JSON.parse(serialized), receipt = this.#bootstrap, state = context.budget.state;
    invariant(migration.at >= receipt.completedAt && migration.requests >= receipt.legacyRequests
      && migration.priorBlockedUntil >= receipt.minimumBlockedUntil, 'COORDINATED_HOST_MIGRATION_PROVENANCE');
    invariant(state.requests >= receipt.legacyRequests && state.throttles >= receipt.legacyThrottles
      && state.blockedUntil >= receipt.minimumBlockedUntil, 'COORDINATED_HOST_BOOTSTRAP_REGRESSED');
    invariant(this.#migration === null || this.#migration === serialized, 'COORDINATED_HOST_MIGRATION_CHANGED');
    this.#migration = serialized;
  }
}

// Explicit local fixture seam. Production callers use the fixed wrapper below;
// no network, credentials, schema migration, auto-bootstrap or implicit start.
export async function openMigratedReadSession(root, consumer, { receiptOwnerUid = 0, now = Date.now, sessionOptions = {} } = {}) {
  invariant(SHARED_READ_CONSUMERS.includes(consumer) && typeof now === 'function'
    && Number.isSafeInteger(receiptOwnerUid) && receiptOwnerUid >= 0, 'COORDINATED_HOST_OPTIONS');
  const receipt = await readBootstrapReceipt(root, { ownerUid: receiptOwnerUid, now });
  const budget = new MigratedReadBudget(root, consumer, receipt, { now });
  try {
    // Migration required these existing owner files. Do not silently recreate
    // a missing owner database via the generic component's bootstrap path.
    const owner = await fs.lstat(path.join(root, `${consumer}.sqlite`));
    invariant(owner.isFile() && !owner.isSymbolicLink() && owner.nlink === 1 && owner.uid === process.getuid()
      && !(owner.mode & 0o077) && owner.size <= 1024 ** 2, 'COORDINATED_HOST_OWNER_REQUIRED');
    await budget.open();
    // Return unstarted so the host can adopt ownership before starting the
    // heartbeat. Request ports reject until the host explicitly calls start().
    return new CoordinatedReadSession(budget, sessionOptions);
  } catch {
    // No request can have started here. A construction failure must not leak
    // the newly acquired owner; never reset the store to make startup succeed.
    if (budget.db) { try { budget.close(); } catch { /* The underlying close preserves its halt. */ } }
    throw new Error('COORDINATED_HOST_OPEN_FAILED');
  }
}

// Used by explicit coordinated reader/scanner/shadow entries. Existing service
// commands still select v1; all three producers must switch together.
export async function openProductionCoordinatedReadSession(consumer) {
  assertSharedAdmissionHost();
  invariant(arguments.length === 1, 'COORDINATED_HOST_OVERRIDES_FORBIDDEN');
  return openMigratedReadSession(SHARED_READ_ROOT, consumer);
}
