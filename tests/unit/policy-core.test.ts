import { describe, expect, it } from "bun:test";

import {
  filterPolicyCandidatesBySelectors,
  normalizePartialSelectorContext,
  normalizeSelectorContext,
  resolveMatchedPolicySet,
  resolvePolicySet,
  selectorDirectionsEquivalent,
  toPolicyMatch,
  type CorePolicy,
  type LLMPolicyEvaluator,
} from "@mahilo/policy-core";

function createPolicy(
  overrides: Partial<CorePolicy> & Pick<CorePolicy, "id">,
): CorePolicy {
  return {
    id: overrides.id,
    scope: overrides.scope ?? "global",
    effect: overrides.effect ?? "deny",
    evaluator: overrides.evaluator ?? "structured",
    policy_content: overrides.policy_content ?? {},
    effective_from: overrides.effective_from ?? null,
    expires_at: overrides.expires_at ?? null,
    max_uses: overrides.max_uses ?? null,
    remaining_uses: overrides.remaining_uses ?? null,
    source: overrides.source ?? "user_created",
    derived_from_message_id: overrides.derived_from_message_id ?? null,
    learning_provenance: overrides.learning_provenance ?? null,
    priority: overrides.priority ?? 1,
    created_at: overrides.created_at ?? null,
  };
}

describe("policy core resolver", () => {
  it("returns allow when no policies apply", async () => {
    const result = await resolvePolicySet({
      policies: [],
      ownerUserId: "usr_owner",
      message: "hello",
      llmSubject: "alice",
    });

    expect(result.effect).toBe("allow");
    expect(result.reason_code).toBe("policy.allow.no_applicable");
    expect(result.evaluated_policies).toHaveLength(0);
  });

  it("returns allow with no-match when applicable deterministic policies do not match", async () => {
    const result = await resolvePolicySet({
      policies: [
        createPolicy({
          id: "pol_max_length",
          effect: "deny",
          policy_content: {
            maxLength: 100,
          },
        }),
      ],
      ownerUserId: "usr_owner",
      message: "hello",
      llmSubject: "alice",
    });

    expect(result.effect).toBe("allow");
    expect(result.reason_code).toBe("policy.allow.no_match");
    expect(result.evaluated_policies[0]?.matched).toBe(false);
  });

  it("prefers user scope over global scope", async () => {
    const result = await resolvePolicySet({
      policies: [
        createPolicy({
          id: "pol_global",
          scope: "global",
          effect: "deny",
          priority: 100,
        }),
        createPolicy({
          id: "pol_user",
          scope: "user",
          effect: "ask",
          priority: 1,
        }),
      ],
      ownerUserId: "usr_owner",
      message: "hello",
      llmSubject: "alice",
    });

    expect(result.effect).toBe("ask");
    expect(result.reason_code).toBe("policy.ask.user.structured");
    expect(result.winning_policy_id).toBe("pol_user");
  });

  it("prefers deny over allow within the same scope regardless of priority", async () => {
    const result = await resolvePolicySet({
      policies: [
        createPolicy({
          id: "pol_user_allow",
          scope: "user",
          effect: "allow",
          priority: 999,
        }),
        createPolicy({
          id: "pol_user_deny",
          scope: "user",
          effect: "deny",
          priority: 1,
        }),
      ],
      ownerUserId: "usr_owner",
      message: "hello",
      llmSubject: "alice",
    });

    expect(result.effect).toBe("deny");
    expect(result.reason_code).toBe("policy.deny.user.structured");
    expect(result.winning_policy_id).toBe("pol_user_deny");
    expect(result.resolution_explanation).toContain("deny > ask > allow");
  });

  it("resolves pre-matched policies with specificity and group overlays", () => {
    const result = resolveMatchedPolicySet([
      toPolicyMatch(
        createPolicy({
          id: "pol_global",
          scope: "global",
          effect: "allow",
        }),
        "usr_owner",
        "Applicable in current context",
        "deterministic",
      ),
      toPolicyMatch(
        createPolicy({
          id: "pol_user",
          scope: "user",
          effect: "ask",
        }),
        "usr_owner",
        "Applicable in current context",
        "deterministic",
      ),
      toPolicyMatch(
        createPolicy({
          id: "pol_group",
          scope: "group",
          effect: "deny",
        }),
        "usr_owner",
        "Applicable in current context",
        "deterministic",
      ),
    ]);

    expect(result.base_resolution?.scope).toBe("user");
    expect(result.base_resolution?.effect).toBe("ask");
    expect(result.group_resolution?.effect).toBe("deny");
    expect(result.final_effect).toBe("deny");
    expect(result.winning_match?.policy_id).toBe("pol_group");
  });

  it("applies group overlay as an additional constraint", async () => {
    const result = await resolvePolicySet({
      policies: [
        createPolicy({
          id: "pol_global_allow",
          scope: "global",
          effect: "allow",
        }),
        createPolicy({
          id: "pol_group_deny",
          scope: "group",
          effect: "deny",
        }),
      ],
      ownerUserId: "usr_owner",
      message: "hello",
      llmSubject: "group:grp_team",
    });

    expect(result.effect).toBe("deny");
    expect(result.reason_code).toBe("policy.deny.group.structured");
    expect(result.winning_policy_id).toBe("pol_group_deny");
  });

  it("can degrade missing llm evaluation to ask", async () => {
    const result = await resolvePolicySet({
      policies: [
        createPolicy({
          id: "pol_llm",
          scope: "global",
          effect: "deny",
          evaluator: "llm",
          policy_content: "Never share secrets",
        }),
      ],
      ownerUserId: "usr_owner",
      message: "hello",
      llmSubject: "alice",
      llmUnavailableMode: "ask",
    });

    expect(result.effect).toBe("ask");
    expect(result.reason_code).toBe("policy.ask.llm.unavailable");
    expect(result.winning_policy_id).toBe("pol_llm");
    expect(result.evaluated_policies[0]?.matched).toBe(true);
  });

  it("maps normalized llm error kinds to explicit ask reason codes", async () => {
    const evaluator: LLMPolicyEvaluator = async () => ({
      status: "error",
      error: "socket hang up",
      error_kind: "network",
    });

    const result = await resolvePolicySet({
      policies: [
        createPolicy({
          id: "pol_llm",
          scope: "global",
          effect: "deny",
          evaluator: "llm",
          policy_content: "Never share secrets",
        }),
      ],
      ownerUserId: "usr_owner",
      message: "hello",
      llmSubject: "alice",
      llmEvaluator: evaluator,
      llmErrorMode: "ask",
    });

    expect(result.effect).toBe("ask");
    expect(result.reason_code).toBe("policy.ask.llm.network");
    expect(result.winning_policy_id).toBe("pol_llm");
    expect(result.winning_policy?.reason).toContain("socket hang up");
  });

  it("can degrade skipped llm evaluation to ask with an explicit skip code", async () => {
    const evaluator: LLMPolicyEvaluator = async () => ({
      status: "skip",
      skip_reason: "Classifier confidence too low",
    });

    const result = await resolvePolicySet({
      policies: [
        createPolicy({
          id: "pol_llm",
          scope: "global",
          effect: "deny",
          evaluator: "llm",
          policy_content: "Never share secrets",
        }),
      ],
      ownerUserId: "usr_owner",
      message: "hello",
      llmSubject: "alice",
      llmEvaluator: evaluator,
      llmSkipMode: "ask",
    });

    expect(result.effect).toBe("ask");
    expect(result.reason_code).toBe("policy.ask.llm.skip");
    expect(result.winning_policy_id).toBe("pol_llm");
    expect(result.winning_policy?.reason).toContain(
      "Classifier confidence too low",
    );
  });

  it("uses an injected llm evaluator when available", async () => {
    const evaluator: LLMPolicyEvaluator = async () => ({
      status: "match",
      reasoning: "LLM matched the policy",
    });

    const result = await resolvePolicySet({
      policies: [
        createPolicy({
          id: "pol_llm",
          scope: "global",
          effect: "deny",
          evaluator: "llm",
          policy_content: "Never share secrets",
        }),
      ],
      ownerUserId: "usr_owner",
      message: "hello",
      llmSubject: "alice",
      llmEvaluator: evaluator,
    });

    expect(result.effect).toBe("deny");
    expect(result.reason_code).toBe("policy.deny.global.llm");
    expect(result.winning_policy_id).toBe("pol_llm");
    expect(result.winning_policy?.reason).toBe("LLM matched the policy");
  });

  it("normalizes selector contexts with canonical token folding", () => {
    expect(
      normalizeSelectorContext(
        {
          action: " Request ",
          direction: " request ",
          resource: "Message General",
        },
        {
          fallbackAction: "share",
          fallbackDirection: "outbound",
          fallbackResource: "message.general",
          normalizeSeparators: true,
        },
      ),
    ).toEqual({
      action: "request",
      direction: "request",
      resource: "message.general",
    });
  });

  it("normalizes partial selectors without inventing missing fields", () => {
    expect(
      normalizePartialSelectorContext(
        {
          direction: " inbound ",
          resource: "Location Current",
        },
        {
          normalizeSeparators: true,
        },
      ),
    ).toEqual({
      direction: "inbound",
      resource: "location.current",
    });
  });

  it("treats inbound and request as equivalent directions", () => {
    expect(selectorDirectionsEquivalent("inbound", "request")).toBe(true);
    expect(selectorDirectionsEquivalent("request", "inbound")).toBe(true);
    expect(selectorDirectionsEquivalent("outbound", "request")).toBe(false);
  });

  it("filters selector candidates with request aliases and wildcard fields", () => {
    const matchingIds = filterPolicyCandidatesBySelectors(
      [
        {
          action: "request",
          direction: "inbound",
          id: "pol_inbound_alias",
          resource: "message.general",
        },
        {
          action: "request",
          direction: "request",
          id: "pol_request_exact",
          resource: "message.general",
        },
        {
          action: null,
          direction: "request",
          id: "pol_any_action",
          resource: "message.general",
        },
        {
          action: "request",
          direction: "request",
          id: "pol_any_resource",
          resource: null,
        },
        {
          action: "request",
          direction: null,
          id: "pol_any_direction",
          resource: "message.general",
        },
        {
          action: "request",
          direction: "outbound",
          id: "pol_outbound",
          resource: "message.general",
        },
      ],
      {
        action: " Request ",
        direction: "request",
        resource: " Message.General ",
      },
    ).map((policy) => policy.id);

    expect(matchingIds).toEqual([
      "pol_inbound_alias",
      "pol_request_exact",
      "pol_any_action",
      "pol_any_resource",
      "pol_any_direction",
    ]);
  });
});
