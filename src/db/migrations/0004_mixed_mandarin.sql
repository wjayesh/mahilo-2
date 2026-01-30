ALTER TABLE `users` ADD `twitter_handle` text;--> statement-breakpoint
ALTER TABLE `users` ADD `twitter_verified` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `users` ADD `verification_code` text;--> statement-breakpoint
CREATE INDEX `idx_users_twitter` ON `users` (`twitter_handle`);