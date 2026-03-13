import { describe, expect, it } from "bun:test";

import { createMahiloWebhookRouteHandler, generateCallbackSignature } from "../src";

const CALLBACK_SECRET = "callback-secret";

function buildRawPayload(): string {
  return JSON.stringify({
    message: "hello",
    message_id: "msg_123",
    recipient_connection_id: "conn_local",
    sender: "alice",
    sender_agent: "openclaw",
    timestamp: "2026-03-08T12:15:00.000Z"
  });
}

function createMockRequest(params: {
  bodyObject?: Record<string, unknown>;
  headers?: Record<string, string>;
  method?: string;
  rawBody?: string;
}) {
  const method = params.method ?? "POST";
  const headers = params.headers ?? {};
  const rawBody = params.rawBody ?? buildRawPayload();

  if (params.bodyObject) {
    return {
      body: params.bodyObject,
      headers,
      method
    };
  }

  return {
    headers,
    method,
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(rawBody, "utf8");
    }
  };
}

function createMockResponse(): {
  response: {
    end: (chunk?: string) => void;
    setHeader: (name: string, value: string) => void;
    statusCode: number;
    writeHead: (statusCode: number, headers?: Record<string, string>) => void;
  };
  status: () => number;
  body: () => Record<string, unknown>;
} {
  let body = "";
  const responseHeaders: Record<string, string> = {};
  const response = {
    end: (chunk?: string) => {
      if (typeof chunk === "string") {
        body = chunk;
      }
    },
    setHeader: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
    statusCode: 200,
    writeHead: (statusCode: number, headers?: Record<string, string>) => {
      response.statusCode = statusCode;
      if (headers) {
        Object.assign(responseHeaders, headers);
      }
    }
  };

  return {
    response,
    status: () => response.statusCode,
    body: () => JSON.parse(body) as Record<string, unknown>
  };
}

describe("createMahiloWebhookRouteHandler", () => {
  it("rejects unsupported methods", async () => {
    const handler = createMahiloWebhookRouteHandler({
      callbackSecret: CALLBACK_SECRET
    });
    const req = createMockRequest({
      method: "PUT"
    });
    const res = createMockResponse();

    await handler(req, res.response);

    expect(res.status()).toBe(405);
    expect(res.body()).toMatchObject({
      error: "method_not_allowed"
    });
  });

  it("answers callback readiness probes without a callback secret", async () => {
    const handler = createMahiloWebhookRouteHandler();
    const req = createMockRequest({
      method: "HEAD"
    });
    const res = createMockResponse();

    await handler(req, res.response);

    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({
      status: "ready"
    });
  });

  it("rejects requests when callback secret is unavailable", async () => {
    const handler = createMahiloWebhookRouteHandler();
    const req = createMockRequest({
      rawBody: buildRawPayload()
    });
    const res = createMockResponse();

    await handler(req, res.response);

    expect(res.status()).toBe(503);
    expect(res.body()).toMatchObject({
      error: "callback_secret_unavailable"
    });
  });

  it("requires raw body semantics for signature checks", async () => {
    const handler = createMahiloWebhookRouteHandler({
      callbackSecret: CALLBACK_SECRET
    });
    const req = createMockRequest({
      bodyObject: {
        message_id: "msg_123"
      }
    });
    const res = createMockResponse();

    await handler(req, res.response);

    expect(res.status()).toBe(400);
    expect(res.body()).toMatchObject({
      error: "invalid_payload"
    });
    expect(String(res.body().message)).toContain("raw request body is required");
  });

  it("accepts valid webhook callbacks and exposes accepted payloads", async () => {
    const acceptedMessageIds: string[] = [];
    const rawBody = buildRawPayload();
    const timestamp = 1_700_000_000;
    const signature = generateCallbackSignature(rawBody, CALLBACK_SECRET, timestamp);
    const handler = createMahiloWebhookRouteHandler({
      callbackSecret: CALLBACK_SECRET,
      maxSignatureAgeSeconds: 120,
      nowSeconds: timestamp + 3,
      onAcceptedDelivery: ({ messageId }) => {
        acceptedMessageIds.push(messageId);
      }
    });
    const req = createMockRequest({
      headers: {
        "x-mahilo-signature": `sha256=${signature}`,
        "x-mahilo-timestamp": String(timestamp)
      },
      rawBody
    });
    const res = createMockResponse();

    await handler(req, res.response);

    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({
      deduplicated: false,
      messageId: "msg_123",
      status: "accepted"
    });
    expect(acceptedMessageIds).toEqual(["msg_123"]);
  });

  it("acknowledges duplicate retries without rerunning delivery callbacks", async () => {
    const acceptedMessageIds: string[] = [];
    const rawBody = buildRawPayload();
    const timestamp = 1_700_000_000;
    const signature = generateCallbackSignature(rawBody, CALLBACK_SECRET, timestamp);
    const headers = {
      "x-mahilo-message-id": "msg_123",
      "x-mahilo-signature": `sha256=${signature}`,
      "x-mahilo-timestamp": String(timestamp)
    };
    const handler = createMahiloWebhookRouteHandler({
      callbackSecret: CALLBACK_SECRET,
      dedupeTtlMs: 60_000,
      maxSignatureAgeSeconds: 120,
      nowSeconds: timestamp + 3,
      onAcceptedDelivery: ({ messageId }) => {
        acceptedMessageIds.push(messageId);
      }
    });

    const firstReq = createMockRequest({
      headers,
      rawBody
    });
    const firstRes = createMockResponse();
    await handler(firstReq, firstRes.response);

    const retryReq = createMockRequest({
      headers,
      rawBody
    });
    const retryRes = createMockResponse();
    await handler(retryReq, retryRes.response);

    expect(firstRes.status()).toBe(200);
    expect(firstRes.body()).toMatchObject({
      deduplicated: false,
      messageId: "msg_123",
      status: "accepted"
    });

    expect(retryRes.status()).toBe(200);
    expect(retryRes.body()).toMatchObject({
      deduplicated: true,
      messageId: "msg_123",
      status: "duplicate"
    });
    expect(acceptedMessageIds).toEqual(["msg_123"]);
  });

  it("verifies signatures using exact raw body bytes", async () => {
    const rawBody =
      '{"message_id":"msg_123", "recipient_connection_id":"conn_local","sender":"alice","sender_agent":"openclaw","message":"hello","timestamp":"2026-03-08T12:15:00.000Z"}';
    const timestamp = 1_700_000_000;
    const signature = generateCallbackSignature(rawBody, CALLBACK_SECRET, timestamp);
    const headers = {
      "x-mahilo-signature": `sha256=${signature}`,
      "x-mahilo-timestamp": String(timestamp)
    };
    const handler = createMahiloWebhookRouteHandler({
      callbackSecret: CALLBACK_SECRET,
      maxSignatureAgeSeconds: 120,
      nowSeconds: timestamp + 1
    });

    const acceptedReq = createMockRequest({
      headers,
      rawBody
    });
    const acceptedRes = createMockResponse();
    await handler(acceptedReq, acceptedRes.response);

    const reformattedBody = JSON.stringify(JSON.parse(rawBody));
    const rejectedReq = createMockRequest({
      headers,
      rawBody: reformattedBody
    });
    const rejectedRes = createMockResponse();
    await handler(rejectedReq, rejectedRes.response);

    expect(acceptedRes.status()).toBe(200);
    expect(acceptedRes.body()).toMatchObject({
      status: "accepted"
    });
    expect(rejectedRes.status()).toBe(401);
    expect(rejectedRes.body()).toMatchObject({
      error: "invalid_signature"
    });
  });
});
