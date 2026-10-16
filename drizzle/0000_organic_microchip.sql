CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`correlation_id` text NOT NULL,
	`in_reply_to_id` text,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`message_kind` text NOT NULL,
	`response_policy` text NOT NULL,
	`priority` text DEFAULT 'P2' NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'DELIVERED' NOT NULL,
	`due_at` text,
	`acknowledged_at` text,
	`responded_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_messages_recipient_status_created` ON `agent_messages` (`recipient`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_messages_correlation_created` ON `agent_messages` (`correlation_id`,`created_at`);
