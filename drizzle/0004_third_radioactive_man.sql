CREATE TABLE `s1_monitor_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`source_as_of` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
