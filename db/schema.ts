import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    correlationId: text("correlation_id").notNull(),
    inReplyToId: text("in_reply_to_id"),
    sender: text("sender").notNull(),
    recipient: text("recipient").notNull(),
    messageKind: text("message_kind").notNull(),
    responsePolicy: text("response_policy").notNull(),
    priority: text("priority").notNull().default("P2"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("DELIVERED"),
    dueAt: text("due_at"),
    acknowledgedAt: text("acknowledged_at"),
    respondedAt: text("responded_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_agent_messages_recipient_status_created").on(
      table.recipient,
      table.status,
      table.createdAt,
    ),
    index("idx_agent_messages_correlation_created").on(
      table.correlationId,
      table.createdAt,
    ),
  ],
);

export const v2LedgerSnapshots = sqliteTable("v2_ledger_snapshots", {
  id: text("id").primaryKey(),
  sourceAsOf: text("source_as_of").notNull(),
  payload: text("payload").notNull(),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const v3EquitySnapshots = sqliteTable("v3_equity_snapshots", {
  id: text("id").primaryKey(),
  sourceAsOf: text("source_as_of").notNull(),
  payload: text("payload").notNull(),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const v4MonitorSnapshots = sqliteTable("v4_monitor_snapshots", {
  id: text("id").primaryKey(),
  sourceAsOf: text("source_as_of").notNull(),
  payload: text("payload").notNull(),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const v4MonitorHistory = sqliteTable("v4_monitor_history", {
  sourceAsOf: text("source_as_of").primaryKey(),
  marginEquityUsdt: real("margin_equity_usdt").notNull(),
  walletBalanceUsdt: real("wallet_balance_usdt").notNull(),
  unrealizedPnlUsdt: real("unrealized_pnl_usdt").notNull(),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const v5AuMonitorSnapshots = sqliteTable("v5_au_monitor_snapshots", {
  id: text("id").primaryKey(),
  sourceAsOf: text("source_as_of").notNull(),
  payload: text("payload").notNull(),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const s1EquityObservations = sqliteTable("s1_equity_observations", {
  observedAt: text("observed_at").primaryKey(),
  equity: real("equity").notNull(),
  wallet: real("wallet").notNull(),
  available: real("available").notNull(),
});

export const s1MonitorSnapshots = sqliteTable("s1_monitor_snapshots", {
  id: text("id").primaryKey(),
  sourceAsOf: text("source_as_of").notNull(),
  payload: text("payload").notNull(),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const s1ExecutionSnapshots = sqliteTable("s1_execution_snapshots", {
  id: text("id").primaryKey(),
  observedAt: text("observed_at").notNull(),
  payload: text("payload").notNull(),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const s1TradeFills = sqliteTable("s1_trade_fills", {
  key: text("key").primaryKey(),
  tradeTime: integer("trade_time").notNull(),
  payload: text("payload").notNull(),
  observedAt: text("observed_at").notNull(),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_s1_trade_fills_time").on(table.tradeTime)]);

export const s2EquityObservations = sqliteTable("s2_equity_observations", {
  observedAt: text("observed_at").primaryKey(),
  equity: real("equity").notNull(),
  wallet: real("wallet").notNull(),
  available: real("available").notNull(),
});

export const s2MonitorSnapshots = sqliteTable("s2_monitor_snapshots", {
  id: text("id").primaryKey(),
  sourceAsOf: text("source_as_of").notNull(),
  payload: text("payload").notNull(),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const s2ExecutionSnapshots = sqliteTable("s2_execution_snapshots", {
  id: text("id").primaryKey(),
  observedAt: text("observed_at").notNull(),
  payload: text("payload").notNull(),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const s2TradeFills = sqliteTable("s2_trade_fills", {
  key: text("key").primaryKey(),
  tradeTime: integer("trade_time").notNull(),
  payload: text("payload").notNull(),
  observedAt: text("observed_at").notNull(),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_s2_trade_fills_time").on(table.tradeTime)]);
