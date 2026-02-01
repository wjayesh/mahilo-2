CREATE TABLE `friend_roles` (
	`friendship_id` text NOT NULL,
	`role_name` text NOT NULL,
	`assigned_at` integer NOT NULL,
	FOREIGN KEY (`friendship_id`) REFERENCES `friendships`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_friend_roles_role` ON `friend_roles` (`role_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_friend_roles_unique` ON `friend_roles` (`friendship_id`,`role_name`);--> statement-breakpoint
CREATE TABLE `user_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`description` text,
	`is_system` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_roles_user` ON `user_roles` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_roles_unique_name` ON `user_roles` (`user_id`,`name`);