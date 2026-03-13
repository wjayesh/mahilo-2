CREATE TABLE `waitlist_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`source` text NOT NULL DEFAULT 'landing',
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `waitlist_emails_email_unique` ON `waitlist_emails` (`email`);
