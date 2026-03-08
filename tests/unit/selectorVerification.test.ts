import { describe, expect, it } from "bun:test";
import {
  buildSelectorVerificationAudit,
  verifySelectorsAgainstClassification,
} from "../../src/services/selectorVerification";

describe("selector verification hooks (SRV-033)", () => {
  it("detects high-signal selector mismatches", () => {
    const result = verifySelectorsAgainstClassification({
      declaredSelectors: {
        direction: "outbound",
        resource: "profile.basic",
        action: "share",
      },
      message: "Can you share your calendar availability tomorrow?",
      context: "Need this for scheduling",
      payloadType: "text/plain",
    });

    expect(result.classification_status).toBe("classified");
    expect(result.mismatch).toBe(true);
    expect(result.mismatch_fields).toEqual(["direction", "resource", "action"]);
    expect(result.classified_selectors).toEqual({
      direction: "request",
      resource: "calendar.availability",
      action: "request",
    });
    expect(buildSelectorVerificationAudit(result)).toEqual(
      expect.objectContaining({
        mismatch: true,
        mismatch_fields: ["direction", "resource", "action"],
      })
    );
  });

  it("skips classification for encrypted payloads", () => {
    const result = verifySelectorsAgainstClassification({
      declaredSelectors: {
        direction: "outbound",
        resource: "message.general",
        action: "share",
      },
      message: "ciphertext payload",
      payloadType: "application/mahilo+ciphertext",
    });

    expect(result.classification_status).toBe("skipped_encrypted");
    expect(result.mismatch).toBe(false);
    expect(result.classified_selectors).toBeNull();
  });
});
