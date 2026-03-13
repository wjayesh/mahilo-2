ALTER TABLE `users` ADD `status` text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE `users` ADD `registration_source` text NOT NULL DEFAULT 'invite';
--> statement-breakpoint
ALTER TABLE `users` ADD `verified_at` integer;
--> statement-breakpoint
UPDATE `users`
SET
  `status` = CASE
    WHEN COALESCE(`twitter_verified`, 0) = 1 THEN 'active'
    ELSE 'pending'
  END,
  `registration_source` = CASE
    WHEN COALESCE(`twitter_verified`, 0) = 1 THEN 'legacy_twitter'
    ELSE 'legacy_unverified'
  END,
  `verified_at` = CASE
    WHEN COALESCE(`twitter_verified`, 0) = 1 THEN unixepoch()
    ELSE NULL
  END;
--> statement-breakpoint
CREATE INDEX `idx_users_status` ON `users` (`status`);
--> statement-breakpoint
CREATE TABLE `invite_tokens` (
  `id` text PRIMARY KEY NOT NULL,
  `token_hash` text NOT NULL,
  `token_id` text NOT NULL,
  `note` text,
  `max_uses` integer DEFAULT 1 NOT NULL,
  `use_count` integer DEFAULT 0 NOT NULL,
  `expires_at` integer,
  `revoked_at` integer,
  `last_used_at` integer,
  `created_by` text,
  `redeemed_by_user_id` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`redeemed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_invite_tokens_token_id_unique` ON `invite_tokens` (`token_id`);
--> statement-breakpoint
CREATE INDEX `idx_invite_tokens_redeemed_by_user` ON `invite_tokens` (`redeemed_by_user_id`);
