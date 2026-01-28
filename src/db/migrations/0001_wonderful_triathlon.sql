CREATE TABLE `group_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`invited_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_group_memberships_group` ON `group_memberships` (`group_id`);--> statement-breakpoint
CREATE INDEX `idx_group_memberships_user` ON `group_memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_group_memberships_status` ON `group_memberships` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_group_memberships_unique` ON `group_memberships` (`group_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`owner_user_id` text NOT NULL,
	`invite_only` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_name_unique` ON `groups` (`name`);--> statement-breakpoint
CREATE INDEX `idx_groups_name` ON `groups` (`name`);--> statement-breakpoint
CREATE INDEX `idx_groups_owner` ON `groups` (`owner_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_messages_idempotency_sender` ON `messages` (`sender_user_id`,`idempotency_key`);