import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, and, or, desc, sql } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/error";
import { validatePolicyContent } from "../services/policy";
import { isValidRole, getRolesForFriend } from "../services/roles";
import { generatePolicySummary } from "../services/policySummary";
import { getInteractionCount, getRecentInteractions } from "../services/interactions";
import {
  dbPolicyToCanonical,
  canonicalToStorage,
  type CanonicalPolicy,
  type PolicyEvaluator,
  type PolicyScope,
} from "../services/policySchema";

export const policyRoutes = new Hono<AppEnv>();

// Use auth middleware for all routes
policyRoutes.use("*", requireAuth());

async function assertGroupPolicyAccess(userId: string, groupId: string, db: ReturnType<typeof getDb>) {
  // Verify the group exists
  const [group] = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .limit(1);

  if (!group) {
    throw new AppError("Target group not found", 404, "GROUP_NOT_FOUND");
  }

  // Verify user is owner or admin of the group
  const [membership] = await db
    .select()
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
    throw new AppError("Only group owners and admins can manage group policies", 403, "FORBIDDEN");
  }
}

const scopeSchema = z.enum(["global", "user", "group", "role"]);
const directionSchema = z.enum(["outbound", "inbound", "request", "response", "notification", "error"]);
const effectSchema = z.enum(["allow", "ask", "deny"]);
const evaluatorSchema = z.enum(["structured", "heuristic", "llm"]);
const sourceSchema = z.enum([
  "default",
  "learned",
  "user_confirmed",
  "override",
  "user_created",
  "legacy_migrated",
]);
const isoDateSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid ISO date" });

function assertScopeTarget(scope: PolicyScope, targetId: string | null) {
  if (scope === "global" && targetId) {
    throw new AppError("Global policies cannot have a target_id", 400, "INVALID_POLICY");
  }

  if ((scope === "user" || scope === "group" || scope === "role") && !targetId) {
    throw new AppError(`${scope} policies require a target_id`, 400, "INVALID_POLICY");
  }
}

function normalizeUses(maxUses?: number | null, remainingUses?: number | null) {
  const max_uses = maxUses ?? null;
  const remaining_uses = remainingUses ?? (max_uses !== null ? max_uses : null);

  if (max_uses !== null && max_uses < 1) {
    throw new AppError("max_uses must be at least 1", 400, "INVALID_POLICY");
  }

  if (remaining_uses !== null && remaining_uses < 0) {
    throw new AppError("remaining_uses must be >= 0", 400, "INVALID_POLICY");
  }

  if (max_uses !== null && remaining_uses !== null && remaining_uses > max_uses) {
    throw new AppError("remaining_uses cannot exceed max_uses", 400, "INVALID_POLICY");
  }

  return { max_uses, remaining_uses };
}

function assertDateWindow(effectiveFrom: string | null, expiresAt: string | null) {
  if (effectiveFrom && expiresAt && Date.parse(expiresAt) <= Date.parse(effectiveFrom)) {
    throw new AppError("expires_at must be after effective_from", 400, "INVALID_POLICY");
  }
}

// Create policy
const createPolicySchema = z.object({
  scope: scopeSchema,
  target_id: z.string().min(1).nullable().optional(),
  direction: directionSchema.optional().default("outbound"),
  resource: z.string().min(1).optional().default("message.general"),
  action: z.string().min(1).nullable().optional().default("share"),
  effect: effectSchema.optional().default("deny"),
  evaluator: evaluatorSchema,
  policy_content: z.unknown(),
  effective_from: isoDateSchema.nullable().optional(),
  expires_at: isoDateSchema.nullable().optional(),
  max_uses: z.number().int().positive().nullable().optional(),
  remaining_uses: z.number().int().min(0).nullable().optional(),
  source: sourceSchema.optional().default("user_created"),
  derived_from_message_id: z.string().min(1).nullable().optional(),
  priority: z.number().int().min(0).max(100).optional().default(0),
  enabled: z.boolean().optional().default(true),
});

policyRoutes.post("/", zValidator("json", createPolicySchema), async (c) => {
  const user = c.get("user")!;
  const data = c.req.valid("json");
  const db = getDb();

  const targetId = data.target_id ?? null;
  assertScopeTarget(data.scope, targetId);
  const uses = normalizeUses(data.max_uses, data.remaining_uses);
  const effectiveFrom = data.effective_from ?? null;
  const expiresAt = data.expires_at ?? null;
  assertDateWindow(effectiveFrom, expiresAt);

  // Validate policy content format
  const validation = validatePolicyContent(data.evaluator, data.policy_content);
  if (!validation.valid) {
    throw new AppError(validation.error!, 400, "INVALID_POLICY_CONTENT");
  }

  // If scope is "user", verify the target exists
  if (data.scope === "user" && targetId) {
    const [targetUser] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, targetId))
      .limit(1);

    if (!targetUser) {
      throw new AppError("Target user not found", 404, "USER_NOT_FOUND");
    }
  }

  // If scope is "group", verify the group exists and user is owner/admin (REG-043)
  if (data.scope === "group" && targetId) {
    await assertGroupPolicyAccess(user.id, targetId, db);
  }

  // If scope is "role", verify the role exists (system or user's custom)
  if (data.scope === "role" && targetId) {
    const validRole = await isValidRole(user.id, targetId);
    if (!validRole) {
      throw new AppError(`Invalid role: ${targetId}`, 400, "INVALID_ROLE");
    }
  }

  const storage = canonicalToStorage({
    scope: data.scope,
    target_id: targetId,
    direction: data.direction,
    resource: data.resource,
    action: data.action ?? null,
    effect: data.effect,
    evaluator: data.evaluator,
    policy_content: data.policy_content,
    effective_from: effectiveFrom,
    expires_at: expiresAt,
    max_uses: uses.max_uses,
    remaining_uses: uses.remaining_uses,
    source: data.source,
    derived_from_message_id: data.derived_from_message_id ?? null,
    priority: data.priority,
    enabled: data.enabled,
  });

  // Create policy
  const policyId = nanoid();
  await db.insert(schema.policies).values({
    id: policyId,
    userId: user.id,
    scope: data.scope,
    targetId: targetId,
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
    priority: data.priority || 0,
    enabled: data.enabled ?? true,
  });

  return c.json(
    {
      policy_id: policyId,
    },
    201
  );
});

// List policies
policyRoutes.get("/", async (c) => {
  const user = c.get("user")!;
  const scope = c.req.query("scope");
  const targetId = c.req.query("target_id");
  const db = getDb();

  const conditions = [eq(schema.policies.userId, user.id)];
  if (scope) {
    conditions.push(eq(schema.policies.scope, scope));
  }
  if (targetId) {
    conditions.push(eq(schema.policies.targetId, targetId));
  }

  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
  const policies = await db
    .select()
    .from(schema.policies)
    .where(whereClause)
    .orderBy(desc(schema.policies.priority));

  return c.json(policies.map((p) => dbPolicyToCanonical(p)));
});

// Update policy
const updatePolicySchema = z.object({
  direction: directionSchema.optional(),
  resource: z.string().min(1).optional(),
  action: z.string().min(1).nullable().optional(),
  effect: effectSchema.optional(),
  evaluator: evaluatorSchema.optional(),
  policy_content: z.unknown().optional(),
  effective_from: isoDateSchema.nullable().optional(),
  expires_at: isoDateSchema.nullable().optional(),
  max_uses: z.number().int().positive().nullable().optional(),
  remaining_uses: z.number().int().min(0).nullable().optional(),
  source: sourceSchema.optional(),
  derived_from_message_id: z.string().min(1).nullable().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  enabled: z.boolean().optional(),
});

policyRoutes.patch("/:id", zValidator("json", updatePolicySchema), async (c) => {
  const user = c.get("user")!;
  const policyId = c.req.param("id");
  const data = c.req.valid("json");
  const db = getDb();

  // Find the policy
  const [policy] = await db
    .select()
    .from(schema.policies)
    .where(eq(schema.policies.id, policyId))
    .limit(1);

  if (!policy) {
    throw new AppError("Policy not found", 404, "NOT_FOUND");
  }

  if (policy.scope === "group") {
    if (!policy.targetId) {
      throw new AppError("Group policies require a target_id", 400, "INVALID_POLICY");
    }
    await assertGroupPolicyAccess(user.id, policy.targetId, db);
  } else if (policy.userId !== user.id) {
    throw new AppError("Policy not found", 404, "NOT_FOUND");
  }

  const current = dbPolicyToCanonical(policy);
  const nextEvaluator = (data.evaluator || current.evaluator) as PolicyEvaluator;
  const nextPolicyContent =
    data.policy_content !== undefined ? data.policy_content : current.policy_content;

  const validation = validatePolicyContent(nextEvaluator, nextPolicyContent);
  if (!validation.valid) {
    throw new AppError(validation.error!, 400, "INVALID_POLICY_CONTENT");
  }

  const uses = normalizeUses(
    data.max_uses !== undefined ? data.max_uses : current.max_uses,
    data.remaining_uses !== undefined ? data.remaining_uses : current.remaining_uses
  );
  const effectiveFrom =
    data.effective_from !== undefined ? data.effective_from : current.effective_from;
  const expiresAt = data.expires_at !== undefined ? data.expires_at : current.expires_at;
  assertDateWindow(effectiveFrom, expiresAt);

  const canonical = {
    scope: current.scope,
    target_id: current.target_id,
    direction: data.direction || current.direction,
    resource: data.resource || current.resource,
    action: data.action !== undefined ? data.action : current.action,
    effect: data.effect || current.effect,
    evaluator: nextEvaluator,
    policy_content: nextPolicyContent,
    effective_from: effectiveFrom,
    expires_at: expiresAt,
    max_uses: uses.max_uses,
    remaining_uses: uses.remaining_uses,
    source: data.source || current.source,
    derived_from_message_id:
      data.derived_from_message_id !== undefined
        ? data.derived_from_message_id
        : current.derived_from_message_id,
    priority: data.priority !== undefined ? data.priority : current.priority,
    enabled: data.enabled !== undefined ? data.enabled : current.enabled,
  };

  // Update policy
  const updates: Partial<schema.NewPolicy> = {};
  const canonicalTouched =
    data.direction !== undefined ||
    data.resource !== undefined ||
    data.action !== undefined ||
    data.effect !== undefined ||
    data.evaluator !== undefined ||
    data.policy_content !== undefined ||
    data.effective_from !== undefined ||
    data.expires_at !== undefined ||
    data.max_uses !== undefined ||
    data.remaining_uses !== undefined ||
    data.source !== undefined ||
    data.derived_from_message_id !== undefined;

  if (canonicalTouched) {
    const storage = canonicalToStorage(canonical);
    updates.policyType = storage.policyType;
    updates.policyContent = storage.policyContent;
    updates.direction = storage.direction;
    updates.resource = storage.resource;
    updates.action = storage.action;
    updates.effect = storage.effect;
    updates.evaluator = storage.evaluator;
    updates.effectiveFrom = storage.effectiveFrom;
    updates.expiresAt = storage.expiresAt;
    updates.maxUses = storage.maxUses;
    updates.remainingUses = storage.remainingUses;
    updates.source = storage.source;
    updates.derivedFromMessageId = storage.derivedFromMessageId;
  }
  if (data.priority !== undefined) updates.priority = data.priority;
  if (data.enabled !== undefined) updates.enabled = data.enabled;

  if (Object.keys(updates).length > 0) {
    await db
      .update(schema.policies)
      .set(updates)
      .where(eq(schema.policies.id, policyId));
  }

  return c.json({ success: true });
});

// Delete policy
policyRoutes.delete("/:id", async (c) => {
  const user = c.get("user")!;
  const policyId = c.req.param("id");
  const db = getDb();

  // Find the policy
  const [policy] = await db
    .select()
    .from(schema.policies)
    .where(eq(schema.policies.id, policyId))
    .limit(1);

  if (!policy) {
    throw new AppError("Policy not found", 404, "NOT_FOUND");
  }

  if (policy.scope === "group") {
    if (!policy.targetId) {
      throw new AppError("Group policies require a target_id", 400, "INVALID_POLICY");
    }
    await assertGroupPolicyAccess(user.id, policy.targetId, db);
  } else if (policy.userId !== user.id) {
    throw new AppError("Policy not found", 404, "NOT_FOUND");
  }

  // Delete the policy
  await db.delete(schema.policies).where(eq(schema.policies.id, policyId));

  return c.json({ success: true });
});

/**
 * GET /api/v1/policies/context/:username
 * Get policy context for a potential recipient
 * Returns relationship info and applicable policies to help agent craft compliant messages
 */
policyRoutes.get("/context/:username", async (c) => {
  const user = c.get("user")!;
  const recipientUsername = c.req.param("username").toLowerCase();
  const db = getDb();

  // Find the recipient user
  const [recipient] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, recipientUsername))
    .limit(1);

  if (!recipient) {
    throw new AppError("User not found", 404, "USER_NOT_FOUND");
  }

  // Find friendship between current user and recipient
  const [friendship] = await db
    .select()
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
    throw new AppError("Not friends with this user", 404, "NOT_FRIENDS");
  }

  // Get roles for this friendship
  const roles = await getRolesForFriend(user.id, recipient.id);

  // Build policy query conditions
  const policyConditions = [
    eq(schema.policies.scope, "global"),
    and(
      eq(schema.policies.scope, "user"),
      eq(schema.policies.targetId, recipient.id)
    ),
  ];

  // Add role-scoped policies if recipient has roles
  if (roles.length > 0) {
    policyConditions.push(
      and(
        eq(schema.policies.scope, "role"),
        sql`${schema.policies.targetId} IN ${roles}`
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

  const canonicalPolicies: CanonicalPolicy[] = policies.map((p) => dbPolicyToCanonical(p));
  const summary = await generatePolicySummary(canonicalPolicies, roles);

  // Get interaction count (PERM-020)
  const interactionCount = await getInteractionCount(user.id, recipient.id);

  // Get recent interactions (PERM-021)
  const recentInteractions = await getRecentInteractions(user.id, recipient.id, 5);

  return c.json({
    recipient: {
      username: recipient.username,
      display_name: recipient.displayName,
      relationship: "friend",
      friendship_id: friendship.id,
      roles,
      connected_since: friendship.createdAt?.toISOString(),
      interaction_count: interactionCount,
    },
    applicable_policies: canonicalPolicies,
    summary,
    recent_interactions: recentInteractions,
  });
});
