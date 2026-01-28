CREATE TABLE `message_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`recipient_user_id` text NOT NULL,
	`recipient_connection_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_connection_id`) REFERENCES `agent_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_message_deliveries_message` ON `message_deliveries` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_message_deliveries_recipient` ON `message_deliveries` (`recipient_user_id`);--> statement-breakpoint
CREATE INDEX `idx_message_deliveries_status` ON `message_deliveries` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_message_deliveries_unique` ON `message_deliveries` (`message_id`,`recipient_user_id`);