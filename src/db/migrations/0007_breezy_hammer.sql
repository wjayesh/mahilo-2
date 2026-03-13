ALTER TABLE `policies` ADD `direction` text;
--> statement-breakpoint
ALTER TABLE `policies` ADD `resource` text;
--> statement-breakpoint
ALTER TABLE `policies` ADD `action` text;
--> statement-breakpoint
ALTER TABLE `policies` ADD `effect` text;
--> statement-breakpoint
ALTER TABLE `policies` ADD `evaluator` text;
--> statement-breakpoint
ALTER TABLE `policies` ADD `effective_from` integer;
--> statement-breakpoint
ALTER TABLE `policies` ADD `expires_at` integer;
--> statement-breakpoint
ALTER TABLE `policies` ADD `max_uses` integer;
--> statement-breakpoint
ALTER TABLE `policies` ADD `remaining_uses` integer;
--> statement-breakpoint
ALTER TABLE `policies` ADD `source` text;
--> statement-breakpoint
ALTER TABLE `policies` ADD `derived_from_message_id` text REFERENCES messages(id);
--> statement-breakpoint
CREATE INDEX `idx_policies_lookup` ON `policies` (`user_id`,`enabled`,`scope`,`target_id`);
--> statement-breakpoint
CREATE INDEX `idx_policies_selectors` ON `policies` (`direction`,`resource`,`action`);
--> statement-breakpoint
CREATE INDEX `idx_policies_lifecycle` ON `policies` (`effective_from`,`expires_at`,`remaining_uses`);
