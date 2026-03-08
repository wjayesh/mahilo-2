import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createApp } from "../../src/server";
import { config } from "../../src/config";
import { canonicalToStorage, type PolicyDirection } from "../../src/services/policySchema";
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
let originalTrustedMode: boolean;

function setTrustedMode(value: boolean) {
  (config as unknown as { trustedMode: boolean }).trustedMode = value;
}

describe("Plugin draft resolution endpoint (SRV-041)", () => {
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

  it("requires authentication", async () => {
    const response = await app.request("/api/v1/plugin/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: "alice",
        message: "hello",
      }),
    });

    expect(response.status).toBe(401);
  });

  it("returns structured preflight resolution without creating delivery records", async () => {
    const db = getTestDb();
    const { sender, senderKey, senderConnection, recipient, recipientConnection } =
      await setupParticipants("plugin_resolve_structured");

    const askPolicyId = await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "ask",
      evaluator: "structured",
      policy_content: {},
      priority: 90,
      resource: "message.general",
      scope: "global",
      target_id: null,
      user_id: sender.id,
    });

    const beforeMessages = await db.select({ id: schema.messages.id }).from(schema.messages);

    const response = await app.request("/api/v1/plugin/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: senderConnection.id,
        recipient: recipient.username,
        recipient_type: "user",
        routing_hints: {
          labels: [recipientConnection.label],
        },
        message: "Draft that should require review",
        context: "Checking preflight behavior",
        declared_selectors: {
          direction: "outbound",
          resource: "message.general",
          action: "share",
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.contract_version).toBe("1.0.0");
    expect(body.decision).toBe("ask");
    expect(body.delivery_mode).toBe("review_required");
    expect(body.review).toEqual({ required: true, review_id: null });
    expect(body.resolution_id).toEqual(expect.any(String));
    expect(body.resolution_summary).toEqual(expect.any(String));
    expect(body.agent_guidance).toEqual(expect.any(String));
    expect(body.server_selectors).toEqual({
      direction: "outbound",
      resource: "message.general",
      action: "share",
    });
    expect(body.applied_policy).toEqual(
      expect.objectContaining({
        winning_policy_id: askPolicyId,
      })
    );
    expect(body.matched_policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: askPolicyId,
          effect: "ask",
          scope: "global",
        }),
      ])
    );
    expect(body.recipient_results).toEqual([
      {
        recipient: recipient.username,
        decision: "ask",
        delivery_mode: "review_required",
      },
    ]);
    expect(body.resolved_recipient).toEqual(
      expect.objectContaining({
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        recipient_type: "user",
      })
    );

    const afterMessages = await db.select({ id: schema.messages.id }).from(schema.messages);
    expect(afterMessages).toHaveLength(beforeMessages.length);
  });

  it("matches actual send-time resolution behavior for the same draft", async () => {
    const { sender, senderKey, senderConnection, recipient, recipientConnection } =
      await setupParticipants("plugin_resolve_match_send");

    const denyPolicyId = await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "deny",
      evaluator: "structured",
      policy_content: {},
      priority: 110,
      resource: "location.current",
      scope: "user",
      target_id: recipient.id,
      user_id: sender.id,
    });

    const payload = {
      sender_connection_id: senderConnection.id,
      recipient: recipient.username,
      recipient_type: "user",
      recipient_connection_id: recipientConnection.id,
      message: "Do not share exact location",
      context: "Testing parity between preflight and final send",
      declared_selectors: {
        direction: "outbound",
        resource: "location.current",
        action: "share",
      },
    };

    const preflightResponse = await app.request("/api/v1/plugin/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    expect(preflightResponse.status).toBe(200);
    const preflight = await preflightResponse.json();
    expect(preflight.decision).toBe("deny");
    expect(preflight.applied_policy.winning_policy_id).toBe(denyPolicyId);

    const sendResponse = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    expect(sendResponse.status).toBe(200);
    const sendBody = await sendResponse.json();

    expect(preflight.decision).toBe(sendBody.resolution.decision);
    expect(preflight.delivery_mode).toBe(sendBody.resolution.delivery_mode);
    expect(preflight.reason_code).toBe(sendBody.resolution.reason_code);
    expect(preflight.applied_policy.winning_policy_id).toBe(
      sendBody.resolution.winning_policy_id
    );
    expect(sendBody.recipient_results[0]).toEqual(
      expect.objectContaining({
        recipient: recipient.username,
        decision: "deny",
        delivery_mode: "blocked",
      })
    );
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
    framework: "openclaw",
    label: `sender_${suffix}`,
  });
  const recipientConnection = await createAgentConnection(recipient.id, {
    callbackUrl: `polling://recipient_${suffix}`,
    framework: "openclaw",
    label: `recipient_${suffix}`,
  });

  return {
    sender,
    senderKey,
    senderConnection,
    recipient,
    recipientConnection,
  };
}

async function insertCanonicalPolicy(input: {
  action: string;
  direction: PolicyDirection;
  effect: "allow" | "ask" | "deny";
  evaluator: "structured" | "heuristic" | "llm";
  policy_content: unknown;
  priority: number;
  resource: string;
  scope: "global" | "user" | "role" | "group";
  target_id: string | null;
  user_id: string;
}) {
  const db = getTestDb();
  const canonical = {
    action: input.action,
    derived_from_message_id: null,
    direction: input.direction,
    effective_from: null,
    effect: input.effect,
    enabled: true,
    evaluator: input.evaluator,
    expires_at: null,
    max_uses: null,
    policy_content: input.policy_content,
    priority: input.priority,
    remaining_uses: null,
    resource: input.resource,
    scope: input.scope,
    source: "user_created" as const,
    target_id: input.target_id,
  };

  const storage = canonicalToStorage(canonical);
  const policyId = nanoid();
  await db.insert(schema.policies).values({
    action: storage.action,
    createdAt: new Date(),
    derivedFromMessageId: storage.derivedFromMessageId,
    direction: storage.direction,
    effect: storage.effect,
    effectiveFrom: storage.effectiveFrom,
    enabled: true,
    evaluator: storage.evaluator,
    expiresAt: storage.expiresAt,
    id: policyId,
    maxUses: storage.maxUses,
    policyContent: storage.policyContent,
    policyType: storage.policyType,
    priority: input.priority,
    remainingUses: storage.remainingUses,
    resource: storage.resource,
    scope: input.scope,
    source: storage.source,
    targetId: input.target_id,
    userId: input.user_id,
  });

  return policyId;
}
