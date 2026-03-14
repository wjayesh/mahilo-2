ALTER TABLE `browser_login_attempts` ADD `failure_state` text;
--> statement-breakpoint
ALTER TABLE `browser_login_attempts` ADD `failure_code` text;
--> statement-breakpoint
ALTER TABLE `browser_login_attempts` ADD `failure_message` text;
--> statement-breakpoint
ALTER TABLE `browser_login_attempts` ADD `failure_at` integer;
