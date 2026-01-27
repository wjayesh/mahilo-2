CREATE TABLE `agent_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`framework` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`capabilities` text,
	`public_key` text NOT NULL,
	`public_key_alg` text NOT NULL,
	`routing_priority` integer DEFAULT 0 NOT NULL,
	`callback_url` text NOT NULL,
	`callback_secret` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seen` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_connections_user` ON `agent_connections` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_connections_status` ON `agent_connections` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_connections_unique` ON `agent_connections` (`user_id`,`framework`,`label`);--> statement-breakpoint
CREATE TABLE `friendships` (
	`id` text PRIMARY KEY NOT NULL,
	`requester_id` text NOT NULL,
	`addressee_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`addressee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_friendships_requester` ON `friendships` (`requester_id`);--> statement-breakpoint
CREATE INDEX `idx_friendships_addressee` ON `friendships` (`addressee_id`);--> statement-breakpoint
CREATE INDEX `idx_friendships_status` ON `friendships` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_friendships_unique` ON `friendships` (`requester_id`,`addressee_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`correlation_id` text,
	`sender_user_id` text NOT NULL,
	`sender_agent` text NOT NULL,
	`recipient_type` text NOT NULL,
	`recipient_id` text NOT NULL,
	`recipient_connection_id` text,
	`payload` text NOT NULL,
	`payload_type` text DEFAULT 'text/plain' NOT NULL,
	`encryption` text,
	`sender_signature` text,
	`context` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`rejection_reason` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`sender_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_connection_id`) REFERENCES `agent_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_messages_sender` ON `messages` (`sender_user_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_recipient` ON `messages` (`recipient_type`,`recipient_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_connection` ON `messages` (`recipient_connection_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_status` ON `messages` (`status`);--> statement-breakpoint
CREATE INDEX `idx_messages_correlation` ON `messages` (`correlation_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_idempotency` ON `messages` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`target_id` text,
	`policy_type` text NOT NULL,
	`policy_content` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_policies_user` ON `policies` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_policies_scope` ON `policies` (`scope`,`target_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text,
	`api_key_hash` text NOT NULL,
	`api_key_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE INDEX `idx_users_username` ON `users` (`username`);--> statement-breakpoint
CREATE INDEX `idx_users_api_key_id` ON `users` (`api_key_id`);