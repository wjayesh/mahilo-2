import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server";
import * as schema from "../../src/db/schema";
import {
  cleanupTestDatabase,
  createAgentConnection,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";

describe("Agent ping route", () => {
  let app: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanupTestDatabase();
  });

  it("treats polling connections as an inbox health check without probing a callback URL", async () => {
    const db = getTestDb();
    const { user, apiKey } = await createTestUser(
      "agent_ping_polling_user",
      "Polling User",
    );
    const connection = await createAgentConnection(user.id, {
      framework: "openclaw",
      label: "polling",
    });

    await db
      .update(schema.agentConnections)
      .set({
        callbackSecret: null,
        callbackUrl: "polling://inbox",
      })
      .where(eq(schema.agentConnections.id, connection.id));

    let callbackFetchCalled = false;
    globalThis.fetch = mock(async () => {
      callbackFetchCalled = true;
      throw new Error("Polling ping should not fetch an HTTP callback");
    });

    const res = await app.request(`/api/v1/agents/${connection.id}/ping`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        latency_ms: 0,
        mode: "polling",
        success: true,
      }),
    );
    expect(callbackFetchCalled).toBe(false);
  });

  it("reports inactive connections without probing their callback", async () => {
    const db = getTestDb();
    const { user, apiKey } = await createTestUser(
      "agent_ping_inactive_user",
      "Inactive User",
    );
    const connection = await createAgentConnection(user.id, {
      framework: "openclaw",
      label: "inactive",
    });

    await db
      .update(schema.agentConnections)
      .set({
        callbackUrl: "https://inactive.example/callback",
        status: "inactive",
      })
      .where(eq(schema.agentConnections.id, connection.id));

    let callbackFetchCalled = false;
    globalThis.fetch = mock(async () => {
      callbackFetchCalled = true;
      return new Response(null, { status: 204 });
    });

    const res = await app.request(`/api/v1/agents/${connection.id}/ping`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        error: "Connection is inactive and will not be selected for sender routing",
        latency_ms: 0,
        mode: "webhook",
        success: false,
      }),
    );
    expect(callbackFetchCalled).toBe(false);
  });

  it("keeps webhook ping behavior intact and reports the refreshed last_seen timestamp", async () => {
    const { user, apiKey } = await createTestUser(
      "agent_ping_webhook_user",
      "Webhook User",
    );
    const connection = await createAgentConnection(user.id, {
      framework: "openclaw",
      label: "default",
    });

    let callbackFetchCalled = false;
    globalThis.fetch = mock(async (input, init) => {
      callbackFetchCalled = true;
      expect(String(input)).toBe("https://example.com/callback");
      expect(init?.method).toBe("HEAD");
      return new Response(null, { status: 204 });
    });

    const res = await app.request(`/api/v1/agents/${connection.id}/ping`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual(
      expect.objectContaining({
        latency_ms: expect.any(Number),
        last_seen: expect.any(String),
        mode: "webhook",
        status_code: 204,
        success: true,
      }),
    );
    expect(callbackFetchCalled).toBe(true);
  });
});
