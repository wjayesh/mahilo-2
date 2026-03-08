import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server";
import {
  cleanupTestDatabase,
  createAgentConnection,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";
import * as schema from "../../src/db/schema";

let app: ReturnType<typeof createApp>;

describe("Plugin override creation endpoint (SRV-043)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("requires authentication", async () => {
    const response = await app.request("/api/v1/plugin/overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender_connection_id: "conn_missing",
        source_resolution_id: "res_missing",
        kind: "one_time",
        scope: "global",
        selectors: {
          direction: "outbound",
          resource: "message.general",
          action: "share",
        },
        effect: "allow",
        reason: "missing auth",
      }),
    });

    expect(response.status).toBe(401);
  });

  it("creates one-time overrides with explicit source/provenance metadata", async () => {
    const db = getTestDb();
    const { sender, senderKey, senderConnection, recipient } = await setupParticipants(
      "plugin_override_once"
    );

    const sourceMessageId = "msg_plugin_override_once_source";
    await db.insert(schema.messages).values({
      id: sourceMessageId,
      senderUserId: sender.id,
      senderConnectionId: senderConnection.id,
      senderAgent: "openclaw-agent",
      recipientType: "user",
      recipientId: recipient.id,
      payload: "Source interaction for one-time override provenance.",
      status: "delivered",
    });

    const response = await app.request("/api/v1/plugin/overrides", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: senderConnection.id,
        source_resolution_id: "res_plugin_override_once",
        kind: "one_time",
        scope: "user",
        target_id: recipient.id,
        selectors: {
          direction: "outbound",
          resource: "location.current",
          action: "share",
        },
        effect: "allow",
        reason: "User approved one-time location share with this recipient.",
        derived_from_message_id: sourceMessageId,
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        policy_id: expect.any(String),
        kind: "one_time",
        created: true,
      })
    );

    const [stored] = await db
      .select()
      .from(schema.policies)
      .where(eq(schema.policies.id, body.policy_id))
      .limit(1);

    expect(stored).toBeDefined();
    expect(stored.scope).toBe("user");
    expect(stored.targetId).toBe(recipient.id);
    expect(stored.direction).toBe("outbound");
    expect(stored.resource).toBe("location.current");
    expect(stored.action).toBe("share");
    expect(stored.effect).toBe("allow");
    expect(stored.evaluator).toBe("structured");
    expect(stored.maxUses).toBe(1);
    expect(stored.remainingUses).toBe(1);
    expect(stored.source).toBe("override");
    expect(stored.derivedFromMessageId).toBe(sourceMessageId);

    const storagePayload = JSON.parse(stored!.policyContent);
    expect(storagePayload.schema_version).toBe("canonical_policy_v1");
    expect(storagePayload.source).toBe("override");
    expect(storagePayload.policy_content?._mahilo_override).toEqual(
      expect.objectContaining({
        kind: "one_time",
        reason: "User approved one-time location share with this recipient.",
        sender_connection_id: senderConnection.id,
        source_resolution_id: "res_plugin_override_once",
        created_via: "plugin.overrides",
      })
    );
  });

  it("creates temporary overrides from ttl_seconds", async () => {
    const db = getTestDb();
    const { senderKey, senderConnection } = await setupParticipants("plugin_override_temporary");

    const beforeRequest = new Date();
    const response = await app.request("/api/v1/plugin/overrides", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: senderConnection.id,
        source_resolution_id: "res_plugin_override_temporary",
        kind: "temporary",
        scope: "global",
        selectors: {
          direction: "outbound",
          resource: "message.general",
          action: "share",
        },
        effect: "ask",
        reason: "Pause and ask while this conversation remains sensitive.",
        ttl_seconds: 120,
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.created).toBe(true);
    expect(body.kind).toBe("temporary");

    const [stored] = await db
      .select({
        expiresAt: schema.policies.expiresAt,
        maxUses: schema.policies.maxUses,
        remainingUses: schema.policies.remainingUses,
      })
      .from(schema.policies)
      .where(eq(schema.policies.id, body.policy_id))
      .limit(1);

    expect(stored).toBeDefined();
    expect(stored?.maxUses).toBeNull();
    expect(stored?.remainingUses).toBeNull();
    expect(stored?.expiresAt).not.toBeNull();
    expect(stored?.expiresAt).toEqual(expect.any(Date));
    expect(stored?.expiresAt?.getTime()).toBeGreaterThan(beforeRequest.getTime());
  });

  it("rejects malformed override lifecycle payloads", async () => {
    const { senderKey, senderConnection, recipient } = await setupParticipants(
      "plugin_override_invalid"
    );

    const oneTimeResponse = await app.request("/api/v1/plugin/overrides", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: senderConnection.id,
        source_resolution_id: "res_plugin_override_invalid_one_time",
        kind: "one_time",
        scope: "user",
        target_id: recipient.id,
        selectors: {
          direction: "outbound",
          resource: "message.general",
          action: "share",
        },
        effect: "allow",
        reason: "This should fail lifecycle validation.",
        max_uses: 2,
      }),
    });

    expect(oneTimeResponse.status).toBe(400);
    const oneTimeBody = await oneTimeResponse.json();
    expect(oneTimeBody.code).toBe("INVALID_OVERRIDE");

    const temporaryResponse = await app.request("/api/v1/plugin/overrides", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: senderConnection.id,
        source_resolution_id: "res_plugin_override_invalid_temporary",
        kind: "temporary",
        scope: "global",
        selectors: {
          direction: "outbound",
          resource: "message.general",
          action: "share",
        },
        effect: "ask",
        reason: "Missing expiry should fail.",
      }),
    });

    expect(temporaryResponse.status).toBe(400);
    const temporaryBody = await temporaryResponse.json();
    expect(temporaryBody.code).toBe("INVALID_OVERRIDE");

    const persistentResponse = await app.request("/api/v1/plugin/overrides", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: senderConnection.id,
        source_resolution_id: "res_plugin_override_invalid_persistent",
        kind: "persistent",
        scope: "global",
        selectors: {
          direction: "outbound",
          resource: "message.general",
          action: "share",
        },
        effect: "allow",
        reason: "Persistent should not allow ttl_seconds.",
        ttl_seconds: 60,
      }),
    });

    expect(persistentResponse.status).toBe(400);
    const persistentBody = await persistentResponse.json();
    expect(persistentBody.code).toBe("INVALID_OVERRIDE");
  });
});

async function setupParticipants(suffix: string) {
  const db = getTestDb();
  const { user: sender, apiKey: senderKey } = await createTestUser(`sender_${suffix}`);
  const { user: recipient } = await createTestUser(`recipient_${suffix}`);

  await db
    .update(schema.users)
    .set({ twitterVerified: true, verificationCode: null })
    .where(eq(schema.users.id, sender.id));

  const senderConnection = await createAgentConnection(sender.id, {
    callbackUrl: `polling://sender_${suffix}`,
    framework: "openclaw",
    label: `sender_${suffix}`,
  });

  return {
    sender,
    senderKey,
    senderConnection,
    recipient,
  };
}
