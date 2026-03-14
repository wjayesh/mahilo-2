ALTER TABLE `browser_login_attempts` ADD `denied_by_user_id` text REFERENCES users(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `browser_login_attempts` ADD `denied_at` integer;
