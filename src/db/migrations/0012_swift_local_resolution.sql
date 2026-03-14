ALTER TABLE `messages` ADD `resolution_id` text;
--> statement-breakpoint
CREATE INDEX `idx_messages_resolution` ON `messages` (`resolution_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_messages_resolution_sender` ON `messages` (`sender_user_id`,`resolution_id`);
