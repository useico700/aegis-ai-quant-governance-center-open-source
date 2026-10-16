// Virtual legs retain their parent's sequence. They are projections of a
// committed paper decision, not additional records in the hash-chain ledger.
export function expandPaperPositionStateRecords(records) {
  return records.flatMap((record) => {
    if (record.type !== "PAPER_R21_PROFIT_PROTECTION_EVALUATED") return [record];
    return [record, ...(record.payload?.positionTransitions ?? []).map((leg, index) => ({
      type: "PAPER_POSITION_STATE_COMMITTED",
      eventId: `${record.eventId}_position_${index}`,
      parentEventId: record.eventId,
      sequence: record.sequence,
      marketTime: leg.marketTime,
      payload: leg,
    }))];
  });
}
