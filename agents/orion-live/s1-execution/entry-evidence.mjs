import { fresh, hash, invariant } from './common.mjs';

// Raw byte verification and durable pinning complete before the order intention
// may be sent. This proves entry evidence only, not full-lifecycle path/queue
// coverage or eligibility for strategy-promotion statistics.
export class EntryEvidenceArchive {
  constructor({ store, now = Date.now }) { this.store = store; this.now = now; }
  async pinEntry({ plan, bbo, tick }) {
    const rows = [bbo, tick];
    for (const [index, row] of rows.entries()) {
      invariant(row?.symbol === plan.symbol && row.type === (index === 0 ? 'BBO' : 'TICK') && row.persisted === true && row.continuity === true && Number.isSafeInteger(row.epoch), 'ENTRY_EVIDENCE_SCOPE_INVALID');
      invariant(fresh(row.marketTime, this.now(), 2000) && fresh(row.receivedAt, this.now(), 2000), 'ENTRY_EVIDENCE_STALE');
      invariant(row.persistence?.persisted === true, 'ENTRY_RAW_RECEIPT_REQUIRED');
    }
    invariant(bbo.epoch === tick.epoch && bbo.connectedAt === tick.connectedAt, 'ENTRY_EVIDENCE_EPOCH_MISMATCH');
    const batches = new Map();
    for (const row of rows) {
      const key = hash(row.persistence), group = batches.get(key) ?? { receipt: row.persistence, rows: [] };
      group.rows.push(row); batches.set(key, group);
    }
    const receipts = [];
    for (const batch of batches.values()) receipts.push(await this.store.verifyAndPin(batch.receipt, batch.rows));
    invariant(this.now() <= plan.validUntil && rows.every(row => fresh(row.marketTime, this.now(), 2000) && fresh(row.receivedAt, this.now(), 2000)), 'ENTRY_EVIDENCE_EXPIRED_DURING_PIN');
    return { schema: 'S1_PINNED_ENTRY_EVIDENCE_V1', planId: plan.id, symbol: plan.symbol, verifiedAt: this.now(),
      bboSequence: bbo.sequence, tickSequence: tick.sequence, epoch: bbo.epoch,
      eventDigests: rows.map(row => hash({ ...row, persisted: undefined, persistence: undefined })), receipts,
      fullLifecycleCoverageProven: false, queuePositionKnown: false };
  }
}
