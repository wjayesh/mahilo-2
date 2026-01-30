PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`framework` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`capabilities` text,
	`public_key` text,
	`public_key_alg` text,
	`routing_priority` integer DEFAULT 0 NOT NULL,
	`callback_url` text NOT NULL,
	`callback_secret` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seen` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_agent_connections`("id", "user_id", "framework", "label", "description", "capabilities", "public_key", "public_key_alg", "routing_priority", "callback_url", "callback_secret", "status", "last_seen", "created_at") SELECT "id", "user_id", "framework", "label", "description", "capabilities", "public_key", "public_key_alg", "routing_priority", "callback_url", "callback_secret", "status", "last_seen", "created_at" FROM `agent_connections`;--> statement-breakpoint
DROP TABLE `agent_connections`;--> statement-breakpoint
ALTER TABLE `__new_agent_connections` RENAME TO `agent_connections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_agent_connections_user` ON `agent_connections` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_connections_status` ON `agent_connections` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_connections_unique` ON `agent_connections` (`user_id`,`framework`,`label`);