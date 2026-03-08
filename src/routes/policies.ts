import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, and, or, desc, sql, inArray } from "drizzle-orm";
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
  type PolicyLearningProvenance,
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
const learningProvenanceSchema = z
  .object({
    source_interaction_id: z.string().min(1).max(255).nullable().optional(),
    promoted_from_policy_ids: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .optional();

type LearningProvenanceInput = z.infer<typeof learningProvenanceSchema>;

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

function normalizeLearningProvenance(
  input: LearningProvenanceInput
): PolicyLearningProvenance | null {
  if (!input) {
    return null;
  }

  const sourceInteractionId =
    typeof input.source_interaction_id === "string" &&
    input.source_interaction_id.trim().length > 0
      ? input.source_interaction_id.trim()
      : null;

  const promotedFromPolicyIds = Array.from(
    new Set(
      (input.promoted_from_policy_ids || [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  );

  if (!sourceInteractionId && promotedFromPolicyIds.length === 0) {
    return null;
  }

  return {
    source_interaction_id: sourceInteractionId,
    promoted_from_policy_ids: promotedFromPolicyIds,
  };
}

async function assertVisibleSourceMessage(
  db: ReturnType<typeof getDb>,
  userId: string,
  messageId: string
) {
  const [sourceMessage] = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.id, messageId),
        or(eq(schema.messages.senderUserId, userId), eq(schema.messages.recipientId, userId))
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

async function assertPromotedPoliciesOwnedByUser(
  db: ReturnType<typeof getDb>,
  userId: string,
  promotedFromPolicyIds: string[]
) {
  if (promotedFromPolicyIds.length === 0) {
    return;
  }

  const promotedPolicies = await db
    .select({ id: schema.policies.id })
    .from(schema.policies)
    .where(
      and(
        eq(schema.policies.userId, userId),
        inArray(schema.policies.id, promotedFromPolicyIds)
      )
    );

  const found = new Set(promotedPolicies.map((policy) => policy.id));
  const missing = promotedFromPolicyIds.filter((policyId) => !found.has(policyId));
  if (missing.length > 0) {
    throw new AppError(
      `promoted_from_policy_ids contains unknown policy ids: ${missing.join(", ")}`,
      400,
      "INVALID_POLICY"
    );
  }
}

function assertDateWindow(effectiveFrom: string | null, expiresAt: string | null) {
  if (effectiveFrom && expiresAt && Date.parse(expiresAt) <= Date.parse(effectiveFrom)) {
    throw new AppError("expires_at must be after effective_from", 400, "INVALID_POLICY");
  }
}

function toPolicyAuditRecord(policy: CanonicalPolicy) {
  return {
    policy_id: policy.id,
    scope: policy.scope,
    target_id: policy.target_id,
    selectors: {
      direction: policy.direction,
      resource: policy.resource,
      action: policy.action,
    },
    effect: policy.effect,
    evaluator: policy.evaluator,
    source: policy.source,
    derived_from_message_id: policy.derived_from_message_id,
    source_interaction_id: policy.learning_provenance?.source_interaction_id || null,
    promoted_from_policy_ids: policy.learning_provenance?.promoted_from_policy_ids || [],
    created_at: policy.created_at,
  };
}

async function loadPromotedPolicyLineage(
  db: ReturnType<typeof getDb>,
  userId: string,
  rootPolicy: CanonicalPolicy
) {
  const lineageById = new Map<string, CanonicalPolicy>();
  const queue = [...(rootPolicy.learning_provenance?.promoted_from_policy_ids || [])];

  while (queue.length > 0) {
    const batchIds = Array.from(
      new Set(queue.splice(0, queue.length).filter((policyId) => !lineageById.has(policyId)))
    );
    if (batchIds.length === 0) {
      continue;
    }

    const rows = await db
      .select()
      .from(schema.policies)
      .where(and(eq(schema.policies.userId, userId), inArray(schema.policies.id, batchIds)));

    for (const row of rows) {
      const canonical = dbPolicyToCanonical(row);
      if (lineageById.has(canonical.id)) {
        continue;
      }
      lineageById.set(canonical.id, canonical);
      for (const promotedId of canonical.learning_provenance?.promoted_from_policy_ids || []) {
        if (!lineageById.has(promotedId)) {
          queue.push(promotedId);
        }
      }
    }
  }

  return lineageById;
}

// Create policy
const createPolicySchema = z.object({
  scope: scopeSchema,
  target_id: z.string().min(1).nullable().optional(),
  direction: directionSchema.optional().default("outbound"),
  resource: z.string().min(1).optional().default("message.general"),
  action: z.string().min(1).nullable().optional().default("share"),
  effect: effectSchema.optional().default("deny"),
  evaluator: evaluatorSchema.optional(),
  policy_type: evaluatorSchema.optional(),
  policy_content: z.unknown(),
  effective_from: isoDateSchema.nullable().optional(),
  expires_at: isoDateSchema.nullable().optional(),
  max_uses: z.number().int().positive().nullable().optional(),
  remaining_uses: z.number().int().min(0).nullable().optional(),
  source: sourceSchema.optional().default("user_created"),
  derived_from_message_id: z.string().min(1).nullable().optional(),
  learning_provenance: learningProvenanceSchema,
  priority: z.number().int().min(0).max(100).optional().default(0),
  enabled: z.boolean().optional().default(true),
}).superRefine((data, ctx) => {
  if (!data.evaluator && !data.policy_type) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evaluator"],
      message: "Either evaluator or policy_type is required",
    });
    return;
  }

  if (data.evaluator && data.policy_type && data.evaluator !== data.policy_type) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["policy_type"],
      message: "policy_type must match evaluator when both are provided",
    });
  }
});

policyRoutes.post("/", zValidator("json", createPolicySchema), async (c) => {
  const user = c.get("user")!;
  const data = c.req.valid("json");
  const db = getDb();

  const targetId = data.target_id ?? null;
  const evaluator = (data.evaluator ?? data.policy_type) as PolicyEvaluator;
  assertScopeTarget(data.scope, targetId);
  const uses = normalizeUses(data.max_uses, data.remaining_uses);
  const effectiveFrom = data.effective_from ?? null;
  const expiresAt = data.expires_at ?? null;
  assertDateWindow(effectiveFrom, expiresAt);

  // Validate policy content format
  const validation = validatePolicyContent(evaluator, data.policy_content);
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

  if (data.derived_from_message_id) {
    await assertVisibleSourceMessage(db, user.id, data.derived_from_message_id);
  }

  const learningProvenance = normalizeLearningProvenance(data.learning_provenance);
  await assertPromotedPoliciesOwnedByUser(
    db,
    user.id,
    learningProvenance?.promoted_from_policy_ids || []
  );

  const storage = canonicalToStorage({
    scope: data.scope,
    target_id: targetId,
    direction: data.direction,
    resource: data.resource,
    action: data.action ?? null,
    effect: data.effect,
    evaluator,
    policy_content: data.policy_content,
    effective_from: effectiveFrom,
    expires_at: expiresAt,
    max_uses: uses.max_uses,
    remaining_uses: uses.remaining_uses,
    source: data.source,
    derived_from_message_id: data.derived_from_message_id ?? null,
    learning_provenance: learningProvenance,
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

policyRoutes.get("/audit/provenance/:id", async (c) => {
  const user = c.get("user")!;
  const policyId = c.req.param("id");
  const db = getDb();

  const [policy] = await db
    .select()
    .from(schema.policies)
    .where(and(eq(schema.policies.id, policyId), eq(schema.policies.userId, user.id)))
    .limit(1);

  if (!policy) {
    throw new AppError("Policy not found", 404, "NOT_FOUND");
  }

  const canonical = dbPolicyToCanonical(policy);
  const lineageById = await loadPromotedPolicyLineage(db, user.id, canonical);
  const lineagePolicies = Array.from(lineageById.values());
  const auditPolicies = [canonical, ...lineagePolicies];
  const policyById = new Map(auditPolicies.map((entry) => [entry.id, entry]));

  const sourceMessageIds = Array.from(
    new Set(
      auditPolicies
        .map((entry) => entry.derived_from_message_id)
        .filter((entry): entry is string => Boolean(entry))
    )
  );

  const sourceMessages =
    sourceMessageIds.length > 0
      ? await db
          .select({
            action: schema.messages.action,
            createdAt: schema.messages.createdAt,
            direction: schema.messages.direction,
            id: schema.messages.id,
            recipientId: schema.messages.recipientId,
            recipientType: schema.messages.recipientType,
            resource: schema.messages.resource,
            senderUserId: schema.messages.senderUserId,
          })
          .from(schema.messages)
          .where(
            and(
              inArray(schema.messages.id, sourceMessageIds),
              or(
                eq(schema.messages.senderUserId, user.id),
                eq(schema.messages.recipientId, user.id)
              )
            )
          )
      : [];
  const sourceMessageById = new Map(sourceMessages.map((entry) => [entry.id, entry]));

  const promotionEdges = auditPolicies.flatMap((entry) =>
    (entry.learning_provenance?.promoted_from_policy_ids || [])
      .filter((fromPolicyId) => policyById.has(fromPolicyId))
      .map((fromPolicyId) => ({
        from_policy_id: fromPolicyId,
        to_policy_id: entry.id,
      }))
  );

  const overridePromotionHistory = promotionEdges
    .map((edge) => {
      const fromPolicy = policyById.get(edge.from_policy_id)!;
      const toPolicy = policyById.get(edge.to_policy_id)!;
      return {
        from_policy_id: fromPolicy.id,
        from_source: fromPolicy.source,
        from_derived_from_message_id: fromPolicy.derived_from_message_id,
        to_policy_id: toPolicy.id,
        to_source: toPolicy.source,
        to_derived_from_message_id: toPolicy.derived_from_message_id,
        source_interaction_id: toPolicy.learning_provenance?.source_interaction_id || null,
      };
    })
    .filter((entry) => entry.from_source === "override" || entry.to_source === "user_confirmed");

  return c.json({
    policy: toPolicyAuditRecord(canonical),
    source_message:
      canonical.derived_from_message_id &&
      sourceMessageById.has(canonical.derived_from_message_id)
        ? {
            id: canonical.derived_from_message_id,
            sender_user_id: sourceMessageById.get(canonical.derived_from_message_id)!.senderUserId,
            recipient_id: sourceMessageById.get(canonical.derived_from_message_id)!.recipientId,
            recipient_type:
              sourceMessageById.get(canonical.derived_from_message_id)!.recipientType,
            selectors: {
              direction: sourceMessageById.get(canonical.derived_from_message_id)!.direction,
              resource: sourceMessageById.get(canonical.derived_from_message_id)!.resource,
              action: sourceMessageById.get(canonical.derived_from_message_id)!.action,
            },
            created_at:
              sourceMessageById.get(canonical.derived_from_message_id)!.createdAt?.toISOString() ||
              null,
          }
        : null,
    lineage: lineagePolicies.map((entry) => toPolicyAuditRecord(entry)),
    override_to_promoted_history: overridePromotionHistory,
  });
});

// Update policy
const updatePolicySchema = z.object({
  direction: directionSchema.optional(),
  resource: z.string().min(1).optional(),
  action: z.string().min(1).nullable().optional(),
  effect: effectSchema.optional(),
  evaluator: evaluatorSchema.optional(),
  policy_type: evaluatorSchema.optional(),
  policy_content: z.unknown().optional(),
  effective_from: isoDateSchema.nullable().optional(),
  expires_at: isoDateSchema.nullable().optional(),
  max_uses: z.number().int().positive().nullable().optional(),
  remaining_uses: z.number().int().min(0).nullable().optional(),
  source: sourceSchema.optional(),
  derived_from_message_id: z.string().min(1).nullable().optional(),
  learning_provenance: learningProvenanceSchema,
  priority: z.number().int().min(0).max(100).optional(),
  enabled: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.evaluator && data.policy_type && data.evaluator !== data.policy_type) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["policy_type"],
      message: "policy_type must match evaluator when both are provided",
    });
  }
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
  const nextEvaluator = (data.evaluator || data.policy_type || current.evaluator) as PolicyEvaluator;
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

  if (data.derived_from_message_id) {
    await assertVisibleSourceMessage(db, user.id, data.derived_from_message_id);
  }

  const nextLearningProvenance =
    data.learning_provenance !== undefined
      ? normalizeLearningProvenance(data.learning_provenance)
      : current.learning_provenance || null;
  await assertPromotedPoliciesOwnedByUser(
    db,
    user.id,
    nextLearningProvenance?.promoted_from_policy_ids || []
  );

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
    learning_provenance: nextLearningProvenance,
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
    data.policy_type !== undefined ||
    data.policy_content !== undefined ||
    data.effective_from !== undefined ||
    data.expires_at !== undefined ||
    data.max_uses !== undefined ||
    data.remaining_uses !== undefined ||
    data.source !== undefined ||
    data.derived_from_message_id !== undefined ||
    data.learning_provenance !== undefined;

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
