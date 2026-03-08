import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/error";
import { getRolesForFriend } from "../services/roles";
import { generatePolicySummary } from "../services/policySummary";
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

type PluginContextRequest = z.infer<typeof pluginContextRequestSchema>;
type ContextDecision = "allow" | "ask" | "deny";

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
