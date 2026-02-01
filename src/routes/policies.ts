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

// Create policy
const createPolicySchema = z.object({
  scope: z.enum(["global", "user", "group", "role"]),
  target_id: z.string().optional(),
  policy_type: z.enum(["heuristic", "llm"]),
  policy_content: z.string(),
  priority: z.number().int().min(0).max(100).optional().default(0),
  enabled: z.boolean().optional().default(true),
});

policyRoutes.post("/", zValidator("json", createPolicySchema), async (c) => {
  const user = c.get("user")!;
  const data = c.req.valid("json");
  const db = getDb();

  // Validate scope and target_id consistency
  if (data.scope === "global" && data.target_id) {
    throw new AppError("Global policies cannot have a target_id", 400, "INVALID_POLICY");
  }

  if ((data.scope === "user" || data.scope === "group" || data.scope === "role") && !data.target_id) {
    throw new AppError(`${data.scope} policies require a target_id`, 400, "INVALID_POLICY");
  }

  // Validate policy content format
  const validation = validatePolicyContent(data.policy_type, data.policy_content);
  if (!validation.valid) {
    throw new AppError(validation.error!, 400, "INVALID_POLICY_CONTENT");
  }

  // If scope is "user", verify the target exists
  if (data.scope === "user" && data.target_id) {
    const [targetUser] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, data.target_id))
      .limit(1);

    if (!targetUser) {
      throw new AppError("Target user not found", 404, "USER_NOT_FOUND");
    }
  }

  // If scope is "group", verify the group exists and user is owner/admin (REG-043)
  if (data.scope === "group" && data.target_id) {
    const [group] = await db
      .select()
      .from(schema.groups)
      .where(eq(schema.groups.id, data.target_id))
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
          eq(schema.groupMemberships.groupId, data.target_id),
          eq(schema.groupMemberships.userId, user.id),
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

  // If scope is "role", verify the role exists (system or user's custom)
  if (data.scope === "role" && data.target_id) {
    const validRole = await isValidRole(user.id, data.target_id);
    if (!validRole) {
      throw new AppError(`Invalid role: ${data.target_id}`, 400, "INVALID_ROLE");
    }
  }

  // Create policy
  const policyId = nanoid();
  await db.insert(schema.policies).values({
    id: policyId,
    userId: user.id,
    scope: data.scope,
    targetId: data.target_id,
    policyType: data.policy_type,
    policyContent: data.policy_content,
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
  const policies = await db.select().from(schema.policies).where(whereClause);

  return c.json(
    policies.map((p) => ({
      id: p.id,
      scope: p.scope,
      target_id: p.targetId,
      policy_type: p.policyType,
      policy_content: p.policyContent,
      priority: p.priority,
      enabled: p.enabled,
      created_at: p.createdAt?.toISOString(),
    }))
  );
});

// Update policy
const updatePolicySchema = z.object({
  policy_content: z.string().optional(),
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

  // Validate policy content if provided
  if (data.policy_content !== undefined) {
    const validation = validatePolicyContent(policy.policyType, data.policy_content);
    if (!validation.valid) {
      throw new AppError(validation.error!, 400, "INVALID_POLICY_CONTENT");
    }
  }

  // Update policy
  const updates: Partial<schema.Policy> = {};
  if (data.policy_content !== undefined) updates.policyContent = data.policy_content;
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

  // Generate policy summary (PERM-013)
  const policyInfos = policies.map((p) => ({
    id: p.id,
    scope: p.scope,
    target_id: p.targetId,
    policy_type: p.policyType,
    policy_content: p.policyContent,
    priority: p.priority,
  }));

  const summary = await generatePolicySummary(policyInfos, roles);

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
    applicable_policies: policyInfos,
    summary,
    recent_interactions: recentInteractions,
  });
});
