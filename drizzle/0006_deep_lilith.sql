CREATE TABLE IF NOT EXISTS `s1_execution_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`observed_at` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `s1_trade_fills` (
	`key` text PRIMARY KEY NOT NULL,
	`trade_time` integer NOT NULL,
	`payload` text NOT NULL,
	`observed_at` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_s1_trade_fills_time` ON `s1_trade_fills` (`trade_time`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `v5_au_monitor_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`source_as_of` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
