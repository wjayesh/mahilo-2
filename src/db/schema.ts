import {
  sqliteTable,
  text,
  integer,
  index,
  unique,
} from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";

// Users table
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().unique(),
    displayName: text("display_name"),
    apiKeyHash: text("api_key_hash").notNull(),
    apiKeyId: text("api_key_id").notNull(), // For indexed lookup (mhl_<kid>_...)
    status: text("status").notNull().default("pending"), // 'pending', 'active', 'suspended'
    registrationSource: text("registration_source").notNull().default("invite"),
    verifiedAt: integer("verified_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    index("idx_users_username").on(table.username),
    index("idx_users_api_key_id").on(table.apiKeyId),
    index("idx_users_status").on(table.status),
  ],
);

export const inviteTokens = sqliteTable(
  "invite_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    tokenId: text("token_id").notNull(),
    note: text("note"),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    createdBy: text("created_by"),
    redeemedByUserId: text("redeemed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    unique("idx_invite_tokens_token_id_unique").on(table.tokenId),
    index("idx_invite_tokens_redeemed_by_user").on(table.redeemedByUserId),
  ],
);

export const browserLoginAttempts = sqliteTable(
  "browser_login_attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    approvalCode: text("approval_code").notNull(),
    browserTokenHash: text("browser_token_hash").notNull(),
    approvedByUserId: text("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    redeemedAt: integer("redeemed_at", { mode: "timestamp" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_browser_login_attempts_user").on(table.userId),
    index("idx_browser_login_attempts_lookup").on(
      table.userId,
      table.approvalCode,
    ),
    index("idx_browser_login_attempts_expires").on(table.expiresAt),
  ],
);

export const browserSessions = sqliteTable(
  "browser_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionTokenHash: text("session_token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_browser_sessions_user").on(table.userId),
    index("idx_browser_sessions_expires").on(table.expiresAt),
    index("idx_browser_sessions_revoked").on(table.revokedAt),
  ],
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
    publicKey: text("public_key"), // Optional: for E2E encryption
    publicKeyAlg: text("public_key_alg"), // 'ed25519', 'x25519'
    routingPriority: integer("routing_priority").notNull().default(0),
    callbackUrl: text("callback_url").notNull(),
    callbackSecret: text("callback_secret"), // Null for polling mode
    status: text("status").notNull().default("active"), // 'active', 'inactive'
    lastSeen: integer("last_seen", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_agent_connections_user").on(table.userId),
    index("idx_agent_connections_status").on(table.status),
    unique("idx_agent_connections_unique").on(
      table.userId,
      table.framework,
      table.label,
    ),
  ],
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
  ],
);

// Messages table
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    correlationId: text("correlation_id"),
    direction: text("direction").notNull().default("outbound"),
    resource: text("resource").notNull().default("message.general"),
    action: text("action").notNull().default("share"),
    inResponseTo: text("in_response_to"),
    outcome: text("outcome"),
    outcomeDetails: text("outcome_details"),
    policiesEvaluated: text("policies_evaluated"),
    senderUserId: text("sender_user_id")
      .notNull()
      .references(() => users.id),
    senderConnectionId: text("sender_connection_id").references(
      () => agentConnections.id,
    ),
    senderAgent: text("sender_agent").notNull(),
    recipientType: text("recipient_type").notNull(), // 'user', 'group'
    recipientId: text("recipient_id").notNull(),
    recipientConnectionId: text("recipient_connection_id").references(
      () => agentConnections.id,
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
    classifiedDirection: text("classified_direction"),
    classifiedResource: text("classified_resource"),
    classifiedAction: text("classified_action"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    deliveredAt: integer("delivered_at", { mode: "timestamp" }),
  },
  (table) => [
    index("idx_messages_sender").on(table.senderUserId),
    index("idx_messages_sender_connection").on(table.senderConnectionId),
    index("idx_messages_recipient").on(table.recipientType, table.recipientId),
    index("idx_messages_connection").on(table.recipientConnectionId),
    index("idx_messages_status").on(table.status),
    index("idx_messages_correlation").on(table.correlationId),
    index("idx_messages_selectors").on(
      table.direction,
      table.resource,
      table.action,
    ),
    index("idx_messages_in_response_to").on(table.inResponseTo),
    index("idx_messages_resource_sender").on(
      table.resource,
      table.senderUserId,
    ),
    index("idx_messages_idempotency").on(table.idempotencyKey),
    unique("idx_messages_idempotency_sender").on(
      table.senderUserId,
      table.idempotencyKey,
    ),
  ],
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
    // Canonical selector/evaluation/lifecycle/provenance columns (SRV-010)
    direction: text("direction"), // 'outbound', 'inbound', ...
    resource: text("resource"), // 'message.general', 'calendar.event', ...
    action: text("action"), // 'share', 'request', ...
    effect: text("effect"), // 'allow', 'ask', 'deny'
    evaluator: text("evaluator"), // 'structured', 'heuristic', 'llm'
    effectiveFrom: integer("effective_from", { mode: "timestamp" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    maxUses: integer("max_uses"),
    remainingUses: integer("remaining_uses"),
    source: text("source"), // 'default', 'learned', ...
    derivedFromMessageId: text("derived_from_message_id").references(
      () => messages.id,
    ),
    // Legacy storage columns kept for migration compatibility
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
    index("idx_policies_lookup").on(
      table.userId,
      table.enabled,
      table.scope,
      table.targetId,
    ),
    index("idx_policies_selectors").on(
      table.direction,
      table.resource,
      table.action,
    ),
    index("idx_policies_lifecycle").on(
      table.effectiveFrom,
      table.expiresAt,
      table.remainingUses,
    ),
  ],
);

// Message deliveries table (for fan-out tracking in group messages)
export const messageDeliveries = sqliteTable(
  "message_deliveries",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    recipientUserId: text("recipient_user_id")
      .notNull()
      .references(() => users.id),
    recipientConnectionId: text("recipient_connection_id").references(
      () => agentConnections.id,
    ),
    policyDecision: text("policy_decision"), // 'allow', 'ask', 'deny'
    policyDeliveryMode: text("policy_delivery_mode"), // 'full_send', 'review_required', ...
    policyReason: text("policy_reason"),
    policyReasonCode: text("policy_reason_code"),
    policyResolutionId: text("policy_resolution_id"),
    winningPolicyId: text("winning_policy_id"),
    matchedPolicyIds: text("matched_policy_ids"), // JSON array of matched policy IDs
    resolverLayer: text("resolver_layer"),
    guardrailId: text("guardrail_id"),
    status: text("status").notNull().default("pending"), // 'pending', 'delivered', 'failed'
    retryCount: integer("retry_count").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    deliveredAt: integer("delivered_at", { mode: "timestamp" }),
  },
  (table) => [
    index("idx_message_deliveries_message").on(table.messageId),
    index("idx_message_deliveries_recipient").on(table.recipientUserId),
    index("idx_message_deliveries_status").on(table.status),
    index("idx_message_deliveries_policy_decision").on(table.policyDecision),
    unique("idx_message_deliveries_unique").on(
      table.messageId,
      table.recipientConnectionId,
    ),
  ],
);

// Groups table
export const groups = sqliteTable(
  "groups",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description"),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    inviteOnly: integer("invite_only", { mode: "boolean" })
      .notNull()
      .default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_groups_name").on(table.name),
    index("idx_groups_owner").on(table.ownerUserId),
  ],
);

// User preferences table (1:1 with users, stores user-level settings that sync across agents)
export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // Notification settings
  preferredChannel: text("preferred_channel"), // 'last_active', 'whatsapp', 'telegram', etc.
  urgentBehavior: text("urgent_behavior").notNull().default("preferred_only"), // 'all_channels', 'preferred_only'
  quietHoursEnabled: integer("quiet_hours_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  quietHoursStart: text("quiet_hours_start").default("22:00"), // HH:MM format
  quietHoursEnd: text("quiet_hours_end").default("07:00"), // HH:MM format
  quietHoursTimezone: text("quiet_hours_timezone").default("UTC"),
  // LLM policy defaults (can be overridden locally by agents)
  defaultLlmProvider: text("default_llm_provider"), // 'anthropic', 'openai', etc.
  defaultLlmModel: text("default_llm_model"), // model identifier
  // Timestamps
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Group memberships table
export const groupMemberships = sqliteTable(
  "group_memberships",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // 'owner', 'admin', 'member'
    status: text("status").notNull().default("pending"), // 'invited', 'pending', 'active'
    invitedByUserId: text("invited_by_user_id").references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_group_memberships_group").on(table.groupId),
    index("idx_group_memberships_user").on(table.userId),
    index("idx_group_memberships_status").on(table.status),
    unique("idx_group_memberships_unique").on(table.groupId, table.userId),
  ],
);

// User roles table (system + user-defined roles)
export const userRoles = sqliteTable(
  "user_roles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }), // NULL for system roles
    name: text("name").notNull(),
    description: text("description"),
    isSystem: integer("is_system", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_user_roles_user").on(table.userId),
    unique("idx_user_roles_unique_name").on(table.userId, table.name),
  ],
);

// Friend roles junction table (many-to-many: friendships can have multiple roles)
export const friendRoles = sqliteTable(
  "friend_roles",
  {
    friendshipId: text("friendship_id")
      .notNull()
      .references(() => friendships.id, { onDelete: "cascade" }),
    roleName: text("role_name").notNull(),
    assignedAt: integer("assigned_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_friend_roles_role").on(table.roleName),
    unique("idx_friend_roles_unique").on(table.friendshipId, table.roleName),
  ],
);

// Waitlist emails table
export const waitlistEmails = sqliteTable("waitlist_emails", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  email: text("email").notNull().unique(),
  source: text("source").notNull().default("landing"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Type exports for use in services
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AgentConnection = typeof agentConnections.$inferSelect;
export type NewAgentConnection = typeof agentConnections.$inferInsert;
export type InviteToken = typeof inviteTokens.$inferSelect;
export type NewInviteToken = typeof inviteTokens.$inferInsert;
export type BrowserLoginAttempt = typeof browserLoginAttempts.$inferSelect;
export type NewBrowserLoginAttempt = typeof browserLoginAttempts.$inferInsert;
export type BrowserSession = typeof browserSessions.$inferSelect;
export type NewBrowserSession = typeof browserSessions.$inferInsert;
export type Friendship = typeof friendships.$inferSelect;
export type NewFriendship = typeof friendships.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Policy = typeof policies.$inferSelect;
export type NewPolicy = typeof policies.$inferInsert;
export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type GroupMembership = typeof groupMemberships.$inferSelect;
export type NewGroupMembership = typeof groupMemberships.$inferInsert;
export type MessageDelivery = typeof messageDeliveries.$inferSelect;
export type NewMessageDelivery = typeof messageDeliveries.$inferInsert;
export type UserPreferences = typeof userPreferences.$inferSelect;
export type NewUserPreferences = typeof userPreferences.$inferInsert;
export type UserRole = typeof userRoles.$inferSelect;
export type NewUserRole = typeof userRoles.$inferInsert;
export type FriendRole = typeof friendRoles.$inferSelect;
export type NewFriendRole = typeof friendRoles.$inferInsert;
export type WaitlistEmail = typeof waitlistEmails.$inferSelect;
export type NewWaitlistEmail = typeof waitlistEmails.$inferInsert;
