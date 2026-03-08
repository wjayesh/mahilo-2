import { eq, and, or, desc, sql, isNull, lte, gt, inArray } from "drizzle-orm";
import { getDb, schema } from "../db";
import { getRolesForFriend } from "./roles";
import { evaluateLLMPolicy, isLLMEnabled } from "./llm";
import { config } from "../config";
import {
  dbPolicyToCanonical,
  type CanonicalPolicy,
  type PolicyDirection,
  type PolicyEffect,
  type PolicyEvaluator,
  type PolicyScope,
} from "./policySchema";
import { evaluatePlatformGuardrails } from "./policyGuardrails";

interface HeuristicRules {
  maxLength?: number;
  minLength?: number;
  blockedPatterns?: string[];
  requiredPatterns?: string[];
  requireContext?: boolean;
  trustedRecipients?: string[];
  blockedRecipients?: string[];
}

export type PolicyResolverLayer = "platform_guardrails" | "user_policies";
export type PolicyEvaluationPhase = "deterministic" | "contextual_llm";

export interface AuthenticatedSenderIdentity {
  sender_user_id: string;
  sender_connection_id: string;
}

export interface PolicySelectorContext {
  direction?: PolicyDirection;
  resource?: string;
  action?: string;
}

interface PolicyLifecycleProvenance {
  created_by_user_id: string;
  source: CanonicalPolicy["source"];
  derived_from_message_id: string | null;
  effective_from: string | null;
  expires_at: string | null;
  max_uses: number | null;
  remaining_uses: number | null;
  created_at: string | null;
}

export interface EvaluatedPolicy extends PolicyLifecycleProvenance {
  policy_id: string;
  scope: PolicyScope;
  evaluator: PolicyEvaluator;
  effect: PolicyEffect;
  priority: number;
  phase: PolicyEvaluationPhase;
  matched: boolean;
  reason?: string;
  skipped?: boolean;
  skip_reason?: string;
}

interface PolicyMatch extends PolicyLifecycleProvenance {
  policy_id: string;
  scope: PolicyScope;
  evaluator: PolicyEvaluator;
  effect: PolicyEffect;
  reason: string;
  priority: number;
  phase: PolicyEvaluationPhase;
}

export interface WinningPolicy extends PolicyLifecycleProvenance {
  policy_id: string;
  scope: PolicyScope;
  evaluator: PolicyEvaluator;
  effect: PolicyEffect;
  priority: number;
  phase: PolicyEvaluationPhase;
  reason: string;
}

interface ScopeResolution {
  effect: PolicyEffect;
  winner: PolicyMatch;
}

type SpecificityScope = "user" | "role" | "global";

interface PolicyResolutionContext {
  all_matches: PolicyMatch[];
  deterministic_evaluated: EvaluatedPolicy[];
  llm_evaluated: EvaluatedPolicy[];
  base_resolution: (ScopeResolution & { scope: SpecificityScope }) | null;
  group_resolution: ScopeResolution | null;
  final_effect: PolicyEffect;
}

export interface PolicyResult {
  allowed: boolean;
  effect: PolicyEffect;
  reason?: string;
  reason_code: string;
  resolution_explanation: string;
  authenticated_identity?: AuthenticatedSenderIdentity;
  resolver_layer?: PolicyResolverLayer;
  guardrail_id?: string;
  winning_policy_id?: string;
  winning_policy?: WinningPolicy;
  matched_policy_ids: string[];
  evaluated_policies: EvaluatedPolicy[];
}

/**
 * SRV-002 resolver order:
 * 1. `platform_guardrails` (non-overridable)
 * 2. `user_policies`
 */
export const POLICY_RESOLVER_ORDER: PolicyResolverLayer[] = [
  "platform_guardrails",
  "user_policies",
];

const EFFECT_PRECEDENCE: Record<PolicyEffect, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

const PHASE_PRECEDENCE: Record<PolicyEvaluationPhase, number> = {
  deterministic: 1,
  contextual_llm: 0,
};

const SPECIFICITY_ORDER: SpecificityScope[] = ["user", "role", "global"];

function parseRules(content: unknown): { valid: boolean; rules?: HeuristicRules; error?: string } {
  if (typeof content === "string") {
    try {
      return { valid: true, rules: JSON.parse(content) as HeuristicRules };
    } catch {
      return { valid: false, error: "Policy content must be valid JSON" };
    }
  }

  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    return { valid: true, rules: content as HeuristicRules };
  }

  return { valid: false, error: "Heuristic/structured policy content must be a JSON object" };
}

export function validatePolicyContent(
  evaluator: string,
  content: unknown
): { valid: boolean; error?: string } {
  if (evaluator === "heuristic" || evaluator === "structured") {
    const parsed = parseRules(content);
    if (!parsed.valid) {
      return { valid: false, error: parsed.error };
    }
    const rules = parsed.rules!;

    // Validate rule types
    if (rules.maxLength !== undefined && typeof rules.maxLength !== "number") {
      return { valid: false, error: "maxLength must be a number" };
    }
    if (rules.minLength !== undefined && typeof rules.minLength !== "number") {
      return { valid: false, error: "minLength must be a number" };
    }
    if (rules.blockedPatterns !== undefined && !Array.isArray(rules.blockedPatterns)) {
      return { valid: false, error: "blockedPatterns must be an array" };
    }
    if (rules.requiredPatterns !== undefined && !Array.isArray(rules.requiredPatterns)) {
      return { valid: false, error: "requiredPatterns must be an array" };
    }

    // Validate regex patterns are valid
    if (rules.blockedPatterns) {
      for (const pattern of rules.blockedPatterns) {
        try {
          new RegExp(pattern);
        } catch {
          return { valid: false, error: `Invalid regex pattern: ${pattern}` };
        }
      }
    }

    if (rules.requiredPatterns) {
      for (const pattern of rules.requiredPatterns) {
        try {
          new RegExp(pattern);
        } catch {
          return { valid: false, error: `Invalid regex pattern: ${pattern}` };
        }
      }
    }

    return { valid: true };
  }

  if (evaluator === "llm") {
    // LLM policies are just prompts
    if (typeof content !== "string" || content.trim().length === 0) {
      return { valid: false, error: "LLM policy must have a non-empty prompt" };
    }
    return { valid: true };
  }

  return { valid: false, error: `Unknown policy evaluator: ${evaluator}` };
}

function hasConstraintRules(rules: HeuristicRules): boolean {
  return (
    rules.maxLength !== undefined ||
    rules.minLength !== undefined ||
    (rules.blockedPatterns?.length ?? 0) > 0 ||
    (rules.requiredPatterns?.length ?? 0) > 0 ||
    rules.requireContext === true ||
    (rules.trustedRecipients?.length ?? 0) > 0 ||
    (rules.blockedRecipients?.length ?? 0) > 0
  );
}

function evaluateHeuristicPolicyMatch(
  rules: HeuristicRules,
  message: string,
  context?: string,
  recipientUsername?: string
): { matched: boolean; reason?: string } {
  // Check length constraints
  if (rules.maxLength !== undefined && message.length > rules.maxLength) {
    return { matched: true, reason: `Message exceeds maximum length of ${rules.maxLength}` };
  }

  if (rules.minLength !== undefined && message.length < rules.minLength) {
    return {
      matched: true,
      reason: `Message is shorter than minimum length of ${rules.minLength}`,
    };
  }

  // Check blocked patterns
  if (rules.blockedPatterns) {
    for (const pattern of rules.blockedPatterns) {
      const regex = new RegExp(pattern, "i");
      if (regex.test(message)) {
        return { matched: true, reason: "Message contains blocked pattern" };
      }
    }
  }

  // Check required patterns
  if (rules.requiredPatterns) {
    for (const pattern of rules.requiredPatterns) {
      const regex = new RegExp(pattern, "i");
      if (!regex.test(message)) {
        return { matched: true, reason: "Message missing required pattern" };
      }
    }
  }

  // Check recipient restrictions
  if (recipientUsername) {
    if (rules.blockedRecipients?.includes(recipientUsername)) {
      return { matched: true, reason: "Recipient is blocked by policy" };
    }

    if (rules.trustedRecipients && !rules.trustedRecipients.includes(recipientUsername)) {
      return { matched: true, reason: "Recipient not in trusted list" };
    }
  }

  if (rules.requireContext && !context) {
    return { matched: true, reason: "Context is required for this message" };
  }

  // Empty structured policies are treated as explicit always-match statements.
  if (!hasConstraintRules(rules)) {
    return { matched: true, reason: "Policy has no constraints and applies to all messages" };
  }

  return { matched: false };
}

function comparePolicyMatches(a: PolicyMatch, b: PolicyMatch): number {
  const effectDelta = EFFECT_PRECEDENCE[b.effect] - EFFECT_PRECEDENCE[a.effect];
  if (effectDelta !== 0) {
    return effectDelta;
  }

  if (b.priority !== a.priority) {
    return b.priority - a.priority;
  }

  const phaseDelta = PHASE_PRECEDENCE[b.phase] - PHASE_PRECEDENCE[a.phase];
  if (phaseDelta !== 0) {
    return phaseDelta;
  }

  return a.policy_id.localeCompare(b.policy_id);
}

function resolveScopeMatches(matches: PolicyMatch[]): ScopeResolution | null {
  if (matches.length === 0) {
    return null;
  }

  const winner = [...matches].sort(comparePolicyMatches)[0];
  return {
    effect: winner.effect,
    winner,
  };
}

function stricterEffect(a: PolicyEffect, b: PolicyEffect): PolicyEffect {
  return EFFECT_PRECEDENCE[a] >= EFFECT_PRECEDENCE[b] ? a : b;
}

function formatPolicyIds(policies: EvaluatedPolicy[]): string {
  if (policies.length === 0) {
    return "none";
  }
  return policies.map((policy) => policy.policy_id).join(", ");
}

function reasonCodeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function buildPolicyReasonCode(
  effect: PolicyEffect,
  winner?: PolicyMatch,
  fallback?: "no_applicable" | "no_match"
): string {
  if (fallback) {
    return `policy.${effect}.${fallback}`;
  }
  if (!winner) {
    return `policy.${effect}.resolved`;
  }
  return `policy.${effect}.${winner.scope}.${winner.evaluator}`;
}

function buildResolutionExplanation(context: PolicyResolutionContext): string {
  const explanation: string[] = [];
  const {
    base_resolution: base,
    group_resolution: group,
    final_effect: finalEffect,
    deterministic_evaluated: deterministicEvaluated,
    llm_evaluated: llmEvaluated,
  } = context;

  const deterministicMatched = deterministicEvaluated.filter((policy) => policy.matched);
  explanation.push(
    `Deterministic phase evaluated ${deterministicEvaluated.length} policy/policies (matched: ${formatPolicyIds(deterministicMatched)}).`
  );

  const llmMatched = llmEvaluated.filter((policy) => policy.matched);
  const llmSkipped = llmEvaluated.filter((policy) => policy.skipped);
  explanation.push(
    `Contextual LLM phase evaluated ${llmEvaluated.length} policy/policies (matched: ${formatPolicyIds(llmMatched)}; skipped: ${formatPolicyIds(llmSkipped)}).`
  );

  if (base) {
    explanation.push(
      `Base specificity resolved from '${base.scope}' scope with effect '${base.effect}' via policy ${base.winner.policy_id}.`
    );
  } else {
    explanation.push("No matching base policy in user/role/global scopes.");
  }

  if (group) {
    explanation.push(
      `Group overlay resolved to '${group.effect}' via policy ${group.winner.policy_id} and applied as additional constraint.`
    );
  } else {
    explanation.push("No matching group overlay policy.");
  }

  explanation.push(`Same-level conflicts use deterministic precedence deny > ask > allow.`);
  explanation.push(`Final effect: '${finalEffect}'.`);
  explanation.push(
    `Matched policies: ${
      context.all_matches.length > 0
        ? context.all_matches.map((m) => m.policy_id).join(", ")
        : "none"
    }.`
  );

  return explanation.join(" ");
}

function toResult(
  effect: PolicyEffect,
  options: {
    reason?: string;
    reason_code?: string;
    explanation: string;
    authenticated_identity?: AuthenticatedSenderIdentity;
    winning_policy_id?: string;
    winning_policy?: WinningPolicy;
    resolver_layer: PolicyResolverLayer;
    guardrail_id?: string;
    matched_policy_ids?: string[];
    evaluated_policies?: EvaluatedPolicy[];
  }
): PolicyResult {
  return {
    allowed: effect === "allow",
    effect,
    reason: options.reason,
    reason_code: options.reason_code || `policy.${effect}.resolved`,
    resolution_explanation: options.explanation,
    authenticated_identity: options.authenticated_identity,
    resolver_layer: options.resolver_layer,
    guardrail_id: options.guardrail_id,
    winning_policy_id: options.winning_policy_id,
    winning_policy: options.winning_policy,
    matched_policy_ids: options.matched_policy_ids ?? [],
    evaluated_policies: options.evaluated_policies ?? [],
  };
}

function normalizeSelectorToken(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveDirectionCandidates(direction: PolicyDirection | undefined): PolicyDirection[] | null {
  if (!direction) {
    return null;
  }
  if (direction === "inbound" || direction === "request") {
    return ["inbound", "request"];
  }
  return [direction];
}

async function loadApplicablePolicies(
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

  return policies.map((policy) => dbPolicyToCanonical(policy));
}

interface PolicyEvaluationResult {
  evaluated_policy: EvaluatedPolicy;
  match: PolicyMatch | null;
}

function buildEvaluatedPolicy(
  policy: CanonicalPolicy,
  ownerUserId: string,
  phase: PolicyEvaluationPhase,
  options: {
    matched: boolean;
    reason?: string;
    skipped?: boolean;
    skip_reason?: string;
  }
): EvaluatedPolicy {
  return {
    policy_id: policy.id,
    scope: policy.scope,
    evaluator: policy.evaluator,
    effect: policy.effect,
    created_by_user_id: ownerUserId,
    source: policy.source,
    derived_from_message_id: policy.derived_from_message_id,
    effective_from: policy.effective_from,
    expires_at: policy.expires_at,
    max_uses: policy.max_uses,
    remaining_uses: policy.remaining_uses,
    created_at: policy.created_at,
    priority: policy.priority,
    phase,
    matched: options.matched,
    reason: options.reason,
    skipped: options.skipped || false,
    skip_reason: options.skip_reason,
  };
}

function toPolicyMatch(
  policy: CanonicalPolicy,
  ownerUserId: string,
  reason: string,
  phase: PolicyEvaluationPhase
): PolicyMatch {
  return {
    policy_id: policy.id,
    scope: policy.scope,
    evaluator: policy.evaluator,
    effect: policy.effect,
    created_by_user_id: ownerUserId,
    source: policy.source,
    derived_from_message_id: policy.derived_from_message_id,
    effective_from: policy.effective_from,
    expires_at: policy.expires_at,
    max_uses: policy.max_uses,
    remaining_uses: policy.remaining_uses,
    created_at: policy.created_at,
    reason,
    priority: policy.priority,
    phase,
  };
}

async function evaluateDeterministicPolicyMatch(
  ownerUserId: string,
  policy: CanonicalPolicy,
  message: string,
  context?: string,
  recipientUsername?: string
): Promise<PolicyEvaluationResult> {
  try {
    const parsed = parseRules(policy.policy_content);
    if (!parsed.valid) {
      return {
        evaluated_policy: buildEvaluatedPolicy(policy, ownerUserId, "deterministic", {
          matched: false,
          skipped: true,
          skip_reason: parsed.error || "Invalid deterministic policy content",
        }),
        match: null,
      };
    }

    const heuristicMatch = evaluateHeuristicPolicyMatch(
      parsed.rules!,
      message,
      context,
      recipientUsername
    );
    if (!heuristicMatch.matched) {
      return {
        evaluated_policy: buildEvaluatedPolicy(policy, ownerUserId, "deterministic", {
          matched: false,
        }),
        match: null,
      };
    }

    const matchReason = heuristicMatch.reason || "Message matched policy conditions";
    return {
      evaluated_policy: buildEvaluatedPolicy(policy, ownerUserId, "deterministic", {
        matched: true,
        reason: matchReason,
      }),
      match: toPolicyMatch(policy, ownerUserId, matchReason, "deterministic"),
    };
  } catch (error) {
    console.error(`Error evaluating deterministic policy ${policy.id}:`, error);
    return {
      evaluated_policy: buildEvaluatedPolicy(policy, ownerUserId, "deterministic", {
        matched: false,
        skipped: true,
        skip_reason: "Deterministic evaluator failed",
      }),
      match: null,
    };
  }
}

async function evaluateContextualPolicyMatch(
  ownerUserId: string,
  policy: CanonicalPolicy,
  message: string,
  llmSubject: string,
  context?: string
): Promise<PolicyEvaluationResult> {
  const llmEnabled = isLLMEnabled();
  if (!(config.trustedMode && llmEnabled)) {
    const skipReason = `Skipping LLM policy ${policy.id} (trustedMode=${config.trustedMode}, llmEnabled=${llmEnabled})`;
    console.log(skipReason);
    return {
      evaluated_policy: buildEvaluatedPolicy(policy, ownerUserId, "contextual_llm", {
        matched: false,
        skipped: true,
        skip_reason: skipReason,
      }),
      match: null,
    };
  }

  try {
    const llmResult = await evaluateLLMPolicy(
      typeof policy.policy_content === "string"
        ? policy.policy_content
        : JSON.stringify(policy.policy_content),
      message,
      llmSubject,
      context
    );

    if (llmResult.passed) {
      return {
        evaluated_policy: buildEvaluatedPolicy(policy, ownerUserId, "contextual_llm", {
          matched: false,
          reason: llmResult.reasoning || "LLM policy passed",
        }),
        match: null,
      };
    }

    const matchReason = llmResult.reasoning || "Message blocked by LLM policy";
    return {
      evaluated_policy: buildEvaluatedPolicy(policy, ownerUserId, "contextual_llm", {
        matched: true,
        reason: matchReason,
      }),
      match: toPolicyMatch(policy, ownerUserId, matchReason, "contextual_llm"),
    };
  } catch (error) {
    console.error(`Error evaluating LLM policy ${policy.id}:`, error);
    return {
      evaluated_policy: buildEvaluatedPolicy(policy, ownerUserId, "contextual_llm", {
        matched: false,
        skipped: true,
        skip_reason: "Contextual LLM evaluation failed",
      }),
      match: null,
    };
  }
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

  if (applicablePolicies.length === 0) {
    return toResult("allow", {
      explanation: "No applicable policies matched. Final effect: 'allow'.",
      reason_code: buildPolicyReasonCode("allow", undefined, "no_applicable"),
      authenticated_identity: options.authenticatedIdentity,
      resolver_layer: "user_policies",
    });
  }

  const allMatches: PolicyMatch[] = [];
  const evaluatedPolicies: EvaluatedPolicy[] = [];
  const deterministicEvaluated: EvaluatedPolicy[] = [];
  const llmEvaluated: EvaluatedPolicy[] = [];

  const deterministicPolicies = applicablePolicies.filter(
    (policy) => policy.evaluator === "heuristic" || policy.evaluator === "structured"
  );
  for (const policy of deterministicPolicies) {
    const result = await evaluateDeterministicPolicyMatch(
      senderUserId,
      policy,
      message,
      options.context,
      options.recipientUsername
    );
    deterministicEvaluated.push(result.evaluated_policy);
    evaluatedPolicies.push(result.evaluated_policy);
    if (result.match) {
      allMatches.push(result.match);
    }
  }

  const llmPolicies = applicablePolicies.filter((policy) => policy.evaluator === "llm");
  for (const policy of llmPolicies) {
    const result = await evaluateContextualPolicyMatch(
      senderUserId,
      policy,
      message,
      options.llmSubject,
      options.context
    );
    llmEvaluated.push(result.evaluated_policy);
    evaluatedPolicies.push(result.evaluated_policy);
    if (result.match) {
      allMatches.push(result.match);
    }
  }

  if (allMatches.length === 0) {
    return toResult("allow", {
      explanation:
        "Applicable policies were evaluated but none matched current message conditions. Final effect: 'allow'.",
      reason_code: buildPolicyReasonCode("allow", undefined, "no_match"),
      authenticated_identity: options.authenticatedIdentity,
      resolver_layer: "user_policies",
      matched_policy_ids: [],
      evaluated_policies: evaluatedPolicies,
    });
  }

  const baseMatchesByScope: Record<SpecificityScope, PolicyMatch[]> = {
    user: allMatches.filter((m) => m.scope === "user"),
    role: allMatches.filter((m) => m.scope === "role"),
    global: allMatches.filter((m) => m.scope === "global"),
  };
  const groupMatches = allMatches.filter((m) => m.scope === "group");

  let baseResolution: (ScopeResolution & { scope: SpecificityScope }) | null = null;
  for (const scope of SPECIFICITY_ORDER) {
    const resolved = resolveScopeMatches(baseMatchesByScope[scope]);
    if (resolved) {
      baseResolution = { ...resolved, scope };
      break;
    }
  }

  const groupResolution = resolveScopeMatches(groupMatches);

  let finalEffect: PolicyEffect = baseResolution?.effect ?? "allow";
  let winner = baseResolution?.winner;

  if (groupResolution) {
    const constrained = stricterEffect(finalEffect, groupResolution.effect);
    if (constrained !== finalEffect || !winner) {
      winner = groupResolution.winner;
    }
    finalEffect = constrained;
  }

  const explanation = buildResolutionExplanation({
    all_matches: allMatches,
    deterministic_evaluated: deterministicEvaluated,
    llm_evaluated: llmEvaluated,
    base_resolution: baseResolution,
    group_resolution: groupResolution,
    final_effect: finalEffect,
  });

  let reason: string | undefined;
  if (finalEffect === "deny") {
    reason = winner?.reason || "Message blocked by policy";
  } else if (finalEffect === "ask") {
    reason = winner?.reason
      ? `Review required: ${winner.reason}`
      : "Review required by policy";
  }

  return toResult(finalEffect, {
    reason,
    reason_code: buildPolicyReasonCode(finalEffect, winner),
    explanation,
    authenticated_identity: options.authenticatedIdentity,
    resolver_layer: "user_policies",
    winning_policy_id: winner?.policy_id,
    winning_policy: winner
        ? {
            policy_id: winner.policy_id,
            scope: winner.scope,
            evaluator: winner.evaluator,
            effect: winner.effect,
            created_by_user_id: winner.created_by_user_id,
            source: winner.source,
            derived_from_message_id: winner.derived_from_message_id,
            effective_from: winner.effective_from,
            expires_at: winner.expires_at,
            max_uses: winner.max_uses,
            remaining_uses: winner.remaining_uses,
            created_at: winner.created_at,
            priority: winner.priority,
            phase: winner.phase,
            reason: winner.reason,
          }
      : undefined,
    matched_policy_ids: allMatches.map((m) => m.policy_id),
    evaluated_policies: evaluatedPolicies,
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
  selectorContext?: PolicySelectorContext
): Promise<PolicyResult> {
  const identityContext = buildIdentityContext(senderUserId, authenticatedIdentity);
  const db = getDb();

  // Bind resolver input to authenticated sender identity + connection whenever available.
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
    selectors: selectorContext,
    llmSubject: recipient?.username || "unknown",
    context,
  });
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

// Evaluate policies for group messages (SRV-003 group overlay semantics).
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

/**
 * SRV-022 one-time overrides:
 * Consume one use from the winning policy when it carries lifecycle limits.
 */
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
