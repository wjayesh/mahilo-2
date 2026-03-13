import { describe, expect, it } from "bun:test";

import {
  applyLocalPolicyGuard,
  decisionBlocksSend,
  decisionNeedsReview,
  extractDecision,
  extractResolutionId,
  mergePolicyDecisions,
  normalizeDeclaredSelectors,
  shouldSendForDecision,
  toToolStatus
} from "../src";

describe("policy helpers", () => {
  it("normalizes selectors", () => {
    const selectors = normalizeDeclaredSelectors({
      action: " Share ",
      direction: "outbound",
      resource: "Location Current"
    });

    expect(selectors).toEqual({
      action: "share",
      direction: "outbound",
      resource: "location.current"
    });
  });

  it("falls back to defaults when selectors are missing", () => {
    expect(normalizeDeclaredSelectors(undefined)).toEqual({
      action: "share",
      direction: "outbound",
      resource: "message.general"
    });
    expect(normalizeDeclaredSelectors({}, "inbound")).toEqual({
      action: "notify",
      direction: "inbound",
      resource: "message.general"
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

  it("extracts policy decision from common response shapes", () => {
    expect(extractDecision({ decision: "ask" })).toBe("ask");
    expect(extractDecision({ policy: { decision: "deny" } })).toBe("deny");
    expect(extractDecision({ result: { decision: "allow" } }, "deny")).toBe("allow");
    expect(extractDecision({ nothing: true }, "deny")).toBe("deny");
  });

  it("extracts resolution id from root and nested response shapes", () => {
    expect(extractResolutionId({ resolution_id: "res_1" })).toBe("res_1");
    expect(extractResolutionId({ resolution: { id: "res_2" } })).toBe("res_2");
    expect(extractResolutionId({ result: { resolutionId: "res_3" } })).toBe("res_3");
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
        resource: "location.current"
      }
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
        resource: "message.general"
      }
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
        resource: "message.general"
      }
    });

    expect(result.decision).toBe("allow");
  });
});
