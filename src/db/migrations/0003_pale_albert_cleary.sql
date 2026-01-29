CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`preferred_channel` text,
	`urgent_behavior` text DEFAULT 'preferred_only' NOT NULL,
	`quiet_hours_enabled` integer DEFAULT false NOT NULL,
	`quiet_hours_start` text DEFAULT '22:00',
	`quiet_hours_end` text DEFAULT '07:00',
	`quiet_hours_timezone` text DEFAULT 'UTC',
	`default_llm_provider` text,
	`default_llm_model` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `idx_message_deliveries_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_message_deliveries_unique` ON `message_deliveries` (`message_id`,`recipient_connection_id`);