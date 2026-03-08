import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { nanoid } from "nanoid";
import { createApp } from "../../src/server";
import { canonicalToStorage } from "../../src/services/policySchema";
import {
  addRoleToFriendship,
  cleanupTestDatabase,
  createAgentConnection,
  createFriendship,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";
import * as schema from "../../src/db/schema";

let app: ReturnType<typeof createApp>;

describe("Plugin context endpoint v2 (SRV-040)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("requires authentication", async () => {
    const response = await app.request("/api/v1/plugin/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: "alice",
        recipient_type: "user",
        sender_connection_id: "conn_missing",
      }),
    });

    expect(response.status).toBe(401);
  });

  it("returns selector-aware compact context with resolved guidance", async () => {
    const db = getTestDb();
    const { user: sender, apiKey: senderKey } = await createTestUser("plugin_ctx_sender");
    const { user: recipient } = await createTestUser("plugin_ctx_recipient");
    const friendship = await createFriendship(sender.id, recipient.id, "accepted");
    await addRoleToFriendship(friendship.id, "close_friends");

    const senderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://plugin_ctx_sender",
      framework: "openclaw",
      label: "default",
    });
    await createAgentConnection(recipient.id, {
      callbackUrl: "polling://plugin_ctx_recipient",
      framework: "openclaw",
      label: "default",
    });

    const askPolicyId = await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "ask",
      evaluator: "structured",
      policy_content: {},
      priority: 80,
      resource: "location.current",
      scope: "role",
      target_id: "close_friends",
      user_id: sender.id,
    });
    await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "deny",
      evaluator: "llm",
      policy_content: "Do not share detailed calendar events",
      priority: 100,
      resource: "calendar.event",
      scope: "global",
      target_id: null,
      user_id: sender.id,
    });

    await db.insert(schema.messages).values([
      {
        action: "share",
        createdAt: new Date("2026-03-08T10:00:00.000Z"),
        direction: "outbound",
        id: nanoid(),
        outcome: "ask",
        payload:
          "Shared a city-level location update with extra context to verify compact summarization for plugin usage.",
        policiesEvaluated: JSON.stringify({
          effect: "ask",
          matched_policy_ids: [askPolicyId],
          reason_code: "policy.ask.role.structured",
          winning_policy_id: askPolicyId,
        }),
        recipientConnectionId: null,
        recipientId: recipient.id,
        recipientType: "user",
        resource: "location.current",
        senderAgent: "test-agent",
        senderConnectionId: senderConnection.id,
        senderUserId: sender.id,
        status: "review_required",
      },
      {
        action: "reply",
        createdAt: new Date("2026-03-08T11:00:00.000Z"),
        direction: "inbound",
        id: nanoid(),
        outcome: "allow",
        payload: "Recipient replied with a safe acknowledgement.",
        policiesEvaluated: JSON.stringify({
          effect: "allow",
          reason_code: "policy.allow.no_match",
        }),
        recipientConnectionId: null,
        recipientId: sender.id,
        recipientType: "user",
        resource: "message.general",
        senderAgent: "test-agent",
        senderConnectionId: null,
        senderUserId: recipient.id,
        status: "delivered",
      },
    ]);

    const response = await app.request("/api/v1/plugin/context", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        draft_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current",
        },
        include_recent_interactions: true,
        interaction_limit: 2,
        recipient: recipient.username,
        recipient_type: "user",
        sender_connection_id: senderConnection.id,
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.contract_version).toBe("1.0.0");
    expect(data.recipient).toEqual(
      expect.objectContaining({
        id: recipient.id,
        relationship: "friend",
        username: recipient.username,
      })
    );
    expect(data.recipient.roles).toContain("close_friends");
    expect(data.sender_connection).toEqual(
      expect.objectContaining({
        id: senderConnection.id,
        label: senderConnection.label,
      })
    );
    expect(data.suggested_selectors).toEqual({
      action: "share",
      direction: "outbound",
      resource: "location.current",
    });

    expect(data.policy_guidance.default_decision).toBe("ask");
    expect(String(data.policy_guidance.reason_code)).toContain("context.ask.role");
    expect(data.policy_guidance.winning_policy_id).toBe(askPolicyId);
    expect(data.policy_guidance.relevant_policies).toHaveLength(1);
    expect(data.policy_guidance.relevant_policies[0]).toEqual(
      expect.objectContaining({
        effect: "ask",
        id: askPolicyId,
        scope: "role",
      })
    );
    expect(data.policy_guidance.relevant_policies[0].selectors).toEqual(
      expect.objectContaining({
        action: "share",
        direction: "outbound",
        resource: "location.current",
      })
    );

    expect(data.recent_interactions).toHaveLength(2);
    expect(data.recent_interactions[0]).toEqual(
      expect.objectContaining({
        direction: "inbound",
        message_id: expect.any(String),
        timestamp: "2026-03-08T11:00:00.000Z",
      })
    );
    expect(data.recent_interactions[1]).toEqual(
      expect.objectContaining({
        direction: "outbound",
        message_id: expect.any(String),
        timestamp: "2026-03-08T10:00:00.000Z",
      })
    );
    expect(typeof data.recent_interactions[1].summary).toBe("string");
    expect(data.recent_interactions[1].summary.length).toBeLessThanOrEqual(140);

    expect(data.policy_guidance.relevant_decisions).toHaveLength(2);
    expect(data.policy_guidance.relevant_decisions[1]).toEqual(
      expect.objectContaining({
        decision: "ask",
        message_id: expect.any(String),
        reason_code: "policy.ask.role.structured",
        winning_policy_id: askPolicyId,
      })
    );
    expect(data.policy_guidance.summary.length).toBeGreaterThan(0);
  });

  it("rejects unknown or inactive sender connection and supports skipping interaction payload", async () => {
    const { user: sender, apiKey: senderKey } = await createTestUser("plugin_ctx_sender_2");
    const { user: recipient } = await createTestUser("plugin_ctx_recipient_2");
    await createFriendship(sender.id, recipient.id, "accepted");

    const senderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://plugin_ctx_sender_2",
      framework: "openclaw",
      label: "default",
    });

    const missingConnectionResponse = await app.request("/api/v1/plugin/context", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipient.username,
        recipient_type: "user",
        sender_connection_id: "conn_missing",
      }),
    });

    expect(missingConnectionResponse.status).toBe(404);
    const missingBody = await missingConnectionResponse.json();
    expect(missingBody.code).toBe("SENDER_CONNECTION_NOT_FOUND");

    const compactResponse = await app.request("/api/v1/plugin/context", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        include_recent_interactions: false,
        recipient: recipient.username,
        recipient_type: "user",
        sender_connection_id: senderConnection.id,
      }),
    });

    expect(compactResponse.status).toBe(200);
    const compactBody = await compactResponse.json();
    expect(compactBody.recent_interactions).toEqual([]);
    expect(compactBody.policy_guidance.relevant_decisions).toEqual([]);
  });
});

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

type PolicyDirection =
  | "outbound"
  | "inbound"
  | "request"
  | "response"
  | "notification"
  | "error";
