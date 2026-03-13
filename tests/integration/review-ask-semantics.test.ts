import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { config } from "../../src/config";
import { createApp } from "../../src/server";
import {
  canonicalToStorage,
  type PolicyEffect,
} from "../../src/services/policySchema";
import {
  cleanupTestDatabase,
  createAgentConnection,
  createFriendship,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";
import * as schema from "../../src/db/schema";

type InboundAskMode = "review_required" | "hold_for_approval";
type PolicyDirection = "inbound" | "outbound";

let app: ReturnType<typeof createApp>;
let originalTrustedMode: boolean;
let originalInboundAskMode: InboundAskMode;

function setTrustedMode(value: boolean) {
  (config as unknown as { trustedMode: boolean }).trustedMode = value;
}

function setInboundAskMode(value: InboundAskMode) {
  (config as unknown as { inboundAskMode: InboundAskMode }).inboundAskMode =
    value;
}

describe("Review / ask semantics (SRV-023)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    originalTrustedMode = config.trustedMode;
    originalInboundAskMode = config.inboundAskMode;
    setTrustedMode(true);
    setInboundAskMode("review_required");
    app = createApp();
  });

  afterEach(() => {
    setTrustedMode(originalTrustedMode);
    setInboundAskMode(originalInboundAskMode);
    cleanupTestDatabase();
  });

  it("blocks outbound ask sends and returns structured review resolution", async () => {
    const {
      db,
      recipient,
      recipientConnection,
      sender,
      senderConnection,
      senderKey,
    } = await setupParticipants("outbound_ask");

    await insertAlwaysMatchPolicy(sender.id, "ask", "outbound");

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
        message: "share this outbound",
      }),
    });

    expect(sendRes.status).toBe(200);
    const sendData = await sendRes.json();
    expect(sendData.status).toBe("review_required");
    expect(sendData.resolution.decision).toBe("ask");
    expect(sendData.resolution.delivery_mode).toBe("review_required");
    expect(sendData.resolution.reason_code).toContain("policy.ask");
    expect(sendData.recipient_results[0]).toEqual(
      expect.objectContaining({
        recipient: recipient.username,
        decision: "ask",
        delivery_mode: "review_required",
        delivery_status: "review_required",
      }),
    );

    const [storedMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, sendData.message_id))
      .limit(1);
    expect(storedMessage?.status).toBe("review_required");
    expect(storedMessage?.outcome).toBe("ask");
    expect(storedMessage?.rejectionReason).toBeNull();

    const evaluation = JSON.parse(storedMessage?.policiesEvaluated || "{}");
    expect(evaluation.effect).toBe("ask");
    expect(String(evaluation.reason_code)).toContain("policy.ask");
  });

  it("delivers inbound ask decisions in review-required mode", async () => {
    setInboundAskMode("review_required");
    const {
      db,
      recipient,
      recipientConnection,
      sender,
      senderConnection,
      senderKey,
    } = await setupParticipants("inbound_review");

    await insertAlwaysMatchPolicy(recipient.id, "ask", "inbound");

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
        message: "inbound request needs review",
        declared_selectors: {
          direction: "inbound",
          resource: "message.general",
          action: "request",
        },
      }),
    });

    expect(sendRes.status).toBe(200);
    const sendData = await sendRes.json();
    expect(sendData.status).toBe("review_required");
    expect(sendData.delivery_status).toBe("delivered");
    expect(sendData.resolution.decision).toBe("ask");
    expect(sendData.resolution.delivery_mode).toBe("review_required");
    expect(sendData.recipient_results[0]).toEqual(
      expect.objectContaining({
        recipient: recipient.username,
        decision: "ask",
        delivery_mode: "review_required",
        delivery_status: "delivered",
      }),
    );

    const [storedMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, sendData.message_id))
      .limit(1);
    expect(storedMessage?.status).toBe("delivered");
    expect(storedMessage?.outcome).toBe("ask");
    expect(storedMessage?.rejectionReason).toBeNull();
    expect(storedMessage?.deliveredAt).toBeTruthy();

    const evaluation = JSON.parse(storedMessage?.policiesEvaluated || "{}");
    expect(evaluation.effect).toBe("ask");
    expect(String(evaluation.reason_code)).toContain("policy.ask");
  });

  it("holds inbound ask decisions for approval when strict mode is enabled", async () => {
    setInboundAskMode("hold_for_approval");
    const {
      db,
      recipient,
      recipientConnection,
      sender,
      senderConnection,
      senderKey,
    } = await setupParticipants("inbound_hold");

    await insertAlwaysMatchPolicy(recipient.id, "ask", "inbound");

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
        message: "inbound request should be held",
        declared_selectors: {
          direction: "inbound",
          resource: "message.general",
          action: "request",
        },
      }),
    });

    expect(sendRes.status).toBe(200);
    const sendData = await sendRes.json();
    expect(sendData.status).toBe("approval_pending");
    expect(sendData.resolution.decision).toBe("ask");
    expect(sendData.resolution.delivery_mode).toBe("hold_for_approval");
    expect(sendData.recipient_results[0]).toEqual(
      expect.objectContaining({
        recipient: recipient.username,
        decision: "ask",
        delivery_mode: "hold_for_approval",
        delivery_status: "approval_pending",
      }),
    );

    const [storedMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, sendData.message_id))
      .limit(1);
    expect(storedMessage?.status).toBe("approval_pending");
    expect(storedMessage?.outcome).toBe("ask");
    expect(storedMessage?.rejectionReason).toBeNull();
    expect(storedMessage?.deliveredAt).toBeNull();

    const evaluation = JSON.parse(storedMessage?.policiesEvaluated || "{}");
    expect(evaluation.effect).toBe("ask");
    expect(String(evaluation.reason_code)).toContain("policy.ask");
  });

  it("blocks inbound deny before delivery and persists inbound audit metadata", async () => {
    setInboundAskMode("review_required");
    const {
      db,
      recipient,
      recipientConnection,
      sender,
      senderConnection,
      senderKey,
    } = await setupParticipants("inbound_deny");

    await insertAlwaysMatchPolicy(recipient.id, "deny", "inbound");

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
        message: "block this inbound request",
        declared_selectors: {
          direction: "inbound",
          resource: "message.general",
          action: "request",
        },
      }),
    });

    expect(sendRes.status).toBe(200);
    const sendData = await sendRes.json();
    expect(sendData.status).toBe("rejected");
    expect(sendData.resolution.decision).toBe("deny");
    expect(sendData.resolution.delivery_mode).toBe("blocked");
    expect(sendData.recipient_results[0]).toEqual(
      expect.objectContaining({
        recipient: recipient.username,
        decision: "deny",
        delivery_mode: "blocked",
        delivery_status: "rejected",
      }),
    );

    const [storedMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, sendData.message_id))
      .limit(1);
    expect(storedMessage?.status).toBe("rejected");
    expect(storedMessage?.outcome).toBe("deny");
    expect(storedMessage?.rejectionReason).toBeTruthy();
    expect(storedMessage?.deliveredAt).toBeNull();

    const evaluation = JSON.parse(storedMessage?.policiesEvaluated || "{}");
    expect(evaluation.effect).toBe("deny");
    expect(String(evaluation.reason_code)).toContain("policy.deny");
    expect(evaluation.policy_owner_user_id).toBe(recipient.id);
    expect(evaluation.policy_evaluation_mode).toBe("inbound_pre_delivery");
    expect(evaluation.selector_context).toEqual(
      expect.objectContaining({
        direction: "inbound",
        resource: "message.general",
        action: "request",
      }),
    );
  });

  it("resolves inbound ask/deny specificity conflicts using user > global", async () => {
    setInboundAskMode("review_required");
    const {
      db,
      recipient,
      recipientConnection,
      sender,
      senderConnection,
      senderKey,
    } = await setupParticipants("inbound_specificity");

    const globalDeny = canonicalToStorage({
      scope: "global",
      target_id: null,
      direction: "inbound",
      resource: "message.general",
      action: "request",
      effect: "deny",
      evaluator: "structured",
      policy_content: {},
      effective_from: null,
      expires_at: null,
      max_uses: null,
      remaining_uses: null,
      source: "user_created",
      derived_from_message_id: null,
      priority: 500,
      enabled: true,
    });
    const userAsk = canonicalToStorage({
      scope: "user",
      target_id: sender.id,
      direction: "inbound",
      resource: "message.general",
      action: "request",
      effect: "ask",
      evaluator: "structured",
      policy_content: {},
      effective_from: null,
      expires_at: null,
      max_uses: null,
      remaining_uses: null,
      source: "user_created",
      derived_from_message_id: null,
      priority: 1,
      enabled: true,
    });

    const globalDenyId = nanoid();
    const userAskId = nanoid();
    await db.insert(schema.policies).values([
      {
        id: globalDenyId,
        userId: recipient.id,
        scope: "global",
        policyType: globalDeny.policyType,
        policyContent: globalDeny.policyContent,
        direction: globalDeny.direction,
        resource: globalDeny.resource,
        action: globalDeny.action,
        effect: globalDeny.effect,
        evaluator: globalDeny.evaluator,
        effectiveFrom: globalDeny.effectiveFrom,
        expiresAt: globalDeny.expiresAt,
        maxUses: globalDeny.maxUses,
        remainingUses: globalDeny.remainingUses,
        source: globalDeny.source,
        derivedFromMessageId: globalDeny.derivedFromMessageId,
        priority: globalDeny.priority,
        enabled: true,
        createdAt: new Date(),
      },
      {
        id: userAskId,
        userId: recipient.id,
        scope: "user",
        targetId: sender.id,
        policyType: userAsk.policyType,
        policyContent: userAsk.policyContent,
        direction: userAsk.direction,
        resource: userAsk.resource,
        action: userAsk.action,
        effect: userAsk.effect,
        evaluator: userAsk.evaluator,
        effectiveFrom: userAsk.effectiveFrom,
        expiresAt: userAsk.expiresAt,
        maxUses: userAsk.maxUses,
        remainingUses: userAsk.remainingUses,
        source: userAsk.source,
        derivedFromMessageId: userAsk.derivedFromMessageId,
        priority: userAsk.priority,
        enabled: true,
        createdAt: new Date(),
      },
    ]);

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
        message: "inbound conflict resolution",
        declared_selectors: {
          direction: "inbound",
          resource: "message.general",
          action: "request",
        },
      }),
    });

    expect(sendRes.status).toBe(200);
    const sendData = await sendRes.json();
    expect(sendData.status).toBe("review_required");
    expect(sendData.delivery_status).toBe("delivered");
    expect(sendData.resolution.decision).toBe("ask");
    expect(sendData.resolution.delivery_mode).toBe("review_required");
    expect(sendData.resolution.winning_policy_id).toBeUndefined();

    const [storedMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, sendData.message_id))
      .limit(1);
    expect(storedMessage?.status).toBe("delivered");
    expect(storedMessage?.outcome).toBe("ask");

    const evaluation = JSON.parse(storedMessage?.policiesEvaluated || "{}");
    expect(evaluation.effect).toBe("ask");
    expect(evaluation.winning_policy_id).toBe(userAskId);
    expect(evaluation.matched_policy_ids).toEqual(
      expect.arrayContaining([globalDenyId, userAskId]),
    );
  });

  it("records audit fields that distinguish ask from deny", async () => {
    const {
      db,
      recipient,
      recipientConnection,
      sender,
      senderConnection,
      senderKey,
    } = await setupParticipants("ask_vs_deny");

    const askPolicyId = await insertAlwaysMatchPolicy(
      sender.id,
      "ask",
      "outbound",
    );
    const askRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        sender_connection_id: senderConnection.id,
        message: "ask me first",
      }),
    });
    expect(askRes.status).toBe(200);
    const askData = await askRes.json();
    expect(askData.status).toBe("review_required");

    await db
      .update(schema.policies)
      .set({ enabled: false })
      .where(eq(schema.policies.id, askPolicyId));
    await insertAlwaysMatchPolicy(sender.id, "deny", "outbound");

    const denyRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        sender_connection_id: senderConnection.id,
        message: "deny this",
      }),
    });
    expect(denyRes.status).toBe(200);
    const denyData = await denyRes.json();
    expect(denyData.status).toBe("rejected");
    expect(denyData.resolution.decision).toBe("deny");
    expect(denyData.resolution.delivery_mode).toBe("blocked");

    const [askMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, askData.message_id))
      .limit(1);
    const [denyMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, denyData.message_id))
      .limit(1);

    expect(askMessage?.status).toBe("review_required");
    expect(askMessage?.outcome).toBe("ask");
    expect(askMessage?.rejectionReason).toBeNull();

    expect(denyMessage?.status).toBe("rejected");
    expect(denyMessage?.outcome).toBe("deny");
    expect(denyMessage?.rejectionReason).toBeTruthy();

    const askEvaluation = JSON.parse(askMessage?.policiesEvaluated || "{}");
    const denyEvaluation = JSON.parse(denyMessage?.policiesEvaluated || "{}");
    expect(String(askEvaluation.reason_code)).toContain("policy.ask");
    expect(String(denyEvaluation.reason_code)).toContain("policy.deny");
  });
});

async function setupParticipants(suffix: string) {
  const db = getTestDb();
  const { user: sender, apiKey: senderKey } = await createTestUser(
    `sender_${suffix}`,
  );
  const { user: recipient } = await createTestUser(`recipient_${suffix}`);

  await db
    .update(schema.users)
    .set({ status: "active", verifiedAt: new Date() })
    .where(eq(schema.users.id, sender.id));

  await createFriendship(sender.id, recipient.id, "accepted");

  const senderConnection = await createAgentConnection(sender.id, {
    callbackUrl: `polling://sender_${suffix}`,
  });
  const recipientConnection = await createAgentConnection(recipient.id, {
    callbackUrl: `polling://recipient_${suffix}`,
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

async function insertAlwaysMatchPolicy(
  userId: string,
  effect: PolicyEffect,
  direction: PolicyDirection,
): Promise<string> {
  const db = getTestDb();
  const policyId = nanoid();
  const storage = canonicalToStorage({
    scope: "global",
    target_id: null,
    direction,
    resource: "message.general",
    action: direction === "inbound" ? "request" : "share",
    effect,
    evaluator: "structured",
    policy_content: {},
    effective_from: null,
    expires_at: null,
    max_uses: null,
    remaining_uses: null,
    source: "user_created",
    derived_from_message_id: null,
    priority: 100,
    enabled: true,
  });

  await db.insert(schema.policies).values({
    id: policyId,
    userId,
    scope: "global",
    policyType: storage.policyType,
    policyContent: storage.policyContent,
    direction: storage.direction,
    resource: storage.resource,
    action: storage.action,
    effect: storage.effect,
    evaluator: storage.evaluator,
    effectiveFrom: storage.effectiveFrom,
    expiresAt: storage.expiresAt,
    maxUses: storage.maxUses,
    remainingUses: storage.remainingUses,
    source: storage.source,
    derivedFromMessageId: storage.derivedFromMessageId,
    priority: 100,
    enabled: true,
    createdAt: new Date(),
  });

  return policyId;
}
