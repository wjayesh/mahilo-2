import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, and } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/error";
import { validatePolicyContent } from "../services/policy";

export const policyRoutes = new Hono<AppEnv>();

// Use auth middleware for all routes
policyRoutes.use("*", requireAuth());

// Create policy
const createPolicySchema = z.object({
  scope: z.enum(["global", "user", "group"]),
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

  if ((data.scope === "user" || data.scope === "group") && !data.target_id) {
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

  let query = db
    .select()
    .from(schema.policies)
    .where(eq(schema.policies.userId, user.id))
    .$dynamic();

  if (scope) {
    query = query.where(
      and(eq(schema.policies.userId, user.id), eq(schema.policies.scope, scope))
    );
  }

  if (targetId) {
    query = query.where(
      and(eq(schema.policies.userId, user.id), eq(schema.policies.targetId, targetId))
    );
  }

  const policies = await query;

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
    .where(
      and(eq(schema.policies.id, policyId), eq(schema.policies.userId, user.id))
    )
    .limit(1);

  if (!policy) {
    throw new AppError("Policy not found", 404, "NOT_FOUND");
  }

  // Validate policy content if provided
  if (data.policy_content) {
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
    .where(
      and(eq(schema.policies.id, policyId), eq(schema.policies.userId, user.id))
    )
    .limit(1);

  if (!policy) {
    throw new AppError("Policy not found", 404, "NOT_FOUND");
  }

  // Delete the policy
  await db.delete(schema.policies).where(eq(schema.policies.id, policyId));

  return c.json({ success: true });
});
