import { sqliteTable, text, integer, index, unique } from "drizzle-orm/sqlite-core";

// Users table
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().unique(),
    displayName: text("display_name"),
    apiKeyHash: text("api_key_hash").notNull(),
    apiKeyId: text("api_key_id").notNull(), // For indexed lookup (mhl_<kid>_...)
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    index("idx_users_username").on(table.username),
    index("idx_users_api_key_id").on(table.apiKeyId),
  ]
);

// Agent connections table
export const agentConnections = sqliteTable(
  "agent_connections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    framework: text("framework").notNull(), // 'clawdbot', 'langchain', etc.
    label: text("label").notNull(), // 'work', 'personal', 'sports'
    description: text("description"),
    capabilities: text("capabilities"), // JSON array of tags
    publicKey: text("public_key").notNull(),
    publicKeyAlg: text("public_key_alg").notNull(), // 'ed25519', 'x25519'
    routingPriority: integer("routing_priority").notNull().default(0),
    callbackUrl: text("callback_url").notNull(),
    callbackSecret: text("callback_secret").notNull(),
    status: text("status").notNull().default("active"), // 'active', 'inactive'
    lastSeen: integer("last_seen", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_agent_connections_user").on(table.userId),
    index("idx_agent_connections_status").on(table.status),
    unique("idx_agent_connections_unique").on(table.userId, table.framework, table.label),
  ]
);

// Friendships table
export const friendships = sqliteTable(
  "friendships",
  {
    id: text("id").primaryKey(),
    requesterId: text("requester_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addresseeId: text("addressee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"), // 'pending', 'accepted', 'blocked'
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_friendships_requester").on(table.requesterId),
    index("idx_friendships_addressee").on(table.addresseeId),
    index("idx_friendships_status").on(table.status),
    unique("idx_friendships_unique").on(table.requesterId, table.addresseeId),
  ]
);

// Messages table
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    correlationId: text("correlation_id"),
    senderUserId: text("sender_user_id")
      .notNull()
      .references(() => users.id),
    senderAgent: text("sender_agent").notNull(),
    recipientType: text("recipient_type").notNull(), // 'user', 'group'
    recipientId: text("recipient_id").notNull(),
    recipientConnectionId: text("recipient_connection_id").references(
      () => agentConnections.id
    ),
    payload: text("payload").notNull(),
    payloadType: text("payload_type").notNull().default("text/plain"),
    encryption: text("encryption"), // JSON: { alg, key_id }
    senderSignature: text("sender_signature"), // JSON: { alg, key_id, signature }
    context: text("context"),
    status: text("status").notNull().default("pending"), // 'pending', 'delivered', 'failed', 'rejected'
    rejectionReason: text("rejection_reason"),
    retryCount: integer("retry_count").notNull().default(0),
    idempotencyKey: text("idempotency_key"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    deliveredAt: integer("delivered_at", { mode: "timestamp" }),
  },
  (table) => [
    index("idx_messages_sender").on(table.senderUserId),
    index("idx_messages_recipient").on(table.recipientType, table.recipientId),
    index("idx_messages_connection").on(table.recipientConnectionId),
    index("idx_messages_status").on(table.status),
    index("idx_messages_correlation").on(table.correlationId),
    index("idx_messages_idempotency").on(table.idempotencyKey),
  ]
);

// Policies table
export const policies = sqliteTable(
  "policies",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(), // 'global', 'user', 'group'
    targetId: text("target_id"), // null for global, user_id or group_id otherwise
    policyType: text("policy_type").notNull(), // 'heuristic', 'llm'
    policyContent: text("policy_content").notNull(), // JSON for heuristic, prompt for llm
    priority: integer("priority").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_policies_user").on(table.userId),
    index("idx_policies_scope").on(table.scope, table.targetId),
  ]
);

// Type exports for use in services
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AgentConnection = typeof agentConnections.$inferSelect;
export type NewAgentConnection = typeof agentConnections.$inferInsert;
export type Friendship = typeof friendships.$inferSelect;
export type NewFriendship = typeof friendships.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Policy = typeof policies.$inferSelect;
export type NewPolicy = typeof policies.$inferInsert;
