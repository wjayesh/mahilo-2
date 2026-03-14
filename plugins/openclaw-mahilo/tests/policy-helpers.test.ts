import { describe, expect, it } from "bun:test";

import {
  applyLocalPolicyGuard,
  decisionBlocksSend,
  decisionNeedsReview,
  extractDecision,
  extractResolutionId,
  mergePolicyDecisions,
  normalizeDeclaredSelectors,
  resolveLocalPolicySet,
  shouldSendForDecision,
  toToolStatus,
} from "../src";
import type { CorePolicy, LLMPolicyEvaluator } from "@mahilo/policy-core";

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

describe("policy helpers", () => {
  it("normalizes selectors", () => {
    const selectors = normalizeDeclaredSelectors({
      action: " Share ",
      direction: "outbound",
      resource: "Location Current",
    });

    expect(selectors).toEqual({
      action: "share",
      direction: "outbound",
      resource: "location.current",
    });
  });

  it("falls back to defaults when selectors are missing", () => {
    expect(normalizeDeclaredSelectors(undefined)).toEqual({
      action: "share",
      direction: "outbound",
      resource: "message.general",
    });
    expect(normalizeDeclaredSelectors({}, "inbound")).toEqual({
      action: "notify",
      direction: "inbound",
      resource: "message.general",
    });
  });

  it("preserves request directions and treats them as inbound-like for defaults", () => {
    expect(
      normalizeDeclaredSelectors({
        direction: "request",
      }),
    ).toEqual({
      action: "notify",
      direction: "request",
      resource: "message.general",
    });
  });

  it("keeps the strictest decision when merging", () => {
    expect(mergePolicyDecisions("allow", "ask")).toBe("ask");
    expect(mergePolicyDecisions("allow", "deny", "ask")).toBe("deny");
  });

  it("maps decisions to send behavior", () => {
    expect(shouldSendForDecision("allow", "ask")).toBe(true);
    expect(shouldSendForDecision("ask", "ask")).toBe(false);
    expect(shouldSendForDecision("ask", "auto")).toBe(true);
    expect(toToolStatus("deny", "auto")).toBe("denied");
  });

  it("can resolve a supplied policy set through the shared core", async () => {
    const result = await resolveLocalPolicySet({
      policies: [
        createPolicy({
          id: "pol_user_allow",
          scope: "user",
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
      recipientUsername: "alice",
      llmSubject: "group:grp_team",
    });

    expect(result.effect).toBe("deny");
    expect(result.reason_code).toBe("policy.deny.group.structured");
    expect(result.winning_policy_id).toBe("pol_group_deny");
  });

  it("forwards an injected llm evaluator so plugin adapters can be supplied later", async () => {
    const llmEvaluator: LLMPolicyEvaluator = async () => ({
      status: "match",
      reasoning: "Provider adapter flagged this message",
    });

    const result = await resolveLocalPolicySet({
      policies: [
        createPolicy({
          id: "pol_llm_deny",
          scope: "global",
          effect: "deny",
          evaluator: "llm",
          policy_content: "Never share secrets",
        }),
      ],
      ownerUserId: "usr_owner",
      message: "The password is hunter2",
      recipientUsername: "alice",
      llmSubject: "alice",
      llmEvaluator,
      llmErrorMode: "ask",
      llmUnavailableMode: "ask",
    });

    expect(result.effect).toBe("deny");
    expect(result.reason_code).toBe("policy.deny.global.llm");
    expect(result.winning_policy?.reason).toBe(
      "Provider adapter flagged this message",
    );
  });

  it("extracts policy decision from common response shapes", () => {
    expect(extractDecision({ decision: "ask" })).toBe("ask");
    expect(extractDecision({ policy: { decision: "deny" } })).toBe("deny");
    expect(extractDecision({ result: { decision: "allow" } }, "deny")).toBe(
      "allow",
    );
    expect(extractDecision({ nothing: true }, "deny")).toBe("deny");
  });

  it("extracts resolution id from root and nested response shapes", () => {
    expect(extractResolutionId({ resolution_id: "res_1" })).toBe("res_1");
    expect(extractResolutionId({ resolution: { id: "res_2" } })).toBe("res_2");
    expect(extractResolutionId({ result: { resolutionId: "res_3" } })).toBe(
      "res_3",
    );
    expect(extractResolutionId({})).toBeUndefined();
  });

  it("flags review and block semantics by decision", () => {
    expect(decisionNeedsReview("ask")).toBe(true);
    expect(decisionNeedsReview("allow")).toBe(false);
    expect(decisionBlocksSend("deny")).toBe(true);
    expect(decisionBlocksSend("ask")).toBe(false);
  });

  it("applies local policy guard for risky sensitive messages", () => {
    const result = applyLocalPolicyGuard({
      message: "My SSN is 123-45-6789",
      selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current",
      },
    });

    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("sensitive resource");
  });

  it("asks for review when message body is empty", () => {
    const result = applyLocalPolicyGuard({
      message: "   ",
      selectors: {
        action: "share",
        direction: "outbound",
        resource: "message.general",
      },
    });

    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("empty");
  });

  it("allows safe messages through local policy guard", () => {
    const result = applyLocalPolicyGuard({
      message: "hello",
      selectors: {
        action: "share",
        direction: "outbound",
        resource: "message.general",
      },
    });

    expect(result.decision).toBe("allow");
  });
});
