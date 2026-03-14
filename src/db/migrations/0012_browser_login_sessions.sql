CREATE TABLE `browser_login_attempts` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `approval_code` text NOT NULL,
  `browser_token_hash` text NOT NULL,
  `approved_by_user_id` text,
  `approved_at` integer,
  `redeemed_at` integer,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_browser_login_attempts_user` ON `browser_login_attempts` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_browser_login_attempts_lookup` ON `browser_login_attempts` (`user_id`, `approval_code`);
--> statement-breakpoint
CREATE INDEX `idx_browser_login_attempts_expires` ON `browser_login_attempts` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `browser_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `session_token_hash` text NOT NULL,
  `expires_at` integer NOT NULL,
  `revoked_at` integer,
  `last_seen_at` integer,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_browser_sessions_user` ON `browser_sessions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_browser_sessions_expires` ON `browser_sessions` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_browser_sessions_revoked` ON `browser_sessions` (`revoked_at`);
