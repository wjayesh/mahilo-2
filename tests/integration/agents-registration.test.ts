import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../src/server";
import * as schema from "../../src/db/schema";
import {
  cleanupTestDatabase,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";

describe("Agent registration route", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  async function postAgentRegistration(
    apiKey: string,
    payload: Record<string, unknown>,
  ) {
    return app.request("/api/v1/agents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  }

  async function getConnection(connectionId: string) {
    const db = getTestDb();
    const [connection] = await db
      .select()
      .from(schema.agentConnections)
      .where(eq(schema.agentConnections.id, connectionId))
      .limit(1);

    return connection;
  }

  async function getConnectionsForLabel(
    userId: string,
    framework: string,
    label: string,
  ) {
    const db = getTestDb();
    return db
      .select()
      .from(schema.agentConnections)
      .where(
        and(
          eq(schema.agentConnections.userId, userId),
          eq(schema.agentConnections.framework, framework),
          eq(schema.agentConnections.label, label),
        ),
      );
  }

  it("creates webhook registrations with a generated callback secret", async () => {
    const { user, apiKey } = await createTestUser(
      "agent_registration_webhook_user",
      "Webhook User",
    );

    const res = await postAgentRegistration(apiKey, {
      framework: "openclaw",
      label: "default",
      mode: "webhook",
      callback_url: "https://example.com/webhook",
      routing_priority: 7,
      capabilities: ["chat"],
    });

    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data).toEqual(
      expect.objectContaining({
        connection_id: expect.any(String),
        mode: "webhook",
        callback_secret: expect.any(String),
      }),
    );

    const connection = await getConnection(data.connection_id);
    expect(connection).toBeDefined();
    expect(connection?.userId).toBe(user.id);
    expect(connection?.callbackUrl).toBe("https://example.com/webhook");
    expect(connection?.callbackSecret).toBe(data.callback_secret);
    expect(connection?.callbackSecret).not.toBeNull();
  });

  it("creates polling registrations with the inbox callback URL and no secret", async () => {
    const { user, apiKey } = await createTestUser(
      "agent_registration_polling_user",
      "Polling User",
    );

    const res = await postAgentRegistration(apiKey, {
      framework: "openclaw",
      label: "polling",
      mode: "polling",
      routing_priority: 3,
    });

    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data).toEqual(
      expect.objectContaining({
        connection_id: expect.any(String),
        mode: "polling",
      }),
    );
    expect(data.callback_secret).toBeUndefined();

    const connection = await getConnection(data.connection_id);
    expect(connection).toBeDefined();
    expect(connection?.userId).toBe(user.id);
    expect(connection?.callbackUrl).toBe("polling://inbox");
    expect(connection?.callbackSecret).toBeNull();
  });

  it("updates an existing registration to polling mode in place", async () => {
    const { user, apiKey } = await createTestUser(
      "agent_registration_update_to_polling_user",
      "Update To Polling User",
    );

    const createRes = await postAgentRegistration(apiKey, {
      framework: "openclaw",
      label: "desktop",
      mode: "webhook",
      callback_url: "https://example.com/original-webhook",
      routing_priority: 5,
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const updateRes = await postAgentRegistration(apiKey, {
      framework: "openclaw",
      label: "desktop",
      mode: "polling",
      routing_priority: 42,
    });

    expect(updateRes.status).toBe(200);

    const data = await updateRes.json();
    expect(data).toEqual(
      expect.objectContaining({
        connection_id: created.connection_id,
        updated: true,
        mode: "polling",
      }),
    );

    const connection = await getConnection(created.connection_id);
    expect(connection).toBeDefined();
    expect(connection?.id).toBe(created.connection_id);
    expect(connection?.callbackUrl).toBe("polling://inbox");
    expect(connection?.callbackSecret).toBeNull();
    expect(connection?.routingPriority).toBe(42);

    const matches = await getConnectionsForLabel(
      user.id,
      "openclaw",
      "desktop",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe(created.connection_id);
  });

  it("updates an existing polling registration back to webhook mode and generates a secret when needed", async () => {
    const { user, apiKey } = await createTestUser(
      "agent_registration_update_to_webhook_user",
      "Update To Webhook User",
    );

    const createRes = await postAgentRegistration(apiKey, {
      framework: "openclaw",
      label: "desktop",
      mode: "polling",
      routing_priority: 4,
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const updateRes = await postAgentRegistration(apiKey, {
      framework: "openclaw",
      label: "desktop",
      mode: "webhook",
      callback_url: "https://example.com/restored-webhook",
      routing_priority: 11,
    });

    expect(updateRes.status).toBe(200);

    const data = await updateRes.json();
    expect(data).toEqual(
      expect.objectContaining({
        connection_id: created.connection_id,
        updated: true,
        mode: "webhook",
        callback_secret: expect.any(String),
      }),
    );

    const connection = await getConnection(created.connection_id);
    expect(connection).toBeDefined();
    expect(connection?.userId).toBe(user.id);
    expect(connection?.id).toBe(created.connection_id);
    expect(connection?.callbackUrl).toBe(
      "https://example.com/restored-webhook",
    );
    expect(connection?.callbackSecret).toBe(data.callback_secret);
    expect(connection?.callbackSecret).not.toBeNull();

    const matches = await getConnectionsForLabel(
      user.id,
      "openclaw",
      "desktop",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe(created.connection_id);
  });
});
