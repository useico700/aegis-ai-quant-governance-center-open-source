CREATE TABLE IF NOT EXISTS `s2_equity_observations` (
	`observed_at` text PRIMARY KEY NOT NULL,
	`equity` real NOT NULL,
	`wallet` real NOT NULL,
	`available` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `s2_execution_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`observed_at` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `s2_monitor_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`source_as_of` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `s2_trade_fills` (
	`key` text PRIMARY KEY NOT NULL,
	`trade_time` integer NOT NULL,
	`payload` text NOT NULL,
	`observed_at` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_s2_trade_fills_time` ON `s2_trade_fills` (`trade_time`);
