import { eq, and, or, desc, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { getRolesForFriend } from "./roles";
import { evaluateLLMPolicy, isLLMEnabled } from "./llm";
import { config } from "../config";
import {
  dbPolicyToCanonical,
  type CanonicalPolicy,
  type PolicyEffect,
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

interface PolicyMatch {
  policy_id: string;
  scope: PolicyScope;
  effect: PolicyEffect;
  reason: string;
  priority: number;
}

interface ScopeResolution {
  effect: PolicyEffect;
  winner: PolicyMatch;
}

type SpecificityScope = "user" | "role" | "global";

interface PolicyResolutionContext {
  all_matches: PolicyMatch[];
  base_resolution: (ScopeResolution & { scope: SpecificityScope }) | null;
  group_resolution: ScopeResolution | null;
  final_effect: PolicyEffect;
}

export interface PolicyResult {
  allowed: boolean;
  effect: PolicyEffect;
  reason?: string;
  resolution_explanation: string;
  resolver_layer?: PolicyResolverLayer;
  guardrail_id?: string;
  winning_policy_id?: string;
  matched_policy_ids: string[];
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

function buildResolutionExplanation(context: PolicyResolutionContext): string {
  const explanation: string[] = [];
  const { base_resolution: base, group_resolution: group, final_effect: finalEffect } = context;

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
    explanation: string;
    winning_policy_id?: string;
    resolver_layer: PolicyResolverLayer;
    guardrail_id?: string;
    matched_policy_ids?: string[];
  }
): PolicyResult {
  return {
    allowed: effect === "allow",
    effect,
    reason: options.reason,
    resolution_explanation: options.explanation,
    resolver_layer: options.resolver_layer,
    guardrail_id: options.guardrail_id,
    winning_policy_id: options.winning_policy_id,
    matched_policy_ids: options.matched_policy_ids ?? [],
  };
}

async function loadApplicablePolicies(
  senderUserId: string,
  recipientUserId?: string,
  recipientRoles: string[] = [],
  groupId?: string
): Promise<CanonicalPolicy[]> {
  const db = getDb();
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

  const policies = await db
    .select()
    .from(schema.policies)
    .where(
      and(
        eq(schema.policies.userId, senderUserId),
        eq(schema.policies.enabled, true),
        or(...policyConditions)
      )
    )
    .orderBy(desc(schema.policies.priority));

  return policies.map((policy) => dbPolicyToCanonical(policy));
}

async function evaluatePolicyMatch(
  policy: CanonicalPolicy,
  message: string,
  llmSubject: string,
  context?: string,
  recipientUsername?: string
): Promise<PolicyMatch | null> {
  if (policy.evaluator === "heuristic" || policy.evaluator === "structured") {
    try {
      const parsed = parseRules(policy.policy_content);
      if (!parsed.valid) {
        return null;
      }

      const match = evaluateHeuristicPolicyMatch(
        parsed.rules!,
        message,
        context,
        recipientUsername
      );
      if (!match.matched) {
        return null;
      }

      return {
        policy_id: policy.id,
        scope: policy.scope,
        effect: policy.effect,
        reason: match.reason || "Message matched policy conditions",
        priority: policy.priority,
      };
    } catch (e) {
      console.error(`Error evaluating policy ${policy.id}:`, e);
      return null;
    }
  }

  if (config.trustedMode && isLLMEnabled()) {
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
        return null;
      }

      return {
        policy_id: policy.id,
        scope: policy.scope,
        effect: policy.effect,
        reason: llmResult.reasoning || "Message blocked by LLM policy",
        priority: policy.priority,
      };
    } catch (e) {
      console.error(`Error evaluating LLM policy ${policy.id}:`, e);
      return null;
    }
  }

  console.log(
    `Skipping LLM policy ${policy.id} (trustedMode=${config.trustedMode}, llmEnabled=${isLLMEnabled()})`
  );
  return null;
}

async function resolveUserPolicyLayer(
  senderUserId: string,
  message: string,
  options: {
    recipientUserId?: string;
    recipientUsername?: string;
    recipientRoles?: string[];
    groupId?: string;
    llmSubject: string;
    context?: string;
  }
): Promise<PolicyResult> {
  const applicablePolicies = await loadApplicablePolicies(
    senderUserId,
    options.recipientUserId,
    options.recipientRoles || [],
    options.groupId
  );

  if (applicablePolicies.length === 0) {
    return toResult("allow", {
      explanation: "No applicable policies matched. Final effect: 'allow'.",
      resolver_layer: "user_policies",
    });
  }

  const allMatches: PolicyMatch[] = [];
  for (const policy of applicablePolicies) {
    const match = await evaluatePolicyMatch(
      policy,
      message,
      options.llmSubject,
      options.context,
      options.recipientUsername
    );
    if (match) {
      allMatches.push(match);
    }
  }

  if (allMatches.length === 0) {
    return toResult("allow", {
      explanation:
        "Applicable policies were evaluated but none matched current message conditions. Final effect: 'allow'.",
      resolver_layer: "user_policies",
      matched_policy_ids: [],
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
    explanation,
    resolver_layer: "user_policies",
    winning_policy_id: winner?.policy_id,
    matched_policy_ids: allMatches.map((m) => m.policy_id),
  });
}

export async function evaluatePolicies(
  senderUserId: string,
  recipientUserId: string,
  message: string,
  context?: string
): Promise<PolicyResult> {
  const guardrailResult = evaluatePlatformGuardrails(message);
  if (guardrailResult.blocked) {
    return toResult("deny", {
      reason: guardrailResult.reason,
      explanation:
        "Platform guardrail matched before user policy evaluation. Final effect: 'deny'.",
      resolver_layer: "platform_guardrails",
      guardrail_id: guardrailResult.guardrail_id,
      matched_policy_ids: [],
    });
  }

  const db = getDb();
  const recipientRoles = await getRolesForFriend(senderUserId, recipientUserId);
  const [recipient] = await db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, recipientUserId))
    .limit(1);

  return resolveUserPolicyLayer(senderUserId, message, {
    recipientUserId,
    recipientUsername: recipient?.username,
    recipientRoles,
    llmSubject: recipient?.username || "unknown",
    context,
  });
}

// Evaluate policies for group messages (SRV-003 group overlay semantics).
export async function evaluateGroupPolicies(
  senderUserId: string,
  groupId: string,
  message: string,
  context?: string
): Promise<PolicyResult> {
  const guardrailResult = evaluatePlatformGuardrails(message);
  if (guardrailResult.blocked) {
    return toResult("deny", {
      reason: guardrailResult.reason,
      explanation:
        "Platform guardrail matched before user policy evaluation. Final effect: 'deny'.",
      resolver_layer: "platform_guardrails",
      guardrail_id: guardrailResult.guardrail_id,
      matched_policy_ids: [],
    });
  }

  return resolveUserPolicyLayer(senderUserId, message, {
    groupId,
    llmSubject: `group:${groupId}`,
    context,
  });
}
