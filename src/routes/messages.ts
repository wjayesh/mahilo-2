import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, and, or, desc, gt, ne, inArray } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { requireAuth, requireVerified } from "../middleware/auth";
import { AppError } from "../middleware/error";
import { parseCapabilities, validatePayloadSize } from "../services/validation";
import { deliverMessage, deliverToConnection } from "../services/delivery";
import {
  evaluatePolicies,
  evaluateInboundPolicies,
  consumeWinningPolicyUse,
  type AuthenticatedSenderIdentity,
  type PolicyResult,
} from "../services/policy";
import { config } from "../config";
import { getRolesForFriend } from "../services/roles";
import { generatePolicySummary } from "../services/policySummary";
import { dbPolicyToCanonical, type CanonicalPolicy } from "../services/policySchema";

export const messageRoutes = new Hono<AppEnv>();

// Use auth middleware for all routes
messageRoutes.use("*", requireAuth());

const messageSelectorDirections = [
  "outbound",
  "inbound",
  "request",
  "response",
  "notification",
  "error",
] as const;
const knownMessageSelectorDirections = new Set<string>(messageSelectorDirections);

const knownMessageSelectorResources = new Set<string>([
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

const legacyMessageSelectorResources = new Set<string>([
  "calendar",
  "location",
  "document",
  "contact",
  "action",
  "meta",
]);

const defaultMessageSelectors = {
  direction: "outbound" as const,
  resource: "message.general",
  action: "share",
};

const selectorTokenSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9._-]+$/i);

const selectorInputSchema = z.object({
  direction: z.enum(messageSelectorDirections).optional(),
  resource: selectorTokenSchema.optional(),
  action: selectorTokenSchema.optional(),
});

const outcomeDetailsSchema = z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]);

type MessageDirection = (typeof messageSelectorDirections)[number];
type PolicyDecision = PolicyResult["effect"];
type DeliveryMode = "full_send" | "review_required" | "hold_for_approval" | "blocked";
type MessageRecordStatus =
  | "pending"
  | "delivered"
  | "failed"
  | "rejected"
  | "review_required"
  | "approval_pending";

interface StructuredResolution {
  resolution_id: string;
  decision: PolicyDecision;
  delivery_mode: DeliveryMode;
  summary: string;
  reason: string | null;
  reason_code: string;
  resolver_layer: PolicyResult["resolver_layer"] | null;
  guardrail_id: string | null;
  winning_policy_id: string | null;
  matched_policy_ids: string[];
}

interface RecipientResolutionResult {
  recipient: string;
  decision: PolicyDecision;
  delivery_mode: DeliveryMode;
  delivery_status: string;
}

interface GroupRecipientPolicyAudit {
  recipient_user_id: string;
  recipient_username: string;
  resolution_id: string;
  decision: PolicyDecision;
  delivery_mode: DeliveryMode;
  should_deliver: boolean;
  delivery_status: string;
  reason: string | null;
  reason_code: string;
  winning_policy_id: string | null;
  matched_policy_ids: string[];
  resolver_layer: PolicyResult["resolver_layer"] | null;
  guardrail_id: string | null;
}

function buildDeliveryResolutionColumns(audit: GroupRecipientPolicyAudit) {
  return {
    policyDecision: audit.decision,
    policyDeliveryMode: audit.delivery_mode,
    policyReason: audit.reason,
    policyReasonCode: audit.reason_code,
    policyResolutionId: audit.resolution_id,
    winningPolicyId: audit.winning_policy_id,
    matchedPolicyIds: JSON.stringify(audit.matched_policy_ids),
    resolverLayer: audit.resolver_layer,
    guardrailId: audit.guardrail_id,
  };
}

function serializeOptionalDetails(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function parseOptionalJsonText(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

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

function isKnownMessageResource(value: string): boolean {
  return (
    knownMessageSelectorResources.has(value) ||
    legacyMessageSelectorResources.has(value)
  );
}

function validateMessageSelectors(selectors: {
  direction: MessageDirection;
  resource: string;
  action: string;
}) {
  if (!knownMessageSelectorDirections.has(selectors.direction)) {
    throw new AppError(
      `Unknown direction selector '${selectors.direction}'`,
      400,
      "INVALID_SELECTOR"
    );
  }

  if (isKnownMessageResource(selectors.resource) || isNamespacedSelectorToken(selectors.resource)) {
    return;
  }

  throw new AppError(
    `Unknown resource selector '${selectors.resource}'. Use a known resource or a namespaced selector like 'custom.preference'.`,
    400,
    "INVALID_SELECTOR"
  );
}

function serializePolicyEvaluation(
  result: PolicyResult,
  auditMetadata?: Record<string, unknown>
): string {
  return JSON.stringify({
    authenticated_identity: result.authenticated_identity || null,
    effect: result.effect,
    reason: result.reason || null,
    reason_code: result.reason_code,
    resolution_explanation: result.resolution_explanation,
    resolver_layer: result.resolver_layer || null,
    guardrail_id: result.guardrail_id || null,
    winning_policy_id: result.winning_policy_id || null,
    winning_policy: result.winning_policy || null,
    matched_policy_ids: result.matched_policy_ids,
    evaluated_policies: result.evaluated_policies,
    ...(auditMetadata || {}),
  });
}

function isInboundDirection(direction: MessageDirection): boolean {
  return direction === "inbound" || direction === "request";
}

function resolveDeliveryMode(decision: PolicyDecision, direction: MessageDirection): DeliveryMode {
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

function shouldDeliverForDecision(
  decision: PolicyDecision,
  direction: MessageDirection,
  deliveryMode: DeliveryMode
): boolean {
  if (decision === "allow") {
    return true;
  }
  if (decision === "ask" && isInboundDirection(direction) && deliveryMode === "review_required") {
    return true;
  }
  return false;
}

function blockedMessageStatusForDecision(
  decision: PolicyDecision,
  deliveryMode: DeliveryMode
): Extract<MessageRecordStatus, "rejected" | "review_required" | "approval_pending"> {
  if (decision === "deny") {
    return "rejected";
  }
  if (deliveryMode === "hold_for_approval") {
    return "approval_pending";
  }
  return "review_required";
}

function buildResolutionSummary(
  decision: PolicyDecision,
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

function defaultReasonCode(decision: PolicyDecision): string {
  if (decision === "ask") {
    return "policy.ask.resolved";
  }
  if (decision === "deny") {
    return "policy.deny.resolved";
  }
  return "policy.allow.resolved";
}

function buildStructuredResolution(
  resolutionId: string,
  direction: MessageDirection,
  policyResult: PolicyResult | null
): StructuredResolution {
  const decision: PolicyDecision = policyResult?.effect ?? "allow";
  const deliveryMode = resolveDeliveryMode(decision, direction);
  return {
    resolution_id: resolutionId,
    decision,
    delivery_mode: deliveryMode,
    summary: buildResolutionSummary(decision, deliveryMode, policyResult),
    reason: policyResult?.reason || null,
    reason_code: policyResult?.reason_code || defaultReasonCode(decision),
    resolver_layer: policyResult?.resolver_layer || null,
    guardrail_id: policyResult?.guardrail_id || null,
    winning_policy_id: policyResult?.winning_policy_id || null,
    matched_policy_ids: policyResult?.matched_policy_ids || [],
  };
}

function buildRecipientResult(
  recipient: string,
  resolution: StructuredResolution,
  deliveryStatus: string
): RecipientResolutionResult {
  return {
    recipient,
    decision: resolution.decision,
    delivery_mode: resolution.delivery_mode,
    delivery_status: deliveryStatus,
  };
}

function serializeGroupFanOutPolicyEvaluation(
  entries: GroupRecipientPolicyAudit[],
  metadata?: Record<string, unknown>
): string | null {
  if (entries.length === 0) {
    return null;
  }

  const decisionCounts: Record<PolicyDecision, number> = {
    allow: 0,
    ask: 0,
    deny: 0,
  };
  const deliveryStatusCounts: Record<string, number> = {};

  for (const entry of entries) {
    decisionCounts[entry.decision] += 1;
    deliveryStatusCounts[entry.delivery_status] = (deliveryStatusCounts[entry.delivery_status] || 0) + 1;
  }

  const partialDelivery =
    Object.values(decisionCounts).filter((count) => count > 0).length > 1 ||
    Object.values(deliveryStatusCounts).filter((count) => count > 0).length > 1;

  return JSON.stringify({
    fanout_mode: "per_recipient",
    partial_delivery: partialDelivery,
    recipient_count: entries.length,
    decision_counts: decisionCounts,
    delivery_status_counts: deliveryStatusCounts,
    recipients: entries,
    ...(metadata || {}),
  });
}

function deriveGroupAggregateDecision(entries: GroupRecipientPolicyAudit[]): PolicyDecision {
  if (entries.length === 0) {
    return "allow";
  }

  const decisions = new Set(entries.map((entry) => entry.decision));
  if (decisions.size === 1) {
    return entries[0].decision;
  }

  if (decisions.has("allow")) {
    return "allow";
  }
  if (decisions.has("ask")) {
    return "ask";
  }
  return "deny";
}

function deriveGroupOutcomeFromFanOut(
  requestedOutcome: string | null,
  entries: GroupRecipientPolicyAudit[]
): string | null {
  if (requestedOutcome) {
    return requestedOutcome;
  }

  if (entries.length === 0) {
    return null;
  }

  const deliveredCount = entries.filter((entry) => entry.delivery_status === "delivered").length;
  const constrainedCount = entries.filter(
    (entry) =>
      entry.delivery_status === "rejected" ||
      entry.delivery_status === "review_required" ||
      entry.delivery_status === "approval_pending"
  ).length;
  const failedCount = entries.filter((entry) => entry.delivery_status === "failed").length;

  if (deliveredCount > 0 && (constrainedCount > 0 || failedCount > 0)) {
    return "partial_sent";
  }
  if (deliveredCount > 0) {
    return "allow";
  }
  if (constrainedCount > 0) {
    return constrainedCount === entries.length ? "deny" : "ask";
  }
  if (failedCount > 0) {
    return "failed";
  }

  return null;
}

function parseDecisionCandidate(value: unknown): PolicyDecision | null {
  if (value === "allow" || value === "ask" || value === "deny") {
    return value;
  }
  return null;
}

function parseDirectionCandidate(value: unknown): MessageDirection {
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
  return defaultMessageSelectors.direction;
}

function buildStoredMessageResolution(
  message: schema.Message,
  requestedResolutionId?: string
): StructuredResolution {
  const parsed = parseOptionalJsonText(message.policiesEvaluated);
  const evaluation =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;

  const decision =
    parseDecisionCandidate(evaluation?.effect) ||
    parseDecisionCandidate(message.outcome) ||
    (message.status === "rejected"
      ? "deny"
      : message.status === "review_required" || message.status === "approval_pending"
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
    resolution_id: requestedResolutionId || `res_${message.id}`,
    decision,
    delivery_mode: deliveryMode,
    summary:
      (typeof evaluation?.reason === "string" && evaluation.reason) ||
      (typeof evaluation?.resolution_explanation === "string" && evaluation.resolution_explanation) ||
      buildResolutionSummary(decision, deliveryMode, null),
    reason: typeof evaluation?.reason === "string" ? evaluation.reason : null,
    reason_code:
      (typeof evaluation?.reason_code === "string" && evaluation.reason_code) ||
      defaultReasonCode(decision),
    resolver_layer:
      (typeof evaluation?.resolver_layer === "string"
        ? (evaluation.resolver_layer as PolicyResult["resolver_layer"])
        : null) || null,
    guardrail_id: typeof evaluation?.guardrail_id === "string" ? evaluation.guardrail_id : null,
    winning_policy_id:
      typeof evaluation?.winning_policy_id === "string" ? evaluation.winning_policy_id : null,
    matched_policy_ids: Array.isArray(evaluation?.matched_policy_ids)
      ? evaluation!.matched_policy_ids.filter((value): value is string => typeof value === "string")
      : [],
  };
}

// Send message
const sendMessageSchema = z.object({
  recipient: z.string().min(1), // username or group_id
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
  encryption: z
    .object({
      alg: z.string(),
      key_id: z.string(),
    })
    .optional(),
  sender_signature: z
    .object({
      alg: z.string(),
      key_id: z.string(),
      signature: z.string(),
    })
    .optional(),
  direction: z.enum(messageSelectorDirections).optional(),
  resource: selectorTokenSchema.optional(),
  action: selectorTokenSchema.optional(),
  declared_selectors: selectorInputSchema.optional(),
  in_response_to: z.string().optional(),
  outcome: z.string().min(1).max(120).optional(),
  outcome_details: outcomeDetailsSchema.optional(),
  outcome_metadata: z
    .object({
      outcome: z.string().min(1).max(120),
      outcome_details: outcomeDetailsSchema.optional(),
    })
    .optional(),
  correlation_id: z.string().optional(),
  idempotency_key: z.string().optional(),
  resolution_id: z.string().optional(),
});

type SendMessageInput = z.infer<typeof sendMessageSchema>;

function resolveMessageSelectors(data: SendMessageInput) {
  const selectorSource = data.declared_selectors;
  return {
    direction:
      selectorSource?.direction ||
      data.direction ||
      defaultMessageSelectors.direction,
    resource: normalizeSelectorToken(
      selectorSource?.resource || data.resource,
      defaultMessageSelectors.resource
    ),
    action: normalizeSelectorToken(
      selectorSource?.action || data.action,
      defaultMessageSelectors.action
    ),
  };
}

function resolveOutcomeMetadata(data: SendMessageInput) {
  const outcome = data.outcome_metadata?.outcome || data.outcome || null;
  const outcomeDetails = serializeOptionalDetails(
    data.outcome_metadata?.outcome_details ?? data.outcome_details
  );

  return { outcome, outcomeDetails };
}

messageRoutes.post("/send", requireVerified(), zValidator("json", sendMessageSchema), async (c) => {
  const user = c.get("user")!;
  const data = c.req.valid("json");
  const db = getDb();

  // Validate payload size
  const sizeValidation = validatePayloadSize(data.message);
  if (!sizeValidation.valid) {
    throw new AppError(sizeValidation.error!, 400, "PAYLOAD_TOO_LARGE");
  }

  // Check idempotency
  if (data.idempotency_key) {
    const [existing] = await db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.senderUserId, user.id),
          eq(schema.messages.idempotencyKey, data.idempotency_key)
        )
      )
      .limit(1);

    if (existing) {
      const resolution = buildStoredMessageResolution(existing, data.resolution_id);
      return c.json({
        message_id: existing.id,
        status: existing.status,
        deduplicated: true,
        resolution,
        recipient_results: [
          buildRecipientResult(existing.recipientId, resolution, existing.status),
        ],
      });
    }
  }

  const messageSelectors = resolveMessageSelectors(data);
  validateMessageSelectors(messageSelectors);
  const requestedOutcome = resolveOutcomeMetadata(data);
  const inResponseTo = data.in_response_to || null;
  const resolutionId = data.resolution_id || `res_${nanoid(18)}`;

  let senderConnectionId: string;
  if (data.sender_connection_id) {
    const [senderConnection] = await db
      .select({ id: schema.agentConnections.id })
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
      throw new AppError("Sender connection not found or inactive", 404, "SENDER_CONNECTION_NOT_FOUND");
    }

    senderConnectionId = senderConnection.id;
  } else {
    const [senderConnection] = await db
      .select({ id: schema.agentConnections.id })
      .from(schema.agentConnections)
      .where(
        and(
          eq(schema.agentConnections.userId, user.id),
          eq(schema.agentConnections.status, "active")
        )
      )
      .orderBy(desc(schema.agentConnections.routingPriority), desc(schema.agentConnections.createdAt))
      .limit(1);

    if (!senderConnection) {
      throw new AppError("Sender connection not found or inactive", 404, "SENDER_CONNECTION_NOT_FOUND");
    }

    senderConnectionId = senderConnection.id;
  }

  const authenticatedSenderIdentity: AuthenticatedSenderIdentity = {
    sender_user_id: user.id,
    sender_connection_id: senderConnectionId,
  };

  // Resolve recipient
  let recipientUserId: string;
  let recipientConnection: schema.AgentConnection | null = null;

  if (data.recipient_type === "user") {
    // Find recipient user
    const [recipient] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, data.recipient.toLowerCase()))
      .limit(1);

    if (!recipient) {
      throw new AppError("Recipient user not found", 404, "USER_NOT_FOUND");
    }

    recipientUserId = recipient.id;

    // Check friendship
    const [friendship] = await db
      .select()
      .from(schema.friendships)
      .where(
        and(
          or(
            and(
              eq(schema.friendships.requesterId, user.id),
              eq(schema.friendships.addresseeId, recipient.id)
            ),
            and(
              eq(schema.friendships.requesterId, recipient.id),
              eq(schema.friendships.addresseeId, user.id)
            )
          ),
          eq(schema.friendships.status, "accepted")
        )
      )
      .limit(1);

    if (!friendship) {
      throw new AppError("Not friends with recipient", 403, "NOT_FRIENDS");
    }

    // Get recipient connection
    if (data.recipient_connection_id) {
      // Specific connection requested
      const [conn] = await db
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

      if (!conn) {
        throw new AppError("Recipient connection not found or inactive", 404, "CONNECTION_NOT_FOUND");
      }

      recipientConnection = conn;
    } else {
      // Find best connection based on routing hints or priority
      let connections = await db
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

      // Apply routing hints if provided
      if (data.routing_hints?.labels?.length) {
        const labelMatch = connections.find((c) =>
          data.routing_hints!.labels!.includes(c.label)
        );
        if (labelMatch) {
          recipientConnection = labelMatch;
        }
      }

      if (!recipientConnection && data.routing_hints?.tags?.length) {
        const tagMatch = connections.find((c) => {
          const caps = parseCapabilities(c.capabilities);
          return data.routing_hints!.tags!.some((t: string) => caps.includes(t));
        });
        if (tagMatch) {
          recipientConnection = tagMatch;
        }
      }

      // Default to highest priority connection
      if (!recipientConnection) {
        recipientConnection = connections[0];
      }
    }
  } else {
    // Group messaging (SRV-050 per-recipient fan-out resolution)
    const groupId = data.recipient;

    // Get the group
    const [group] = await db
      .select()
      .from(schema.groups)
      .where(eq(schema.groups.id, groupId))
      .limit(1);

    if (!group) {
      throw new AppError("Group not found", 404, "GROUP_NOT_FOUND");
    }

    // Check if sender is an active member
    const [senderMembership] = await db
      .select()
      .from(schema.groupMemberships)
      .where(
        and(
          eq(schema.groupMemberships.groupId, groupId),
          eq(schema.groupMemberships.userId, user.id),
          eq(schema.groupMemberships.status, "active")
        )
      )
      .limit(1);

    if (!senderMembership) {
      throw new AppError("Not a member of this group", 403, "NOT_MEMBER");
    }

    // Get sender's agent connection for sender_agent field
    const senderAgent = data.routing_hints?.labels?.[0] || "agent";

    // Get sender username
    const [sender] = await db
      .select({ username: schema.users.username })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .limit(1);

    const groupDirection = parseDirectionCandidate(messageSelectors.direction);
    const selectorContext = {
      direction: groupDirection,
      resource: messageSelectors.resource,
      action: messageSelectors.action,
    };
    const isEncrypted = data.payload_type === "application/mahilo+ciphertext";

    // Get all active group members (excluding sender)
    const members = await db
      .select({
        userId: schema.groupMemberships.userId,
        username: schema.users.username,
      })
      .from(schema.groupMemberships)
      .innerJoin(schema.users, eq(schema.groupMemberships.userId, schema.users.id))
      .where(
        and(
          eq(schema.groupMemberships.groupId, groupId),
          eq(schema.groupMemberships.status, "active"),
          ne(schema.groupMemberships.userId, user.id)
        )
      );

    const memberUserIds = members.map((member) => member.userId);
    const memberConnections =
      memberUserIds.length > 0
        ? await db
            .select()
            .from(schema.agentConnections)
            .where(
              and(
                inArray(schema.agentConnections.userId, memberUserIds),
                eq(schema.agentConnections.status, "active")
              )
            )
            .orderBy(desc(schema.agentConnections.routingPriority))
        : [];

    const connectionsByUser = new Map<string, schema.AgentConnection[]>();
    for (const connection of memberConnections) {
      const connections = connectionsByUser.get(connection.userId) || [];
      connections.push(connection);
      connectionsByUser.set(connection.userId, connections);
    }

    const recipientPolicyAudits: GroupRecipientPolicyAudit[] = [];
    const recipientPolicyAuditByUser = new Map<string, GroupRecipientPolicyAudit>();
    const deliveryEligibleMembers: Array<{
      userId: string;
      username: string;
      resolution: StructuredResolution;
      reviewRequiredDelivery: boolean;
      connections: schema.AgentConnection[];
    }> = [];

    for (const member of members) {
      let recipientPolicyResult: PolicyResult | null = null;
      if (!isEncrypted && config.trustedMode) {
        recipientPolicyResult = await evaluatePolicies(
          user.id,
          member.userId,
          data.message,
          data.context,
          authenticatedSenderIdentity,
          selectorContext,
          groupId
        );
        await consumeWinningPolicyUse(user.id, recipientPolicyResult);
      }

      const recipientResolution = buildStructuredResolution(
        `${resolutionId}_${member.userId}`,
        groupDirection,
        recipientPolicyResult
      );
      const shouldDeliverRecipient = shouldDeliverForDecision(
        recipientResolution.decision,
        groupDirection,
        recipientResolution.delivery_mode
      );
      const deliveryStatus = shouldDeliverRecipient
        ? "pending"
        : blockedMessageStatusForDecision(
            recipientResolution.decision,
            recipientResolution.delivery_mode
          );

      const policyAudit: GroupRecipientPolicyAudit = {
        recipient_user_id: member.userId,
        recipient_username: member.username,
        resolution_id: recipientResolution.resolution_id,
        decision: recipientResolution.decision,
        delivery_mode: recipientResolution.delivery_mode,
        should_deliver: shouldDeliverRecipient,
        delivery_status: deliveryStatus,
        reason: recipientResolution.reason,
        reason_code: recipientResolution.reason_code,
        winning_policy_id: recipientResolution.winning_policy_id,
        matched_policy_ids: recipientResolution.matched_policy_ids,
        resolver_layer: recipientResolution.resolver_layer,
        guardrail_id: recipientResolution.guardrail_id,
      };
      recipientPolicyAudits.push(policyAudit);
      recipientPolicyAuditByUser.set(member.userId, policyAudit);

      if (!shouldDeliverRecipient) {
        continue;
      }

      deliveryEligibleMembers.push({
        userId: member.userId,
        username: member.username,
        resolution: recipientResolution,
        reviewRequiredDelivery:
          recipientResolution.decision === "ask" &&
          recipientResolution.delivery_mode === "review_required",
        connections: connectionsByUser.get(member.userId) || [],
      });
    }

    // Create the parent message record. Final status/evaluation are set after fan-out completes.
    const messageId = nanoid();
    await db.insert(schema.messages).values({
      id: messageId,
      correlationId: data.correlation_id,
      direction: messageSelectors.direction,
      resource: messageSelectors.resource,
      action: messageSelectors.action,
      inResponseTo,
      outcome: requestedOutcome.outcome,
      outcomeDetails: requestedOutcome.outcomeDetails,
      policiesEvaluated: null,
      senderUserId: user.id,
      senderConnectionId,
      senderAgent,
      recipientType: "group",
      recipientId: groupId,
      recipientConnectionId: null,
      payload: data.message,
      payloadType: data.payload_type,
      encryption: data.encryption ? JSON.stringify(data.encryption) : null,
      senderSignature: data.sender_signature
        ? JSON.stringify(data.sender_signature)
        : null,
      context: data.context,
      status: "pending",
      idempotencyKey: data.idempotency_key,
    });

    // Log policy-constrained recipients explicitly in delivery records.
    for (const policyAudit of recipientPolicyAudits) {
      if (
        policyAudit.delivery_status === "rejected" ||
        policyAudit.delivery_status === "review_required" ||
        policyAudit.delivery_status === "approval_pending"
      ) {
        await db.insert(schema.messageDeliveries).values({
          id: nanoid(),
          messageId,
          recipientUserId: policyAudit.recipient_user_id,
          recipientConnectionId: null,
          ...buildDeliveryResolutionColumns(policyAudit),
          status: "failed",
          errorMessage: policyAudit.reason
            ? `Policy ${policyAudit.decision}: ${policyAudit.reason}`
            : `Policy ${policyAudit.decision}: ${policyAudit.reason_code}`,
        });
      }
    }

    // Deliver to recipients that passed per-recipient resolution.
    const deliveryPromises: Promise<void>[] = [];
    const memberDeliveryStats = new Map<
      string,
      { delivered: number; pending: number; failed: number }
    >();

    for (const member of deliveryEligibleMembers) {
      const memberPolicyAudit = recipientPolicyAuditByUser.get(member.userId);
      if (!memberPolicyAudit) {
        continue;
      }

      const memberStats = memberDeliveryStats.get(member.userId) || {
        delivered: 0,
        pending: 0,
        failed: 0,
      };

      if (member.connections.length === 0) {
        await db.insert(schema.messageDeliveries).values({
          id: nanoid(),
          messageId,
          recipientUserId: member.userId,
          recipientConnectionId: null,
          ...buildDeliveryResolutionColumns(memberPolicyAudit),
          status: "failed",
          errorMessage: "No active connection",
        });
        memberStats.failed++;
        memberDeliveryStats.set(member.userId, memberStats);
        continue;
      }

      for (const connection of member.connections) {
        const deliveryId = nanoid();
        await db.insert(schema.messageDeliveries).values({
          id: deliveryId,
          messageId,
          recipientUserId: member.userId,
          recipientConnectionId: connection.id,
          ...buildDeliveryResolutionColumns(memberPolicyAudit),
          status: "pending",
        });

        // Deliver asynchronously
        deliveryPromises.push(
          deliverToConnection(connection, {
            message_id: messageId,
            delivery_id: deliveryId,
            correlation_id: data.correlation_id,
            recipient_connection_id: connection.id,
            sender: sender!.username,
            sender_user_id: user.id,
            sender_connection_id: senderConnectionId,
            sender_agent: senderAgent,
            message: data.message,
            payload_type: data.payload_type,
            encryption: data.encryption,
            sender_signature: data.sender_signature,
            context: data.context,
            selectors: {
              direction: messageSelectors.direction,
              resource: messageSelectors.resource,
              action: messageSelectors.action,
            },
            resolution_id: member.resolution.resolution_id,
            review_required: member.reviewRequiredDelivery,
            delivery_mode: member.resolution.delivery_mode,
            group_id: groupId,
            group_name: group.name,
            timestamp: new Date().toISOString(),
          }).then((result) => {
            const stats = memberDeliveryStats.get(member.userId) || {
              delivered: 0,
              pending: 0,
              failed: 0,
            };

            if (result.status === "delivered") {
              stats.delivered++;
            } else if (result.status === "pending") {
              stats.pending++;
            } else {
              stats.failed++;
            }

            memberDeliveryStats.set(member.userId, stats);
          })
        );
      }
    }

    await Promise.all(deliveryPromises);

    for (const member of deliveryEligibleMembers) {
      const stats = memberDeliveryStats.get(member.userId);
      const policyAudit = recipientPolicyAuditByUser.get(member.userId);
      if (!policyAudit) {
        continue;
      }

      if (!stats) {
        policyAudit.delivery_status = "failed";
      } else if (stats.pending > 0) {
        policyAudit.delivery_status = "pending";
      } else if (stats.delivered > 0) {
        policyAudit.delivery_status = "delivered";
      } else {
        policyAudit.delivery_status = "failed";
      }
    }

    const recipientsTotal = recipientPolicyAudits.length;
    let memberDeliveredCount = 0;
    let memberPendingCount = 0;
    let memberFailedCount = 0;
    let memberRejectedCount = 0;
    let memberReviewRequiredCount = 0;

    for (const policyAudit of recipientPolicyAudits) {
      if (policyAudit.delivery_status === "delivered") {
        memberDeliveredCount++;
      } else if (policyAudit.delivery_status === "pending") {
        memberPendingCount++;
      } else if (
        policyAudit.delivery_status === "review_required" ||
        policyAudit.delivery_status === "approval_pending"
      ) {
        memberReviewRequiredCount++;
      } else if (policyAudit.delivery_status === "rejected") {
        memberRejectedCount++;
      } else {
        memberFailedCount++;
      }
    }

    const aggregateDecision = deriveGroupAggregateDecision(recipientPolicyAudits);
    const aggregateDeliveryMode = resolveDeliveryMode(aggregateDecision, groupDirection);
    const distinctDecisions = new Set(recipientPolicyAudits.map((entry) => entry.decision));
    const distinctStatuses = new Set(recipientPolicyAudits.map((entry) => entry.delivery_status));
    const partialDelivery =
      recipientsTotal > 0 &&
      (distinctDecisions.size > 1 || distinctStatuses.size > 1);

    const representativeAudit =
      recipientPolicyAudits.find((entry) => entry.decision === aggregateDecision) ||
      recipientPolicyAudits[0];
    const aggregateReason = partialDelivery
      ? "Group fan-out produced mixed per-recipient outcomes."
      : representativeAudit?.reason || null;
    const aggregateReasonCode = partialDelivery
      ? "policy.partial.group_fanout"
      : representativeAudit?.reason_code || defaultReasonCode(aggregateDecision);
    const aggregateSummary =
      recipientsTotal === 0
        ? "No active recipients in group."
        : partialDelivery
          ? `Partial group delivery: ${memberDeliveredCount} delivered, ${memberPendingCount} pending, ${memberRejectedCount} denied, ${memberReviewRequiredCount} review-required, ${memberFailedCount} failed.`
          : buildResolutionSummary(aggregateDecision, aggregateDeliveryMode, null);

    const groupResolution: StructuredResolution = {
      resolution_id: resolutionId,
      decision: aggregateDecision,
      delivery_mode: aggregateDeliveryMode,
      summary: aggregateSummary,
      reason: aggregateReason,
      reason_code: aggregateReasonCode,
      resolver_layer: partialDelivery ? null : representativeAudit?.resolver_layer || null,
      guardrail_id: partialDelivery ? null : representativeAudit?.guardrail_id || null,
      winning_policy_id: partialDelivery ? null : representativeAudit?.winning_policy_id || null,
      matched_policy_ids: Array.from(
        new Set(recipientPolicyAudits.flatMap((entry) => entry.matched_policy_ids))
      ),
    };

    const groupPolicyEvaluation = serializeGroupFanOutPolicyEvaluation(recipientPolicyAudits, {
      resolution_id: resolutionId,
      group_id: groupId,
      policy_evaluation_mode: "group_outbound_fanout",
    });
    const groupOutcome = deriveGroupOutcomeFromFanOut(
      requestedOutcome.outcome,
      recipientPolicyAudits
    );
    const groupOutcomeDetails = requestedOutcome.outcomeDetails || groupResolution.summary;

    let overallStatus: MessageRecordStatus = "delivered";
    if (memberPendingCount > 0) {
      overallStatus = "pending";
    } else if (memberDeliveredCount > 0) {
      overallStatus = "delivered";
    } else if (memberReviewRequiredCount > 0) {
      overallStatus = "review_required";
    } else if (memberRejectedCount > 0 && memberRejectedCount + memberFailedCount === recipientsTotal) {
      overallStatus = "rejected";
    } else if (memberFailedCount > 0) {
      overallStatus = "failed";
    } else if (recipientsTotal === 0) {
      overallStatus = "delivered";
    }

    await db
      .update(schema.messages)
      .set({
        outcome: groupOutcome,
        outcomeDetails: groupOutcomeDetails,
        policiesEvaluated: groupPolicyEvaluation,
        status: overallStatus,
        rejectionReason:
          overallStatus === "rejected"
            ? recipientPolicyAudits.find((entry) => entry.delivery_status === "rejected")?.reason ||
              null
            : null,
        deliveredAt: overallStatus === "delivered" ? new Date() : null,
      })
      .where(eq(schema.messages.id, messageId));

    let deliveryStatus: "delivered" | "pending" | "failed" = "delivered";
    if (memberPendingCount > 0) {
      deliveryStatus = "pending";
    } else if (recipientsTotal > 0 && memberDeliveredCount === 0) {
      deliveryStatus = "failed";
    }

    return c.json({
      message_id: messageId,
      status: overallStatus,
      delivery_status: deliveryStatus,
      recipients: recipientsTotal,
      delivered: memberDeliveredCount,
      pending: memberPendingCount,
      failed: memberFailedCount,
      denied: memberRejectedCount,
      review_required: memberReviewRequiredCount,
      resolution: groupResolution,
      recipient_results: recipientPolicyAudits.map((entry) =>
        buildRecipientResult(entry.recipient_username, {
          resolution_id: resolutionId,
          decision: entry.decision,
          delivery_mode: entry.delivery_mode,
          summary: entry.reason || aggregateSummary,
          reason: entry.reason,
          reason_code: entry.reason_code,
          resolver_layer: entry.resolver_layer,
          guardrail_id: entry.guardrail_id,
          winning_policy_id: entry.winning_policy_id,
          matched_policy_ids: entry.matched_policy_ids,
        }, entry.delivery_status)
      ),
    });
  }

  // Get sender's agent connection for sender_agent field
  // For now, use the framework from routing hints or default to "unknown"
  const senderAgent = data.routing_hints?.labels?.[0] || "agent";

  let userPolicyEvaluation: string | null = null;
  let userPolicyResult: PolicyResult | null = null;
  let userOutcome = requestedOutcome.outcome;
  let userOutcomeDetails = requestedOutcome.outcomeDetails;
  const userDirection = parseDirectionCandidate(messageSelectors.direction);
  const inboundRequestEvaluation = isInboundDirection(userDirection);

  // Policy evaluation (only in trusted mode with plaintext)
  const isEncrypted = data.payload_type === "application/mahilo+ciphertext";
  if (!isEncrypted && config.trustedMode) {
    const selectorContext = {
      direction: userDirection,
      resource: messageSelectors.resource,
      action: messageSelectors.action,
    };

    if (inboundRequestEvaluation) {
      userPolicyResult = await evaluateInboundPolicies(
        recipientUserId,
        user.id,
        data.message,
        data.context,
        authenticatedSenderIdentity,
        selectorContext
      );
      await consumeWinningPolicyUse(recipientUserId, userPolicyResult);
    } else {
      userPolicyResult = await evaluatePolicies(
        user.id,
        recipientUserId,
        data.message,
        data.context,
        authenticatedSenderIdentity,
        selectorContext
      );
      await consumeWinningPolicyUse(user.id, userPolicyResult);
    }

    userPolicyEvaluation = serializePolicyEvaluation(userPolicyResult, {
      policy_owner_user_id: inboundRequestEvaluation ? recipientUserId : user.id,
      policy_evaluation_mode: inboundRequestEvaluation
        ? "inbound_pre_delivery"
        : "outbound_pre_delivery",
      selector_context: selectorContext,
    });
    userOutcome = userOutcome || userPolicyResult.effect;
    userOutcomeDetails =
      userOutcomeDetails || userPolicyResult.reason || userPolicyResult.resolution_explanation;
  }

  const userResolution = buildStructuredResolution(resolutionId, userDirection, userPolicyResult);
  const shouldDeliverUser = shouldDeliverForDecision(
    userResolution.decision,
    userDirection,
    userResolution.delivery_mode
  );

  if (!shouldDeliverUser) {
    const blockedStatus = blockedMessageStatusForDecision(
      userResolution.decision,
      userResolution.delivery_mode
    );
    const messageId = nanoid();
    await db.insert(schema.messages).values({
      id: messageId,
      correlationId: data.correlation_id,
      direction: messageSelectors.direction,
      resource: messageSelectors.resource,
      action: messageSelectors.action,
      inResponseTo,
      outcome: userOutcome,
      outcomeDetails: userOutcomeDetails,
      policiesEvaluated: userPolicyEvaluation,
      senderUserId: user.id,
      senderConnectionId,
      senderAgent,
      recipientType: data.recipient_type,
      recipientId: recipientUserId,
      recipientConnectionId: recipientConnection!.id,
      payload: data.message,
      payloadType: data.payload_type,
      encryption: data.encryption ? JSON.stringify(data.encryption) : null,
      senderSignature: data.sender_signature
        ? JSON.stringify(data.sender_signature)
        : null,
      context: data.context,
      status: blockedStatus,
      rejectionReason: userResolution.decision === "deny" ? userPolicyResult?.reason || null : null,
      idempotencyKey: data.idempotency_key,
    });

    return c.json({
      message_id: messageId,
      status: blockedStatus,
      rejection_reason: userResolution.decision === "deny" ? userPolicyResult?.reason || null : null,
      resolution: userResolution,
      recipient_results: [buildRecipientResult(data.recipient, userResolution, blockedStatus)],
    });
  }

  const reviewRequiredDelivery =
    userResolution.decision === "ask" && userResolution.delivery_mode === "review_required";

  // Create message record
  const messageId = nanoid();
  await db.insert(schema.messages).values({
    id: messageId,
    correlationId: data.correlation_id,
    direction: messageSelectors.direction,
    resource: messageSelectors.resource,
    action: messageSelectors.action,
    inResponseTo,
    outcome: userOutcome,
    outcomeDetails: userOutcomeDetails,
    policiesEvaluated: userPolicyEvaluation,
    senderUserId: user.id,
    senderConnectionId,
    senderAgent,
    recipientType: data.recipient_type,
    recipientId: recipientUserId,
    recipientConnectionId: recipientConnection!.id,
    payload: data.message,
    payloadType: data.payload_type,
    encryption: data.encryption ? JSON.stringify(data.encryption) : null,
    senderSignature: data.sender_signature
      ? JSON.stringify(data.sender_signature)
      : null,
    context: data.context,
    status: "pending",
    idempotencyKey: data.idempotency_key,
  });

  // Get sender username
  const [sender] = await db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);

  // Deliver message
  const deliveryResult = await deliverMessage(recipientConnection!, {
    message_id: messageId,
    correlation_id: data.correlation_id,
    recipient_connection_id: recipientConnection!.id,
    sender: sender!.username,
    sender_user_id: user.id,
    sender_connection_id: senderConnectionId,
    sender_agent: senderAgent,
    message: data.message,
    payload_type: data.payload_type,
    encryption: data.encryption,
    sender_signature: data.sender_signature,
    context: data.context,
    selectors: {
      direction: messageSelectors.direction,
      resource: messageSelectors.resource,
      action: messageSelectors.action,
    },
    resolution_id: userResolution.resolution_id,
    review_required: reviewRequiredDelivery,
    delivery_mode: userResolution.delivery_mode,
    timestamp: new Date().toISOString(),
  });

  const responseStatus = userResolution.decision === "ask" ? "review_required" : deliveryResult.status;
  return c.json({
    message_id: messageId,
    status: responseStatus,
    delivery_status: deliveryResult.status,
    resolution: userResolution,
    recipient_results: [buildRecipientResult(data.recipient, userResolution, deliveryResult.status)],
  });
});

// Get message history
messageRoutes.get("/", async (c) => {
  const user = c.get("user")!;
  const limitParam = parseInt(c.req.query("limit") || "50", 10);
  const direction = c.req.query("direction") as "sent" | "received" | undefined;
  const sinceParam = c.req.query("since");
  const db = getDb();

  // Build where clause based on direction
  let whereClause;
  if (direction === "sent") {
    whereClause = eq(schema.messages.senderUserId, user.id);
  } else if (direction === "received") {
    whereClause = and(
      eq(schema.messages.recipientType, "user"),
      eq(schema.messages.recipientId, user.id)
    );
  } else {
    whereClause = or(
      eq(schema.messages.senderUserId, user.id),
      and(
        eq(schema.messages.recipientType, "user"),
        eq(schema.messages.recipientId, user.id)
      )
    );
  }

  let whereFilters = whereClause;

  if (sinceParam) {
    let sinceMs: number;
    if (/^\d+$/.test(sinceParam)) {
      sinceMs = Number(sinceParam);
      if (sinceMs < 1_000_000_000_000) {
        sinceMs *= 1000;
      }
    } else {
      sinceMs = Date.parse(sinceParam);
    }

    if (Number.isNaN(sinceMs)) {
      throw new AppError("Invalid since parameter", 400, "INVALID_SINCE");
    }
    whereFilters = and(whereFilters, gt(schema.messages.createdAt, new Date(sinceMs)));
  }

  const messages = await db
    .select()
    .from(schema.messages)
    .where(whereFilters)
    .orderBy(desc(schema.messages.createdAt))
    .limit(Math.min(limitParam, 100));

  // Get usernames for senders/recipients
  const userIds = new Set<string>();
  messages.forEach((m) => {
    userIds.add(m.senderUserId);
    if (m.recipientType === "user") {
      userIds.add(m.recipientId);
    }
  });

  const users = await db
    .select({ id: schema.users.id, username: schema.users.username })
    .from(schema.users);

  const usersMap = new Map(users.map((u) => [u.id, u.username]));

  // For received messages, include applicable policies for each sender
  // This helps the agent know what policies apply when replying
  const senderPoliciesMap = new Map<
    string,
    {
      roles: string[];
      policies: CanonicalPolicy[];
      summary: string;
    }
  >();

  if (direction === "received") {
    // Get unique sender IDs
    const senderIds = [...new Set(messages.map((m) => m.senderUserId))];

    for (const senderId of senderIds) {
      // Get roles for this sender (from the recipient's perspective)
      const roles = await getRolesForFriend(user.id, senderId);

      // Build policy query conditions
      const policyConditions = [
        eq(schema.policies.scope, "global"),
        and(
          eq(schema.policies.scope, "user"),
          eq(schema.policies.targetId, senderId)
        ),
      ];

      // Add role-scoped policies if sender has roles
      if (roles.length > 0) {
        policyConditions.push(
          and(
            eq(schema.policies.scope, "role"),
            inArray(schema.policies.targetId, roles)
          )
        );
      }

      // Get applicable policies
      const policies = await db
        .select()
        .from(schema.policies)
        .where(
          and(
            eq(schema.policies.userId, user.id),
            eq(schema.policies.enabled, true),
            or(...policyConditions)
          )
        )
        .orderBy(desc(schema.policies.priority));

      const canonicalPolicies = policies.map((p) => dbPolicyToCanonical(p));
      const summary = await generatePolicySummary(canonicalPolicies, roles);

      senderPoliciesMap.set(senderId, {
        roles,
        policies: canonicalPolicies,
        summary,
      });
    }
  }

  return c.json(
    messages.map((m) => {
      const baseMessage = {
        id: m.id,
        correlation_id: m.correlationId,
        direction: m.direction,
        resource: m.resource,
        action: m.action,
        in_response_to: m.inResponseTo,
        outcome: m.outcome,
        outcome_details: parseOptionalJsonText(m.outcomeDetails),
        policies_evaluated: parseOptionalJsonText(m.policiesEvaluated),
        sender: usersMap.get(m.senderUserId),
        sender_connection_id: m.senderConnectionId,
        sender_agent: m.senderAgent,
        recipient: usersMap.get(m.recipientId),
        recipient_type: m.recipientType,
        classified_direction: m.classifiedDirection,
        classified_resource: m.classifiedResource,
        classified_action: m.classifiedAction,
        message: m.payload,
        context: m.context,
        status: m.status,
        created_at: m.createdAt?.toISOString(),
        delivered_at: m.deliveredAt?.toISOString(),
      };

      // Include policy context for received messages
      if (direction === "received") {
        const policyContext = senderPoliciesMap.get(m.senderUserId);
        return {
          ...baseMessage,
          reply_policies: policyContext ? {
            sender_roles: policyContext.roles,
            applicable_policies: policyContext.policies,
            summary: policyContext.summary,
          } : null,
        };
      }

      return baseMessage;
    })
  );
});
