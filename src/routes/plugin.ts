import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { createHash } from "crypto";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { requireAuth, requireVerified } from "../middleware/auth";
import { AppError } from "../middleware/error";
import { getRolesForFriend, isValidRole } from "../services/roles";
import { generatePolicySummary } from "../services/policySummary";
import { config } from "../config";
import { parseCapabilities, validatePayloadSize } from "../services/validation";
import {
  evaluateGroupPolicies,
  evaluateInboundPolicies,
  evaluatePolicies,
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

const selectorDirections = [
  "outbound",
  "inbound",
  "request",
  "response",
  "notification",
  "error",
] as const;

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
  direction: z.enum(selectorDirections).optional(),
  resource: selectorTokenSchema.optional(),
  action: selectorTokenSchema.optional(),
});

const pluginContextRequestSchema = z.object({
  sender_connection_id: z.string().min(1),
  recipient: z.string().min(1),
  recipient_type: z.enum(["user", "group"]).optional().default("user"),
  draft_selectors: selectorInputSchema.optional(),
  declared_selectors: selectorInputSchema.optional(),
  include_recent_interactions: z.boolean().optional().default(true),
  interaction_limit: z.number().int().min(1).max(20).optional().default(5),
});

const pluginResolveRequestSchema = z.object({
  recipient: z.string().min(1),
  recipient_type: z.enum(["user", "group"]).optional().default("user"),
  sender_connection_id: z.string().optional(),
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
  direction: z.enum(selectorDirections).optional(),
  resource: selectorTokenSchema.optional(),
  action: selectorTokenSchema.optional(),
  declared_selectors: selectorInputSchema.optional(),
  correlation_id: z.string().optional(),
  idempotency_key: z.string().optional(),
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
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid ISO date" });

const pluginOverrideRequestSchema = z.object({
  sender_connection_id: z.string().min(1),
  source_resolution_id: z.string().min(1).max(120),
  kind: z.enum(pluginOverrideKinds),
  scope: policyScopeSchema,
  target_id: z.string().min(1).nullable().optional(),
  selectors: selectorInputSchema,
  effect: policyEffectSchema.optional().default("allow"),
  reason: z.string().min(1).max(2000),
  max_uses: z.number().int().positive().nullable().optional(),
  expires_at: isoDateSchema.optional(),
  ttl_seconds: z.number().int().positive().max(60 * 60 * 24 * 30).optional(),
  derived_from_message_id: z.string().min(1).optional(),
  policy_content: z.record(z.unknown()).optional(),
  priority: z.number().int().min(0).max(100).optional().default(90),
});

type PluginContextRequest = z.infer<typeof pluginContextRequestSchema>;
type PluginResolveRequest = z.infer<typeof pluginResolveRequestSchema>;
type PluginOutcomeRequest = z.infer<typeof pluginOutcomeRequestSchema>;
type PluginOverrideRequest = z.infer<typeof pluginOverrideRequestSchema>;
type PluginReportedOutcome = (typeof pluginOutcomeValues)[number];
type PluginOverrideKind = (typeof pluginOverrideKinds)[number];
type ContextDecision = "allow" | "ask" | "deny";
type DeliveryMode = "full_send" | "review_required" | "hold_for_approval" | "blocked";
type ReviewQueueStatus = "review_required" | "approval_pending";
type QueueDirectionFilter = "all" | "outbound" | "inbound";

const reviewQueueStatuses: readonly ReviewQueueStatus[] = [
  "review_required",
  "approval_pending",
];

const policyEffectPriority: Record<ContextDecision, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

const policyEvaluatorPriority: Record<CanonicalPolicy["evaluator"], number> = {
  llm: 0,
  heuristic: 1,
  structured: 1,
};

const defaultSelectors = {
  action: "share",
  direction: "outbound" as const,
  resource: "message.general",
};

export const pluginRoutes = new Hono<AppEnv>();
pluginRoutes.use("*", requireAuth());

function normalizeSelectorToken(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : fallback;
}

function isNamespacedSelectorToken(value: string): boolean {
  return value.includes(".");
}

function isKnownSelectorResource(value: string): boolean {
  return knownSelectorResources.has(value) || legacySelectorResources.has(value);
}

function validateSelectors(selectors: {
  direction: PolicyDirection;
  resource: string;
  action: string;
}) {
  if (!selectorDirections.includes(selectors.direction)) {
    throw new AppError(
      `Unknown direction selector '${selectors.direction}'`,
      400,
      "INVALID_SELECTOR"
    );
  }

  if (isKnownSelectorResource(selectors.resource) || isNamespacedSelectorToken(selectors.resource)) {
    return;
  }

  throw new AppError(
    `Unknown resource selector '${selectors.resource}'. Use a known resource or a namespaced selector like 'custom.preference'.`,
    400,
    "INVALID_SELECTOR"
  );
}

function resolveDirectionCandidates(direction: PolicyDirection): PolicyDirection[] {
  if (direction === "inbound" || direction === "request") {
    return ["inbound", "request"];
  }
  return [direction];
}

function resolveContextSelectors(data: PluginContextRequest) {
  const selectorSource = data.draft_selectors || data.declared_selectors;
  const direction = selectorSource?.direction || defaultSelectors.direction;
  const resource = normalizeSelectorToken(selectorSource?.resource, defaultSelectors.resource);
  const action = normalizeSelectorToken(selectorSource?.action, defaultSelectors.action);
  const selectors = {
    action,
    direction,
    resource,
  };
  validateSelectors(selectors);
  return selectors;
}

function resolveDraftSelectors(data: PluginResolveRequest) {
  const selectorSource = data.declared_selectors;
  const direction = selectorSource?.direction || data.direction || defaultSelectors.direction;
  const resource = normalizeSelectorToken(
    selectorSource?.resource || data.resource,
    defaultSelectors.resource
  );
  const action = normalizeSelectorToken(
    selectorSource?.action || data.action,
    defaultSelectors.action
  );
  const selectors = {
    action,
    direction,
    resource,
  };
  validateSelectors(selectors);
  return selectors;
}

function resolveOverrideSelectors(data: PluginOverrideRequest) {
  const direction = data.selectors.direction || defaultSelectors.direction;
  const resource = normalizeSelectorToken(data.selectors.resource, defaultSelectors.resource);
  const action = normalizeSelectorToken(data.selectors.action, defaultSelectors.action);
  const selectors = {
    action,
    direction,
    resource,
  };
  validateSelectors(selectors);
  return selectors;
}

function assertScopeTarget(scope: PolicyScope, targetId: string | null) {
  if (scope === "global" && targetId) {
    throw new AppError("Global overrides cannot include target_id", 400, "INVALID_OVERRIDE");
  }

  if ((scope === "user" || scope === "group" || scope === "role") && !targetId) {
    throw new AppError(`${scope} overrides require target_id`, 400, "INVALID_OVERRIDE");
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
        eq(schema.groupMemberships.status, "active")
      )
    )
    .limit(1);

  if (!membership) {
    throw new AppError("Not a member of this group", 403, "NOT_MEMBER");
  }

  if (membership.role !== "owner" && membership.role !== "admin") {
    throw new AppError(
      "Only group owners and admins can create group-scoped overrides",
      403,
      "FORBIDDEN"
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
      "INVALID_OVERRIDE"
    );
  }

  let expiresAt: string | null = null;
  if (data.expires_at) {
    expiresAt = new Date(data.expires_at).toISOString();
  } else if (data.ttl_seconds !== undefined) {
    expiresAt = new Date(Date.now() + data.ttl_seconds * 1000).toISOString();
  }

  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    throw new AppError("expires_at must be in the future", 400, "INVALID_OVERRIDE");
  }

  if (data.kind === "one_time") {
    if (data.max_uses !== undefined && data.max_uses !== 1) {
      throw new AppError("one_time overrides require max_uses = 1", 400, "INVALID_OVERRIDE");
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
        "INVALID_OVERRIDE"
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
      "INVALID_OVERRIDE"
    );
  }

  if (data.max_uses !== undefined && data.max_uses !== null) {
    throw new AppError("persistent overrides cannot include max_uses", 400, "INVALID_OVERRIDE");
  }

  return {
    expires_at: null,
    max_uses: null,
    remaining_uses: null,
  };
}

function parseDirectionCandidate(value: unknown): PolicyDirection {
  if (
    value === "outbound" ||
    value === "inbound" ||
    value === "request" ||
    value === "response" ||
    value === "notification" ||
    value === "error"
  ) {
    return value;
  }
  return defaultSelectors.direction;
}

function isInboundDirection(direction: PolicyDirection): boolean {
  return direction === "inbound" || direction === "request";
}

function resolveDeliveryMode(decision: ContextDecision, direction: PolicyDirection): DeliveryMode {
  if (decision === "deny") {
    return "blocked";
  }
  if (decision === "ask") {
    if (isInboundDirection(direction) && config.inboundAskMode === "hold_for_approval") {
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

function buildResolutionSummary(
  decision: ContextDecision,
  deliveryMode: DeliveryMode,
  policyResult: PolicyResult | null
): string {
  if (policyResult?.reason) {
    return policyResult.reason;
  }
  if (policyResult?.resolution_explanation) {
    return policyResult.resolution_explanation;
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

function buildAgentGuidance(decision: ContextDecision, deliveryMode: DeliveryMode): string {
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

function buildMatchedPolicies(policyResult: PolicyResult | null) {
  if (!policyResult) {
    return [];
  }

  return policyResult.evaluated_policies
    .filter((entry) => entry.matched)
    .map((entry) => ({
      effect: entry.effect,
      evaluator: entry.evaluator,
      id: entry.policy_id,
      phase: entry.phase,
      priority: entry.priority,
      scope: entry.scope,
    }));
}

async function resolveSenderConnection(
  userId: string,
  senderConnectionId?: string
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
          eq(schema.agentConnections.status, "active")
        )
      )
      .limit(1);

    if (!senderConnection) {
      throw new AppError("Sender connection not found or inactive", 404, "SENDER_CONNECTION_NOT_FOUND");
    }

    return senderConnection;
  }

  const [senderConnection] = await db
    .select()
    .from(schema.agentConnections)
    .where(
      and(
        eq(schema.agentConnections.userId, userId),
        eq(schema.agentConnections.status, "active")
      )
    )
    .orderBy(desc(schema.agentConnections.routingPriority), desc(schema.agentConnections.createdAt))
    .limit(1);

  if (!senderConnection) {
    throw new AppError("Sender connection not found or inactive", 404, "SENDER_CONNECTION_NOT_FOUND");
  }

  return senderConnection;
}

async function resolveUserRecipient(
  senderUserId: string,
  data: PluginResolveRequest
): Promise<{ recipientConnection: schema.AgentConnection; recipientUserId: string }> {
  const db = getDb();
  const [recipient] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, data.recipient.toLowerCase()))
    .limit(1);

  if (!recipient) {
    throw new AppError("Recipient user not found", 404, "USER_NOT_FOUND");
  }

  const [friendship] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        or(
          and(
            eq(schema.friendships.requesterId, senderUserId),
            eq(schema.friendships.addresseeId, recipient.id)
          ),
          and(
            eq(schema.friendships.requesterId, recipient.id),
            eq(schema.friendships.addresseeId, senderUserId)
          )
        ),
        eq(schema.friendships.status, "accepted")
      )
    )
    .limit(1);

  if (!friendship) {
    throw new AppError("Not friends with recipient", 403, "NOT_FRIENDS");
  }

  if (data.recipient_connection_id) {
    const [recipientConnection] = await db
      .select()
      .from(schema.agentConnections)
      .where(
        and(
          eq(schema.agentConnections.id, data.recipient_connection_id),
          eq(schema.agentConnections.userId, recipient.id),
          eq(schema.agentConnections.status, "active")
        )
      )
      .limit(1);

    if (!recipientConnection) {
      throw new AppError("Recipient connection not found or inactive", 404, "CONNECTION_NOT_FOUND");
    }

    return { recipientConnection, recipientUserId: recipient.id };
  }

  const connections = await db
    .select()
    .from(schema.agentConnections)
    .where(
      and(
        eq(schema.agentConnections.userId, recipient.id),
        eq(schema.agentConnections.status, "active")
      )
    )
    .orderBy(desc(schema.agentConnections.routingPriority));

  if (connections.length === 0) {
    throw new AppError("Recipient has no active connections", 404, "NO_CONNECTIONS");
  }

  let recipientConnection: schema.AgentConnection | undefined;

  if (data.routing_hints?.labels?.length) {
    recipientConnection = connections.find((connection) =>
      data.routing_hints!.labels!.includes(connection.label)
    );
  }

  if (!recipientConnection && data.routing_hints?.tags?.length) {
    recipientConnection = connections.find((connection) => {
      const capabilities = parseCapabilities(connection.capabilities);
      return data.routing_hints!.tags!.some((tag: string) => capabilities.includes(tag));
    });
  }

  return {
    recipientConnection: recipientConnection || connections[0],
    recipientUserId: recipient.id,
  };
}

async function resolveGroupRecipient(senderUserId: string, groupId: string): Promise<void> {
  const db = getDb();
  const [group] = await db
    .select()
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
        eq(schema.groupMemberships.status, "active")
      )
    )
    .limit(1);

  if (!senderMembership) {
    throw new AppError("Not a member of this group", 403, "NOT_MEMBER");
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
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

function parseOutcomeAuditContainer(
  value: string | null
): { container: Record<string, unknown>; reports: Record<string, unknown>[] } {
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
            typeof entry === "object" && entry !== null && !Array.isArray(entry)
        )
        .map((entry) => ({ ...entry }))
    : [];

  return { container, reports: reportEntries };
}

function findOutcomeEventByIdempotency(
  value: string | null,
  idempotencyKey: string
): string | null {
  const { reports } = parseOutcomeAuditContainer(value);
  const existing = reports.find((report) => report.idempotency_key === idempotencyKey);
  return typeof existing?.event_id === "string" ? existing.event_id : null;
}

function resolveOutcomeIdempotencyKey(
  data: PluginOutcomeRequest,
  idempotencyHeader: string | undefined
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
  reportEntry: PluginOutcomeAuditEntry
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

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function parsePositiveLimit(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError("limit must be a positive integer", 400, "INVALID_QUERY");
  }
  return Math.min(parsed, 100);
}

function parseQueueDirectionFilter(value: string | undefined): QueueDirectionFilter {
  if (!value || value === "all") {
    return "all";
  }
  if (value === "outbound" || value === "inbound") {
    return value;
  }
  throw new AppError("direction must be one of: all, outbound, inbound", 400, "INVALID_QUERY");
}

function parseReviewStatusFilter(value: string | undefined): ReviewQueueStatus[] {
  if (!value) {
    return [...reviewQueueStatuses];
  }

  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    throw new AppError("status must include at least one value", 400, "INVALID_QUERY");
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
      "INVALID_QUERY"
    );
  }

  return [...statuses];
}

function parseBooleanQueryFlag(
  value: string | undefined,
  fieldName: string,
  fallback: boolean
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

  throw new AppError(`${fieldName} must be true or false`, 400, "INVALID_QUERY");
}

function buildMessageVisibilityFilter(userId: string, direction: QueueDirectionFilter) {
  const outboundFilter = eq(schema.messages.senderUserId, userId);
  const inboundFilter = and(
    eq(schema.messages.recipientType, "user"),
    eq(schema.messages.recipientId, userId)
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
  message: { senderUserId: string; recipientType: string; recipientId: string }
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
  fallback: string
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

function comparePolicies(a: CanonicalPolicy, b: CanonicalPolicy): number {
  const effectDelta = policyEffectPriority[b.effect] - policyEffectPriority[a.effect];
  if (effectDelta !== 0) {
    return effectDelta;
  }

  if (b.priority !== a.priority) {
    return b.priority - a.priority;
  }

  const evaluatorDelta =
    policyEvaluatorPriority[b.evaluator] - policyEvaluatorPriority[a.evaluator];
  if (evaluatorDelta !== 0) {
    return evaluatorDelta;
  }

  return a.id.localeCompare(b.id);
}

function pickScopeWinner(policies: CanonicalPolicy[], scope: CanonicalPolicy["scope"]) {
  const scopePolicies = policies.filter((policy) => policy.scope === scope);
  if (scopePolicies.length === 0) {
    return null;
  }
  return [...scopePolicies].sort(comparePolicies)[0];
}

function resolveDefaultDecision(policies: CanonicalPolicy[]): {
  decision: ContextDecision;
  reasonCode: string;
  winningPolicy: CanonicalPolicy | null;
} {
  const orderedScopes: CanonicalPolicy["scope"][] = ["user", "role", "global"];
  for (const scope of orderedScopes) {
    const winner = pickScopeWinner(policies, scope);
    if (!winner) {
      continue;
    }
    return {
      decision: winner.effect,
      reasonCode: `context.${winner.effect}.${winner.scope}.${winner.evaluator}`,
      winningPolicy: winner,
    };
  }

  return {
    decision: "allow",
    reasonCode: "context.allow.no_applicable",
    winningPolicy: null,
  };
}

async function loadContextPolicies(
  userId: string,
  recipientUserId: string,
  roles: string[],
  selectors: { direction: PolicyDirection; resource: string; action: string }
) {
  const db = getDb();
  const now = new Date();
  const directionCandidates = resolveDirectionCandidates(selectors.direction);
  const policyConditions = [
    eq(schema.policies.scope, "global"),
    and(eq(schema.policies.scope, "user"), eq(schema.policies.targetId, recipientUserId)),
  ];

  if (roles.length > 0) {
    policyConditions.push(
      and(eq(schema.policies.scope, "role"), sql`${schema.policies.targetId} IN ${roles}`)
    );
  }

  const policies = await db
    .select()
    .from(schema.policies)
    .where(
      and(
        eq(schema.policies.userId, userId),
        eq(schema.policies.enabled, true),
        or(isNull(schema.policies.effectiveFrom), lte(schema.policies.effectiveFrom, now)),
        or(isNull(schema.policies.expiresAt), gt(schema.policies.expiresAt, now)),
        or(isNull(schema.policies.remainingUses), gt(schema.policies.remainingUses, 0)),
        or(...policyConditions),
        or(
          isNull(schema.policies.direction),
          inArray(schema.policies.direction, directionCandidates)
        ),
        or(isNull(schema.policies.resource), eq(schema.policies.resource, selectors.resource)),
        or(isNull(schema.policies.action), eq(schema.policies.action, selectors.action))
      )
    )
    .orderBy(desc(schema.policies.priority), desc(schema.policies.createdAt));

  return policies.map((policy) => dbPolicyToCanonical(policy));
}

pluginRoutes.get("/reviews", requireVerified(), async (c) => {
  const user = c.get("user")!;
  const db = getDb();
  const statusFilter = parseReviewStatusFilter(c.req.query("status"));
  const directionFilter = parseQueueDirectionFilter(c.req.query("direction"));
  const limit = parsePositiveLimit(c.req.query("limit"), 50);
  const visibilityFilter = buildMessageVisibilityFilter(user.id, directionFilter);

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
    })
  );

  const reviews = reviewMessages.map((message) => {
    const evaluation = parseJsonObject(message.policiesEvaluated);
    const decision = parseDecision(evaluation?.effect) || "ask";
    const reasonCode = parseReasonCode(evaluation?.reason_code) || "policy.ask.resolved";
    const summary = parseReasonSummary(evaluation, "Message requires review before delivery.");
    const queueDirection = resolveQueueDirection(user.id, message);
    const deliveryMode =
      message.status === "approval_pending" ? "hold_for_approval" : "review_required";

    return {
      review_id: `rev_${message.id}`,
      message_id: message.id,
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
      context_preview: message.context ? summarizeMessage(message.context, 200) : null,
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
          typeof evaluation?.winning_policy_id === "string" ? evaluation.winning_policy_id : null,
      },
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

pluginRoutes.get("/events/blocked", requireVerified(), async (c) => {
  const user = c.get("user")!;
  const db = getDb();
  const directionFilter = parseQueueDirectionFilter(c.req.query("direction"));
  const includePayloadExcerpt = parseBooleanQueryFlag(
    c.req.query("include_payload_excerpt"),
    "include_payload_excerpt",
    false
  );
  const limit = parsePositiveLimit(c.req.query("limit"), 50);
  const visibilityFilter = buildMessageVisibilityFilter(user.id, directionFilter);

  const blockedMessages = await db
    .select({
      action: schema.messages.action,
      createdAt: schema.messages.createdAt,
      direction: schema.messages.direction,
      id: schema.messages.id,
      payload: schema.messages.payload,
      policiesEvaluated: schema.messages.policiesEvaluated,
      recipientId: schema.messages.recipientId,
      recipientType: schema.messages.recipientType,
      rejectionReason: schema.messages.rejectionReason,
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
    })
  );

  const blockedEvents = blockedMessages.map((message) => {
    const evaluation = parseJsonObject(message.policiesEvaluated);
    const reasonCode = parseReasonCode(evaluation?.reason_code) || "policy.deny.resolved";
    const reason = parseReasonSummary(evaluation, message.rejectionReason || "Message blocked by policy.");

    return {
      id: `blocked_${message.id}`,
      message_id: message.id,
      queue_direction: resolveQueueDirection(user.id, message),
      sender: usernamesById.get(message.senderUserId) || null,
      reason_code: reasonCode,
      reason,
      direction: message.direction,
      resource: message.resource,
      action: message.action,
      stored_payload_excerpt: includePayloadExcerpt ? summarizeMessage(message.payload, 120) : null,
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

pluginRoutes.post("/context", zValidator("json", pluginContextRequestSchema), async (c) => {
  const user = c.get("user")!;
  const data = c.req.valid("json");
  const db = getDb();

  if (data.recipient_type !== "user") {
    throw new AppError(
      "Only recipient_type='user' is supported for plugin context v2",
      400,
      "UNSUPPORTED_RECIPIENT_TYPE"
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
        eq(schema.agentConnections.status, "active")
      )
    )
    .limit(1);

  if (!senderConnection) {
    throw new AppError(
      "Sender connection not found or inactive",
      404,
      "SENDER_CONNECTION_NOT_FOUND"
    );
  }

  const recipientUsername = data.recipient.toLowerCase();
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
            eq(schema.friendships.requesterId, user.id),
            eq(schema.friendships.addresseeId, recipient.id)
          ),
          and(
            eq(schema.friendships.requesterId, recipient.id),
            eq(schema.friendships.addresseeId, user.id)
          )
        )
      )
    )
    .limit(1);

  if (!friendship) {
    throw new AppError("Not friends with recipient", 404, "NOT_FRIENDS");
  }

  const roles = await getRolesForFriend(user.id, recipient.id);
  const applicablePolicies = await loadContextPolicies(user.id, recipient.id, roles, selectors);
  const summary = await generatePolicySummary(applicablePolicies, roles);
  const defaultDecision = resolveDefaultDecision(applicablePolicies);

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
                eq(schema.messages.recipientId, recipient.id)
              ),
              and(
                eq(schema.messages.senderUserId, recipient.id),
                eq(schema.messages.recipientId, user.id)
              )
            )
          )
        )
        .orderBy(desc(schema.messages.createdAt))
        .limit(data.interaction_limit)
    : [];

  const recentInteractions = interactions.map((interaction) => ({
    direction: interaction.senderUserId === user.id ? "outbound" : "inbound",
    message_id: interaction.id,
    summary: summarizeMessage(interaction.payload),
    timestamp: interaction.createdAt?.toISOString() || new Date().toISOString(),
  }));

  const relevantDecisions = interactions
    .map((interaction) => {
      const evaluation = parseJsonObject(interaction.policiesEvaluated);
      const decision = parseDecision(evaluation?.effect) || parseDecision(interaction.outcome);
      if (!decision) {
        return null;
      }

      return {
        decision,
        direction: interaction.senderUserId === user.id ? "outbound" : "inbound",
        matched_policy_ids: parseStringArray(evaluation?.matched_policy_ids),
        message_id: interaction.id,
        reason_code: parseReasonCode(evaluation?.reason_code),
        selectors: {
          action: interaction.action,
          direction: interaction.direction,
          resource: interaction.resource,
        },
        status: interaction.status,
        timestamp: interaction.createdAt?.toISOString() || new Date().toISOString(),
        winning_policy_id:
          typeof evaluation?.winning_policy_id === "string" ? evaluation.winning_policy_id : null,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  return c.json({
    contract_version: CONTRACT_VERSION,
    policy_guidance: {
      default_decision: defaultDecision.decision,
      reason_code: defaultDecision.reasonCode,
      relevant_decisions: relevantDecisions,
      relevant_policies: applicablePolicies.map((policy) => ({
        effect: policy.effect,
        evaluator: policy.evaluator,
        id: policy.id,
        priority: policy.priority,
        scope: policy.scope,
        selectors: {
          action: policy.action || defaultSelectors.action,
          direction: policy.direction,
          resource: policy.resource,
        },
        target_id: policy.target_id,
      })),
      summary,
      winning_policy_id: defaultDecision.winningPolicy?.id || null,
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
});

pluginRoutes.post(
  "/resolve",
  requireVerified(),
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
    const senderConnection = await resolveSenderConnection(user.id, data.sender_connection_id);
    const identity: AuthenticatedSenderIdentity = {
      sender_user_id: user.id,
      sender_connection_id: senderConnection.id,
    };

    const selectorContext = {
      action: selectors.action,
      direction,
      resource: selectors.resource,
    };
    const evaluatePolicy = config.trustedMode && data.payload_type !== "application/mahilo+ciphertext";

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
          selectorContext
        );
      }
    } else {
      const { recipientConnection, recipientUserId } = await resolveUserRecipient(user.id, data);
      resolvedRecipientConnectionId = recipientConnection.id;

      if (evaluatePolicy) {
        if (isInboundDirection(direction)) {
          policyResult = await evaluateInboundPolicies(
            recipientUserId,
            user.id,
            data.message,
            data.context,
            identity,
            selectorContext
          );
        } else {
          policyResult = await evaluatePolicies(
            user.id,
            recipientUserId,
            data.message,
            data.context,
            identity,
            selectorContext
          );
        }
      }
    }

    const decision: ContextDecision = policyResult?.effect ?? "allow";
    const deliveryMode = resolveDeliveryMode(decision, direction);
    const resolutionSummary = buildResolutionSummary(decision, deliveryMode, policyResult);
    const resolutionId = `res_${nanoid(18)}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    return c.json({
      contract_version: CONTRACT_VERSION,
      resolution_id: resolutionId,
      decision,
      delivery_mode: deliveryMode,
      resolution_summary: resolutionSummary,
      agent_guidance: buildAgentGuidance(decision, deliveryMode),
      reason_code: policyResult?.reason_code || defaultReasonCode(decision),
      server_selectors: {
        action: selectors.action,
        direction,
        resource: selectors.resource,
      },
      matched_policies: buildMatchedPolicies(policyResult),
      applied_policy: {
        guardrail_id: policyResult?.guardrail_id || null,
        matched_policy_ids: policyResult?.matched_policy_ids || [],
        resolver_layer: policyResult?.resolver_layer || null,
        winning_policy_id: policyResult?.winning_policy_id || null,
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
  }
);

pluginRoutes.post(
  "/overrides",
  requireVerified(),
  zValidator("json", pluginOverrideRequestSchema),
  async (c) => {
    const user = c.get("user")!;
    const data = c.req.valid("json");
    const db = getDb();
    const senderConnection = await resolveSenderConnection(user.id, data.sender_connection_id);
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
              eq(schema.messages.recipientId, user.id)
            )
          )
        )
        .limit(1);

      if (!sourceMessage) {
        throw new AppError(
          "derived_from_message_id must reference a message visible to this user",
          404,
          "SOURCE_MESSAGE_NOT_FOUND"
        );
      }
    }

    const selectors = resolveOverrideSelectors(data);
    const lifecycle = resolveOverrideLifecycle(data);
    const createdAt = new Date().toISOString();
    const basePolicyContent = data.policy_content ? { ...data.policy_content } : {};
    const policyContent = {
      ...basePolicyContent,
      _mahilo_override: {
        kind: data.kind as PluginOverrideKind,
        reason: data.reason,
        sender_connection_id: senderConnection.id,
        source_resolution_id: data.source_resolution_id,
        created_via: "plugin.overrides",
        created_at: createdAt,
      },
    };

    const contentValidation = validatePolicyContent("structured", policyContent);
    if (!contentValidation.valid) {
      throw new AppError(contentValidation.error!, 400, "INVALID_POLICY_CONTENT");
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
      201
    );
  }
);

pluginRoutes.post(
  "/outcomes",
  requireVerified(),
  zValidator("json", pluginOutcomeRequestSchema),
  async (c) => {
    const user = c.get("user")!;
    const data = c.req.valid("json");
    const db = getDb();
    const senderConnection = await resolveSenderConnection(user.id, data.sender_connection_id);

    const [message] = await db
      .select({
        action: schema.messages.action,
        correlationId: schema.messages.correlationId,
        direction: schema.messages.direction,
        id: schema.messages.id,
        inResponseTo: schema.messages.inResponseTo,
        outcomeDetails: schema.messages.outcomeDetails,
        resource: schema.messages.resource,
        senderConnectionId: schema.messages.senderConnectionId,
      })
      .from(schema.messages)
      .where(and(eq(schema.messages.id, data.message_id), eq(schema.messages.senderUserId, user.id)))
      .limit(1);

    if (!message) {
      throw new AppError("Message not found", 404, "MESSAGE_NOT_FOUND");
    }

    if (message.senderConnectionId && message.senderConnectionId !== senderConnection.id) {
      throw new AppError(
        "Message sender connection does not match sender_connection_id",
        403,
        "MESSAGE_SENDER_MISMATCH"
      );
    }

    const idempotencyKey = resolveOutcomeIdempotencyKey(
      data,
      c.req.header("Idempotency-Key")
    );
    if (idempotencyKey) {
      const existingEventId = findOutcomeEventByIdempotency(message.outcomeDetails, idempotencyKey);
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
      resolution_id: data.resolution_id || `res_${message.id}`,
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

    const nextOutcomeDetails = buildOutcomeAuditDetails(message.outcomeDetails, auditEntry);

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
  }
);
