import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  buildPolicyReasonCode,
  POLICY_RESOLVER_ORDER,
  filterPolicyCandidatesBySelectors,
  normalizeSelectorToken,
  reasonCodeToken,
  resolveDirectionCandidates,
  resolveMatchedPolicySet,
  resolvePolicySet,
  toPolicyMatch,
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
import { createAnthropicLLMPolicyEvaluator } from "./llm";
import { dbPolicyToCanonical, type CanonicalPolicy } from "./policySchema";
import { getRolesForFriend } from "./roles";

export { POLICY_RESOLVER_ORDER, validatePolicyContent };

export type {
  AuthenticatedSenderIdentity,
  EvaluatedPolicy,
  PolicyEvaluationPhase,
  PolicyResolverLayer,
  PolicyResult,
  PolicySelectorContext,
  WinningPolicy,
};

interface ServerPolicyPrecheckResult {
  identityContext: AuthenticatedSenderIdentity;
  earlyResult: PolicyResult | null;
}

interface ResolvedServerPolicyInputs {
  policyOwnerUserId: string;
  message: string;
  authenticatedIdentity: AuthenticatedSenderIdentity;
  recipientUserId?: string;
  recipientUsername?: string;
  recipientRoles: string[];
  groupId?: string;
  selectors?: PolicySelectorContext;
  llmSubject: string;
  context?: string;
}

export async function loadApplicablePolicies(
  policyOwnerUserId: string,
  recipientUserId?: string,
  recipientRoles: string[] = [],
  groupId?: string,
  selectors?: PolicySelectorContext,
): Promise<CanonicalPolicy[]> {
  const db = getDb();
  const now = new Date();
  const policyConditions = [eq(schema.policies.scope, "global")];

  if (recipientUserId) {
    policyConditions.push(
      and(
        eq(schema.policies.scope, "user"),
        eq(schema.policies.targetId, recipientUserId),
      ),
    );
  }

  if (recipientRoles.length > 0) {
    policyConditions.push(
      and(
        eq(schema.policies.scope, "role"),
        sql`${schema.policies.targetId} IN ${recipientRoles}`,
      ),
    );
  }

  if (groupId) {
    policyConditions.push(
      and(
        eq(schema.policies.scope, "group"),
        eq(schema.policies.targetId, groupId),
      ),
    );
  }

  const directionCandidates = resolveDirectionCandidates(selectors?.direction);
  const directionCondition = directionCandidates
    ? or(
        isNull(schema.policies.direction),
        inArray(schema.policies.direction, directionCandidates),
      )
    : null;

  const resourceSelector = normalizeSelectorToken(selectors?.resource);
  const resourceCondition = resourceSelector
    ? or(
        isNull(schema.policies.resource),
        eq(schema.policies.resource, resourceSelector),
      )
    : null;

  const actionSelector = normalizeSelectorToken(selectors?.action);
  const actionCondition = actionSelector
    ? or(
        isNull(schema.policies.action),
        eq(schema.policies.action, actionSelector),
      )
    : null;

  const policies = await db
    .select()
    .from(schema.policies)
    .where(
      and(
        eq(schema.policies.userId, policyOwnerUserId),
        eq(schema.policies.enabled, true),
        or(
          isNull(schema.policies.effectiveFrom),
          lte(schema.policies.effectiveFrom, now),
        ),
        or(
          isNull(schema.policies.expiresAt),
          gt(schema.policies.expiresAt, now),
        ),
        or(
          isNull(schema.policies.remainingUses),
          gt(schema.policies.remainingUses, 0),
        ),
        or(...policyConditions),
        ...(directionCondition ? [directionCondition] : []),
        ...(resourceCondition ? [resourceCondition] : []),
        ...(actionCondition ? [actionCondition] : []),
      ),
    )
    .orderBy(desc(schema.policies.priority));

  // Lifecycle and scope ownership stay server-side in SQL; the shared selector
  // filter is reapplied here so future bundle consumers reuse identical matching.
  return filterPolicyCandidatesBySelectors(policies, selectors).map((policy) =>
    dbPolicyToCanonical(policy),
  );
}

function createServerLLMPolicyEvaluator(): LLMPolicyEvaluator | undefined {
  if (!config.trustedMode) {
    return undefined;
  }

  return createAnthropicLLMPolicyEvaluator({
    onError: "pass",
  });
}

function toApplicablePolicyMatch(policy: CanonicalPolicy) {
  return toPolicyMatch(
    policy,
    "",
    "Policy is applicable for the current selector context",
    policy.evaluator === "llm" ? "contextual_llm" : "deterministic",
  );
}

function toContextReasonCode(reasonCode: string): string {
  return reasonCode.replace(/^policy\./, "context.");
}

export function resolveContextPolicyGuidance(policies: CanonicalPolicy[]): {
  decision: CanonicalPolicy["effect"];
  reasonCode: string;
} {
  const matchedResolution = resolveMatchedPolicySet(
    policies.map((policy) => toApplicablePolicyMatch(policy)),
  );
  const winningMatch = matchedResolution.winning_match;

  if (!winningMatch) {
    return {
      decision: "allow",
      reasonCode: toContextReasonCode(
        buildPolicyReasonCode("allow", undefined, "no_applicable"),
      ),
    };
  }

  return {
    decision: matchedResolution.final_effect,
    reasonCode: toContextReasonCode(
      buildPolicyReasonCode(matchedResolution.final_effect, winningMatch),
    ),
  };
}

async function evaluateResolvedServerPolicies(
  inputs: ResolvedServerPolicyInputs,
): Promise<PolicyResult> {
  const applicablePolicies = await loadApplicablePolicies(
    inputs.policyOwnerUserId,
    inputs.recipientUserId,
    inputs.recipientRoles,
    inputs.groupId,
    inputs.selectors,
  );

  return resolvePolicySet({
    policies: applicablePolicies,
    ownerUserId: inputs.policyOwnerUserId,
    message: inputs.message,
    context: inputs.context,
    recipientUsername: inputs.recipientUsername,
    llmSubject: inputs.llmSubject,
    authenticatedIdentity: inputs.authenticatedIdentity,
    resolverLayer: "user_policies",
    llmEvaluator: createServerLLMPolicyEvaluator(),
  });
}

async function loadCounterpartyPolicyContext(
  policyOwnerUserId: string,
  counterpartyUserId: string,
): Promise<{
  recipientRoles: string[];
  recipientUsername?: string;
  llmSubject: string;
}> {
  const db = getDb();
  const recipientRoles = await getRolesForFriend(
    policyOwnerUserId,
    counterpartyUserId,
  );
  const [counterparty] = await db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, counterpartyUserId))
    .limit(1);

  return {
    recipientRoles,
    recipientUsername: counterparty?.username,
    llmSubject: counterparty?.username || "unknown",
  };
}

function buildIdentityContext(
  senderUserId: string,
  authenticatedIdentity?: AuthenticatedSenderIdentity,
): AuthenticatedSenderIdentity {
  return (
    authenticatedIdentity || {
      sender_user_id: senderUserId,
      sender_connection_id: "unknown",
    }
  );
}

async function validateAuthenticatedIdentity(
  expectedSenderUserId: string,
  authenticatedIdentity: AuthenticatedSenderIdentity | undefined,
  identityContext: AuthenticatedSenderIdentity,
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
        eq(
          schema.agentConnections.id,
          authenticatedIdentity.sender_connection_id,
        ),
        eq(schema.agentConnections.userId, expectedSenderUserId),
        eq(schema.agentConnections.status, "active"),
      ),
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

async function runServerPolicyPrechecks(
  expectedSenderUserId: string,
  message: string,
  authenticatedIdentity?: AuthenticatedSenderIdentity,
): Promise<ServerPolicyPrecheckResult> {
  const identityContext = buildIdentityContext(
    expectedSenderUserId,
    authenticatedIdentity,
  );

  const identityValidationResult = await validateAuthenticatedIdentity(
    expectedSenderUserId,
    authenticatedIdentity,
    identityContext,
  );
  if (identityValidationResult) {
    return {
      identityContext,
      earlyResult: identityValidationResult,
    };
  }

  return {
    identityContext,
    earlyResult: evaluatePolicyGuardrails(message, identityContext),
  };
}

function evaluatePolicyGuardrails(
  message: string,
  identityContext: AuthenticatedSenderIdentity,
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
  groupId?: string,
): Promise<PolicyResult> {
  const { identityContext, earlyResult } = await runServerPolicyPrechecks(
    senderUserId,
    message,
    authenticatedIdentity,
  );
  if (earlyResult) {
    return earlyResult;
  }

  const recipientContext = await loadCounterpartyPolicyContext(
    senderUserId,
    recipientUserId,
  );

  return evaluateResolvedServerPolicies({
    policyOwnerUserId: senderUserId,
    message,
    authenticatedIdentity: identityContext,
    recipientUserId,
    recipientUsername: recipientContext.recipientUsername,
    recipientRoles: recipientContext.recipientRoles,
    groupId,
    selectors: selectorContext,
    llmSubject: recipientContext.llmSubject,
    context,
  });
}

export async function loadBilateralPolicies(
  policyOwnerUserId: string,
  recipientUserId: string,
  roles: string[] = [],
): Promise<CanonicalPolicy[]> {
  return loadApplicablePolicies(policyOwnerUserId, recipientUserId, roles);
}

export async function evaluateInboundPolicies(
  recipientUserId: string,
  requesterUserId: string,
  message: string,
  context?: string,
  authenticatedRequesterIdentity?: AuthenticatedSenderIdentity,
  selectorContext?: PolicySelectorContext,
): Promise<PolicyResult> {
  const { identityContext, earlyResult } = await runServerPolicyPrechecks(
    requesterUserId,
    message,
    authenticatedRequesterIdentity,
  );
  if (earlyResult) {
    return earlyResult;
  }

  const requesterContext = await loadCounterpartyPolicyContext(
    recipientUserId,
    requesterUserId,
  );

  return evaluateResolvedServerPolicies({
    policyOwnerUserId: recipientUserId,
    message,
    authenticatedIdentity: identityContext,
    recipientUserId: requesterUserId,
    recipientUsername: requesterContext.recipientUsername,
    recipientRoles: requesterContext.recipientRoles,
    selectors: selectorContext,
    llmSubject: requesterContext.llmSubject,
    context,
  });
}

export async function evaluateGroupPolicies(
  senderUserId: string,
  groupId: string,
  message: string,
  context?: string,
  authenticatedIdentity?: AuthenticatedSenderIdentity,
  selectorContext?: PolicySelectorContext,
): Promise<PolicyResult> {
  const { identityContext, earlyResult } = await runServerPolicyPrechecks(
    senderUserId,
    message,
    authenticatedIdentity,
  );
  if (earlyResult) {
    return earlyResult;
  }

  return evaluateResolvedServerPolicies({
    policyOwnerUserId: senderUserId,
    message,
    authenticatedIdentity: identityContext,
    recipientRoles: [],
    groupId,
    selectors: selectorContext,
    llmSubject: `group:${groupId}`,
    context,
  });
}

export async function consumeWinningPolicyUse(
  senderUserId: string,
  result: PolicyResult,
): Promise<void> {
  const winningPolicy = result.winning_policy;
  if (!winningPolicy) {
    return;
  }

  const hasUsageLimit =
    winningPolicy.max_uses !== null || winningPolicy.remaining_uses !== null;
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
          gt(schema.policies.remainingUses, 0),
        ),
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
        gt(schema.policies.maxUses, 0),
      ),
    );
}
