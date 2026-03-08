import { describe, expect, it } from "bun:test";

import { generateCallbackSignature, InMemoryDedupeState, processWebhookDelivery } from "../src";

const CALLBACK_SECRET = "callback-secret";

function buildPayload() {
  return {
    message: "hello",
    message_id: "msg_123",
    recipient_connection_id: "conn_local",
    sender: "alice",
    sender_agent: "openclaw",
    timestamp: "2026-03-08T12:15:00.000Z"
  };
}

describe("processWebhookDelivery", () => {
  it("accepts valid callback payloads", () => {
    const payload = buildPayload();
    const rawBody = JSON.stringify(payload);
    const timestamp = 1_700_000_000;
    const signature = generateCallbackSignature(rawBody, CALLBACK_SECRET, timestamp);

    const result = processWebhookDelivery(
      {
        headers: new Headers({
          "X-Mahilo-Message-Id": payload.message_id,
          "X-Mahilo-Signature": `sha256=${signature}`,
          "X-Mahilo-Timestamp": String(timestamp)
        }),
        rawBody
      },
      {
        callbackSecret: CALLBACK_SECRET,
        maxSignatureAgeSeconds: 120,
        nowSeconds: timestamp + 5
      }
    );

    expect(result.status).toBe("accepted");
    expect(result.messageId).toBe(payload.message_id);
    expect(result.payload?.sender).toBe("alice");
  });

  it("deduplicates retry callbacks by message id", () => {
    const payload = buildPayload();
    const rawBody = JSON.stringify(payload);
    const timestamp = 1_700_000_000;
    const signature = generateCallbackSignature(rawBody, CALLBACK_SECRET, timestamp);
    const headers = new Headers({
      "X-Mahilo-Message-Id": payload.message_id,
      "X-Mahilo-Signature": `sha256=${signature}`,
      "X-Mahilo-Timestamp": String(timestamp)
    });

    const dedupe = new InMemoryDedupeState(60_000);

    const first = processWebhookDelivery(
      {
        headers,
        rawBody
      },
      {
        callbackSecret: CALLBACK_SECRET,
        dedupeState: dedupe,
        maxSignatureAgeSeconds: 120,
        nowSeconds: timestamp + 1
      }
    );
    const second = processWebhookDelivery(
      {
        headers,
        rawBody
      },
      {
        callbackSecret: CALLBACK_SECRET,
        dedupeState: dedupe,
        maxSignatureAgeSeconds: 120,
        nowSeconds: timestamp + 2
      }
    );

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("duplicate");
    expect(second.deduplicated).toBe(true);
  });

  it("rejects invalid signature callbacks", () => {
    const payload = buildPayload();
    const rawBody = JSON.stringify(payload);
    const timestamp = 1_700_000_000;

    const result = processWebhookDelivery(
      {
        headers: new Headers({
          "X-Mahilo-Signature": "sha256=not-valid",
          "X-Mahilo-Timestamp": String(timestamp)
        }),
        rawBody
      },
      {
        callbackSecret: CALLBACK_SECRET,
        maxSignatureAgeSeconds: 120,
        nowSeconds: timestamp + 1
      }
    );

    expect(result.status).toBe("invalid_signature");
    expect(result.reason).toBe("missing_headers");
  });
});
