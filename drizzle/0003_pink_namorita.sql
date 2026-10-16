CREATE TABLE IF NOT EXISTS `v4_monitor_history` (
	`source_as_of` text PRIMARY KEY NOT NULL,
	`margin_equity_usdt` real NOT NULL,
	`wallet_balance_usdt` real NOT NULL,
	`unrealized_pnl_usdt` real NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `v4_monitor_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`source_as_of` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
