import { describe, expect, it } from "bun:test";

import { mergePolicyDecisions, normalizeDeclaredSelectors, shouldSendForDecision, toToolStatus } from "../src";

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
});
