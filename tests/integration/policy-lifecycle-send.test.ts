import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createApp } from "../../src/server";
import { config } from "../../src/config";
import {
  cleanupTestDatabase,
  createAgentConnection,
  createFriendship,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";
import * as schema from "../../src/db/schema";
import { canonicalToStorage } from "../../src/services/policySchema";

let app: ReturnType<typeof createApp>;
let originalTrustedMode: boolean;

function setTrustedMode(value: boolean) {
  (config as unknown as { trustedMode: boolean }).trustedMode = value;
}

describe("Policy lifecycle on send", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    originalTrustedMode = config.trustedMode;
    setTrustedMode(true);
    app = createApp();
  });

  afterEach(() => {
    setTrustedMode(originalTrustedMode);
    cleanupTestDatabase();
  });

  it("consumes one-time overrides after use and stores override provenance in audit", async () => {
    const db = getTestDb();
    const { user: sender, apiKey: senderKey } = await createTestUser("lifecycle_sender_once");
    const { user: recipient } = await createTestUser("lifecycle_recipient_once");

    await db
      .update(schema.users)
      .set({ twitterVerified: true, verificationCode: null })
      .where(eq(schema.users.id, sender.id));

    await createFriendship(sender.id, recipient.id, "accepted");
    const senderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://sender-once",
    });
    const recipientConnection = await createAgentConnection(recipient.id, {
      callbackUrl: "polling://recipient-once",
    });

    const globalDeny = canonicalToStorage({
      scope: "global",
      target_id: null,
      direction: "outbound",
      resource: "message.general",
      action: "share",
      effect: "deny",
      evaluator: "structured",
      policy_content: {},
      effective_from: null,
      expires_at: null,
      max_uses: null,
      remaining_uses: null,
      source: "user_created",
      derived_from_message_id: null,
      priority: 10,
      enabled: true,
    });

    const derivedMessageId = "msg_override_source_001";
    await db.insert(schema.messages).values({
      id: derivedMessageId,
      senderUserId: sender.id,
      senderConnectionId: senderConnection.id,
      senderAgent: "agent",
      recipientType: "user",
      recipientId: recipient.id,
      recipientConnectionId: recipientConnection.id,
      payload: "Seed message for override provenance",
      status: "delivered",
      createdAt: new Date(),
      deliveredAt: new Date(),
    });

    const oneTimeAllow = canonicalToStorage({
      scope: "user",
      target_id: recipient.id,
      direction: "outbound",
      resource: "message.general",
      action: "share",
      effect: "allow",
      evaluator: "structured",
      policy_content: {},
      effective_from: null,
      expires_at: null,
      max_uses: 1,
      remaining_uses: 1,
      source: "override",
      derived_from_message_id: derivedMessageId,
      priority: 1,
      enabled: true,
    });

    const denyPolicyId = nanoid();
    const overridePolicyId = nanoid();
    await db.insert(schema.policies).values([
      {
        id: denyPolicyId,
        userId: sender.id,
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
        priority: 10,
        enabled: true,
        createdAt: new Date(),
      },
      {
        id: overridePolicyId,
        userId: sender.id,
        scope: "user",
        targetId: recipient.id,
        policyType: oneTimeAllow.policyType,
        policyContent: oneTimeAllow.policyContent,
        direction: oneTimeAllow.direction,
        resource: oneTimeAllow.resource,
        action: oneTimeAllow.action,
        effect: oneTimeAllow.effect,
        evaluator: oneTimeAllow.evaluator,
        effectiveFrom: oneTimeAllow.effectiveFrom,
        expiresAt: oneTimeAllow.expiresAt,
        maxUses: oneTimeAllow.maxUses,
        remainingUses: oneTimeAllow.remainingUses,
        source: oneTimeAllow.source,
        derivedFromMessageId: oneTimeAllow.derivedFromMessageId,
        priority: 1,
        enabled: true,
        createdAt: new Date(),
      },
    ]);

    const firstSendRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        sender_connection_id: senderConnection.id,
        message: "share once",
      }),
    });

    expect(firstSendRes.status).toBe(200);
    const firstSendData = await firstSendRes.json();

    const [overrideAfterFirstSend] = await db
      .select({ remainingUses: schema.policies.remainingUses })
      .from(schema.policies)
      .where(eq(schema.policies.id, overridePolicyId))
      .limit(1);
    expect(overrideAfterFirstSend?.remainingUses).toBe(0);

    const [firstMessage] = await db
      .select({
        policiesEvaluated: schema.messages.policiesEvaluated,
        senderConnectionId: schema.messages.senderConnectionId,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, firstSendData.message_id))
      .limit(1);

    expect(firstMessage?.senderConnectionId).toBe(senderConnection.id);
    const firstEvaluation = JSON.parse(firstMessage?.policiesEvaluated || "{}");
    expect(firstEvaluation.authenticated_identity).toEqual({
      sender_user_id: sender.id,
      sender_connection_id: senderConnection.id,
    });
    expect(firstEvaluation.winning_policy_id).toBe(overridePolicyId);
    expect(firstEvaluation.winning_policy?.created_by_user_id).toBe(sender.id);
    expect(firstEvaluation.winning_policy?.source).toBe("override");
    expect(firstEvaluation.winning_policy?.derived_from_message_id).toBe(derivedMessageId);
    const evaluatedOverride = firstEvaluation.evaluated_policies.find(
      (policy: { policy_id: string }) => policy.policy_id === overridePolicyId
    );
    expect(evaluatedOverride?.created_by_user_id).toBe(sender.id);
    expect(evaluatedOverride?.source).toBe("override");

    const secondSendRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        sender_connection_id: senderConnection.id,
        message: "share twice",
      }),
    });

    expect(secondSendRes.status).toBe(200);
    const secondSendData = await secondSendRes.json();
    expect(secondSendData.status).toBe("rejected");

    const [secondMessage] = await db
      .select({
        policiesEvaluated: schema.messages.policiesEvaluated,
        senderConnectionId: schema.messages.senderConnectionId,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, secondSendData.message_id))
      .limit(1);

    expect(secondMessage?.senderConnectionId).toBe(senderConnection.id);
    const secondEvaluation = JSON.parse(secondMessage?.policiesEvaluated || "{}");
    expect(secondEvaluation.authenticated_identity).toEqual({
      sender_user_id: sender.id,
      sender_connection_id: senderConnection.id,
    });
    expect(secondEvaluation.winning_policy_id).toBe(denyPolicyId);
    expect(secondEvaluation.matched_policy_ids).not.toContain(overridePolicyId);
  });

  it("consumes one-time deny overrides when they reject a send", async () => {
    const db = getTestDb();
    const { user: sender, apiKey: senderKey } = await createTestUser("lifecycle_sender_deny_once");
    const { user: recipient } = await createTestUser("lifecycle_recipient_deny_once");

    await db
      .update(schema.users)
      .set({ twitterVerified: true, verificationCode: null })
      .where(eq(schema.users.id, sender.id));

    await createFriendship(sender.id, recipient.id, "accepted");
    const senderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://sender-deny-once",
    });
    const recipientConnection = await createAgentConnection(recipient.id, {
      callbackUrl: "polling://recipient-deny-once",
    });

    const oneTimeDeny = canonicalToStorage({
      scope: "user",
      target_id: recipient.id,
      direction: "outbound",
      resource: "message.general",
      action: "share",
      effect: "deny",
      evaluator: "structured",
      policy_content: {},
      effective_from: null,
      expires_at: null,
      max_uses: 1,
      remaining_uses: 1,
      source: "override",
      derived_from_message_id: null,
      priority: 1,
      enabled: true,
    });
    const fallbackAllow = canonicalToStorage({
      scope: "global",
      target_id: null,
      direction: "outbound",
      resource: "message.general",
      action: "share",
      effect: "allow",
      evaluator: "structured",
      policy_content: {},
      effective_from: null,
      expires_at: null,
      max_uses: null,
      remaining_uses: null,
      source: "user_created",
      derived_from_message_id: null,
      priority: 10,
      enabled: true,
    });

    const denyPolicyId = nanoid();
    const allowPolicyId = nanoid();
    await db.insert(schema.policies).values([
      {
        id: denyPolicyId,
        userId: sender.id,
        scope: "user",
        targetId: recipient.id,
        policyType: oneTimeDeny.policyType,
        policyContent: oneTimeDeny.policyContent,
        direction: oneTimeDeny.direction,
        resource: oneTimeDeny.resource,
        action: oneTimeDeny.action,
        effect: oneTimeDeny.effect,
        evaluator: oneTimeDeny.evaluator,
        effectiveFrom: oneTimeDeny.effectiveFrom,
        expiresAt: oneTimeDeny.expiresAt,
        maxUses: oneTimeDeny.maxUses,
        remainingUses: oneTimeDeny.remainingUses,
        source: oneTimeDeny.source,
        derivedFromMessageId: oneTimeDeny.derivedFromMessageId,
        priority: 1,
        enabled: true,
        createdAt: new Date(),
      },
      {
        id: allowPolicyId,
        userId: sender.id,
        scope: "global",
        policyType: fallbackAllow.policyType,
        policyContent: fallbackAllow.policyContent,
        direction: fallbackAllow.direction,
        resource: fallbackAllow.resource,
        action: fallbackAllow.action,
        effect: fallbackAllow.effect,
        evaluator: fallbackAllow.evaluator,
        effectiveFrom: fallbackAllow.effectiveFrom,
        expiresAt: fallbackAllow.expiresAt,
        maxUses: fallbackAllow.maxUses,
        remainingUses: fallbackAllow.remainingUses,
        source: fallbackAllow.source,
        derivedFromMessageId: fallbackAllow.derivedFromMessageId,
        priority: 10,
        enabled: true,
        createdAt: new Date(),
      },
    ]);

    const firstSendRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        message: "should be blocked once",
      }),
    });

    expect(firstSendRes.status).toBe(200);
    const firstSendData = await firstSendRes.json();
    expect(firstSendData.status).toBe("rejected");

    const [denyAfterFirstSend] = await db
      .select({ remainingUses: schema.policies.remainingUses })
      .from(schema.policies)
      .where(eq(schema.policies.id, denyPolicyId))
      .limit(1);
    expect(denyAfterFirstSend?.remainingUses).toBe(0);

    const [firstMessage] = await db
      .select({
        policiesEvaluated: schema.messages.policiesEvaluated,
        senderConnectionId: schema.messages.senderConnectionId,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, firstSendData.message_id))
      .limit(1);

    expect(firstMessage?.senderConnectionId).toBe(senderConnection.id);
    const firstEvaluation = JSON.parse(firstMessage?.policiesEvaluated || "{}");
    expect(firstEvaluation.authenticated_identity).toEqual({
      sender_user_id: sender.id,
      sender_connection_id: senderConnection.id,
    });
    expect(firstEvaluation.winning_policy_id).toBe(denyPolicyId);
    expect(firstEvaluation.winning_policy?.source).toBe("override");
    expect(firstEvaluation.winning_policy?.created_by_user_id).toBe(sender.id);

    const secondSendRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        message: "should pass after deny is spent",
      }),
    });

    expect(secondSendRes.status).toBe(200);
    const secondSendData = await secondSendRes.json();

    const [secondMessage] = await db
      .select({
        policiesEvaluated: schema.messages.policiesEvaluated,
        senderConnectionId: schema.messages.senderConnectionId,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, secondSendData.message_id))
      .limit(1);

    expect(secondMessage?.senderConnectionId).toBe(senderConnection.id);
    const secondEvaluation = JSON.parse(secondMessage?.policiesEvaluated || "{}");
    expect(secondEvaluation.authenticated_identity).toEqual({
      sender_user_id: sender.id,
      sender_connection_id: senderConnection.id,
    });
    expect(secondEvaluation.winning_policy_id).toBe(allowPolicyId);
    expect(secondEvaluation.matched_policy_ids).not.toContain(denyPolicyId);
  });

  it("consumes one-time ask overrides and falls back after depletion", async () => {
    const db = getTestDb();
    const { user: sender, apiKey: senderKey } = await createTestUser("lifecycle_sender_ask_once");
    const { user: recipient } = await createTestUser("lifecycle_recipient_ask_once");

    await db
      .update(schema.users)
      .set({ twitterVerified: true, verificationCode: null })
      .where(eq(schema.users.id, sender.id));

    await createFriendship(sender.id, recipient.id, "accepted");
    const senderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://sender-ask-once",
    });
    const recipientConnection = await createAgentConnection(recipient.id, {
      callbackUrl: "polling://recipient-ask-once",
    });

    const oneTimeAsk = canonicalToStorage({
      scope: "user",
      target_id: recipient.id,
      direction: "outbound",
      resource: "message.general",
      action: "share",
      effect: "ask",
      evaluator: "structured",
      policy_content: {},
      effective_from: null,
      expires_at: null,
      max_uses: 1,
      remaining_uses: 1,
      source: "override",
      derived_from_message_id: null,
      priority: 1,
      enabled: true,
    });
    const fallbackAllow = canonicalToStorage({
      scope: "global",
      target_id: null,
      direction: "outbound",
      resource: "message.general",
      action: "share",
      effect: "allow",
      evaluator: "structured",
      policy_content: {},
      effective_from: null,
      expires_at: null,
      max_uses: null,
      remaining_uses: null,
      source: "user_created",
      derived_from_message_id: null,
      priority: 50,
      enabled: true,
    });

    const askPolicyId = nanoid();
    const allowPolicyId = nanoid();
    await db.insert(schema.policies).values([
      {
        id: askPolicyId,
        userId: sender.id,
        scope: "user",
        targetId: recipient.id,
        policyType: oneTimeAsk.policyType,
        policyContent: oneTimeAsk.policyContent,
        direction: oneTimeAsk.direction,
        resource: oneTimeAsk.resource,
        action: oneTimeAsk.action,
        effect: oneTimeAsk.effect,
        evaluator: oneTimeAsk.evaluator,
        effectiveFrom: oneTimeAsk.effectiveFrom,
        expiresAt: oneTimeAsk.expiresAt,
        maxUses: oneTimeAsk.maxUses,
        remainingUses: oneTimeAsk.remainingUses,
        source: oneTimeAsk.source,
        derivedFromMessageId: oneTimeAsk.derivedFromMessageId,
        priority: oneTimeAsk.priority,
        enabled: true,
        createdAt: new Date(),
      },
      {
        id: allowPolicyId,
        userId: sender.id,
        scope: "global",
        policyType: fallbackAllow.policyType,
        policyContent: fallbackAllow.policyContent,
        direction: fallbackAllow.direction,
        resource: fallbackAllow.resource,
        action: fallbackAllow.action,
        effect: fallbackAllow.effect,
        evaluator: fallbackAllow.evaluator,
        effectiveFrom: fallbackAllow.effectiveFrom,
        expiresAt: fallbackAllow.expiresAt,
        maxUses: fallbackAllow.maxUses,
        remainingUses: fallbackAllow.remainingUses,
        source: fallbackAllow.source,
        derivedFromMessageId: fallbackAllow.derivedFromMessageId,
        priority: fallbackAllow.priority,
        enabled: true,
        createdAt: new Date(),
      },
    ]);

    const firstSendRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        sender_connection_id: senderConnection.id,
        message: "ask once before sending",
      }),
    });

    expect(firstSendRes.status).toBe(200);
    const firstSendData = await firstSendRes.json();
    expect(firstSendData.status).toBe("review_required");

    const [askAfterFirstSend] = await db
      .select({ remainingUses: schema.policies.remainingUses })
      .from(schema.policies)
      .where(eq(schema.policies.id, askPolicyId))
      .limit(1);
    expect(askAfterFirstSend?.remainingUses).toBe(0);

    const [firstMessage] = await db
      .select({ policiesEvaluated: schema.messages.policiesEvaluated })
      .from(schema.messages)
      .where(eq(schema.messages.id, firstSendData.message_id))
      .limit(1);
    const firstEvaluation = JSON.parse(firstMessage?.policiesEvaluated || "{}");
    expect(firstEvaluation.winning_policy_id).toBe(askPolicyId);

    const secondSendRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        sender_connection_id: senderConnection.id,
        message: "second attempt after ask depletion",
      }),
    });

    expect(secondSendRes.status).toBe(200);
    const secondSendData = await secondSendRes.json();

    const [secondMessage] = await db
      .select({ policiesEvaluated: schema.messages.policiesEvaluated })
      .from(schema.messages)
      .where(eq(schema.messages.id, secondSendData.message_id))
      .limit(1);
    const secondEvaluation = JSON.parse(secondMessage?.policiesEvaluated || "{}");
    expect(secondEvaluation.winning_policy_id).toBe(allowPolicyId);
    expect(secondEvaluation.matched_policy_ids).not.toContain(askPolicyId);
  });

  it("applies expiring overrides before expiry and skips them after expiry", async () => {
    const db = getTestDb();
    const { user: sender, apiKey: senderKey } = await createTestUser("lifecycle_sender_expiry_boundary");
    const { user: recipient } = await createTestUser("lifecycle_recipient_expiry_boundary");

    await db
      .update(schema.users)
      .set({ twitterVerified: true, verificationCode: null })
      .where(eq(schema.users.id, sender.id));

    await createFriendship(sender.id, recipient.id, "accepted");
    const senderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://sender-expiry-boundary",
    });
    const recipientConnection = await createAgentConnection(recipient.id, {
      callbackUrl: "polling://recipient-expiry-boundary",
    });

    const expiresAt = new Date(Date.now() + 1_200).toISOString();
    const expiringDeny = canonicalToStorage({
      scope: "user",
      target_id: recipient.id,
      direction: "outbound",
      resource: "message.general",
      action: "share",
      effect: "deny",
      evaluator: "structured",
      policy_content: {},
      effective_from: new Date(Date.now() - 60_000).toISOString(),
      expires_at: expiresAt,
      max_uses: null,
      remaining_uses: null,
      source: "override",
      derived_from_message_id: null,
      priority: 100,
      enabled: true,
    });
    const fallbackAllow = canonicalToStorage({
      scope: "global",
      target_id: null,
      direction: "outbound",
      resource: "message.general",
      action: "share",
      effect: "allow",
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

    const expiringPolicyId = nanoid();
    const allowPolicyId = nanoid();
    await db.insert(schema.policies).values([
      {
        id: expiringPolicyId,
        userId: sender.id,
        scope: "user",
        targetId: recipient.id,
        policyType: expiringDeny.policyType,
        policyContent: expiringDeny.policyContent,
        direction: expiringDeny.direction,
        resource: expiringDeny.resource,
        action: expiringDeny.action,
        effect: expiringDeny.effect,
        evaluator: expiringDeny.evaluator,
        effectiveFrom: expiringDeny.effectiveFrom,
        expiresAt: expiringDeny.expiresAt,
        maxUses: expiringDeny.maxUses,
        remainingUses: expiringDeny.remainingUses,
        source: expiringDeny.source,
        derivedFromMessageId: expiringDeny.derivedFromMessageId,
        priority: expiringDeny.priority,
        enabled: true,
        createdAt: new Date(),
      },
      {
        id: allowPolicyId,
        userId: sender.id,
        scope: "global",
        policyType: fallbackAllow.policyType,
        policyContent: fallbackAllow.policyContent,
        direction: fallbackAllow.direction,
        resource: fallbackAllow.resource,
        action: fallbackAllow.action,
        effect: fallbackAllow.effect,
        evaluator: fallbackAllow.evaluator,
        effectiveFrom: fallbackAllow.effectiveFrom,
        expiresAt: fallbackAllow.expiresAt,
        maxUses: fallbackAllow.maxUses,
        remainingUses: fallbackAllow.remainingUses,
        source: fallbackAllow.source,
        derivedFromMessageId: fallbackAllow.derivedFromMessageId,
        priority: fallbackAllow.priority,
        enabled: true,
        createdAt: new Date(),
      },
    ]);

    const beforeExpiryRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        sender_connection_id: senderConnection.id,
        message: "should be blocked before expiry",
      }),
    });

    expect(beforeExpiryRes.status).toBe(200);
    const beforeExpiryData = await beforeExpiryRes.json();
    expect(beforeExpiryData.status).toBe("rejected");

    const [beforeExpiryMessage] = await db
      .select({ policiesEvaluated: schema.messages.policiesEvaluated })
      .from(schema.messages)
      .where(eq(schema.messages.id, beforeExpiryData.message_id))
      .limit(1);
    const beforeExpiryEvaluation = JSON.parse(beforeExpiryMessage?.policiesEvaluated || "{}");
    expect(beforeExpiryEvaluation.winning_policy_id).toBe(expiringPolicyId);

    await new Promise((resolve) => setTimeout(resolve, 1_400));

    const afterExpiryRes = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderKey}`,
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        sender_connection_id: senderConnection.id,
        message: "should pass after expiry",
      }),
    });

    expect(afterExpiryRes.status).toBe(200);
    const afterExpiryData = await afterExpiryRes.json();

    const [afterExpiryMessage] = await db
      .select({ policiesEvaluated: schema.messages.policiesEvaluated })
      .from(schema.messages)
      .where(eq(schema.messages.id, afterExpiryData.message_id))
      .limit(1);
    const afterExpiryEvaluation = JSON.parse(afterExpiryMessage?.policiesEvaluated || "{}");
    expect(afterExpiryEvaluation.winning_policy_id).toBe(allowPolicyId);
    expect(afterExpiryEvaluation.matched_policy_ids).not.toContain(expiringPolicyId);
  });

  it("stops applying expired rules automatically", async () => {
    const db = getTestDb();
    const { user: sender, apiKey: senderKey } = await createTestUser("lifecycle_sender_expired");
    const { user: recipient } = await createTestUser("lifecycle_recipient_expired");

    await db
      .update(schema.users)
      .set({ twitterVerified: true, verificationCode: null })
      .where(eq(schema.users.id, sender.id));

    await createFriendship(sender.id, recipient.id, "accepted");
    const senderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://sender-expired",
    });
    const recipientConnection = await createAgentConnection(recipient.id, {
      callbackUrl: "polling://recipient-expired",
    });

    const expiredDeny = canonicalToStorage({
      scope: "global",
      target_id: null,
      direction: "outbound",
      resource: "message.general",
      action: "share",
      effect: "deny",
      evaluator: "structured",
      policy_content: {},
      effective_from: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() - 1_000).toISOString(),
      max_uses: null,
      remaining_uses: null,
      source: "override",
      derived_from_message_id: null,
      priority: 100,
      enabled: true,
    });

    const activeAllow = canonicalToStorage({
      scope: "global",
      target_id: null,
      direction: "outbound",
      resource: "message.general",
      action: "share",
      effect: "allow",
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

    const expiredPolicyId = nanoid();
    const activePolicyId = nanoid();
    await db.insert(schema.policies).values([
      {
        id: expiredPolicyId,
        userId: sender.id,
        scope: "global",
        policyType: expiredDeny.policyType,
        policyContent: expiredDeny.policyContent,
        direction: expiredDeny.direction,
        resource: expiredDeny.resource,
        action: expiredDeny.action,
        effect: expiredDeny.effect,
        evaluator: expiredDeny.evaluator,
        effectiveFrom: expiredDeny.effectiveFrom,
        expiresAt: expiredDeny.expiresAt,
        maxUses: expiredDeny.maxUses,
        remainingUses: expiredDeny.remainingUses,
        source: expiredDeny.source,
        derivedFromMessageId: expiredDeny.derivedFromMessageId,
        priority: 100,
        enabled: true,
        createdAt: new Date(),
      },
      {
        id: activePolicyId,
        userId: sender.id,
        scope: "global",
        policyType: activeAllow.policyType,
        policyContent: activeAllow.policyContent,
        direction: activeAllow.direction,
        resource: activeAllow.resource,
        action: activeAllow.action,
        effect: activeAllow.effect,
        evaluator: activeAllow.evaluator,
        effectiveFrom: activeAllow.effectiveFrom,
        expiresAt: activeAllow.expiresAt,
        maxUses: activeAllow.maxUses,
        remainingUses: activeAllow.remainingUses,
        source: activeAllow.source,
        derivedFromMessageId: activeAllow.derivedFromMessageId,
        priority: 1,
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
        message: "expired rules should not block this",
      }),
    });

    expect(sendRes.status).toBe(200);
    const sendData = await sendRes.json();
    const [storedMessage] = await db
      .select({
        policiesEvaluated: schema.messages.policiesEvaluated,
        senderConnectionId: schema.messages.senderConnectionId,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, sendData.message_id))
      .limit(1);

    expect(storedMessage?.senderConnectionId).toBe(senderConnection.id);
    const evaluation = JSON.parse(storedMessage?.policiesEvaluated || "{}");
    expect(evaluation.authenticated_identity).toEqual({
      sender_user_id: sender.id,
      sender_connection_id: senderConnection.id,
    });
    expect(evaluation.winning_policy_id).toBe(activePolicyId);
    expect(evaluation.matched_policy_ids).toContain(activePolicyId);
    expect(evaluation.matched_policy_ids).not.toContain(expiredPolicyId);
  });
});
