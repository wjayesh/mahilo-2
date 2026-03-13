import { describe, expect, it } from "bun:test";

import {
  buildCallbackSignaturePayload,
  extractWebhookSignatureHeaders,
  generateCallbackSignature,
  verifyWebhookSignature
} from "../src";

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

  it("rejects wrong but well-formed signatures", () => {
    const rawBody = JSON.stringify({ message_id: "msg_1" });
    const timestamp = 1_700_000_000;
    const headers = new Headers({
      "X-Mahilo-Signature": `sha256=${"a".repeat(64)}`,
      "X-Mahilo-Timestamp": String(timestamp)
    });

    const result = verifyWebhookSignature(rawBody, headers, SECRET, {
      maxAgeSeconds: 60,
      nowSeconds: timestamp + 1
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
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

  it("rejects future timestamps outside max age window", () => {
    const rawBody = JSON.stringify({ message_id: "msg_1" });
    const timestamp = 1_700_000_000;
    const signature = generateCallbackSignature(rawBody, SECRET, timestamp);
    const headers = new Headers({
      "X-Mahilo-Signature": `sha256=${signature}`,
      "X-Mahilo-Timestamp": String(timestamp)
    });

    const result = verifyWebhookSignature(rawBody, headers, SECRET, {
      maxAgeSeconds: 60,
      nowSeconds: timestamp - 600
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale_timestamp");
  });

  it("returns invalid_timestamp for bad verification settings", () => {
    const rawBody = JSON.stringify({ message_id: "msg_1" });
    const timestamp = 1_700_000_000;
    const signature = generateCallbackSignature(rawBody, SECRET, timestamp);
    const headers = new Headers({
      "X-Mahilo-Signature": `sha256=${signature}`,
      "X-Mahilo-Timestamp": String(timestamp)
    });

    const result = verifyWebhookSignature(rawBody, headers, SECRET, {
      maxAgeSeconds: -1,
      nowSeconds: timestamp + 1
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_timestamp");
  });

  it("uses exact raw body bytes for signature checks", () => {
    const rawBody = '{"message_id":"msg_1","sender":"alice","message":"hello"}';
    const timestamp = 1_700_000_000;
    const signature = generateCallbackSignature(rawBody, SECRET, timestamp);

    const headers = {
      "X-Mahilo-Signature": `sha256=${signature}`,
      "X-Mahilo-Timestamp": String(timestamp)
    };

    const validResult = verifyWebhookSignature(rawBody, headers, SECRET, {
      maxAgeSeconds: 60,
      nowSeconds: timestamp + 1
    });
    expect(validResult.ok).toBe(true);

    const reformattedBody = '{ "message_id": "msg_1", "sender": "alice", "message": "hello" }';
    const invalidResult = verifyWebhookSignature(reformattedBody, headers, SECRET, {
      maxAgeSeconds: 60,
      nowSeconds: timestamp + 1
    });
    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.reason).toBe("invalid_signature");
  });

  it("extracts webhook signature headers from mixed-case records", () => {
    const headers = extractWebhookSignatureHeaders({
      "X-Mahilo-Delivery-Id": "del_123",
      "x-mahilo-group-id": "grp_1",
      "X-Mahilo-Message-Id": "msg_1",
      "X-Mahilo-Signature": "sha256=abcd",
      "X-Mahilo-Timestamp": "1700000000"
    });

    expect(headers).toEqual({
      deliveryId: "del_123",
      groupId: "grp_1",
      messageId: "msg_1",
      signature: "sha256=abcd",
      timestamp: "1700000000"
    });
  });

  it("builds callback signing payload as <timestamp>.<rawBody>", () => {
    expect(buildCallbackSignaturePayload('{"ok":true}', 123)).toBe('123.{"ok":true}');
  });
});
