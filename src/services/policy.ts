import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  POLICY_RESOLVER_ORDER,
  filterPolicyCandidatesBySelectors,
  normalizeSelectorToken,
  reasonCodeToken,
  resolveDirectionCandidates,
  resolvePolicySet,
  toResult,
  validatePolicyContent,
  type AuthenticatedSenderIdentity,
  type LLMPolicyEvaluator,
  type PolicyEvaluationPhase,
  type PolicyResolverLayer,
  type PolicyResult,
  type PolicySelectorContext,
  type EvaluatedPolicy,
  type WinningPolicy,
} from "@mahilo/policy-core";
import { config } from "../config";
import { getDb, schema } from "../db";
import { evaluatePlatformGuardrails } from "./policyGuardrails";
import { evaluateLLMPolicy, isLLMEnabled } from "./llm";
import {
  dbPolicyToCanonical,
  type CanonicalPolicy,
} from "./policySchema";
import { getRolesForFriend } from "./roles";

export {
  POLICY_RESOLVER_ORDER,
  validatePolicyContent,
};

export type {
  AuthenticatedSenderIdentity,
  EvaluatedPolicy,
  PolicyEvaluationPhase,
  PolicyResolverLayer,
  PolicyResult,
  PolicySelectorContext,
  WinningPolicy,
};

export async function loadApplicablePolicies(
  senderUserId: string,
  recipientUserId?: string,
  recipientRoles: string[] = [],
  groupId?: string,
  selectors?: PolicySelectorContext
): Promise<CanonicalPolicy[]> {
  const db = getDb();
  const now = new Date();
  const policyConditions = [eq(schema.policies.scope, "global")];

  if (recipientUserId) {
    policyConditions.push(
      and(eq(schema.policies.scope, "user"), eq(schema.policies.targetId, recipientUserId))
    );
  }

  if (recipientRoles.length > 0) {
    policyConditions.push(
      and(eq(schema.policies.scope, "role"), sql`${schema.policies.targetId} IN ${recipientRoles}`)
    );
  }

  if (groupId) {
    policyConditions.push(
      and(eq(schema.policies.scope, "group"), eq(schema.policies.targetId, groupId))
    );
  }

  const directionCandidates = resolveDirectionCandidates(selectors?.direction);
  const directionCondition = directionCandidates
    ? or(
        isNull(schema.policies.direction),
        inArray(schema.policies.direction, directionCandidates)
      )
    : null;

  const resourceSelector = normalizeSelectorToken(selectors?.resource);
  const resourceCondition = resourceSelector
    ? or(isNull(schema.policies.resource), eq(schema.policies.resource, resourceSelector))
    : null;

  const actionSelector = normalizeSelectorToken(selectors?.action);
  const actionCondition = actionSelector
    ? or(isNull(schema.policies.action), eq(schema.policies.action, actionSelector))
    : null;

  const policies = await db
    .select()
    .from(schema.policies)
    .where(
      and(
        eq(schema.policies.userId, senderUserId),
        eq(schema.policies.enabled, true),
        or(isNull(schema.policies.effectiveFrom), lte(schema.policies.effectiveFrom, now)),
        or(isNull(schema.policies.expiresAt), gt(schema.policies.expiresAt, now)),
        or(isNull(schema.policies.remainingUses), gt(schema.policies.remainingUses, 0)),
        or(...policyConditions),
        ...(directionCondition ? [directionCondition] : []),
        ...(resourceCondition ? [resourceCondition] : []),
        ...(actionCondition ? [actionCondition] : [])
      )
    )
    .orderBy(desc(schema.policies.priority));

  // Lifecycle and scope ownership stay server-side in SQL; the shared selector
  // filter is reapplied here so future bundle consumers reuse identical matching.
  return filterPolicyCandidatesBySelectors(policies, selectors).map((policy) =>
    dbPolicyToCanonical(policy)
  );
}

function createServerLLMPolicyEvaluator(): LLMPolicyEvaluator | undefined {
  if (!(config.trustedMode && isLLMEnabled())) {
    return undefined;
  }

  return async ({ policyContent, message, subject, context }) => {
    const result = await evaluateLLMPolicy(policyContent, message, subject, context);
    if (result.passed) {
      return {
        status: "pass",
        reasoning: result.reasoning || "LLM policy passed",
      };
    }

    return {
      status: "match",
      reasoning: result.reasoning || "Message blocked by LLM policy",
    };
  };
}

async function resolveUserPolicyLayer(
  senderUserId: string,
  message: string,
  options: {
    authenticatedIdentity: AuthenticatedSenderIdentity;
    recipientUserId?: string;
    recipientUsername?: string;
    recipientRoles?: string[];
    groupId?: string;
    selectors?: PolicySelectorContext;
    llmSubject: string;
    context?: string;
  }
): Promise<PolicyResult> {
  const applicablePolicies = await loadApplicablePolicies(
    senderUserId,
    options.recipientUserId,
    options.recipientRoles || [],
    options.groupId,
    options.selectors
  );

  return resolvePolicySet({
    policies: applicablePolicies,
    ownerUserId: senderUserId,
    message,
    context: options.context,
    recipientUsername: options.recipientUsername,
    llmSubject: options.llmSubject,
    authenticatedIdentity: options.authenticatedIdentity,
    resolverLayer: "user_policies",
    llmEvaluator: createServerLLMPolicyEvaluator(),
  });
}

function buildIdentityContext(
  senderUserId: string,
  authenticatedIdentity?: AuthenticatedSenderIdentity
): AuthenticatedSenderIdentity {
  return authenticatedIdentity || {
    sender_user_id: senderUserId,
    sender_connection_id: "unknown",
  };
}

async function validateAuthenticatedIdentity(
  expectedSenderUserId: string,
  authenticatedIdentity: AuthenticatedSenderIdentity | undefined,
  identityContext: AuthenticatedSenderIdentity
): Promise<PolicyResult | null> {
  if (!authenticatedIdentity) {
    return null;
  }

  if (authenticatedIdentity.sender_user_id !== expectedSenderUserId) {
    return toResult("deny", {
      reason: "Authenticated sender identity does not match resolver sender",
      reason_code: "auth.sender_identity.mismatch",
      explanation:
        "Authenticated sender identity validation failed before policy evaluation. Final effect: 'deny'.",
      authenticated_identity: identityContext,
      resolver_layer: "platform_guardrails",
      matched_policy_ids: [],
      evaluated_policies: [],
    });
  }

  const db = getDb();
  const [senderConnection] = await db
    .select({ id: schema.agentConnections.id })
    .from(schema.agentConnections)
    .where(
      and(
        eq(schema.agentConnections.id, authenticatedIdentity.sender_connection_id),
        eq(schema.agentConnections.userId, expectedSenderUserId),
        eq(schema.agentConnections.status, "active")
      )
    )
    .limit(1);

  if (!senderConnection) {
    return toResult("deny", {
      reason: "Authenticated sender connection not found or inactive",
      reason_code: "auth.sender_connection.invalid",
      explanation:
        "Authenticated sender connection validation failed before policy evaluation. Final effect: 'deny'.",
      authenticated_identity: identityContext,
      resolver_layer: "platform_guardrails",
      matched_policy_ids: [],
      evaluated_policies: [],
    });
  }

  return null;
}

function evaluatePolicyGuardrails(
  message: string,
  identityContext: AuthenticatedSenderIdentity
): PolicyResult | null {
  const guardrailResult = evaluatePlatformGuardrails(message);
  if (!guardrailResult.blocked) {
    return null;
  }

  return toResult("deny", {
    reason: guardrailResult.reason,
    reason_code: `guardrail.${reasonCodeToken(guardrailResult.guardrail_id || "blocked")}`,
    explanation:
      "Platform guardrail matched before user policy evaluation. Final effect: 'deny'.",
    authenticated_identity: identityContext,
    resolver_layer: "platform_guardrails",
    guardrail_id: guardrailResult.guardrail_id,
    matched_policy_ids: [],
    evaluated_policies: [],
  });
}

export async function evaluatePolicies(
  senderUserId: string,
  recipientUserId: string,
  message: string,
  context?: string,
  authenticatedIdentity?: AuthenticatedSenderIdentity,
  selectorContext?: PolicySelectorContext,
  groupId?: string
): Promise<PolicyResult> {
  const identityContext = buildIdentityContext(senderUserId, authenticatedIdentity);
  const db = getDb();

  const identityValidationResult = await validateAuthenticatedIdentity(
    senderUserId,
    authenticatedIdentity,
    identityContext
  );
  if (identityValidationResult) {
    return identityValidationResult;
  }

  const guardrailResult = evaluatePolicyGuardrails(message, identityContext);
  if (guardrailResult) {
    return guardrailResult;
  }

  const recipientRoles = await getRolesForFriend(senderUserId, recipientUserId);
  const [recipient] = await db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, recipientUserId))
    .limit(1);

  return resolveUserPolicyLayer(senderUserId, message, {
    authenticatedIdentity: identityContext,
    recipientUserId,
    recipientUsername: recipient?.username,
    recipientRoles,
    groupId,
    selectors: selectorContext,
    llmSubject: recipient?.username || "unknown",
    context,
  });
}

export async function loadBilateralPolicies(
  userId: string,
  recipientUserId: string,
  roles: string[] = []
): Promise<CanonicalPolicy[]> {
  return loadApplicablePolicies(userId, recipientUserId, roles);
}

export async function evaluateInboundPolicies(
  recipientUserId: string,
  requesterUserId: string,
  message: string,
  context?: string,
  authenticatedRequesterIdentity?: AuthenticatedSenderIdentity,
  selectorContext?: PolicySelectorContext
): Promise<PolicyResult> {
  const identityContext = buildIdentityContext(requesterUserId, authenticatedRequesterIdentity);
  const db = getDb();

  const identityValidationResult = await validateAuthenticatedIdentity(
    requesterUserId,
    authenticatedRequesterIdentity,
    identityContext
  );
  if (identityValidationResult) {
    return identityValidationResult;
  }

  const guardrailResult = evaluatePolicyGuardrails(message, identityContext);
  if (guardrailResult) {
    return guardrailResult;
  }

  const requesterRoles = await getRolesForFriend(recipientUserId, requesterUserId);
  const [requester] = await db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, requesterUserId))
    .limit(1);

  return resolveUserPolicyLayer(recipientUserId, message, {
    authenticatedIdentity: identityContext,
    recipientUserId: requesterUserId,
    recipientUsername: requester?.username,
    recipientRoles: requesterRoles,
    selectors: selectorContext,
    llmSubject: requester?.username || "unknown",
    context,
  });
}

export async function evaluateGroupPolicies(
  senderUserId: string,
  groupId: string,
  message: string,
  context?: string,
  authenticatedIdentity?: AuthenticatedSenderIdentity,
  selectorContext?: PolicySelectorContext
): Promise<PolicyResult> {
  const identityContext = buildIdentityContext(senderUserId, authenticatedIdentity);

  const identityValidationResult = await validateAuthenticatedIdentity(
    senderUserId,
    authenticatedIdentity,
    identityContext
  );
  if (identityValidationResult) {
    return identityValidationResult;
  }

  const guardrailResult = evaluatePolicyGuardrails(message, identityContext);
  if (guardrailResult) {
    return guardrailResult;
  }

  return resolveUserPolicyLayer(senderUserId, message, {
    authenticatedIdentity: identityContext,
    groupId,
    selectors: selectorContext,
    llmSubject: `group:${groupId}`,
    context,
  });
}

export async function consumeWinningPolicyUse(
  senderUserId: string,
  result: PolicyResult
): Promise<void> {
  const winningPolicy = result.winning_policy;
  if (!winningPolicy) {
    return;
  }

  const hasUsageLimit = winningPolicy.max_uses !== null || winningPolicy.remaining_uses !== null;
  if (!hasUsageLimit) {
    return;
  }

  const db = getDb();

  if (winningPolicy.remaining_uses !== null) {
    await db
      .update(schema.policies)
      .set({
        remainingUses: sql`CASE
          WHEN ${schema.policies.remainingUses} > 0
            THEN ${schema.policies.remainingUses} - 1
          ELSE ${schema.policies.remainingUses}
        END`,
      })
      .where(
        and(
          eq(schema.policies.id, winningPolicy.policy_id),
          eq(schema.policies.userId, senderUserId),
          gt(schema.policies.remainingUses, 0)
        )
      );
    return;
  }

  await db
    .update(schema.policies)
    .set({
      remainingUses: sql`CASE
        WHEN ${schema.policies.maxUses} > 0
          THEN ${schema.policies.maxUses} - 1
        ELSE 0
      END`,
    })
    .where(
      and(
        eq(schema.policies.id, winningPolicy.policy_id),
        eq(schema.policies.userId, senderUserId),
        isNull(schema.policies.remainingUses),
        gt(schema.policies.maxUses, 0)
      )
    );
}
