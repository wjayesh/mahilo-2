import { describe, expect, it } from "bun:test";

import {
  resolvePolicySet,
  type CorePolicy,
  type LLMPolicyEvaluator,
} from "@mahilo/policy-core";

function createPolicy(overrides: Partial<CorePolicy> & Pick<CorePolicy, "id">): CorePolicy {
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
});
