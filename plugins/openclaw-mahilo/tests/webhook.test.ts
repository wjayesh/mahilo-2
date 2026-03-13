import { describe, expect, it } from "bun:test";

import {
  generateCallbackSignature,
  InMemoryDedupeState,
  parseInboundWebhookPayload,
  processWebhookDelivery
} from "../src";

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

describe("parseInboundWebhookPayload", () => {
  it("parses required fields and applies payload defaults", () => {
    const payload = parseInboundWebhookPayload(JSON.stringify(buildPayload()));

    expect(payload.message_id).toBe("msg_123");
    expect(payload.sender).toBe("alice");
    expect(payload.payload_type).toBe("text/plain");
  });

  it("normalizes inbound selectors when provided", () => {
    const payload = parseInboundWebhookPayload(
      JSON.stringify({
        ...buildPayload(),
        selectors: {
          action: " Notify ",
          direction: "outbound",
          resource: "Message General"
        }
      })
    );

    expect(payload.selectors).toEqual({
      action: "notify",
      direction: "outbound",
      resource: "message.general"
    });
  });

  it("throws for invalid JSON body", () => {
    expect(() => parseInboundWebhookPayload("{invalid json")).toThrow(
      "webhook body must be valid JSON"
    );
  });

  it("throws for non-object payloads", () => {
    expect(() => parseInboundWebhookPayload('"text"')).toThrow(
      "webhook payload must be an object"
    );
  });

  it("throws for missing required fields", () => {
    expect(() =>
      parseInboundWebhookPayload(
        JSON.stringify({
          sender: "alice"
        })
      )
    ).toThrow("message_id must be a non-empty string");
  });
});

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

  it("supports plain object header bags", () => {
    const payload = buildPayload();
    const rawBody = JSON.stringify(payload);
    const timestamp = 1_700_000_000;
    const signature = generateCallbackSignature(rawBody, CALLBACK_SECRET, timestamp);

    const result = processWebhookDelivery(
      {
        headers: {
          "X-Mahilo-Signature": `sha256=${signature}`,
          "x-mahilo-timestamp": String(timestamp),
          "x-mahilo-message-id": payload.message_id
        },
        rawBody
      },
      {
        callbackSecret: CALLBACK_SECRET,
        maxSignatureAgeSeconds: 120,
        nowSeconds: timestamp + 1
      }
    );

    expect(result.status).toBe("accepted");
    expect(result.messageId).toBe(payload.message_id);
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

  it("normalizes payload message ids before dedupe checks", () => {
    const timestamp = 1_700_000_000;
    const dedupe = new InMemoryDedupeState(60_000);

    const rawBodyWithWhitespace = JSON.stringify({
      ...buildPayload(),
      message_id: "  msg_123  "
    });
    const signatureWithWhitespace = generateCallbackSignature(rawBodyWithWhitespace, CALLBACK_SECRET, timestamp);
    const first = processWebhookDelivery(
      {
        headers: new Headers({
          "X-Mahilo-Signature": `sha256=${signatureWithWhitespace}`,
          "X-Mahilo-Timestamp": String(timestamp)
        }),
        rawBody: rawBodyWithWhitespace
      },
      {
        callbackSecret: CALLBACK_SECRET,
        dedupeState: dedupe,
        maxSignatureAgeSeconds: 120,
        nowSeconds: timestamp + 1
      }
    );

    const rawBodyNormalized = JSON.stringify(buildPayload());
    const signatureNormalized = generateCallbackSignature(rawBodyNormalized, CALLBACK_SECRET, timestamp);
    const second = processWebhookDelivery(
      {
        headers: new Headers({
          "X-Mahilo-Signature": `sha256=${signatureNormalized}`,
          "X-Mahilo-Timestamp": String(timestamp)
        }),
        rawBody: rawBodyNormalized
      },
      {
        callbackSecret: CALLBACK_SECRET,
        dedupeState: dedupe,
        maxSignatureAgeSeconds: 120,
        nowSeconds: timestamp + 2
      }
    );

    expect(first.status).toBe("accepted");
    expect(first.messageId).toBe("msg_123");
    expect(second.status).toBe("duplicate");
    expect(second.deduplicated).toBe(true);
  });

  it("rejects mismatched message ids between payload and headers", () => {
    const payload = buildPayload();
    const rawBody = JSON.stringify(payload);
    const timestamp = 1_700_000_000;
    const signature = generateCallbackSignature(rawBody, CALLBACK_SECRET, timestamp);

    const result = processWebhookDelivery(
      {
        headers: new Headers({
          "X-Mahilo-Message-Id": "msg_999",
          "X-Mahilo-Signature": `sha256=${signature}`,
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

    expect(result.status).toBe("invalid_payload");
    expect(result.error).toBe("x-mahilo-message-id must match payload message_id");
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

  it("rejects stale callback signatures", () => {
    const payload = buildPayload();
    const rawBody = JSON.stringify(payload);
    const timestamp = 1_700_000_000;
    const signature = generateCallbackSignature(rawBody, CALLBACK_SECRET, timestamp);

    const result = processWebhookDelivery(
      {
        headers: new Headers({
          "X-Mahilo-Signature": `sha256=${signature}`,
          "X-Mahilo-Timestamp": String(timestamp)
        }),
        rawBody
      },
      {
        callbackSecret: CALLBACK_SECRET,
        maxSignatureAgeSeconds: 60,
        nowSeconds: timestamp + 600
      }
    );

    expect(result.status).toBe("invalid_signature");
    expect(result.reason).toBe("stale_timestamp");
  });

  it("rejects invalid payloads after signature verification", () => {
    const rawBody = JSON.stringify({
      message_id: "msg_123"
    });
    const timestamp = 1_700_000_000;
    const signature = generateCallbackSignature(rawBody, CALLBACK_SECRET, timestamp);

    const result = processWebhookDelivery(
      {
        headers: new Headers({
          "X-Mahilo-Signature": `sha256=${signature}`,
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

    expect(result.status).toBe("invalid_payload");
    expect(result.error).toContain("recipient_connection_id must be a non-empty string");
  });
});
