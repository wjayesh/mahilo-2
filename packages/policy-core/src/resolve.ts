import {
  EFFECT_PRECEDENCE,
  PHASE_PRECEDENCE,
  SPECIFICITY_ORDER,
  type EvaluatedPolicy,
  type MatchedPolicyResolution,
  type LLMEvaluationFallbackMode,
  type PolicyEffect,
  type PolicyEvaluationResult,
  type PolicyMatch,
  type PolicyResolutionContext,
  type PolicyResolverLayer,
  type PolicyResult,
  type ResolvePolicySetOptions,
  type ScopeResolution,
  type SpecificityScope,
  type WinningPolicy,
} from "./types";
import {
  buildEvaluatedPolicy,
  evaluateDeterministicPolicyMatch,
  toPolicyMatch,
} from "./deterministic";

function formatPolicyIds(policies: EvaluatedPolicy[]): string {
  if (policies.length === 0) {
    return "none";
  }

  return policies.map((policy) => policy.policy_id).join(", ");
}

export function reasonCodeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function buildPolicyReasonCode(
  effect: PolicyEffect,
  winner?: Pick<PolicyMatch, "scope" | "evaluator" | "reason_code">,
  fallback?: "no_applicable" | "no_match",
): string {
  if (winner?.reason_code) {
    return winner.reason_code;
  }
  if (fallback) {
    return `policy.${effect}.${fallback}`;
  }
  if (!winner) {
    return `policy.${effect}.resolved`;
  }
  return `policy.${effect}.${winner.scope}.${winner.evaluator}`;
}

export function comparePolicyMatches(a: PolicyMatch, b: PolicyMatch): number {
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

export function resolveScopeMatches(
  matches: PolicyMatch[],
): ScopeResolution | null {
  if (matches.length === 0) {
    return null;
  }

  const winner = [...matches].sort(comparePolicyMatches)[0]!;
  return {
    effect: winner.effect,
    winner,
  };
}

export function stricterEffect(a: PolicyEffect, b: PolicyEffect): PolicyEffect {
  return EFFECT_PRECEDENCE[a] >= EFFECT_PRECEDENCE[b] ? a : b;
}

export function resolveMatchedPolicySet(
  matches: ReadonlyArray<PolicyMatch>,
): MatchedPolicyResolution {
  const baseMatchesByScope: Record<SpecificityScope, PolicyMatch[]> = {
    user: matches.filter((match) => match.scope === "user"),
    role: matches.filter((match) => match.scope === "role"),
    global: matches.filter((match) => match.scope === "global"),
  };
  const groupMatches = matches.filter((match) => match.scope === "group");

  let baseResolution: (ScopeResolution & { scope: SpecificityScope }) | null =
    null;
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

  return {
    base_resolution: baseResolution,
    group_resolution: groupResolution,
    final_effect: finalEffect,
    winning_match: winner,
  };
}

export function buildResolutionExplanation(
  context: PolicyResolutionContext,
): string {
  const explanation: string[] = [];
  const {
    base_resolution: base,
    group_resolution: group,
    final_effect: finalEffect,
    deterministic_evaluated: deterministicEvaluated,
    llm_evaluated: llmEvaluated,
  } = context;

  const deterministicMatched = deterministicEvaluated.filter(
    (policy) => policy.matched,
  );
  explanation.push(
    `Deterministic phase evaluated ${deterministicEvaluated.length} policy/policies (matched: ${formatPolicyIds(deterministicMatched)}).`,
  );

  const llmMatched = llmEvaluated.filter((policy) => policy.matched);
  const llmSkipped = llmEvaluated.filter((policy) => policy.skipped);
  explanation.push(
    `Contextual LLM phase evaluated ${llmEvaluated.length} policy/policies (matched: ${formatPolicyIds(llmMatched)}; skipped: ${formatPolicyIds(llmSkipped)}).`,
  );

  if (base) {
    explanation.push(
      `Base specificity resolved from '${base.scope}' scope with effect '${base.effect}' via policy ${base.winner.policy_id}.`,
    );
  } else {
    explanation.push("No matching base policy in user/role/global scopes.");
  }

  if (group) {
    explanation.push(
      `Group overlay resolved to '${group.effect}' via policy ${group.winner.policy_id} and applied as additional constraint.`,
    );
  } else {
    explanation.push("No matching group overlay policy.");
  }

  explanation.push(
    "Same-level conflicts use deterministic precedence deny > ask > allow.",
  );
  explanation.push(`Final effect: '${finalEffect}'.`);
  explanation.push(
    `Matched policies: ${
      context.all_matches.length > 0
        ? context.all_matches.map((match) => match.policy_id).join(", ")
        : "none"
    }.`,
  );

  return explanation.join(" ");
}

export function toResult(
  effect: PolicyEffect,
  options: {
    reason?: string;
    reason_code?: string;
    explanation: string;
    authenticated_identity?: ResolvePolicySetOptions["authenticatedIdentity"];
    winning_policy_id?: string;
    winning_policy?: WinningPolicy;
    resolver_layer: PolicyResolverLayer;
    guardrail_id?: string;
    matched_policy_ids?: string[];
    evaluated_policies?: EvaluatedPolicy[];
  },
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

function toWinningPolicy(match: PolicyMatch): WinningPolicy {
  return {
    policy_id: match.policy_id,
    scope: match.scope,
    evaluator: match.evaluator,
    effect: match.effect,
    created_by_user_id: match.created_by_user_id,
    source: match.source,
    derived_from_message_id: match.derived_from_message_id,
    learning_provenance: match.learning_provenance,
    effective_from: match.effective_from,
    expires_at: match.expires_at,
    max_uses: match.max_uses,
    remaining_uses: match.remaining_uses,
    created_at: match.created_at,
    priority: match.priority,
    phase: match.phase,
    reason: match.reason,
    reason_code: match.reason_code,
  };
}

function normalizeLLMPolicyContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function buildLLMFallbackResult(
  ownerUserId: string,
  policy: ResolvePolicySetOptions["policies"][number],
  mode: LLMEvaluationFallbackMode,
  kind: "error" | "unavailable",
  errorMessage?: string,
): PolicyEvaluationResult {
  const detail = errorMessage ? `: ${errorMessage}` : "";
  const fallbackReason =
    kind === "unavailable"
      ? `LLM evaluator unavailable for policy ${policy.id}${detail}`
      : `LLM evaluation failed for policy ${policy.id}${detail}`;

  if (mode === "skip") {
    return {
      evaluated_policy: buildEvaluatedPolicy(
        policy,
        ownerUserId,
        "contextual_llm",
        {
          matched: false,
          skipped: true,
          skip_reason: fallbackReason,
        },
      ),
      match: null,
    };
  }

  return {
    evaluated_policy: buildEvaluatedPolicy(
      policy,
      ownerUserId,
      "contextual_llm",
      {
        matched: true,
        reason: fallbackReason,
      },
    ),
    match: toPolicyMatch(
      policy,
      ownerUserId,
      fallbackReason,
      "contextual_llm",
      {
        effect: mode,
        reason_code: `policy.${mode}.llm.${kind}`,
      },
    ),
  };
}

async function evaluateContextualPolicyMatch(
  ownerUserId: string,
  policy: ResolvePolicySetOptions["policies"][number],
  message: string,
  llmSubject: string,
  context: string | undefined,
  llmEvaluator: ResolvePolicySetOptions["llmEvaluator"],
  llmUnavailableMode: LLMEvaluationFallbackMode,
  llmErrorMode: LLMEvaluationFallbackMode,
): Promise<PolicyEvaluationResult> {
  if (!llmEvaluator) {
    return buildLLMFallbackResult(
      ownerUserId,
      policy,
      llmUnavailableMode,
      "unavailable",
    );
  }

  try {
    const llmResult = await llmEvaluator({
      policyContent: normalizeLLMPolicyContent(policy.policy_content),
      message,
      subject: llmSubject,
      context,
    });

    if (llmResult.status === "pass") {
      return {
        evaluated_policy: buildEvaluatedPolicy(
          policy,
          ownerUserId,
          "contextual_llm",
          {
            matched: false,
            reason: llmResult.reasoning || "LLM policy passed",
          },
        ),
        match: null,
      };
    }

    if (llmResult.status === "match") {
      const matchReason =
        llmResult.reasoning || "Message blocked by LLM policy";
      return {
        evaluated_policy: buildEvaluatedPolicy(
          policy,
          ownerUserId,
          "contextual_llm",
          {
            matched: true,
            reason: matchReason,
          },
        ),
        match: toPolicyMatch(
          policy,
          ownerUserId,
          matchReason,
          "contextual_llm",
        ),
      };
    }

    if (llmResult.status === "skip") {
      return {
        evaluated_policy: buildEvaluatedPolicy(
          policy,
          ownerUserId,
          "contextual_llm",
          {
            matched: false,
            skipped: true,
            skip_reason:
              llmResult.skip_reason || "Contextual LLM evaluation skipped",
          },
        ),
        match: null,
      };
    }

    return buildLLMFallbackResult(
      ownerUserId,
      policy,
      llmErrorMode,
      "error",
      llmResult.error || llmResult.reasoning,
    );
  } catch (error) {
    return buildLLMFallbackResult(
      ownerUserId,
      policy,
      llmErrorMode,
      "error",
      error instanceof Error ? error.message : undefined,
    );
  }
}

export async function resolvePolicySet(
  options: ResolvePolicySetOptions,
): Promise<PolicyResult> {
  if (options.policies.length === 0) {
    return toResult("allow", {
      explanation: "No applicable policies matched. Final effect: 'allow'.",
      reason_code: buildPolicyReasonCode("allow", undefined, "no_applicable"),
      authenticated_identity: options.authenticatedIdentity,
      resolver_layer: options.resolverLayer ?? "user_policies",
    });
  }

  const allMatches: PolicyMatch[] = [];
  const evaluatedPolicies: EvaluatedPolicy[] = [];
  const deterministicEvaluated: EvaluatedPolicy[] = [];
  const llmEvaluated: EvaluatedPolicy[] = [];

  const deterministicPolicies = options.policies.filter(
    (policy) =>
      policy.evaluator === "heuristic" || policy.evaluator === "structured",
  );
  for (const policy of deterministicPolicies) {
    const result = await evaluateDeterministicPolicyMatch(
      options.ownerUserId,
      policy,
      options.message,
      options.context,
      options.recipientUsername,
    );
    deterministicEvaluated.push(result.evaluated_policy);
    evaluatedPolicies.push(result.evaluated_policy);
    if (result.match) {
      allMatches.push(result.match);
    }
  }

  const llmPolicies = options.policies.filter(
    (policy) => policy.evaluator === "llm",
  );
  for (const policy of llmPolicies) {
    const result = await evaluateContextualPolicyMatch(
      options.ownerUserId,
      policy,
      options.message,
      options.llmSubject,
      options.context,
      options.llmEvaluator,
      options.llmUnavailableMode ?? "skip",
      options.llmErrorMode ?? "skip",
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
      resolver_layer: options.resolverLayer ?? "user_policies",
      matched_policy_ids: [],
      evaluated_policies: evaluatedPolicies,
    });
  }

  const matchedResolution = resolveMatchedPolicySet(allMatches);
  const finalEffect = matchedResolution.final_effect;
  const winner = matchedResolution.winning_match;

  const explanation = buildResolutionExplanation({
    all_matches: allMatches,
    deterministic_evaluated: deterministicEvaluated,
    llm_evaluated: llmEvaluated,
    base_resolution: matchedResolution.base_resolution,
    group_resolution: matchedResolution.group_resolution,
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
    resolver_layer: options.resolverLayer ?? "user_policies",
    winning_policy_id: winner?.policy_id,
    winning_policy: winner ? toWinningPolicy(winner) : undefined,
    matched_policy_ids: allMatches.map((match) => match.policy_id),
    evaluated_policies: evaluatedPolicies,
  });
}
