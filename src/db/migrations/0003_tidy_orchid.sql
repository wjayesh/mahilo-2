DROP INDEX IF EXISTS groups_name_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX groups_name_unique ON groups (name COLLATE NOCASE);
--> statement-breakpoint
DROP INDEX IF EXISTS idx_message_deliveries_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_message_deliveries_unique ON message_deliveries (message_id, recipient_connection_id);
