import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHmac } from "crypto";
import { serve } from "bun";
import { createApp } from "../../src/server";
import { cleanupTestDatabase, setupTestDatabase } from "../helpers/setup";

let app: ReturnType<typeof createApp>;
let mockCallbackServer: ReturnType<typeof serve> | null = null;
let receivedCallbacks: Array<{
  rawBody: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}> = [];

const MOCK_CALLBACK_PORT = 9999;
const MOCK_CALLBACK_URL = `http://localhost:${MOCK_CALLBACK_PORT}/callback`;

function startMockCallbackServer() {
  receivedCallbacks = [];
  mockCallbackServer = serve({
    port: MOCK_CALLBACK_PORT,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/callback" && req.method === "POST") {
        const rawBody = await req.text();
        let body: Record<string, unknown> | null = null;
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = null;
        }

        receivedCallbacks.push({
          rawBody,
          body,
          headers: {
            "x-mahilo-signature": req.headers.get("x-mahilo-signature") || "",
            "x-mahilo-timestamp": req.headers.get("x-mahilo-timestamp") || "",
            "x-mahilo-message-id": req.headers.get("x-mahilo-message-id") || "",
          },
        });

        return new Response(JSON.stringify({ acknowledged: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
}

function stopMockCallbackServer() {
  mockCallbackServer?.stop();
  mockCallbackServer = null;
}

async function waitForCallbacks(count: number, timeoutMs = 2000) {
  const start = Date.now();
  while (receivedCallbacks.length < count) {
    if (Date.now() - start > timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function findCallback(messageId: string) {
  return receivedCallbacks.find((cb) => cb.body?.message_id === messageId);
}

describe("E2E: Two Users Exchange Messages", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
    startMockCallbackServer();
  });

  afterEach(() => {
    stopMockCallbackServer();
    cleanupTestDatabase();
  });

  it("delivers messages end-to-end with idempotency scoping", async () => {
    const registerUser = async (username: string) => {
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      expect(res.status).toBe(201);
      return res.json();
    };

    const registerAgent = async (apiKey: string, label: string) => {
      const res = await app.request("/api/v1/agents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          framework: "clawdbot",
          label,
          callback_url: MOCK_CALLBACK_URL,
          public_key: "test-public-key",
          public_key_alg: "ed25519",
          capabilities: ["chat"],
        }),
      });

      expect(res.status).toBe(201);
      return res.json();
    };

    const bob = await registerUser("bob");
    const alice = await registerUser("alice");

    await registerAgent(bob.api_key, "bob-agent");
    const aliceAgent = await registerAgent(alice.api_key, "alice-agent");

    const requestRes = await app.request("/api/v1/friends/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bob.api_key}`,
      },
      body: JSON.stringify({ username: "alice" }),
    });
    expect(requestRes.status).toBe(201);
    const requestData = await requestRes.json();

    const acceptRes = await app.request(`/api/v1/friends/${requestData.friendship_id}/accept`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.api_key}` },
    });
    expect(acceptRes.status).toBe(200);

    const sendRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bob.api_key}`,
      },
      body: JSON.stringify({
        recipient: "alice",
        message: "Hello Alice",
        idempotency_key: "idempotency-1",
      }),
    });

    expect(sendRes.status).toBe(200);
    const sendData = await sendRes.json();

    await waitForCallbacks(1);
    const aliceCallback = findCallback(sendData.message_id);
    expect(aliceCallback).toBeDefined();
    expect(aliceCallback?.body?.sender).toBe("bob");

    const timestamp = Number(aliceCallback?.headers["x-mahilo-timestamp"]);
    const expectedSignature = createHmac("sha256", aliceAgent.callback_secret)
      .update(`${timestamp}.${aliceCallback?.rawBody}`)
      .digest("hex");

    expect(aliceCallback?.headers["x-mahilo-signature"]).toBe(`sha256=${expectedSignature}`);

    const dedupeRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bob.api_key}`,
      },
      body: JSON.stringify({
        recipient: "alice",
        message: "Hello Alice",
        idempotency_key: "idempotency-1",
      }),
    });
    const dedupeData = await dedupeRes.json();
    expect(dedupeData.deduplicated).toBe(true);
    expect(dedupeData.message_id).toBe(sendData.message_id);

    const crossUserRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${alice.api_key}`,
      },
      body: JSON.stringify({
        recipient: "bob",
        message: "Hello Bob",
        idempotency_key: "idempotency-1",
      }),
    });

    expect(crossUserRes.status).toBe(200);
    const crossUserData = await crossUserRes.json();
    expect(crossUserData.message_id).not.toBe(sendData.message_id);
    expect(crossUserData.deduplicated).not.toBe(true);

    await waitForCallbacks(2);
    const bobCallback = findCallback(crossUserData.message_id);
    expect(bobCallback).toBeDefined();
  });
});
