import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server";
import {
  cleanupTestDatabase,
  createAgentConnection,
  createFriendship,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";
import * as schema from "../../src/db/schema";

let app: ReturnType<typeof createApp>;

describe("Selector-aware send API (SRV-031)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("stores canonical selectors from declared_selectors and prefers them over legacy top-level fields", async () => {
    const { db, senderKey, senderConnection, recipientConnection, recipient } =
      await setupParticipants("selector_declared");

    const sendRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        sender_connection_id: senderConnection.id,
        message: "location update",
        direction: "inbound",
        resource: "profile.basic",
        action: "request",
        declared_selectors: {
          direction: "outbound",
          resource: "Location.Current",
          action: "Share",
        },
      }),
    });

    expect(sendRes.status).toBe(200);
    const sendData = await sendRes.json();
    const [storedMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, sendData.message_id))
      .limit(1);

    expect(storedMessage?.direction).toBe("outbound");
    expect(storedMessage?.resource).toBe("location.current");
    expect(storedMessage?.action).toBe("share");
  });

  it("validates known directions/resources while allowing namespaced resource extensions", async () => {
    const { senderKey, senderConnection, recipientConnection, recipient } =
      await setupParticipants("selector_validation");

    const invalidResourceRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        sender_connection_id: senderConnection.id,
        message: "bad selector",
        declared_selectors: {
          direction: "outbound",
          resource: "private",
          action: "share",
        },
      }),
    });

    expect(invalidResourceRes.status).toBe(400);
    const invalidResourceBody = await invalidResourceRes.json();
    expect(invalidResourceBody.code).toBe("INVALID_SELECTOR");

    const namespacedResourceRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        sender_connection_id: senderConnection.id,
        message: "custom selector",
        declared_selectors: {
          direction: "outbound",
          resource: "custom.preference",
          action: "share",
        },
      }),
    });

    expect(namespacedResourceRes.status).toBe(200);

    const invalidDirectionRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        sender_connection_id: senderConnection.id,
        message: "bad direction",
        direction: "sideways",
      }),
    });

    expect(invalidDirectionRes.status).toBe(400);
    const invalidDirectionBody = await invalidDirectionRes.json();
    expect(JSON.stringify(invalidDirectionBody).toLowerCase()).toContain("direction");
  });

  it("keeps backward compatibility for old clients using top-level selectors", async () => {
    const { db, senderKey, senderConnection, recipientConnection, recipient } =
      await setupParticipants("selector_legacy");

    const sendRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        sender_connection_id: senderConnection.id,
        message: "legacy selector payload",
        direction: "inbound",
        resource: "message.general",
        action: "Request",
      }),
    });

    expect(sendRes.status).toBe(200);
    const sendData = await sendRes.json();
    const [storedMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, sendData.message_id))
      .limit(1);

    expect(storedMessage?.direction).toBe("inbound");
    expect(storedMessage?.resource).toBe("message.general");
    expect(storedMessage?.action).toBe("request");
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
  await db
    .update(schema.users)
    .set({ twitterVerified: true, verificationCode: null })
    .where(eq(schema.users.id, recipient.id));

  await createFriendship(sender.id, recipient.id, "accepted");

  const senderConnection = await createAgentConnection(sender.id, {
    callbackUrl: `polling://sender_${suffix}`,
    label: `sender_${suffix}`,
  });
  const recipientConnection = await createAgentConnection(recipient.id, {
    callbackUrl: `polling://recipient_${suffix}`,
    label: `recipient_${suffix}`,
  });

  return {
    db,
    sender,
    senderKey,
    recipient,
    senderConnection,
    recipientConnection,
  };
}
