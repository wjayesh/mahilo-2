import { describe, expect, it } from "bun:test";

import { generateCallbackSignature, verifyWebhookSignature } from "../src";

const SECRET = "callback-secret";

describe("webhook signature helpers", () => {
  it("verifies a valid signature", () => {
    const rawBody = JSON.stringify({ message_id: "msg_1" });
    const timestamp = 1_700_000_000;
    const signature = generateCallbackSignature(rawBody, SECRET, timestamp);

    const headers = new Headers({
      "X-Mahilo-Signature": `sha256=${signature}`,
      "X-Mahilo-Timestamp": String(timestamp)
    });

    const result = verifyWebhookSignature(rawBody, headers, SECRET, {
      maxAgeSeconds: 60,
      nowSeconds: timestamp + 1
    });

    expect(result.ok).toBe(true);
    expect(result.timestamp).toBe(timestamp);
  });

  it("rejects invalid signatures", () => {
    const rawBody = JSON.stringify({ message_id: "msg_1" });
    const timestamp = 1_700_000_000;
    const headers = new Headers({
      "X-Mahilo-Signature": "sha256=deadbeef",
      "X-Mahilo-Timestamp": String(timestamp)
    });

    const result = verifyWebhookSignature(rawBody, headers, SECRET, {
      maxAgeSeconds: 60,
      nowSeconds: timestamp + 1
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_headers");
  });

  it("rejects stale timestamps", () => {
    const rawBody = JSON.stringify({ message_id: "msg_1" });
    const timestamp = 1_700_000_000;
    const signature = generateCallbackSignature(rawBody, SECRET, timestamp);
    const headers = new Headers({
      "X-Mahilo-Signature": `sha256=${signature}`,
      "X-Mahilo-Timestamp": String(timestamp)
    });

    const result = verifyWebhookSignature(rawBody, headers, SECRET, {
      maxAgeSeconds: 60,
      nowSeconds: timestamp + 600
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale_timestamp");
  });
});
