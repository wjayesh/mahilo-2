ALTER TABLE `message_deliveries` ADD `policy_decision` text;
--> statement-breakpoint
ALTER TABLE `message_deliveries` ADD `policy_delivery_mode` text;
--> statement-breakpoint
ALTER TABLE `message_deliveries` ADD `policy_reason` text;
--> statement-breakpoint
ALTER TABLE `message_deliveries` ADD `policy_reason_code` text;
--> statement-breakpoint
ALTER TABLE `message_deliveries` ADD `policy_resolution_id` text;
--> statement-breakpoint
ALTER TABLE `message_deliveries` ADD `winning_policy_id` text;
--> statement-breakpoint
ALTER TABLE `message_deliveries` ADD `matched_policy_ids` text;
--> statement-breakpoint
ALTER TABLE `message_deliveries` ADD `resolver_layer` text;
--> statement-breakpoint
ALTER TABLE `message_deliveries` ADD `guardrail_id` text;
--> statement-breakpoint
CREATE INDEX `idx_message_deliveries_policy_decision` ON `message_deliveries` (`policy_decision`);
