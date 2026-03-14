import type {
  CorePolicy,
  EvaluatedPolicy,
  PolicyEffect,
  PolicyEvaluationPhase,
  PolicyEvaluationResult,
  PolicyMatch,
} from "./types";

interface HeuristicRules {
  maxLength?: number;
  minLength?: number;
  blockedPatterns?: string[];
  requiredPatterns?: string[];
  requireContext?: boolean;
  trustedRecipients?: string[];
  blockedRecipients?: string[];
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

export function parseRules(
  content: unknown
): { valid: boolean; rules?: HeuristicRules; error?: string } {
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
    if (typeof content !== "string" || content.trim().length === 0) {
      return { valid: false, error: "LLM policy must have a non-empty prompt" };
    }
    return { valid: true };
  }

  return { valid: false, error: `Unknown policy evaluator: ${evaluator}` };
}

export function evaluateHeuristicPolicyMatch(
  rules: HeuristicRules,
  message: string,
  context?: string,
  recipientUsername?: string
): { matched: boolean; reason?: string } {
  if (rules.maxLength !== undefined && message.length > rules.maxLength) {
    return { matched: true, reason: `Message exceeds maximum length of ${rules.maxLength}` };
  }

  if (rules.minLength !== undefined && message.length < rules.minLength) {
    return {
      matched: true,
      reason: `Message is shorter than minimum length of ${rules.minLength}`,
    };
  }

  if (rules.blockedPatterns) {
    for (const pattern of rules.blockedPatterns) {
      const regex = new RegExp(pattern, "i");
      if (regex.test(message)) {
        return { matched: true, reason: "Message contains blocked pattern" };
      }
    }
  }

  if (rules.requiredPatterns) {
    for (const pattern of rules.requiredPatterns) {
      const regex = new RegExp(pattern, "i");
      if (!regex.test(message)) {
        return { matched: true, reason: "Message missing required pattern" };
      }
    }
  }

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

  if (!hasConstraintRules(rules)) {
    return { matched: true, reason: "Policy has no constraints and applies to all messages" };
  }

  return { matched: false };
}

export function buildEvaluatedPolicy(
  policy: CorePolicy,
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
    learning_provenance: policy.learning_provenance || null,
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

export function toPolicyMatch(
  policy: CorePolicy,
  ownerUserId: string,
  reason: string,
  phase: PolicyEvaluationPhase,
  overrides: {
    effect?: PolicyEffect;
    reason_code?: string;
  } = {}
): PolicyMatch {
  return {
    policy_id: policy.id,
    scope: policy.scope,
    evaluator: policy.evaluator,
    effect: overrides.effect ?? policy.effect,
    created_by_user_id: ownerUserId,
    source: policy.source,
    derived_from_message_id: policy.derived_from_message_id,
    learning_provenance: policy.learning_provenance || null,
    effective_from: policy.effective_from,
    expires_at: policy.expires_at,
    max_uses: policy.max_uses,
    remaining_uses: policy.remaining_uses,
    created_at: policy.created_at,
    reason,
    priority: policy.priority,
    phase,
    reason_code: overrides.reason_code,
  };
}

export async function evaluateDeterministicPolicyMatch(
  ownerUserId: string,
  policy: CorePolicy,
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
