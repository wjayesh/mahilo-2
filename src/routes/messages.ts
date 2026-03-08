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
  evaluateGroupPolicies,
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
    // Group messaging (REG-045, REG-046)
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

    let groupPolicyEvaluation: string | null = null;
    let groupPolicyResult: PolicyResult | null = null;
    let groupOutcome = requestedOutcome.outcome;
    let groupOutcomeDetails = requestedOutcome.outcomeDetails;
    const groupDirection = parseDirectionCandidate(messageSelectors.direction);

    // Group policy evaluation in trusted mode (REG-044)
    const isEncrypted = data.payload_type === "application/mahilo+ciphertext";
    if (!isEncrypted && config.trustedMode) {
      groupPolicyResult = await evaluateGroupPolicies(
        user.id,
        groupId,
        data.message,
        data.context,
        authenticatedSenderIdentity,
        {
          direction: groupDirection,
          resource: messageSelectors.resource,
          action: messageSelectors.action,
        }
      );
      await consumeWinningPolicyUse(user.id, groupPolicyResult);
      groupPolicyEvaluation = serializePolicyEvaluation(groupPolicyResult);
      groupOutcome = groupOutcome || groupPolicyResult.effect;
      groupOutcomeDetails =
        groupOutcomeDetails || groupPolicyResult.reason || groupPolicyResult.resolution_explanation;
    }

    const groupResolution = buildStructuredResolution(resolutionId, groupDirection, groupPolicyResult);
    const shouldDeliverGroup = shouldDeliverForDecision(
      groupResolution.decision,
      groupDirection,
      groupResolution.delivery_mode
    );

    if (!shouldDeliverGroup) {
      const blockedStatus = blockedMessageStatusForDecision(
        groupResolution.decision,
        groupResolution.delivery_mode
      );
      const messageId = nanoid();
      await db.insert(schema.messages).values({
        id: messageId,
        correlationId: data.correlation_id,
        direction: messageSelectors.direction,
        resource: messageSelectors.resource,
        action: messageSelectors.action,
        inResponseTo,
        outcome: groupOutcome,
        outcomeDetails: groupOutcomeDetails,
        policiesEvaluated: groupPolicyEvaluation,
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
        status: blockedStatus,
        rejectionReason: groupResolution.decision === "deny" ? groupPolicyResult?.reason || null : null,
        idempotencyKey: data.idempotency_key,
      });

      return c.json({
        message_id: messageId,
        status: blockedStatus,
        rejection_reason: groupResolution.decision === "deny" ? groupPolicyResult?.reason || null : null,
        resolution: groupResolution,
        recipient_results: [buildRecipientResult(groupId, groupResolution, blockedStatus)],
      });
    }

    const reviewRequiredDelivery =
      groupResolution.decision === "ask" && groupResolution.delivery_mode === "review_required";

    // Create the parent message record
    const messageId = nanoid();
    await db.insert(schema.messages).values({
      id: messageId,
      correlationId: data.correlation_id,
      direction: messageSelectors.direction,
      resource: messageSelectors.resource,
      action: messageSelectors.action,
      inResponseTo,
      outcome: groupOutcome,
      outcomeDetails: groupOutcomeDetails,
      policiesEvaluated: groupPolicyEvaluation,
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

    // Get all active group members (excluding sender)
    const members = await db
      .select({
        userId: schema.groupMemberships.userId,
      })
      .from(schema.groupMemberships)
      .where(
        and(
          eq(schema.groupMemberships.groupId, groupId),
          eq(schema.groupMemberships.status, "active"),
          ne(schema.groupMemberships.userId, user.id)
        )
      );

    if (members.length === 0) {
      // No other members - mark as delivered
      await db
        .update(schema.messages)
        .set({ status: "delivered", deliveredAt: new Date() })
        .where(eq(schema.messages.id, messageId));

      const noRecipientStatus = groupResolution.decision === "ask" ? "review_required" : "delivered";
      return c.json({
        message_id: messageId,
        status: noRecipientStatus,
        delivery_status: "delivered",
        recipients: 0,
        resolution: groupResolution,
        recipient_results: [buildRecipientResult(groupId, groupResolution, "delivered")],
      });
    }

    // Get active connections for each member
    const memberUserIds = members.map((m) => m.userId);
    const memberConnections = await db
      .select()
      .from(schema.agentConnections)
      .where(
        and(
          inArray(schema.agentConnections.userId, memberUserIds),
          eq(schema.agentConnections.status, "active")
        )
      );

    // Group connections by user
    const connectionsByUser = new Map<string, schema.AgentConnection[]>();
    for (const conn of memberConnections) {
      const list = connectionsByUser.get(conn.userId) || [];
      list.push(conn);
      connectionsByUser.set(conn.userId, list);
    }

    // Create delivery records and deliver to each recipient connection
    const deliveryPromises: Promise<void>[] = [];
    const memberResults = new Map<
      string,
      { delivered: number; pending: number; failed: number }
    >();
    let pendingCount = 0;
    let failedCount = 0;
    let deliveryTotal = 0;

    for (const member of members) {
      const connections = connectionsByUser.get(member.userId) || [];
      const memberStats = memberResults.get(member.userId) || {
        delivered: 0,
        pending: 0,
        failed: 0,
      };

      if (connections.length === 0) {
        // No active connection for this member - mark as failed
        const deliveryId = nanoid();
        await db.insert(schema.messageDeliveries).values({
          id: deliveryId,
          messageId,
          recipientUserId: member.userId,
          recipientConnectionId: null,
          status: "failed",
          errorMessage: "No active connection",
        });
        deliveryTotal++;
        failedCount++;
        memberStats.failed++;
        memberResults.set(member.userId, memberStats);
        continue;
      }

      for (const connection of connections) {
        const deliveryId = nanoid();
        // Create delivery record
        await db.insert(schema.messageDeliveries).values({
          id: deliveryId,
          messageId,
          recipientUserId: member.userId,
          recipientConnectionId: connection.id,
          status: "pending",
        });
        deliveryTotal++;

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
            resolution_id: groupResolution.resolution_id,
            review_required: reviewRequiredDelivery,
            delivery_mode: groupResolution.delivery_mode,
            group_id: groupId,
            group_name: group.name,
            timestamp: new Date().toISOString(),
          }).then((result) => {
            const stats = memberResults.get(member.userId) || {
              delivered: 0,
              pending: 0,
              failed: 0,
            };

            if (result.status === "delivered") {
              stats.delivered++;
            } else if (result.status === "pending") {
              pendingCount++;
              stats.pending++;
            } else {
              failedCount++;
              stats.failed++;
            }

            memberResults.set(member.userId, stats);
          })
        );
      }
    }

    // Wait for all deliveries to complete
    await Promise.all(deliveryPromises);

    // Aggregate per-member delivery status for response
    let memberDeliveredCount = 0;
    let memberPendingCount = 0;
    let memberFailedCount = 0;

    for (const member of members) {
      const stats = memberResults.get(member.userId);
      if (!stats) {
        memberFailedCount++;
        continue;
      }
      if (stats.pending > 0) {
        memberPendingCount++;
      } else if (stats.delivered > 0) {
        memberDeliveredCount++;
      } else {
        memberFailedCount++;
      }
    }

    // Update parent message status based on delivery results
    let overallStatus: "delivered" | "pending" | "failed" = "delivered";
    if (pendingCount > 0) {
      overallStatus = "pending";
    } else if (failedCount === deliveryTotal) {
      overallStatus = "failed";
    }

    await db
      .update(schema.messages)
      .set({
        status: overallStatus,
        deliveredAt: overallStatus === "delivered" ? new Date() : undefined,
      })
      .where(eq(schema.messages.id, messageId));

    const groupResponseStatus = groupResolution.decision === "ask" ? "review_required" : overallStatus;
    return c.json({
      message_id: messageId,
      status: groupResponseStatus,
      delivery_status: overallStatus,
      recipients: members.length,
      delivered: memberDeliveredCount,
      pending: memberPendingCount,
      failed: memberFailedCount,
      resolution: groupResolution,
      recipient_results: [buildRecipientResult(groupId, groupResolution, overallStatus)],
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
