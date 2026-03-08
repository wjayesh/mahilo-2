import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createApp } from "../../src/server";
import { config } from "../../src/config";
import * as schema from "../../src/db/schema";
import { canonicalToStorage } from "../../src/services/policySchema";
import {
  cleanupTestDatabase,
  createAgentConnection,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";

let app: ReturnType<typeof createApp>;
let originalTrustedMode: boolean;
let originalFetch: typeof fetch | null = null;
const callbacks: Array<{ url: string; body: Record<string, unknown> | null }> = [];

function setTrustedMode(value: boolean) {
  (config as unknown as { trustedMode: boolean }).trustedMode = value;
}

function installCallbackMock() {
  callbacks.length = 0;
  originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://callback.test/")) {
      const bodyString =
        typeof init?.body === "string"
          ? init.body
          : init?.body
            ? new TextDecoder().decode(init.body as ArrayBufferView)
            : "";
      let body: Record<string, unknown> | null = null;
      try {
        body = bodyString ? JSON.parse(bodyString) : null;
      } catch {
        body = null;
      }
      callbacks.push({ url, body });
      return new Response(JSON.stringify({ acknowledged: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!originalFetch) {
      throw new Error("Original fetch is not available");
    }
    return originalFetch(input, init);
  };
}

function restoreCallbackMock() {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}

async function insertCanonicalPolicy(input: {
  user_id: string;
  scope: "global" | "user" | "role" | "group";
  target_id: string | null;
  effect: "allow" | "ask" | "deny";
  priority?: number;
}) {
  const db = getTestDb();
  const policyId = nanoid();
  const canonical = canonicalToStorage({
    scope: input.scope,
    target_id: input.target_id,
    direction: "outbound",
    resource: "message.general",
    action: "share",
    effect: input.effect,
    evaluator: "structured",
    policy_content: {},
    effective_from: null,
    expires_at: null,
    max_uses: null,
    remaining_uses: null,
    source: "user_created",
    derived_from_message_id: null,
    priority: input.priority ?? 50,
    enabled: true,
  });

  await db.insert(schema.policies).values({
    id: policyId,
    userId: input.user_id,
    scope: input.scope,
    targetId: input.target_id,
    policyType: canonical.policyType,
    policyContent: canonical.policyContent,
    direction: canonical.direction,
    resource: canonical.resource,
    action: canonical.action,
    effect: canonical.effect,
    evaluator: canonical.evaluator,
    effectiveFrom: canonical.effectiveFrom,
    expiresAt: canonical.expiresAt,
    maxUses: canonical.maxUses,
    remainingUses: canonical.remainingUses,
    source: canonical.source,
    derivedFromMessageId: canonical.derivedFromMessageId,
    priority: canonical.priority,
    enabled: true,
    createdAt: new Date(),
  });

  return policyId;
}

describe("Group fan-out per-recipient resolution (SRV-050)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    originalTrustedMode = config.trustedMode;
    setTrustedMode(true);
    installCallbackMock();
    app = createApp();
  });

  afterEach(() => {
    restoreCallbackMock();
    setTrustedMode(originalTrustedMode);
    cleanupTestDatabase();
  });

  it("produces mixed per-recipient results and blocks denied recipients from delivery", async () => {
    const db = getTestDb();
    const { user: sender, apiKey: senderKey } = await createTestUser("fanout_sender");
    const { user: deniedRecipient } = await createTestUser("fanout_denied");
    const { user: allowedRecipient } = await createTestUser("fanout_allowed");

    await db
      .update(schema.users)
      .set({ twitterVerified: true, verificationCode: null })
      .where(eq(schema.users.id, sender.id));

    const senderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "https://callback.test/sender",
      label: "sender",
    });
    const deniedConnection = await createAgentConnection(deniedRecipient.id, {
      callbackUrl: "https://callback.test/denied",
      label: "denied",
    });
    const allowedConnection = await createAgentConnection(allowedRecipient.id, {
      callbackUrl: "https://callback.test/allowed",
      label: "allowed",
    });

    const groupId = `grp_${nanoid(10)}`;
    await db.insert(schema.groups).values({
      id: groupId,
      name: `fanout-group-${nanoid(6)}`,
      ownerUserId: sender.id,
      inviteOnly: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.groupMemberships).values([
      {
        id: nanoid(),
        groupId,
        userId: sender.id,
        role: "owner",
        status: "active",
        invitedByUserId: sender.id,
        createdAt: new Date(),
      },
      {
        id: nanoid(),
        groupId,
        userId: deniedRecipient.id,
        role: "member",
        status: "active",
        invitedByUserId: sender.id,
        createdAt: new Date(),
      },
      {
        id: nanoid(),
        groupId,
        userId: allowedRecipient.id,
        role: "member",
        status: "active",
        invitedByUserId: sender.id,
        createdAt: new Date(),
      },
    ]);

    await insertCanonicalPolicy({
      user_id: sender.id,
      scope: "group",
      target_id: groupId,
      effect: "allow",
      priority: 10,
    });
    await insertCanonicalPolicy({
      user_id: sender.id,
      scope: "user",
      target_id: deniedRecipient.id,
      effect: "deny",
      priority: 100,
    });

    const response = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: groupId,
        recipient_type: "group",
        sender_connection_id: senderConnection.id,
        message: "Team update",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.status).toBe("delivered");
    expect(body.delivery_status).toBe("delivered");
    expect(body.delivered).toBe(1);
    expect(body.denied).toBe(1);
    expect(body.recipients).toBe(2);
    expect(body.recipient_results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipient: deniedRecipient.username,
          decision: "deny",
          delivery_status: "rejected",
        }),
        expect.objectContaining({
          recipient: allowedRecipient.username,
          decision: "allow",
          delivery_status: "delivered",
        }),
      ])
    );

    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.body?.recipient_connection_id).toBe(allowedConnection.id);
    expect(callbacks[0]?.body?.recipient_connection_id).not.toBe(deniedConnection.id);

    const deliveries = await db
      .select()
      .from(schema.messageDeliveries)
      .where(eq(schema.messageDeliveries.messageId, body.message_id));
    expect(
      deliveries.some((delivery) => delivery.recipientConnectionId === deniedConnection.id)
    ).toBe(false);
    expect(
      deliveries.some((delivery) => delivery.recipientConnectionId === allowedConnection.id)
    ).toBe(true);

    const [storedMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, body.message_id))
      .limit(1);
    expect(storedMessage?.policiesEvaluated).toBeTruthy();

    const fanoutAudit = JSON.parse(storedMessage!.policiesEvaluated!);
    expect(fanoutAudit.fanout_mode).toBe("per_recipient");
    expect(fanoutAudit.partial_delivery).toBe(true);
    expect(fanoutAudit.decision_counts).toEqual(
      expect.objectContaining({
        allow: 1,
        deny: 1,
      })
    );
  });

  it("marks mixed allow/ask/deny fan-out as partial delivery with deterministic aggregate metadata", async () => {
    const db = getTestDb();
    const { user: sender, apiKey: senderKey } = await createTestUser("fanout_sender_mixed");
    const { user: deniedRecipient } = await createTestUser("fanout_denied_mixed");
    const { user: askRecipient } = await createTestUser("fanout_ask_mixed");
    const { user: allowedRecipient } = await createTestUser("fanout_allowed_mixed");

    await db
      .update(schema.users)
      .set({ twitterVerified: true, verificationCode: null })
      .where(eq(schema.users.id, sender.id));

    const senderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "https://callback.test/sender-mixed",
      label: "sender-mixed",
    });
    const deniedConnection = await createAgentConnection(deniedRecipient.id, {
      callbackUrl: "https://callback.test/denied-mixed",
      label: "denied-mixed",
    });
    const askConnection = await createAgentConnection(askRecipient.id, {
      callbackUrl: "https://callback.test/ask-mixed",
      label: "ask-mixed",
    });
    const allowedConnection = await createAgentConnection(allowedRecipient.id, {
      callbackUrl: "https://callback.test/allowed-mixed",
      label: "allowed-mixed",
    });

    const groupId = `grp_${nanoid(10)}`;
    await db.insert(schema.groups).values({
      id: groupId,
      name: `fanout-group-mixed-${nanoid(6)}`,
      ownerUserId: sender.id,
      inviteOnly: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.groupMemberships).values([
      {
        id: nanoid(),
        groupId,
        userId: sender.id,
        role: "owner",
        status: "active",
        invitedByUserId: sender.id,
        createdAt: new Date(),
      },
      {
        id: nanoid(),
        groupId,
        userId: deniedRecipient.id,
        role: "member",
        status: "active",
        invitedByUserId: sender.id,
        createdAt: new Date(),
      },
      {
        id: nanoid(),
        groupId,
        userId: askRecipient.id,
        role: "member",
        status: "active",
        invitedByUserId: sender.id,
        createdAt: new Date(),
      },
      {
        id: nanoid(),
        groupId,
        userId: allowedRecipient.id,
        role: "member",
        status: "active",
        invitedByUserId: sender.id,
        createdAt: new Date(),
      },
    ]);

    await insertCanonicalPolicy({
      user_id: sender.id,
      scope: "group",
      target_id: groupId,
      effect: "allow",
      priority: 10,
    });
    await insertCanonicalPolicy({
      user_id: sender.id,
      scope: "user",
      target_id: deniedRecipient.id,
      effect: "deny",
      priority: 100,
    });
    await insertCanonicalPolicy({
      user_id: sender.id,
      scope: "user",
      target_id: askRecipient.id,
      effect: "ask",
      priority: 100,
    });

    const response = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: groupId,
        recipient_type: "group",
        sender_connection_id: senderConnection.id,
        message: "Mixed team update",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.status).toBe("delivered");
    expect(body.delivery_status).toBe("delivered");
    expect(body.recipients).toBe(3);
    expect(body.delivered).toBe(1);
    expect(body.denied).toBe(1);
    expect(body.review_required).toBe(1);
    expect(body.resolution.reason_code).toBe("policy.partial.group_fanout");
    expect(body.resolution.winning_policy_id).toBeNull();
    expect(body.recipient_results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipient: deniedRecipient.username,
          decision: "deny",
          delivery_status: "rejected",
        }),
        expect.objectContaining({
          recipient: askRecipient.username,
          decision: "ask",
          delivery_status: "review_required",
        }),
        expect.objectContaining({
          recipient: allowedRecipient.username,
          decision: "allow",
          delivery_status: "delivered",
        }),
      ])
    );

    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.body?.recipient_connection_id).toBe(allowedConnection.id);
    expect(callbacks[0]?.body?.recipient_connection_id).not.toBe(deniedConnection.id);
    expect(callbacks[0]?.body?.recipient_connection_id).not.toBe(askConnection.id);

    const [storedMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, body.message_id))
      .limit(1);
    expect(storedMessage?.outcome).toBe("partial_sent");

    const fanoutAudit = JSON.parse(storedMessage!.policiesEvaluated!);
    expect(fanoutAudit.partial_delivery).toBe(true);
    expect(fanoutAudit.decision_counts).toEqual(
      expect.objectContaining({
        allow: 1,
        ask: 1,
        deny: 1,
      })
    );
  });
});
