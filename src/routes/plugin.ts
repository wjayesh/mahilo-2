import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { createHash } from "crypto";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  isInboundSelectorDirection,
  normalizeSelectorContext,
  normalizeSelectorDirection,
  SELECTOR_DIRECTIONS,
} from "@mahilo/policy-core";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { requireActive, requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/error";
import { getRolesForFriend, isValidRole } from "../services/roles";
import { loadUserLLMProviderDefaults } from "../services/preferences";
import { generatePolicySummary } from "../services/policySummary";
import { config } from "../config";
import { parseCapabilities, validatePayloadSize } from "../services/validation";
import { detectPromotionSuggestions } from "../services/promotionSuggestions";
import {
  consumeWinningPolicyUse,
  evaluateGroupPolicies,
  evaluateInboundPolicies,
  evaluatePolicies,
  loadApplicablePolicies,
  resolveContextPolicyGuidance,
  validatePolicyContent,
  type AuthenticatedSenderIdentity,
  type PolicyResult,
} from "../services/policy";
import {
  canonicalToStorage,
  dbPolicyToCanonical,
  type CanonicalPolicy,
  type PolicyDirection,
  type PolicyEffect,
  type PolicyScope,
} from "../services/policySchema";

const CONTRACT_VERSION = "1.0.0";

const knownSelectorResources = new Set<string>([
  "message.general",
  "profile.basic",
  "contact.email",
  "contact.phone",
  "location.current",
  "location.history",
  "calendar.availability",
  "calendar.event",
  "financial.balance",
  "financial.transaction",
  "health.metric",
  "health.summary",
]);

const legacySelectorResources = new Set<string>([
  "calendar",
  "location",
  "document",
  "contact",
  "action",
  "meta",
]);

const selectorTokenSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9._-]+$/i);

const selectorInputSchema = z.object({
  direction: z.enum(SELECTOR_DIRECTIONS).optional(),
  resource: selectorTokenSchema.optional(),
  action: selectorTokenSchema.optional(),
});

const selectorDirections = SELECTOR_DIRECTIONS;

const pluginContextRequestSchema = z.object({
  sender_connection_id: z.string().min(1),
  recipient: z.string().min(1),
  recipient_type: z.enum(["user", "group"]).optional().default("user"),
  draft_selectors: selectorInputSchema.optional(),
  declared_selectors: selectorInputSchema.optional(),
  include_recent_interactions: z.boolean().optional().default(true),
  interaction_limit: z.number().int().min(1).max(20).optional().default(5),
});

const pluginSendSelectorRequestSchema = z.object({
  recipient: z.string().min(1),
  recipient_type: z.enum(["user", "group"]).optional().default("user"),
  sender_connection_id: z.string().optional(),
  direction: z.enum(selectorDirections).optional(),
  resource: selectorTokenSchema.optional(),
  action: selectorTokenSchema.optional(),
  declared_selectors: selectorInputSchema.optional(),
});

const pluginDirectSendBundleRequestSchema = pluginSendSelectorRequestSchema;
const pluginGroupFanoutBundleRequestSchema =
  pluginSendSelectorRequestSchema.extend({
    recipient_type: z.enum(["group"]).optional().default("group"),
  });

const pluginResolveRequestSchema = pluginSendSelectorRequestSchema.extend({
  recipient_connection_id: z.string().optional(),
  routing_hints: z
    .object({
      labels: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  message: z.string().min(1),
  context: z.string().optional(),
  payload_type: z.string().optional().default("text/plain"),
  correlation_id: z.string().optional(),
  idempotency_key: z.string().optional(),
});

const localDecisionAuditPolicySchema = z.record(z.unknown());
const localPolicyDecisionDiagnosticTimingSchema = z.object({
  bundle_fetch_ms: z.number().finite().min(0).max(60 * 60 * 1000).optional(),
  evaluation_ms: z.number().finite().min(0).max(60 * 60 * 1000),
  llm_evaluator_ms: z.number().finite().min(0).max(60 * 60 * 1000).optional(),
  provider_ms: z.number().finite().min(0).max(60 * 60 * 1000).optional(),
  total_ms: z.number().finite().min(0).max(60 * 60 * 1000),
});
const localPolicyDecisionLLMDiagnosticsSchema = z.object({
  applicable_policy_count: z.number().int().min(0).max(100),
  degraded_cause: z.string().min(1).max(120).optional(),
  degraded_reason_code: z.string().min(1).max(255).optional(),
  evaluator_invocation_count: z.number().int().min(0).max(100),
  model: z.string().min(1).max(120).nullable(),
  provider: z.string().min(1).max(120).nullable(),
  provider_invocation_count: z.number().int().min(0).max(100),
});
const localPolicyDecisionWinningPolicyDiagnosticsSchema = z.object({
  effect: z.enum(["allow", "ask", "deny"]).nullable(),
  evaluator: z.enum(["structured", "heuristic", "llm"]).nullable(),
  policy_id: z.string().min(1).max(255).nullable(),
  scope: z.enum(["global", "user", "role", "group"]).nullable(),
});
const localPolicyDecisionRedactionDiagnosticsSchema = z.object({
  context: z.enum(["absent", "omitted"]),
  credentials: z.literal("omitted"),
  message: z.literal("omitted"),
  raw_prompt: z.literal("omitted"),
});
const localPolicyDecisionDiagnosticsSchema = z.object({
  applicable_policy_count: z.number().int().min(0).max(100),
  bundle_id: z.string().min(1).max(255),
  bundle_type: z.enum(["direct_send", "group_fanout"]),
  decision: z.enum(["allow", "ask", "deny"]),
  delivery_mode: z.enum([
    "full_send",
    "review_required",
    "hold_for_approval",
    "blocked",
  ]),
  diagnostic_version: z.literal("1.0.0"),
  evaluated_policy_count: z.number().int().min(0).max(100),
  llm: localPolicyDecisionLLMDiagnosticsSchema.optional(),
  matched_policy_count: z.number().int().min(0).max(100),
  reason_code: z.string().min(1).max(255),
  reason_kind: z.enum([
    "degraded_llm_review",
    "matched_policy",
    "no_match_default",
    "policy_resolved",
  ]),
  redaction: localPolicyDecisionRedactionDiagnosticsSchema,
  resolution_id: z.string().min(1).max(255),
  timing_ms: localPolicyDecisionDiagnosticTimingSchema,
  winning_policy: localPolicyDecisionWinningPolicyDiagnosticsSchema,
});

const pluginLocalDecisionCommitRequestSchema =
  pluginSendSelectorRequestSchema.extend({
    sender_connection_id: z.string().min(1),
    recipient_type: z.enum(["user"]).optional().default("user"),
    message: z.string().min(1),
    context: z.string().optional(),
    payload_type: z.string().optional().default("text/plain"),
    correlation_id: z.string().optional(),
    group_id: z.string().min(1).max(255).optional(),
    in_response_to: z.string().optional(),
    resolution_id: z.string().min(1).max(120),
    idempotency_key: z.string().min(1).max(255).optional(),
    local_decision: z.object({
      decision: z.enum(["allow", "ask", "deny"]),
      delivery_mode: z.enum([
        "full_send",
        "review_required",
        "hold_for_approval",
        "blocked",
      ]),
      summary: z.string().min(1).max(2000).optional(),
      reason: z.string().min(1).max(2000).optional(),
      reason_code: z.string().min(1).max(255).optional(),
      resolution_explanation: z.string().min(1).max(4000).optional(),
      resolver_layer: z
        .enum(["platform_guardrails", "user_policies"])
        .optional(),
      guardrail_id: z.string().min(1).max(255).optional(),
      winning_policy_id: z.string().min(1).max(255).optional(),
      matched_policy_ids: z
        .array(z.string().min(1).max(255))
        .max(100)
        .optional(),
      evaluated_policies: z
        .array(localDecisionAuditPolicySchema)
        .max(100)
        .optional(),
      diagnostics: localPolicyDecisionDiagnosticsSchema.optional(),
    }),
  });

const pluginOutcomeValues = [
  "sent",
  "partial_sent",
  "blocked",
  "review_requested",
  "review_approved",
  "review_rejected",
  "withheld",
  "send_failed",
] as const;

const pluginRecipientOutcomeSchema = z.object({
  recipient: z.string().min(1),
  outcome: z.enum(pluginOutcomeValues),
});

const pluginOutcomeRequestSchema = z.object({
  sender_connection_id: z.string().min(1),
  resolution_id: z.string().min(1).optional(),
  message_id: z.string().min(1),
  outcome: z.enum(pluginOutcomeValues),
  user_action: z.string().min(1).max(120).optional(),
  notes: z.string().min(1).max(2000).optional(),
  recipient_results: z.array(pluginRecipientOutcomeSchema).max(100).optional(),
  idempotency_key: z.string().min(1).max(255).optional(),
});

const pluginOverrideKinds = ["one_time", "temporary", "persistent"] as const;
const policyScopeSchema = z.enum(["global", "user", "group", "role"]);
const policyEffectSchema = z.enum(["allow", "ask", "deny"]);
const isoDateSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Invalid ISO date",
  });

const pluginOverrideRequestSchema = z.object({
  sender_connection_id: z.string().min(1),
  source_resolution_id: z.string().min(1).max(120).optional(),
  kind: z.enum(pluginOverrideKinds),
  scope: policyScopeSchema,
  target_id: z.string().min(1).nullable().optional(),
  selectors: selectorInputSchema,
  effect: policyEffectSchema.optional().default("allow"),
  reason: z.string().min(1).max(2000),
  max_uses: z.number().int().positive().nullable().optional(),
  expires_at: isoDateSchema.optional(),
  ttl_seconds: z
    .number()
    .int()
    .positive()
    .max(60 * 60 * 24 * 30)
    .optional(),
  derived_from_message_id: z.string().min(1).optional(),
  policy_content: z.record(z.unknown()).optional(),
  priority: z.number().int().min(0).max(100).optional().default(90),
});

type PluginContextRequest = z.infer<typeof pluginContextRequestSchema>;
type PluginResolveRequest = z.infer<typeof pluginResolveRequestSchema>;
type PluginLocalDecisionCommitRequest = z.infer<
  typeof pluginLocalDecisionCommitRequestSchema
>;
type PluginOutcomeRequest = z.infer<typeof pluginOutcomeRequestSchema>;
type PluginOverrideRequest = z.infer<typeof pluginOverrideRequestSchema>;
type PluginSendSelectorRequest = z.infer<
  typeof pluginSendSelectorRequestSchema
>;
type PluginReportedOutcome = (typeof pluginOutcomeValues)[number];
type PluginOverrideKind = (typeof pluginOverrideKinds)[number];
type ContextDecision = "allow" | "ask" | "deny";
type DeliveryMode =
  | "full_send"
  | "review_required"
  | "hold_for_approval"
  | "blocked";
type ReviewQueueStatus = "review_required" | "approval_pending";
type QueueDirectionFilter = "all" | "outbound" | "inbound";

const reviewQueueStatuses: readonly ReviewQueueStatus[] = [
  "review_required",
  "approval_pending",
];

const defaultSelectors = {
  action: "share",
  direction: "outbound" as const,
  resource: "message.general",
};

const GROUP_FANOUT_MIXED_DECISION_PRIORITY = ["allow", "ask", "deny"] as const;
const GROUP_FANOUT_EMPTY_SUMMARY = "No active recipients in group.";
const GROUP_FANOUT_PARTIAL_SUMMARY_TEMPLATE =
  "Partial group delivery: {delivered} delivered, {pending} pending, {denied} denied, {review_required} review-required, {failed} failed.";

export const pluginRoutes = new Hono<AppEnv>();
pluginRoutes.use("*", requireAuth());
function isNamespacedSelectorToken(value: string): boolean {
  return value.includes(".");
}

function isKnownSelectorResource(value: string): boolean {
  return (
    knownSelectorResources.has(value) || legacySelectorResources.has(value)
  );
}

function validateSelectors(selectors: {
  direction: PolicyDirection;
  resource: string;
  action: string;
}) {
  if (!SELECTOR_DIRECTIONS.includes(selectors.direction)) {
    throw new AppError(
      `Unknown direction selector '${selectors.direction}'`,
      400,
      "INVALID_SELECTOR",
    );
  }

  if (
    isKnownSelectorResource(selectors.resource) ||
    isNamespacedSelectorToken(selectors.resource)
  ) {
    return;
  }

  throw new AppError(
    `Unknown resource selector '${selectors.resource}'. Use a known resource or a namespaced selector like 'custom.preference'.`,
    400,
    "INVALID_SELECTOR",
  );
}

function resolveContextSelectors(data: PluginContextRequest) {
  const selectorSource = data.draft_selectors || data.declared_selectors;
  const selectors = normalizeSelectorContext(selectorSource, {
    fallbackAction: defaultSelectors.action,
    fallbackDirection: defaultSelectors.direction,
    fallbackResource: defaultSelectors.resource,
    normalizeSeparators: true,
  });
  validateSelectors(selectors);
  return selectors;
}

function resolveDraftSelectors(data: PluginSendSelectorRequest) {
  const selectorSource = data.declared_selectors;
  const selectors = normalizeSelectorContext(
    {
      action: selectorSource?.action ?? data.action,
      direction: selectorSource?.direction ?? data.direction,
      resource: selectorSource?.resource ?? data.resource,
    },
    {
      fallbackAction: defaultSelectors.action,
      fallbackDirection: defaultSelectors.direction,
      fallbackResource: defaultSelectors.resource,
      normalizeSeparators: true,
    },
  );
  validateSelectors(selectors);
  return selectors;
}

function resolveOverrideSelectors(data: PluginOverrideRequest) {
  const selectors = normalizeSelectorContext(data.selectors, {
    fallbackAction: defaultSelectors.action,
    fallbackDirection: defaultSelectors.direction,
    fallbackResource: defaultSelectors.resource,
    normalizeSeparators: true,
  });
  validateSelectors(selectors);
  return selectors;
}

function assertScopeTarget(scope: PolicyScope, targetId: string | null) {
  if (scope === "global" && targetId) {
    throw new AppError(
      "Global overrides cannot include target_id",
      400,
      "INVALID_OVERRIDE",
    );
  }

  if (
    (scope === "user" || scope === "group" || scope === "role") &&
    !targetId
  ) {
    throw new AppError(
      `${scope} overrides require target_id`,
      400,
      "INVALID_OVERRIDE",
    );
  }
}

async function assertGroupPolicyAccess(userId: string, groupId: string) {
  const db = getDb();
  const [group] = await db
    .select({ id: schema.groups.id })
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .limit(1);

  if (!group) {
    throw new AppError("Target group not found", 404, "GROUP_NOT_FOUND");
  }

  const [membership] = await db
    .select({ role: schema.groupMemberships.role })
    .from(schema.groupMemberships)
    .where(
      and(
        eq(schema.groupMemberships.groupId, groupId),
        eq(schema.groupMemberships.userId, userId),
        eq(schema.groupMemberships.status, "active"),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new AppError("Not a member of this group", 403, "NOT_MEMBER");
  }

  if (membership.role !== "owner" && membership.role !== "admin") {
    throw new AppError(
      "Only group owners and admins can create group-scoped overrides",
      403,
      "FORBIDDEN",
    );
  }
}

function resolveOverrideLifecycle(data: PluginOverrideRequest): {
  expires_at: string | null;
  max_uses: number | null;
  remaining_uses: number | null;
} {
  if (data.expires_at && data.ttl_seconds !== undefined) {
    throw new AppError(
      "Provide either expires_at or ttl_seconds, not both",
      400,
      "INVALID_OVERRIDE",
    );
  }

  let expiresAt: string | null = null;
  if (data.expires_at) {
    expiresAt = new Date(data.expires_at).toISOString();
  } else if (data.ttl_seconds !== undefined) {
    expiresAt = new Date(Date.now() + data.ttl_seconds * 1000).toISOString();
  }

  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    throw new AppError(
      "expires_at must be in the future",
      400,
      "INVALID_OVERRIDE",
    );
  }

  if (data.kind === "one_time") {
    if (data.max_uses !== undefined && data.max_uses !== 1) {
      throw new AppError(
        "one_time overrides require max_uses = 1",
        400,
        "INVALID_OVERRIDE",
      );
    }
    return {
      expires_at: expiresAt,
      max_uses: 1,
      remaining_uses: 1,
    };
  }

  if (data.kind === "temporary") {
    if (!expiresAt) {
      throw new AppError(
        "temporary overrides require expires_at or ttl_seconds",
        400,
        "INVALID_OVERRIDE",
      );
    }
    const maxUses = data.max_uses ?? null;
    return {
      expires_at: expiresAt,
      max_uses: maxUses,
      remaining_uses: maxUses,
    };
  }

  if (expiresAt) {
    throw new AppError(
      "persistent overrides cannot include expires_at or ttl_seconds",
      400,
      "INVALID_OVERRIDE",
    );
  }

  if (data.max_uses !== undefined && data.max_uses !== null) {
    throw new AppError(
      "persistent overrides cannot include max_uses",
      400,
      "INVALID_OVERRIDE",
    );
  }

  return {
    expires_at: null,
    max_uses: null,
    remaining_uses: null,
  };
}

function parseDirectionCandidate(value: unknown): PolicyDirection {
  return normalizeSelectorDirection(
    typeof value === "string" ? value : undefined,
    defaultSelectors.direction,
  )!;
}

function isInboundDirection(direction: PolicyDirection): boolean {
  return isInboundSelectorDirection(direction);
}

function resolveDeliveryMode(
  decision: ContextDecision,
  direction: PolicyDirection,
): DeliveryMode {
  if (decision === "deny") {
    return "blocked";
  }
  if (decision === "ask") {
    if (
      isInboundDirection(direction) &&
      config.inboundAskMode === "hold_for_approval"
    ) {
      return "hold_for_approval";
    }
    return "review_required";
  }
  return "full_send";
}

function defaultReasonCode(decision: ContextDecision): string {
  if (decision === "ask") {
    return "policy.ask.resolved";
  }
  if (decision === "deny") {
    return "policy.deny.resolved";
  }
  return "policy.allow.resolved";
}

function resolvePreviewReasonCode(
  decision: ContextDecision,
  authoritative: boolean,
): string {
  if (!authoritative) {
    return "plugin.resolve.preview_only";
  }

  return defaultReasonCode(decision);
}

function buildAgentResolutionSummary(
  decision: ContextDecision,
  deliveryMode: DeliveryMode,
  options: {
    authoritative?: boolean;
  } = {},
): string {
  if (options.authoritative === false) {
    return "Preview only. Live non-trusted sends require bundle evaluation and local decision commit before transport.";
  }

  if (decision === "ask") {
    return deliveryMode === "hold_for_approval"
      ? "Message held for approval before delivery."
      : "Message requires review before delivery.";
  }
  if (decision === "deny") {
    return "Message blocked by policy.";
  }
  return "Message allowed by policy.";
}

function buildAgentGuidance(
  decision: ContextDecision,
  deliveryMode: DeliveryMode,
  options: {
    authoritative?: boolean;
  } = {},
): string {
  if (options.authoritative === false) {
    return "Preview only. Do not treat this as send authorization. For live non-trusted sends, fetch a policy bundle, evaluate locally, commit the decision, and transport only committed allow recipients.";
  }

  if (decision === "allow") {
    return "Proceed with final send. Mahilo will evaluate policies again at send time.";
  }

  if (decision === "ask") {
    if (deliveryMode === "hold_for_approval") {
      return "This draft will be held for approval. Request approval or create an override.";
    }
    return "This draft requires review before delivery. Ask for approval or create an override.";
  }

  return "This draft is blocked by policy. Adjust content or create an explicit override.";
}

async function resolveSenderConnection(
  userId: string,
  senderConnectionId?: string,
): Promise<schema.AgentConnection> {
  const db = getDb();

  if (senderConnectionId) {
    const [senderConnection] = await db
      .select()
      .from(schema.agentConnections)
      .where(
        and(
          eq(schema.agentConnections.id, senderConnectionId),
          eq(schema.agentConnections.userId, userId),
          eq(schema.agentConnections.status, "active"),
        ),
      )
      .limit(1);

    if (!senderConnection) {
      throw new AppError(
        "Sender connection not found or inactive",
        404,
        "SENDER_CONNECTION_NOT_FOUND",
      );
    }

    return senderConnection;
  }

  const [senderConnection] = await db
    .select()
    .from(schema.agentConnections)
    .where(
      and(
        eq(schema.agentConnections.userId, userId),
        eq(schema.agentConnections.status, "active"),
      ),
    )
    .orderBy(
      desc(schema.agentConnections.routingPriority),
      desc(schema.agentConnections.createdAt),
    )
    .limit(1);

  if (!senderConnection) {
    throw new AppError(
      "Sender connection not found or inactive",
      404,
      "SENDER_CONNECTION_NOT_FOUND",
    );
  }

  return senderConnection;
}

async function loadDirectUserRecipientAccess(
  senderUserId: string,
  recipientValue: string,
  notFriendsStatus = 403,
): Promise<{
  friendship: {
    createdAt: Date | null;
  };
  recipient: {
    displayName: string | null;
    id: string;
    username: string;
  };
}> {
  const db = getDb();
  const recipient = await loadRecipientUserRecord(recipientValue);

  const [friendship] = await db
    .select({
      createdAt: schema.friendships.createdAt,
    })
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.status, "accepted"),
        or(
          and(
            eq(schema.friendships.requesterId, senderUserId),
            eq(schema.friendships.addresseeId, recipient.id),
          ),
          and(
            eq(schema.friendships.requesterId, recipient.id),
            eq(schema.friendships.addresseeId, senderUserId),
          ),
        ),
      ),
    )
    .limit(1);

  if (!friendship) {
    throw new AppError(
      "Not friends with recipient",
      notFriendsStatus,
      "NOT_FRIENDS",
    );
  }

  return { friendship, recipient };
}

async function loadRecipientUserRecord(recipientValue: string): Promise<{
  displayName: string | null;
  id: string;
  username: string;
}> {
  const db = getDb();
  const recipientUsername = recipientValue.toLowerCase();
  const [recipient] = await db
    .select({
      displayName: schema.users.displayName,
      id: schema.users.id,
      username: schema.users.username,
    })
    .from(schema.users)
    .where(eq(schema.users.username, recipientUsername))
    .limit(1);

  if (!recipient) {
    throw new AppError("Recipient user not found", 404, "USER_NOT_FOUND");
  }

  return recipient;
}

async function loadLocalDecisionRecipientAccess(
  senderUserId: string,
  recipientValue: string,
  groupId?: string,
): Promise<{
  group: {
    id: string;
    name: string;
  } | null;
  recipient: {
    displayName: string | null;
    id: string;
    username: string;
  };
}> {
  if (!groupId) {
    const { recipient } = await loadDirectUserRecipientAccess(
      senderUserId,
      recipientValue,
    );

    return {
      group: null,
      recipient,
    };
  }

  const db = getDb();
  const recipient = await loadRecipientUserRecord(recipientValue);
  const { group } = await resolveGroupRecipient(senderUserId, groupId);
  const [membership] = await db
    .select({ id: schema.groupMemberships.id })
    .from(schema.groupMemberships)
    .where(
      and(
        eq(schema.groupMemberships.groupId, groupId),
        eq(schema.groupMemberships.userId, recipient.id),
        eq(schema.groupMemberships.status, "active"),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new AppError(
      "Recipient is no longer an active member of this group",
      409,
      "LOCAL_DECISION_STALE",
    );
  }

  return {
    group,
    recipient,
  };
}

async function resolveUserRecipient(
  senderUserId: string,
  data: PluginResolveRequest,
): Promise<{
  recipientConnection: schema.AgentConnection;
  recipientUserId: string;
}> {
  const db = getDb();
  const { recipient } = await loadDirectUserRecipientAccess(
    senderUserId,
    data.recipient,
  );

  if (data.recipient_connection_id) {
    const [recipientConnection] = await db
      .select()
      .from(schema.agentConnections)
      .where(
        and(
          eq(schema.agentConnections.id, data.recipient_connection_id),
          eq(schema.agentConnections.userId, recipient.id),
          eq(schema.agentConnections.status, "active"),
        ),
      )
      .limit(1);

    if (!recipientConnection) {
      throw new AppError(
        "Recipient connection not found or inactive",
        404,
        "CONNECTION_NOT_FOUND",
      );
    }

    return { recipientConnection, recipientUserId: recipient.id };
  }

  const connections = await db
    .select()
    .from(schema.agentConnections)
    .where(
      and(
        eq(schema.agentConnections.userId, recipient.id),
        eq(schema.agentConnections.status, "active"),
      ),
    )
    .orderBy(desc(schema.agentConnections.routingPriority));

  if (connections.length === 0) {
    throw new AppError(
      "Recipient has no active connections",
      404,
      "NO_CONNECTIONS",
    );
  }

  let recipientConnection: schema.AgentConnection | undefined;

  if (data.routing_hints?.labels?.length) {
    recipientConnection = connections.find((connection) =>
      data.routing_hints!.labels!.includes(connection.label),
    );
  }

  if (!recipientConnection && data.routing_hints?.tags?.length) {
    recipientConnection = connections.find((connection) => {
      const capabilities = parseCapabilities(connection.capabilities);
      return data.routing_hints!.tags!.some((tag: string) =>
        capabilities.includes(tag),
      );
    });
  }

  return {
    recipientConnection: recipientConnection || connections[0],
    recipientUserId: recipient.id,
  };
}

async function resolveGroupRecipient(
  senderUserId: string,
  groupId: string,
): Promise<{
  group: {
    id: string;
    name: string;
  };
}> {
  const db = getDb();
  const [group] = await db
    .select({
      id: schema.groups.id,
      name: schema.groups.name,
    })
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .limit(1);

  if (!group) {
    throw new AppError("Group not found", 404, "GROUP_NOT_FOUND");
  }

  const [senderMembership] = await db
    .select()
    .from(schema.groupMemberships)
    .where(
      and(
        eq(schema.groupMemberships.groupId, groupId),
        eq(schema.groupMemberships.userId, senderUserId),
        eq(schema.groupMemberships.status, "active"),
      ),
    )
    .limit(1);

  if (!senderMembership) {
    throw new AppError("Not a member of this group", 403, "NOT_MEMBER");
  }

  return { group };
}

async function loadGroupFanoutMembers(
  senderUserId: string,
  groupId: string,
): Promise<{
  group: {
    id: string;
    name: string;
  };
  members: Array<{
    userId: string;
    username: string;
  }>;
}> {
  const db = getDb();
  const { group } = await resolveGroupRecipient(senderUserId, groupId);
  const members = await db
    .select({
      userId: schema.groupMemberships.userId,
      username: schema.users.username,
    })
    .from(schema.groupMemberships)
    .innerJoin(
      schema.users,
      eq(schema.groupMemberships.userId, schema.users.id),
    )
    .where(
      and(
        eq(schema.groupMemberships.groupId, groupId),
        eq(schema.groupMemberships.status, "active"),
        ne(schema.groupMemberships.userId, senderUserId),
      ),
    );

  return { group, members };
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function parseJsonValue(value: string | null): unknown {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseOutcomeAuditContainer(value: string | null): {
  container: Record<string, unknown>;
  reports: Record<string, unknown>[];
} {
  const parsed = parseJsonValue(value);
  const container =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : value
        ? { prior_outcome_details: parsed }
        : {};

  const reportEntries = Array.isArray(container.plugin_outcome_reports)
    ? container.plugin_outcome_reports
        .filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry),
        )
        .map((entry) => ({ ...entry }))
    : [];

  return { container, reports: reportEntries };
}

function findOutcomeEventByIdempotency(
  value: string | null,
  idempotencyKey: string,
): string | null {
  const { reports } = parseOutcomeAuditContainer(value);
  const existing = reports.find(
    (report) => report.idempotency_key === idempotencyKey,
  );
  return typeof existing?.event_id === "string" ? existing.event_id : null;
}

function resolveRequestIdempotencyKey(
  data: { idempotency_key?: string },
  idempotencyHeader: string | undefined,
): string | null {
  const source = data.idempotency_key || idempotencyHeader;
  if (!source) {
    return null;
  }
  const normalized = source.trim();
  return normalized.length > 0 ? normalized : null;
}

interface PluginOutcomeAuditEntry {
  event_id: string;
  message_id: string;
  resolution_id: string;
  outcome: PluginReportedOutcome;
  user_action: string | null;
  notes: string | null;
  recipient_results: Array<{
    recipient: string;
    outcome: PluginReportedOutcome;
  }>;
  idempotency_key: string | null;
  reported_by_user_id: string;
  sender_connection_id: string;
  reported_at: string;
  correlation: {
    correlation_id: string | null;
    in_response_to: string | null;
    selectors: {
      direction: string;
      resource: string;
      action: string;
    };
  };
}

function buildOutcomeAuditDetails(
  existingValue: string | null,
  reportEntry: PluginOutcomeAuditEntry,
): string {
  const { container, reports } = parseOutcomeAuditContainer(existingValue);
  const updatedReports = [...reports, reportEntry];
  container.plugin_outcome_reports = updatedReports;
  container.latest_plugin_outcome_event_id = reportEntry.event_id;
  container.latest_plugin_outcome = reportEntry.outcome;
  container.latest_plugin_outcome_at = reportEntry.reported_at;
  return JSON.stringify(container);
}

function summarizeMessage(payload: string, maxLength = 140): string {
  const normalized = payload.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function parseDecision(value: unknown): ContextDecision | null {
  if (value === "allow" || value === "ask" || value === "deny") {
    return value;
  }
  return null;
}

function parseReasonCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
}

function normalizeOptionalText(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function assertLocalDecisionDeliveryMode(
  decision: ContextDecision,
  deliveryMode: DeliveryMode,
) {
  if (decision === "allow" && deliveryMode === "full_send") {
    return;
  }

  if (decision === "deny" && deliveryMode === "blocked") {
    return;
  }

  if (
    decision === "ask" &&
    (deliveryMode === "review_required" || deliveryMode === "hold_for_approval")
  ) {
    return;
  }

  throw new AppError(
    "local_decision.delivery_mode is incompatible with local_decision.decision",
    400,
    "INVALID_LOCAL_DECISION",
  );
}

function localDecisionMessageStatus(
  decision: ContextDecision,
  deliveryMode: DeliveryMode,
): schema.Message["status"] {
  if (decision === "allow") {
    return "pending";
  }

  if (decision === "deny") {
    return "rejected";
  }

  return deliveryMode === "hold_for_approval"
    ? "approval_pending"
    : "review_required";
}

function policyEvaluationPhaseForEvaluator(
  evaluator: CanonicalPolicy["evaluator"],
) {
  return evaluator === "llm" ? "contextual_llm" : "deterministic";
}

function buildPolicyLifecycleAudit(policy: CanonicalPolicy, userId: string) {
  return {
    source: policy.source,
    created_by_user_id: userId,
    derived_from_message_id: policy.derived_from_message_id,
    learning_provenance: policy.learning_provenance ?? null,
    effective_from: policy.effective_from,
    expires_at: policy.expires_at,
    max_uses: policy.max_uses,
    remaining_uses: policy.remaining_uses,
    created_at: policy.created_at,
  };
}

function buildWinningPolicyAudit(
  policy: CanonicalPolicy,
  userId: string,
  reason: string | null,
  reasonCode: string,
) {
  return {
    policy_id: policy.id,
    scope: policy.scope,
    evaluator: policy.evaluator,
    effect: policy.effect,
    priority: policy.priority,
    phase: policyEvaluationPhaseForEvaluator(policy.evaluator),
    reason: reason || undefined,
    reason_code: reasonCode,
    ...buildPolicyLifecycleAudit(policy, userId),
  };
}

function buildFallbackEvaluatedPolicyAudit(
  policy: CanonicalPolicy,
  userId: string,
  matched: boolean,
  reason: string | null,
) {
  return {
    policy_id: policy.id,
    scope: policy.scope,
    evaluator: policy.evaluator,
    effect: policy.effect,
    priority: policy.priority,
    phase: policyEvaluationPhaseForEvaluator(policy.evaluator),
    matched,
    ...(reason ? { reason } : {}),
    ...buildPolicyLifecycleAudit(policy, userId),
  };
}

function buildLocalDecisionPolicyEvaluation(args: {
  userId: string;
  senderConnectionId: string;
  resolutionId: string;
  committedAt: string;
  groupId: string | null;
  selectors: { direction: PolicyDirection; resource: string; action: string };
  decision: ContextDecision;
  reason: string | null;
  reasonCode: string;
  summary: string;
  resolutionExplanation: string;
  resolverLayer: string | null;
  guardrailId: string | null;
  winningPolicy: CanonicalPolicy | null;
  matchedPolicyIds: string[];
  evaluatedPolicies: Record<string, unknown>[];
  localPolicyDiagnostics?: Record<string, unknown> | null;
}) {
  return JSON.stringify({
    authenticated_identity: {
      sender_user_id: args.userId,
      sender_connection_id: args.senderConnectionId,
    },
    effect: args.decision,
    reason: args.reason,
    reason_code: args.reasonCode,
    resolution_explanation: args.resolutionExplanation,
    resolver_layer: args.resolverLayer,
    guardrail_id: args.guardrailId,
    winning_policy_id: args.winningPolicy?.id ?? null,
    winning_policy: args.winningPolicy
      ? buildWinningPolicyAudit(
          args.winningPolicy,
          args.userId,
          args.reason,
          args.reasonCode,
        )
      : null,
    matched_policy_ids: args.matchedPolicyIds,
    evaluated_policies: args.evaluatedPolicies,
    policy_owner_user_id: args.userId,
    policy_evaluation_mode: "plugin_local_pre_delivery",
    selector_context: args.selectors,
    local_decision_commit: {
      source: "plugin.local_decisions.commit",
      resolution_id: args.resolutionId,
      committed_at: args.committedAt,
      summary: args.summary,
      ...(args.groupId ? { group_id: args.groupId } : {}),
    },
    local_policy_diagnostics: args.localPolicyDiagnostics ?? null,
  });
}

function buildCommittedMessageResolution(message: {
  id: string;
  resolutionId: string | null;
  direction: string;
  status: string;
  outcome: string | null;
  policiesEvaluated: string | null;
}) {
  const evaluation = parseJsonObject(message.policiesEvaluated);
  const decision =
    parseDecision(evaluation?.effect) ||
    parseDecision(message.outcome) ||
    (message.status === "rejected"
      ? "deny"
      : message.status === "review_required" ||
          message.status === "approval_pending"
        ? "ask"
        : "allow");
  const direction = parseDirectionCandidate(message.direction);
  const deliveryMode =
    message.status === "review_required"
      ? "review_required"
      : message.status === "approval_pending"
        ? "hold_for_approval"
        : resolveDeliveryMode(decision, direction);

  return {
    resolution_id: message.resolutionId || `res_${message.id}`,
    decision,
    delivery_mode: deliveryMode,
    summary:
      parseStringValue(evaluation?.reason) ||
      parseStringValue(evaluation?.resolution_explanation) ||
      buildAgentResolutionSummary(decision, deliveryMode),
    reason_code:
      parseReasonCode(evaluation?.reason_code) || defaultReasonCode(decision),
  };
}

function buildCommittedMessageResponse(
  message: {
    id: string;
    resolutionId: string | null;
    direction: string;
    status: string;
    outcome: string | null;
    policiesEvaluated: string | null;
  },
  recipient: string,
) {
  const resolution = buildCommittedMessageResolution(message);
  return {
    message_id: message.id,
    status: message.status,
    resolution,
    recipient_results: [
      {
        recipient,
        decision: resolution.decision,
        delivery_mode: resolution.delivery_mode,
        delivery_status: message.status,
      },
    ],
  };
}

function buildLocalDecisionCommitResponse(
  message: {
    id: string;
    resolutionId: string | null;
    direction: string;
    status: string;
    outcome: string | null;
    policiesEvaluated: string | null;
  },
  recipient: string,
  deduplicated = false,
) {
  return {
    committed: true,
    ...(deduplicated ? { deduplicated: true } : {}),
    ...buildCommittedMessageResponse(message, recipient),
  };
}

function assertCommittedMessageMatchesLocalDecision(
  message: {
    direction: string;
    id: string;
    outcome: string | null;
    payload: string;
    payloadType: string;
    policiesEvaluated: string | null;
    recipientId: string;
    recipientType: string;
    resolutionId: string | null;
    senderConnectionId: string | null;
    status: string;
    context: string | null;
    resource: string;
    action: string;
  },
  input: {
    senderConnectionId: string;
    resolutionId: string;
    recipientId: string;
    recipientType: PluginLocalDecisionCommitRequest["recipient_type"];
    groupId: string | null;
    selectors: ReturnType<typeof resolveDraftSelectors>;
    payload: string;
    payloadType: string;
    context: string | null;
    decision: ContextDecision;
    deliveryMode: DeliveryMode;
  },
) {
  if (message.resolutionId && message.resolutionId !== input.resolutionId) {
    throw new AppError(
      "idempotency_key is already bound to a different resolution_id",
      409,
      "LOCAL_DECISION_CONFLICT",
    );
  }

  if (
    message.senderConnectionId &&
    message.senderConnectionId !== input.senderConnectionId
  ) {
    throw new AppError(
      "resolution_id is already bound to a different sender connection",
      409,
      "LOCAL_DECISION_CONFLICT",
    );
  }

  if (
    message.recipientType !== input.recipientType ||
    message.recipientId !== input.recipientId
  ) {
    throw new AppError(
      "resolution_id is already bound to a different recipient",
      409,
      "LOCAL_DECISION_CONFLICT",
    );
  }

  if (
    message.direction !== input.selectors.direction ||
    message.resource !== input.selectors.resource ||
    message.action !== input.selectors.action
  ) {
    throw new AppError(
      "resolution_id is already bound to different selectors",
      409,
      "LOCAL_DECISION_CONFLICT",
    );
  }

  if (
    message.payload !== input.payload ||
    message.payloadType !== input.payloadType
  ) {
    throw new AppError(
      "resolution_id is already bound to different payload content",
      409,
      "LOCAL_DECISION_CONFLICT",
    );
  }

  if (
    normalizeOptionalText(message.context) !==
    normalizeOptionalText(input.context)
  ) {
    throw new AppError(
      "resolution_id is already bound to different context",
      409,
      "LOCAL_DECISION_CONFLICT",
    );
  }

  const evaluation = parseJsonObject(message.policiesEvaluated);
  const localDecisionCommit = parseObjectValue(
    evaluation?.local_decision_commit,
  );
  const storedGroupId = parseStringValue(localDecisionCommit?.group_id);
  if (storedGroupId || input.groupId) {
    if (storedGroupId !== input.groupId) {
      throw new AppError(
        "resolution_id is already bound to a different group context",
        409,
        "LOCAL_DECISION_CONFLICT",
      );
    }
  }

  const existingResolution = buildCommittedMessageResolution(message);
  if (
    existingResolution.decision !== input.decision ||
    existingResolution.delivery_mode !== input.deliveryMode
  ) {
    throw new AppError(
      "resolution_id is already bound to a different local decision",
      409,
      "LOCAL_DECISION_CONFLICT",
    );
  }
}

function parsePositiveLimit(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError(
      "limit must be a positive integer",
      400,
      "INVALID_QUERY",
    );
  }
  return Math.min(parsed, 100);
}

function parseBoundedIntegerQuery(
  value: string | undefined,
  fieldName: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new AppError(`${fieldName} must be an integer`, 400, "INVALID_QUERY");
  }

  if (parsed < min || parsed > max) {
    throw new AppError(
      `${fieldName} must be between ${min} and ${max}`,
      400,
      "INVALID_QUERY",
    );
  }

  return parsed;
}

function parseQueueDirectionFilter(
  value: string | undefined,
): QueueDirectionFilter {
  if (!value || value === "all") {
    return "all";
  }
  if (value === "outbound" || value === "inbound") {
    return value;
  }
  throw new AppError(
    "direction must be one of: all, outbound, inbound",
    400,
    "INVALID_QUERY",
  );
}

function parseReviewStatusFilter(
  value: string | undefined,
): ReviewQueueStatus[] {
  if (!value) {
    return [...reviewQueueStatuses];
  }

  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    throw new AppError(
      "status must include at least one value",
      400,
      "INVALID_QUERY",
    );
  }

  const statuses = new Set<ReviewQueueStatus>();
  for (const token of tokens) {
    if (token === "review_required" || token === "approval_pending") {
      statuses.add(token);
      continue;
    }
    throw new AppError(
      "status must be one of: review_required, approval_pending",
      400,
      "INVALID_QUERY",
    );
  }

  return [...statuses];
}

function parseBooleanQueryFlag(
  value: string | undefined,
  fieldName: string,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (value === "true" || value === "1") {
    return true;
  }

  if (value === "false" || value === "0") {
    return false;
  }

  throw new AppError(
    `${fieldName} must be true or false`,
    400,
    "INVALID_QUERY",
  );
}

function buildMessageVisibilityFilter(
  userId: string,
  direction: QueueDirectionFilter,
) {
  const outboundFilter = eq(schema.messages.senderUserId, userId);
  const inboundFilter = and(
    eq(schema.messages.recipientType, "user"),
    eq(schema.messages.recipientId, userId),
  );

  if (direction === "outbound") {
    return outboundFilter;
  }

  if (direction === "inbound") {
    return inboundFilter;
  }

  return or(outboundFilter, inboundFilter);
}

function resolveQueueDirection(
  userId: string,
  message: { senderUserId: string; recipientType: string; recipientId: string },
): "outbound" | "inbound" {
  if (message.senderUserId === userId) {
    return "outbound";
  }
  if (message.recipientType === "user" && message.recipientId === userId) {
    return "inbound";
  }
  return "outbound";
}

function hashPayload(payload: string): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function parseReasonSummary(
  evaluation: Record<string, unknown> | null,
  fallback: string,
): string {
  if (typeof evaluation?.reason === "string" && evaluation.reason.length > 0) {
    return evaluation.reason;
  }

  if (
    typeof evaluation?.resolution_explanation === "string" &&
    evaluation.resolution_explanation.length > 0
  ) {
    return evaluation.resolution_explanation;
  }

  return fallback;
}

function parseStringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseBooleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseObjectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseSelectorContext(value: unknown): {
  direction: string | null;
  resource: string | null;
  action: string | null;
} | null {
  const parsed = parseObjectValue(value);
  if (!parsed) {
    return null;
  }

  return {
    direction: parseStringValue(parsed.direction),
    resource: parseStringValue(parsed.resource),
    action: parseStringValue(parsed.action),
  };
}

function parseSelectorVerification(value: unknown): {
  classifier_version: string | null;
  classification_status: string | null;
  mismatch: boolean | null;
  mismatch_fields: string[];
  declared_selectors: {
    direction: string | null;
    resource: string | null;
    action: string | null;
  } | null;
  classified_selectors: {
    direction: string | null;
    resource: string | null;
    action: string | null;
  } | null;
} | null {
  const parsed = parseObjectValue(value);
  if (!parsed) {
    return null;
  }

  return {
    classifier_version: parseStringValue(parsed.classifier_version),
    classification_status: parseStringValue(parsed.classification_status),
    mismatch: parseBooleanValue(parsed.mismatch),
    mismatch_fields: parseStringArray(parsed.mismatch_fields),
    declared_selectors: parseSelectorContext(parsed.declared_selectors),
    classified_selectors: parseSelectorContext(parsed.classified_selectors),
  };
}

function parseAuthenticatedIdentity(value: unknown): {
  sender_user_id: string | null;
  sender_connection_id: string | null;
} | null {
  const parsed = parseObjectValue(value);
  if (!parsed) {
    return null;
  }

  return {
    sender_user_id: parseStringValue(parsed.sender_user_id),
    sender_connection_id: parseStringValue(parsed.sender_connection_id),
  };
}

function parseLearningProvenance(value: unknown): {
  source_interaction_id: string | null;
  promoted_from_policy_ids: string[];
} | null {
  const parsed = parseObjectValue(value);
  if (!parsed) {
    return null;
  }

  return {
    source_interaction_id: parseStringValue(parsed.source_interaction_id),
    promoted_from_policy_ids: parseStringArray(parsed.promoted_from_policy_ids),
  };
}

function parseLocalDecisionCommitAudit(value: unknown): {
  source: string | null;
  resolution_id: string | null;
  committed_at: string | null;
  summary: string | null;
  group_id: string | null;
} | null {
  const parsed = parseObjectValue(value);
  if (!parsed) {
    return null;
  }

  return {
    source: parseStringValue(parsed.source),
    resolution_id: parseStringValue(parsed.resolution_id),
    committed_at: parseStringValue(parsed.committed_at),
    summary: parseStringValue(parsed.summary),
    group_id: parseStringValue(parsed.group_id),
  };
}

function parseWinningPolicyAudit(
  value: unknown,
): Record<string, unknown> | null {
  const parsed = parseObjectValue(value);
  if (!parsed) {
    return null;
  }

  return {
    policy_id: parseStringValue(parsed.policy_id),
    scope: parseStringValue(parsed.scope),
    evaluator: parseStringValue(parsed.evaluator),
    effect: parseStringValue(parsed.effect),
    priority: parseNumberValue(parsed.priority),
    phase: parseStringValue(parsed.phase),
    reason: parseStringValue(parsed.reason),
    source: parseStringValue(parsed.source),
    created_by_user_id: parseStringValue(parsed.created_by_user_id),
    derived_from_message_id: parseStringValue(parsed.derived_from_message_id),
    effective_from: parseStringValue(parsed.effective_from),
    expires_at: parseStringValue(parsed.expires_at),
    max_uses: parseNumberValue(parsed.max_uses),
    remaining_uses: parseNumberValue(parsed.remaining_uses),
    created_at: parseStringValue(parsed.created_at),
    learning_provenance: parseLearningProvenance(parsed.learning_provenance),
  };
}

function parseEvaluatedPolicyAudit(evaluation: Record<string, unknown> | null) {
  if (!Array.isArray(evaluation?.evaluated_policies)) {
    return [];
  }

  return evaluation.evaluated_policies
    .map((entry) => parseObjectValue(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      policy_id: parseStringValue(entry.policy_id),
      scope: parseStringValue(entry.scope),
      evaluator: parseStringValue(entry.evaluator),
      effect: parseStringValue(entry.effect),
      priority: parseNumberValue(entry.priority),
      phase: parseStringValue(entry.phase),
      matched: parseBooleanValue(entry.matched),
      skipped: parseBooleanValue(entry.skipped),
      skip_reason: parseStringValue(entry.skip_reason),
      reason: parseStringValue(entry.reason),
      source: parseStringValue(entry.source),
      created_by_user_id: parseStringValue(entry.created_by_user_id),
      derived_from_message_id: parseStringValue(entry.derived_from_message_id),
      effective_from: parseStringValue(entry.effective_from),
      expires_at: parseStringValue(entry.expires_at),
      max_uses: parseNumberValue(entry.max_uses),
      remaining_uses: parseNumberValue(entry.remaining_uses),
      created_at: parseStringValue(entry.created_at),
      learning_provenance: parseLearningProvenance(entry.learning_provenance),
    }));
}

function parseLocalPolicyDiagnosticTiming(value: unknown) {
  const parsed = parseObjectValue(value);
  if (!parsed) {
    return null;
  }

  return {
    bundle_fetch_ms: parseNumberValue(parsed.bundle_fetch_ms),
    evaluation_ms: parseNumberValue(parsed.evaluation_ms),
    llm_evaluator_ms: parseNumberValue(parsed.llm_evaluator_ms),
    provider_ms: parseNumberValue(parsed.provider_ms),
    total_ms: parseNumberValue(parsed.total_ms),
  };
}

function parseLocalPolicyLLMDiagnostics(value: unknown) {
  const parsed = parseObjectValue(value);
  if (!parsed) {
    return null;
  }

  return {
    applicable_policy_count: parseNumberValue(parsed.applicable_policy_count),
    degraded_cause: parseStringValue(parsed.degraded_cause),
    degraded_reason_code: parseReasonCode(parsed.degraded_reason_code),
    evaluator_invocation_count: parseNumberValue(
      parsed.evaluator_invocation_count,
    ),
    model: parseStringValue(parsed.model),
    provider: parseStringValue(parsed.provider),
    provider_invocation_count: parseNumberValue(
      parsed.provider_invocation_count,
    ),
  };
}

function parseLocalPolicyWinningPolicyDiagnostics(value: unknown) {
  const parsed = parseObjectValue(value);
  if (!parsed) {
    return null;
  }

  return {
    effect: parseDecision(parsed.effect),
    evaluator: parseStringValue(parsed.evaluator),
    policy_id: parseStringValue(parsed.policy_id),
    scope: parseStringValue(parsed.scope),
  };
}

function parseLocalPolicyRedactionDiagnostics(value: unknown) {
  const parsed = parseObjectValue(value);
  if (!parsed) {
    return null;
  }

  return {
    context: parseStringValue(parsed.context),
    credentials: parseStringValue(parsed.credentials),
    message: parseStringValue(parsed.message),
    raw_prompt: parseStringValue(parsed.raw_prompt),
  };
}

function parseLocalPolicyDiagnostics(value: unknown) {
  const parsed = parseObjectValue(value);
  if (!parsed) {
    return null;
  }

  return {
    applicable_policy_count: parseNumberValue(parsed.applicable_policy_count),
    bundle_id: parseStringValue(parsed.bundle_id),
    bundle_type: parseStringValue(parsed.bundle_type),
    decision: parseDecision(parsed.decision),
    delivery_mode: parseStringValue(parsed.delivery_mode),
    diagnostic_version: parseStringValue(parsed.diagnostic_version),
    evaluated_policy_count: parseNumberValue(parsed.evaluated_policy_count),
    llm: parseLocalPolicyLLMDiagnostics(parsed.llm),
    matched_policy_count: parseNumberValue(parsed.matched_policy_count),
    reason_code: parseReasonCode(parsed.reason_code),
    reason_kind: parseStringValue(parsed.reason_kind),
    redaction: parseLocalPolicyRedactionDiagnostics(parsed.redaction),
    resolution_id: parseStringValue(parsed.resolution_id),
    timing_ms: parseLocalPolicyDiagnosticTiming(parsed.timing_ms),
    winning_policy: parseLocalPolicyWinningPolicyDiagnostics(
      parsed.winning_policy,
    ),
  };
}

function buildPolicyAuditDetails(evaluation: Record<string, unknown> | null) {
  return {
    reason: parseStringValue(evaluation?.reason),
    resolution_explanation: parseStringValue(
      evaluation?.resolution_explanation,
    ),
    resolver_layer: parseStringValue(evaluation?.resolver_layer),
    guardrail_id: parseStringValue(evaluation?.guardrail_id),
    authenticated_identity: parseAuthenticatedIdentity(
      evaluation?.authenticated_identity,
    ),
    policy_owner_user_id: parseStringValue(evaluation?.policy_owner_user_id),
    policy_evaluation_mode: parseStringValue(
      evaluation?.policy_evaluation_mode,
    ),
    local_decision_commit: parseLocalDecisionCommitAudit(
      evaluation?.local_decision_commit,
    ),
    selector_context: parseSelectorContext(evaluation?.selector_context),
    selector_verification: parseSelectorVerification(
      evaluation?.selector_verification,
    ),
    local_policy_diagnostics: parseLocalPolicyDiagnostics(
      evaluation?.local_policy_diagnostics,
    ),
    winning_policy_id: parseStringValue(evaluation?.winning_policy_id),
    winning_policy: parseWinningPolicyAudit(evaluation?.winning_policy),
    matched_policy_ids: parseStringArray(evaluation?.matched_policy_ids),
    evaluated_policies: parseEvaluatedPolicyAudit(evaluation),
  };
}

async function loadUsernames(userIds: string[]): Promise<Map<string, string>> {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) {
    return new Map();
  }

  const db = getDb();
  const users = await db
    .select({ id: schema.users.id, username: schema.users.username })
    .from(schema.users)
    .where(inArray(schema.users.id, uniqueUserIds));

  return new Map(users.map((entry) => [entry.id, entry.username]));
}

async function loadContextPolicies(
  userId: string,
  recipientUserId: string,
  roles: string[],
  selectors: { direction: PolicyDirection; resource: string; action: string },
  groupId?: string,
) {
  return loadApplicablePolicies(userId, recipientUserId, roles, groupId, {
    direction: selectors.direction,
    resource: selectors.resource,
    action: selectors.action,
  });
}

async function loadGroupOverlayPolicies(
  userId: string,
  groupId: string,
  selectors: { direction: PolicyDirection; resource: string; action: string },
) {
  const applicablePolicies = await loadApplicablePolicies(
    userId,
    undefined,
    [],
    groupId,
    {
      direction: selectors.direction,
      resource: selectors.resource,
      action: selectors.action,
    },
  );

  return applicablePolicies.filter((policy) => policy.scope === "group");
}

function toBundlePolicy(policy: CanonicalPolicy) {
  return {
    id: policy.id,
    scope: policy.scope,
    target_id: policy.target_id,
    direction: policy.direction,
    resource: policy.resource,
    action: policy.action,
    effect: policy.effect,
    evaluator: policy.evaluator,
    policy_content: policy.policy_content,
    effective_from: policy.effective_from,
    expires_at: policy.expires_at,
    max_uses: policy.max_uses,
    remaining_uses: policy.remaining_uses,
    source: policy.source,
    derived_from_message_id: policy.derived_from_message_id,
    learning_provenance: policy.learning_provenance ?? null,
    priority: policy.priority,
    created_at: policy.created_at,
  };
}

function buildBundleLLMContext(
  applicablePolicies: CanonicalPolicy[],
  subject: string,
  providerDefaults: Awaited<ReturnType<typeof loadUserLLMProviderDefaults>>,
) {
  const hasApplicableLLMPolicy = applicablePolicies.some(
    (policy) => policy.evaluator === "llm",
  );

  return {
    subject,
    provider_defaults: hasApplicableLLMPolicy ? providerDefaults : null,
  };
}

pluginRoutes.get("/reviews", requireActive(), async (c) => {
  const user = c.get("user")!;
  const db = getDb();
  const statusFilter = parseReviewStatusFilter(c.req.query("status"));
  const directionFilter = parseQueueDirectionFilter(c.req.query("direction"));
  const limit = parsePositiveLimit(c.req.query("limit"), 50);
  const visibilityFilter = buildMessageVisibilityFilter(
    user.id,
    directionFilter,
  );

  const reviewMessages = await db
    .select({
      action: schema.messages.action,
      context: schema.messages.context,
      correlationId: schema.messages.correlationId,
      createdAt: schema.messages.createdAt,
      direction: schema.messages.direction,
      id: schema.messages.id,
      inResponseTo: schema.messages.inResponseTo,
      payload: schema.messages.payload,
      payloadType: schema.messages.payloadType,
      policiesEvaluated: schema.messages.policiesEvaluated,
      recipientConnectionId: schema.messages.recipientConnectionId,
      recipientId: schema.messages.recipientId,
      recipientType: schema.messages.recipientType,
      senderAgent: schema.messages.senderAgent,
      senderConnectionId: schema.messages.senderConnectionId,
      senderUserId: schema.messages.senderUserId,
      status: schema.messages.status,
      resource: schema.messages.resource,
      resolutionId: schema.messages.resolutionId,
    })
    .from(schema.messages)
    .where(and(visibilityFilter, inArray(schema.messages.status, statusFilter)))
    .orderBy(desc(schema.messages.createdAt))
    .limit(limit);

  const usernamesById = await loadUsernames(
    reviewMessages.flatMap((message) => {
      const ids = [message.senderUserId];
      if (message.recipientType === "user") {
        ids.push(message.recipientId);
      }
      return ids;
    }),
  );

  const reviews = reviewMessages.map((message) => {
    const evaluation = parseJsonObject(message.policiesEvaluated);
    const auditDetails = buildPolicyAuditDetails(evaluation);
    const decision = parseDecision(evaluation?.effect) || "ask";
    const reasonCode =
      parseReasonCode(evaluation?.reason_code) || "policy.ask.resolved";
    const summary = parseReasonSummary(
      evaluation,
      "Message requires review before delivery.",
    );
    const queueDirection = resolveQueueDirection(user.id, message);
    const deliveryMode =
      message.status === "approval_pending"
        ? "hold_for_approval"
        : "review_required";

    return {
      review_id: `rev_${message.id}`,
      message_id: message.id,
      resolution_id:
        message.resolutionId ||
        auditDetails.local_decision_commit?.resolution_id,
      status: message.status,
      queue_direction: queueDirection,
      decision,
      delivery_mode: deliveryMode,
      summary,
      reason_code: reasonCode,
      created_at: message.createdAt?.toISOString() || new Date().toISOString(),
      correlation_id: message.correlationId,
      in_response_to: message.inResponseTo,
      payload_type: message.payloadType,
      message_preview: summarizeMessage(message.payload, 240),
      context_preview: message.context
        ? summarizeMessage(message.context, 200)
        : null,
      selectors: {
        direction: message.direction,
        resource: message.resource,
        action: message.action,
      },
      sender: {
        user_id: message.senderUserId,
        username: usernamesById.get(message.senderUserId) || null,
        connection_id: message.senderConnectionId,
        agent: message.senderAgent,
      },
      recipient: {
        id: message.recipientId,
        type: message.recipientType,
        username:
          message.recipientType === "user"
            ? (usernamesById.get(message.recipientId) ?? null)
            : null,
        connection_id: message.recipientConnectionId,
      },
      applied_policy: {
        matched_policy_ids: parseStringArray(evaluation?.matched_policy_ids),
        winning_policy_id:
          typeof evaluation?.winning_policy_id === "string"
            ? evaluation.winning_policy_id
            : null,
      },
      audit: auditDetails,
    };
  });

  return c.json({
    contract_version: CONTRACT_VERSION,
    review_queue: {
      count: reviews.length,
      direction: directionFilter,
      statuses: statusFilter,
    },
    reviews,
  });
});

pluginRoutes.get("/events/blocked", requireActive(), async (c) => {
  const user = c.get("user")!;
  const db = getDb();
  const directionFilter = parseQueueDirectionFilter(c.req.query("direction"));
  const includePayloadExcerpt = parseBooleanQueryFlag(
    c.req.query("include_payload_excerpt"),
    "include_payload_excerpt",
    false,
  );
  const limit = parsePositiveLimit(c.req.query("limit"), 50);
  const visibilityFilter = buildMessageVisibilityFilter(
    user.id,
    directionFilter,
  );

  const blockedMessages = await db
    .select({
      action: schema.messages.action,
      correlationId: schema.messages.correlationId,
      createdAt: schema.messages.createdAt,
      direction: schema.messages.direction,
      id: schema.messages.id,
      inResponseTo: schema.messages.inResponseTo,
      payload: schema.messages.payload,
      policiesEvaluated: schema.messages.policiesEvaluated,
      recipientId: schema.messages.recipientId,
      recipientType: schema.messages.recipientType,
      rejectionReason: schema.messages.rejectionReason,
      resolutionId: schema.messages.resolutionId,
      resource: schema.messages.resource,
      senderUserId: schema.messages.senderUserId,
      status: schema.messages.status,
    })
    .from(schema.messages)
    .where(and(visibilityFilter, eq(schema.messages.status, "rejected")))
    .orderBy(desc(schema.messages.createdAt))
    .limit(limit);

  const usernamesById = await loadUsernames(
    blockedMessages.flatMap((message) => {
      const ids = [message.senderUserId];
      if (message.recipientType === "user") {
        ids.push(message.recipientId);
      }
      return ids;
    }),
  );

  const blockedEvents = blockedMessages.map((message) => {
    const evaluation = parseJsonObject(message.policiesEvaluated);
    const auditDetails = buildPolicyAuditDetails(evaluation);
    const reasonCode =
      parseReasonCode(evaluation?.reason_code) || "policy.deny.resolved";
    const reason = parseReasonSummary(
      evaluation,
      message.rejectionReason || "Message blocked by policy.",
    );

    return {
      id: `blocked_${message.id}`,
      message_id: message.id,
      resolution_id:
        message.resolutionId ||
        auditDetails.local_decision_commit?.resolution_id,
      queue_direction: resolveQueueDirection(user.id, message),
      sender: usernamesById.get(message.senderUserId) || null,
      reason_code: reasonCode,
      reason,
      correlation_id: message.correlationId,
      in_response_to: message.inResponseTo,
      direction: message.direction,
      resource: message.resource,
      action: message.action,
      stored_payload_excerpt: includePayloadExcerpt
        ? summarizeMessage(message.payload, 120)
        : null,
      payload_hash: hashPayload(message.payload),
      timestamp: message.createdAt?.toISOString() || new Date().toISOString(),
      status: message.status,
      recipient: {
        id: message.recipientId,
        type: message.recipientType,
        username:
          message.recipientType === "user"
            ? (usernamesById.get(message.recipientId) ?? null)
            : null,
      },
      audit: auditDetails,
    };
  });

  return c.json({
    contract_version: CONTRACT_VERSION,
    retention: {
      blocked_event_log: "metadata_only",
      payload_excerpt_default: "omitted",
      payload_excerpt_included: includePayloadExcerpt,
      payload_hash_algorithm: "sha256",
      source_message_payload:
        "messages table may retain full payload for delivery/audit compatibility",
    },
    blocked_events: blockedEvents,
  });
});

pluginRoutes.get("/suggestions/promotions", requireActive(), async (c) => {
  const user = c.get("user")!;
  const minRepetitions = parseBoundedIntegerQuery(
    c.req.query("min_repetitions"),
    "min_repetitions",
    3,
    2,
    20,
  );
  const lookbackDays = parseBoundedIntegerQuery(
    c.req.query("lookback_days"),
    "lookback_days",
    30,
    1,
    365,
  );
  const limit = parseBoundedIntegerQuery(
    c.req.query("limit"),
    "limit",
    20,
    1,
    50,
  );
  const report = await detectPromotionSuggestions(user.id, {
    min_repetitions: minRepetitions,
    lookback_days: lookbackDays,
    limit,
  });

  return c.json({
    contract_version: CONTRACT_VERSION,
    learning: {
      min_repetitions: report.min_repetitions,
      lookback_days: report.lookback_days,
      evaluated_override_count: report.evaluated_override_count,
      total_pattern_count: report.total_pattern_count,
    },
    promotion_suggestions: report.suggestions,
  });
});

pluginRoutes.post(
  "/context",
  zValidator("json", pluginContextRequestSchema),
  async (c) => {
    const user = c.get("user")!;
    const data = c.req.valid("json");
    const db = getDb();

    if (data.recipient_type !== "user") {
      throw new AppError(
        "Only recipient_type='user' is supported for plugin context v2",
        400,
        "UNSUPPORTED_RECIPIENT_TYPE",
      );
    }

    const selectors = resolveContextSelectors(data);

    const [senderConnection] = await db
      .select({
        framework: schema.agentConnections.framework,
        id: schema.agentConnections.id,
        label: schema.agentConnections.label,
      })
      .from(schema.agentConnections)
      .where(
        and(
          eq(schema.agentConnections.id, data.sender_connection_id),
          eq(schema.agentConnections.userId, user.id),
          eq(schema.agentConnections.status, "active"),
        ),
      )
      .limit(1);

    if (!senderConnection) {
      throw new AppError(
        "Sender connection not found or inactive",
        404,
        "SENDER_CONNECTION_NOT_FOUND",
      );
    }

    const { friendship, recipient } = await loadDirectUserRecipientAccess(
      user.id,
      data.recipient,
      404,
    );

    const roles = await getRolesForFriend(user.id, recipient.id);
    const applicablePolicies = await loadContextPolicies(
      user.id,
      recipient.id,
      roles,
      selectors,
    );
    const summary = await generatePolicySummary(applicablePolicies, roles);
    const defaultDecision = resolveContextPolicyGuidance(applicablePolicies);

    const interactions = data.include_recent_interactions
      ? await db
          .select({
            action: schema.messages.action,
            createdAt: schema.messages.createdAt,
            direction: schema.messages.direction,
            id: schema.messages.id,
            outcome: schema.messages.outcome,
            payload: schema.messages.payload,
            policiesEvaluated: schema.messages.policiesEvaluated,
            resource: schema.messages.resource,
            senderUserId: schema.messages.senderUserId,
            status: schema.messages.status,
          })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.recipientType, "user"),
              or(
                and(
                  eq(schema.messages.senderUserId, user.id),
                  eq(schema.messages.recipientId, recipient.id),
                ),
                and(
                  eq(schema.messages.senderUserId, recipient.id),
                  eq(schema.messages.recipientId, user.id),
                ),
              ),
            ),
          )
          .orderBy(desc(schema.messages.createdAt))
          .limit(data.interaction_limit)
      : [];

    const recentInteractions = interactions.map((interaction) => ({
      direction: interaction.senderUserId === user.id ? "outbound" : "inbound",
      message_id: interaction.id,
      summary: summarizeMessage(interaction.payload),
      timestamp:
        interaction.createdAt?.toISOString() || new Date().toISOString(),
    }));

    const relevantDecisions = interactions
      .map((interaction) => {
        const evaluation = parseJsonObject(interaction.policiesEvaluated);
        const decision =
          parseDecision(evaluation?.effect) ||
          parseDecision(interaction.outcome);
        if (!decision) {
          return null;
        }

        return {
          decision,
          direction:
            interaction.senderUserId === user.id ? "outbound" : "inbound",
          message_id: interaction.id,
          reason_code: parseReasonCode(evaluation?.reason_code),
          selectors: {
            action: interaction.action,
            direction: interaction.direction,
            resource: interaction.resource,
          },
          status: interaction.status,
          timestamp:
            interaction.createdAt?.toISOString() || new Date().toISOString(),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    const scopeCounts = applicablePolicies.reduce(
      (acc, policy) => {
        if (
          policy.scope === "user" ||
          policy.scope === "role" ||
          policy.scope === "global"
        ) {
          acc[policy.scope] += 1;
        }
        return acc;
      },
      { global: 0, role: 0, user: 0 },
    );

    return c.json({
      contract_version: CONTRACT_VERSION,
      policy_guidance: {
        default_decision: defaultDecision.decision,
        reason_code: defaultDecision.reasonCode,
        relevant_decisions: relevantDecisions,
        summary,
        policy_signal: {
          applicable_policy_count: applicablePolicies.length,
          scope_counts: scopeCounts,
        },
      },
      recipient: {
        connected_since: friendship.createdAt?.toISOString() || null,
        display_name: recipient.displayName,
        id: recipient.id,
        relationship: "friend",
        roles,
        username: recipient.username,
      },
      recent_interactions: recentInteractions,
      sender_connection: senderConnection,
      suggested_selectors: selectors,
    });
  },
);

pluginRoutes.post(
  "/bundles/direct-send",
  requireActive(),
  zValidator("json", pluginDirectSendBundleRequestSchema),
  async (c) => {
    const user = c.get("user")!;
    const data = c.req.valid("json");

    if (data.recipient_type !== "user") {
      throw new AppError(
        "Only recipient_type='user' is supported for direct-send policy bundles",
        400,
        "UNSUPPORTED_RECIPIENT_TYPE",
      );
    }

    const selectors = resolveDraftSelectors(data);
    const direction = parseDirectionCandidate(selectors.direction);
    const senderConnection = await resolveSenderConnection(
      user.id,
      data.sender_connection_id,
    );
    const { recipient } = await loadDirectUserRecipientAccess(
      user.id,
      data.recipient,
    );
    const roles = await getRolesForFriend(user.id, recipient.id);
    const applicablePolicies = await loadContextPolicies(
      user.id,
      recipient.id,
      roles,
      {
        action: selectors.action,
        direction,
        resource: selectors.resource,
      },
    );
    const llmProviderDefaults = await loadUserLLMProviderDefaults(user.id);
    const issuedAt = new Date();

    return c.json({
      contract_version: CONTRACT_VERSION,
      bundle_type: "direct_send",
      bundle_metadata: {
        bundle_id: `bundle_${nanoid(18)}`,
        resolution_id: `res_${nanoid(18)}`,
        issued_at: issuedAt.toISOString(),
        expires_at: new Date(issuedAt.getTime() + 5 * 60 * 1000).toISOString(),
      },
      authenticated_identity: {
        sender_user_id: user.id,
        sender_connection_id: senderConnection.id,
      },
      selector_context: {
        action: selectors.action,
        direction,
        resource: selectors.resource,
      },
      recipient: {
        id: recipient.id,
        type: "user",
        username: recipient.username,
      },
      applicable_policies: applicablePolicies.map(toBundlePolicy),
      llm: buildBundleLLMContext(
        applicablePolicies,
        recipient.username,
        llmProviderDefaults,
      ),
    });
  },
);

pluginRoutes.post(
  "/bundles/group-fanout",
  requireActive(),
  zValidator("json", pluginGroupFanoutBundleRequestSchema),
  async (c) => {
    const user = c.get("user")!;
    const data = c.req.valid("json");
    const selectors = resolveDraftSelectors(data);
    const direction = parseDirectionCandidate(selectors.direction);
    const senderConnection = await resolveSenderConnection(
      user.id,
      data.sender_connection_id,
    );
    const { group, members } = await loadGroupFanoutMembers(
      user.id,
      data.recipient,
    );
    const issuedAt = new Date();
    const resolutionId = `res_${nanoid(18)}`;
    const llmProviderDefaults = await loadUserLLMProviderDefaults(user.id);
    const groupOverlayPolicies = await loadGroupOverlayPolicies(
      user.id,
      group.id,
      {
        action: selectors.action,
        direction,
        resource: selectors.resource,
      },
    );
    const bundleMembers = await Promise.all(
      members.map(async (member) => {
        const roles = await getRolesForFriend(user.id, member.userId);
        const applicablePolicies = await loadContextPolicies(
          user.id,
          member.userId,
          roles,
          {
            action: selectors.action,
            direction,
            resource: selectors.resource,
          },
          group.id,
        );
        const memberApplicablePolicies = applicablePolicies.filter(
          (policy) => policy.scope !== "group",
        );

        return {
          recipient: {
            id: member.userId,
            type: "user",
            username: member.username,
          },
          roles,
          resolution_id: `${resolutionId}_${member.userId}`,
          member_applicable_policies:
            memberApplicablePolicies.map(toBundlePolicy),
          llm: buildBundleLLMContext(
            applicablePolicies,
            member.username,
            llmProviderDefaults,
          ),
        };
      }),
    );

    return c.json({
      contract_version: CONTRACT_VERSION,
      bundle_type: "group_fanout",
      bundle_metadata: {
        bundle_id: `bundle_${nanoid(18)}`,
        resolution_id: resolutionId,
        issued_at: issuedAt.toISOString(),
        expires_at: new Date(issuedAt.getTime() + 5 * 60 * 1000).toISOString(),
      },
      authenticated_identity: {
        sender_user_id: user.id,
        sender_connection_id: senderConnection.id,
      },
      selector_context: {
        action: selectors.action,
        direction,
        resource: selectors.resource,
      },
      group: {
        id: group.id,
        member_count: members.length,
        name: group.name,
        type: "group",
      },
      aggregate_metadata: {
        fanout_mode: "per_recipient",
        mixed_decision_priority: GROUP_FANOUT_MIXED_DECISION_PRIORITY,
        partial_reason_code: "policy.partial.group_fanout",
        empty_group_summary: GROUP_FANOUT_EMPTY_SUMMARY,
        partial_summary_template: GROUP_FANOUT_PARTIAL_SUMMARY_TEMPLATE,
        policy_evaluation_mode: "group_outbound_fanout",
      },
      group_overlay_policies: groupOverlayPolicies.map(toBundlePolicy),
      members: bundleMembers,
    });
  },
);

pluginRoutes.post(
  "/resolve",
  requireActive(),
  zValidator("json", pluginResolveRequestSchema),
  async (c) => {
    const user = c.get("user")!;
    const data = c.req.valid("json");

    const sizeValidation = validatePayloadSize(data.message);
    if (!sizeValidation.valid) {
      throw new AppError(sizeValidation.error!, 400, "PAYLOAD_TOO_LARGE");
    }

    const selectors = resolveDraftSelectors(data);
    const direction = parseDirectionCandidate(selectors.direction);
    const senderConnection = await resolveSenderConnection(
      user.id,
      data.sender_connection_id,
    );
    const identity: AuthenticatedSenderIdentity = {
      sender_user_id: user.id,
      sender_connection_id: senderConnection.id,
    };

    const selectorContext = {
      action: selectors.action,
      direction,
      resource: selectors.resource,
    };
    const evaluatePolicy =
      config.trustedMode &&
      data.payload_type !== "application/mahilo+ciphertext";

    let policyResult: PolicyResult | null = null;
    let resolvedRecipientConnectionId: string | null = null;

    if (data.recipient_type === "group") {
      await resolveGroupRecipient(user.id, data.recipient);

      if (evaluatePolicy) {
        policyResult = await evaluateGroupPolicies(
          user.id,
          data.recipient,
          data.message,
          data.context,
          identity,
          selectorContext,
        );
      }
    } else {
      const { recipientConnection, recipientUserId } =
        await resolveUserRecipient(user.id, data);
      resolvedRecipientConnectionId = recipientConnection.id;

      if (evaluatePolicy) {
        if (isInboundDirection(direction)) {
          policyResult = await evaluateInboundPolicies(
            recipientUserId,
            user.id,
            data.message,
            data.context,
            identity,
            selectorContext,
          );
        } else {
          policyResult = await evaluatePolicies(
            user.id,
            recipientUserId,
            data.message,
            data.context,
            identity,
            selectorContext,
          );
        }
      }
    }

    const decision: ContextDecision = policyResult?.effect ?? "allow";
    const deliveryMode = resolveDeliveryMode(decision, direction);
    const authoritativePreview = evaluatePolicy;
    const resolutionSummary = buildAgentResolutionSummary(
      decision,
      deliveryMode,
      {
        authoritative: authoritativePreview,
      },
    );
    const resolutionId = `res_${nanoid(18)}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    return c.json({
      contract_version: CONTRACT_VERSION,
      resolution_id: resolutionId,
      decision,
      delivery_mode: deliveryMode,
      resolution_summary: resolutionSummary,
      agent_guidance: buildAgentGuidance(decision, deliveryMode, {
        authoritative: authoritativePreview,
      }),
      reason_code:
        policyResult?.reason_code ||
        resolvePreviewReasonCode(decision, authoritativePreview),
      server_selectors: {
        action: selectors.action,
        direction,
        resource: selectors.resource,
      },
      resolved_recipient: {
        recipient: data.recipient,
        recipient_connection_id: resolvedRecipientConnectionId,
        recipient_type: data.recipient_type,
      },
      review: {
        required: decision === "ask",
        review_id: null,
      },
      recipient_results: [
        {
          recipient: data.recipient,
          decision,
          delivery_mode: deliveryMode,
        },
      ],
      expires_at: expiresAt,
    });
  },
);

pluginRoutes.post(
  "/local-decisions/commit",
  requireActive(),
  zValidator("json", pluginLocalDecisionCommitRequestSchema),
  async (c) => {
    const user = c.get("user")!;
    const data = c.req.valid("json");
    const db = getDb();

    const sizeValidation = validatePayloadSize(data.message);
    if (!sizeValidation.valid) {
      throw new AppError(sizeValidation.error!, 400, "PAYLOAD_TOO_LARGE");
    }

    const selectors = resolveDraftSelectors(data);
    const direction = parseDirectionCandidate(selectors.direction);
    const senderConnection = await resolveSenderConnection(
      user.id,
      data.sender_connection_id,
    );
    const { group, recipient } = await loadLocalDecisionRecipientAccess(
      user.id,
      data.recipient,
      data.group_id,
    );
    const decision = data.local_decision.decision as ContextDecision;
    const deliveryMode = data.local_decision.delivery_mode as DeliveryMode;

    assertLocalDecisionDeliveryMode(decision, deliveryMode);
    const idempotencyKey = resolveRequestIdempotencyKey(
      data,
      c.req.header("Idempotency-Key"),
    );
    const roles = await getRolesForFriend(user.id, recipient.id);
    const applicablePolicies = await loadContextPolicies(
      user.id,
      recipient.id,
      roles,
      {
        action: selectors.action,
        direction,
        resource: selectors.resource,
      },
      group?.id,
    );

    const [existingByResolution] = await db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.senderUserId, user.id),
          eq(schema.messages.resolutionId, data.resolution_id),
        ),
      )
      .limit(1);

    const [existingByIdempotency] = idempotencyKey
      ? await db
          .select()
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.senderUserId, user.id),
              eq(schema.messages.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1)
      : [];

    if (
      existingByResolution &&
      existingByIdempotency &&
      existingByResolution.id !== existingByIdempotency.id
    ) {
      throw new AppError(
        "idempotency_key is already bound to a different resolution_id",
        409,
        "LOCAL_DECISION_CONFLICT",
      );
    }

    const existingMessage = existingByResolution || existingByIdempotency;
    if (existingMessage) {
      assertCommittedMessageMatchesLocalDecision(existingMessage, {
        senderConnectionId: senderConnection.id,
        resolutionId: data.resolution_id,
        recipientId: recipient.id,
        recipientType: "user",
        groupId: group?.id ?? null,
        selectors,
        payload: data.message,
        payloadType: data.payload_type,
        context: data.context ?? null,
        decision,
        deliveryMode,
      });

      return c.json({
        recorded: true,
        ...buildLocalDecisionCommitResponse(
          existingMessage,
          recipient.username,
          true,
        ),
      });
    }

    let winningPolicy: CanonicalPolicy | null = null;
    if (data.local_decision.winning_policy_id) {
      winningPolicy =
        applicablePolicies.find(
          (policy) => policy.id === data.local_decision.winning_policy_id,
        ) || null;

      if (!winningPolicy) {
        throw new AppError(
          "Winning policy is no longer eligible for this local decision commit",
          409,
          "LOCAL_DECISION_STALE",
        );
      }

      if (winningPolicy.effect !== decision) {
        throw new AppError(
          "winning_policy_id effect does not match local_decision.decision",
          400,
          "INVALID_LOCAL_DECISION",
        );
      }
    }

    const summary =
      data.local_decision.summary ||
      data.local_decision.reason ||
      buildAgentResolutionSummary(decision, deliveryMode);
    const reason = data.local_decision.reason || null;
    const reasonCode =
      data.local_decision.reason_code || defaultReasonCode(decision);
    const resolutionExplanation =
      data.local_decision.resolution_explanation || summary;
    const localPolicyDiagnostics = data.local_decision.diagnostics || null;

    if (
      localPolicyDiagnostics &&
      localPolicyDiagnostics.resolution_id !== data.resolution_id
    ) {
      throw new AppError(
        "local_decision.diagnostics.resolution_id must match resolution_id",
        400,
        "INVALID_LOCAL_DECISION",
      );
    }

    if (localPolicyDiagnostics && localPolicyDiagnostics.decision !== decision) {
      throw new AppError(
        "local_decision.diagnostics.decision must match local_decision.decision",
        400,
        "INVALID_LOCAL_DECISION",
      );
    }

    if (
      localPolicyDiagnostics &&
      localPolicyDiagnostics.delivery_mode !== deliveryMode
    ) {
      throw new AppError(
        "local_decision.diagnostics.delivery_mode must match local_decision.delivery_mode",
        400,
        "INVALID_LOCAL_DECISION",
      );
    }

    if (
      localPolicyDiagnostics &&
      localPolicyDiagnostics.reason_code !== reasonCode
    ) {
      throw new AppError(
        "local_decision.diagnostics.reason_code must match local_decision.reason_code",
        400,
        "INVALID_LOCAL_DECISION",
      );
    }
    const matchedPolicyIds = [
      ...new Set(
        data.local_decision.matched_policy_ids ||
          (winningPolicy ? [winningPolicy.id] : []),
      ),
    ];
    const evaluatedPolicies =
      data.local_decision.evaluated_policies ||
      applicablePolicies.map((policy) =>
        buildFallbackEvaluatedPolicyAudit(
          policy,
          user.id,
          matchedPolicyIds.includes(policy.id),
          policy.id === winningPolicy?.id ? reason || summary : null,
        ),
      );

    if (winningPolicy) {
      await consumeWinningPolicyUse(user.id, {
        allowed: decision === "allow",
        effect: decision,
        reason: reason || undefined,
        reason_code: reasonCode,
        resolution_explanation: resolutionExplanation,
        authenticated_identity: {
          sender_user_id: user.id,
          sender_connection_id: senderConnection.id,
        },
        resolver_layer: "user_policies",
        guardrail_id: data.local_decision.guardrail_id,
        winning_policy_id: winningPolicy.id,
        winning_policy: {
          policy_id: winningPolicy.id,
          scope: winningPolicy.scope,
          evaluator: winningPolicy.evaluator,
          effect: winningPolicy.effect,
          priority: winningPolicy.priority,
          phase: policyEvaluationPhaseForEvaluator(winningPolicy.evaluator),
          reason: reason || summary,
          reason_code: reasonCode,
          ...buildPolicyLifecycleAudit(winningPolicy, user.id),
        },
        matched_policy_ids: matchedPolicyIds,
        evaluated_policies: [],
      });
    }

    const committedAt = new Date().toISOString();
    const messageId = nanoid();
    const status = localDecisionMessageStatus(decision, deliveryMode);
    const policyEvaluation = buildLocalDecisionPolicyEvaluation({
      userId: user.id,
      senderConnectionId: senderConnection.id,
      resolutionId: data.resolution_id,
      committedAt,
      groupId: group?.id ?? null,
      selectors: {
        direction,
        resource: selectors.resource,
        action: selectors.action,
      },
      decision,
      reason,
      reasonCode,
      summary,
      resolutionExplanation,
      resolverLayer: data.local_decision.resolver_layer || "user_policies",
      guardrailId: data.local_decision.guardrail_id || null,
      winningPolicy,
      matchedPolicyIds,
      evaluatedPolicies,
      localPolicyDiagnostics,
    });

    await db.insert(schema.messages).values({
      id: messageId,
      resolutionId: data.resolution_id,
      correlationId: data.correlation_id,
      direction,
      resource: selectors.resource,
      action: selectors.action,
      inResponseTo: data.in_response_to || null,
      outcome: decision,
      outcomeDetails: reason || summary,
      policiesEvaluated: policyEvaluation,
      senderUserId: user.id,
      senderConnectionId: senderConnection.id,
      senderAgent: senderConnection.framework,
      recipientType: "user",
      recipientId: recipient.id,
      recipientConnectionId: null,
      payload: data.message,
      payloadType: data.payload_type,
      context: data.context,
      status,
      rejectionReason: decision === "deny" ? reason || summary : null,
      idempotencyKey,
    });

    return c.json({
      recorded: true,
      ...buildLocalDecisionCommitResponse(
        {
          id: messageId,
          resolutionId: data.resolution_id,
          direction,
          status,
          outcome: decision,
          policiesEvaluated: policyEvaluation,
        },
        recipient.username,
      ),
    });
  },
);

pluginRoutes.post(
  "/overrides",
  requireActive(),
  zValidator("json", pluginOverrideRequestSchema),
  async (c) => {
    const user = c.get("user")!;
    const data = c.req.valid("json");
    const db = getDb();
    const senderConnection = await resolveSenderConnection(
      user.id,
      data.sender_connection_id,
    );
    const targetId = data.target_id ?? null;
    assertScopeTarget(data.scope, targetId);

    if (data.scope === "user" && targetId) {
      const [targetUser] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, targetId))
        .limit(1);

      if (!targetUser) {
        throw new AppError("Target user not found", 404, "USER_NOT_FOUND");
      }
    }

    if (data.scope === "group" && targetId) {
      await assertGroupPolicyAccess(user.id, targetId);
    }

    if (data.scope === "role" && targetId) {
      const validRole = await isValidRole(user.id, targetId);
      if (!validRole) {
        throw new AppError(`Invalid role: ${targetId}`, 400, "INVALID_ROLE");
      }
    }

    if (data.derived_from_message_id) {
      const [sourceMessage] = await db
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.id, data.derived_from_message_id),
            or(
              eq(schema.messages.senderUserId, user.id),
              eq(schema.messages.recipientId, user.id),
            ),
          ),
        )
        .limit(1);

      if (!sourceMessage) {
        throw new AppError(
          "derived_from_message_id must reference a message visible to this user",
          404,
          "SOURCE_MESSAGE_NOT_FOUND",
        );
      }
    }

    const selectors = resolveOverrideSelectors(data);
    const lifecycle = resolveOverrideLifecycle(data);
    const createdAt = new Date().toISOString();
    const basePolicyContent = data.policy_content
      ? { ...data.policy_content }
      : {};
    const policyContent = {
      ...basePolicyContent,
      _mahilo_override: {
        kind: data.kind as PluginOverrideKind,
        reason: data.reason,
        sender_connection_id: senderConnection.id,
        created_via: "plugin.overrides",
        created_at: createdAt,
        ...(data.source_resolution_id
          ? { source_resolution_id: data.source_resolution_id }
          : {}),
      },
    };

    const contentValidation = validatePolicyContent(
      "structured",
      policyContent,
    );
    if (!contentValidation.valid) {
      throw new AppError(
        contentValidation.error!,
        400,
        "INVALID_POLICY_CONTENT",
      );
    }

    const storage = canonicalToStorage({
      scope: data.scope as PolicyScope,
      target_id: targetId,
      direction: selectors.direction,
      resource: selectors.resource,
      action: selectors.action,
      effect: data.effect as PolicyEffect,
      evaluator: "structured",
      policy_content: policyContent,
      effective_from: null,
      expires_at: lifecycle.expires_at,
      max_uses: lifecycle.max_uses,
      remaining_uses: lifecycle.remaining_uses,
      source: "override",
      derived_from_message_id: data.derived_from_message_id ?? null,
      learning_provenance: {
        ...(data.source_resolution_id
          ? { source_interaction_id: data.source_resolution_id }
          : {}),
        promoted_from_policy_ids: [],
      },
      priority: data.priority,
      enabled: true,
    });

    const policyId = nanoid();
    await db.insert(schema.policies).values({
      id: policyId,
      userId: user.id,
      scope: data.scope,
      targetId,
      direction: storage.direction,
      resource: storage.resource,
      action: storage.action,
      effect: storage.effect,
      evaluator: storage.evaluator,
      effectiveFrom: storage.effectiveFrom,
      expiresAt: storage.expiresAt,
      maxUses: storage.maxUses,
      remainingUses: storage.remainingUses,
      source: storage.source,
      derivedFromMessageId: storage.derivedFromMessageId,
      policyType: storage.policyType,
      policyContent: storage.policyContent,
      priority: data.priority,
      enabled: true,
    });

    return c.json(
      {
        policy_id: policyId,
        kind: data.kind,
        created: true,
      },
      201,
    );
  },
);

pluginRoutes.post(
  "/outcomes",
  requireActive(),
  zValidator("json", pluginOutcomeRequestSchema),
  async (c) => {
    const user = c.get("user")!;
    const data = c.req.valid("json");
    const db = getDb();
    const senderConnection = await resolveSenderConnection(
      user.id,
      data.sender_connection_id,
    );

    const [message] = await db
      .select({
        action: schema.messages.action,
        correlationId: schema.messages.correlationId,
        direction: schema.messages.direction,
        id: schema.messages.id,
        inResponseTo: schema.messages.inResponseTo,
        outcomeDetails: schema.messages.outcomeDetails,
        resolutionId: schema.messages.resolutionId,
        resource: schema.messages.resource,
        senderConnectionId: schema.messages.senderConnectionId,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.id, data.message_id),
          eq(schema.messages.senderUserId, user.id),
        ),
      )
      .limit(1);

    if (!message) {
      throw new AppError("Message not found", 404, "MESSAGE_NOT_FOUND");
    }

    if (
      message.senderConnectionId &&
      message.senderConnectionId !== senderConnection.id
    ) {
      throw new AppError(
        "Message sender connection does not match sender_connection_id",
        403,
        "MESSAGE_SENDER_MISMATCH",
      );
    }

    const idempotencyKey = resolveRequestIdempotencyKey(
      data,
      c.req.header("Idempotency-Key"),
    );
    if (idempotencyKey) {
      const existingEventId = findOutcomeEventByIdempotency(
        message.outcomeDetails,
        idempotencyKey,
      );
      if (existingEventId) {
        return c.json({
          recorded: true,
          event_id: existingEventId,
          deduplicated: true,
        });
      }
    }

    const eventId = `evt_${nanoid(18)}`;
    const reportedAt = new Date().toISOString();
    const auditEntry: PluginOutcomeAuditEntry = {
      event_id: eventId,
      message_id: message.id,
      resolution_id:
        data.resolution_id || message.resolutionId || `res_${message.id}`,
      outcome: data.outcome,
      user_action: data.user_action || null,
      notes: data.notes || null,
      recipient_results: data.recipient_results || [],
      idempotency_key: idempotencyKey,
      reported_by_user_id: user.id,
      sender_connection_id: senderConnection.id,
      reported_at: reportedAt,
      correlation: {
        correlation_id: message.correlationId,
        in_response_to: message.inResponseTo,
        selectors: {
          direction: message.direction,
          resource: message.resource,
          action: message.action,
        },
      },
    };

    const nextOutcomeDetails = buildOutcomeAuditDetails(
      message.outcomeDetails,
      auditEntry,
    );

    await db
      .update(schema.messages)
      .set({
        outcome: data.outcome,
        outcomeDetails: nextOutcomeDetails,
      })
      .where(eq(schema.messages.id, message.id));

    return c.json({
      recorded: true,
      event_id: eventId,
    });
  },
);
