ALTER TABLE `messages` ADD `direction` text NOT NULL DEFAULT 'outbound';
--> statement-breakpoint
ALTER TABLE `messages` ADD `resource` text NOT NULL DEFAULT 'message.general';
--> statement-breakpoint
ALTER TABLE `messages` ADD `action` text NOT NULL DEFAULT 'share';
--> statement-breakpoint
ALTER TABLE `messages` ADD `in_response_to` text REFERENCES messages(id);
--> statement-breakpoint
ALTER TABLE `messages` ADD `outcome` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD `outcome_details` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD `policies_evaluated` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD `sender_connection_id` text REFERENCES agent_connections(id);
--> statement-breakpoint
ALTER TABLE `messages` ADD `classified_direction` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD `classified_resource` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD `classified_action` text;
--> statement-breakpoint
CREATE INDEX `idx_messages_sender_connection` ON `messages` (`sender_connection_id`);
--> statement-breakpoint
CREATE INDEX `idx_messages_selectors` ON `messages` (`direction`,`resource`,`action`);
--> statement-breakpoint
CREATE INDEX `idx_messages_in_response_to` ON `messages` (`in_response_to`);
--> statement-breakpoint
CREATE INDEX `idx_messages_resource_sender` ON `messages` (`resource`,`sender_user_id`);
