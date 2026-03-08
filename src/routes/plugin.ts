import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { requireAuth, requireVerified } from "../middleware/auth";
import { AppError } from "../middleware/error";
import { getRolesForFriend } from "../services/roles";
import { generatePolicySummary } from "../services/policySummary";
import { config } from "../config";
import { parseCapabilities, validatePayloadSize } from "../services/validation";
import {
  evaluateGroupPolicies,
  evaluateInboundPolicies,
  evaluatePolicies,
  type AuthenticatedSenderIdentity,
  type PolicyResult,
} from "../services/policy";
import { dbPolicyToCanonical, type CanonicalPolicy, type PolicyDirection } from "../services/policySchema";

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

type PluginContextRequest = z.infer<typeof pluginContextRequestSchema>;
type PluginResolveRequest = z.infer<typeof pluginResolveRequestSchema>;
type ContextDecision = "allow" | "ask" | "deny";
type DeliveryMode = "full_send" | "review_required" | "hold_for_approval" | "blocked";

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
