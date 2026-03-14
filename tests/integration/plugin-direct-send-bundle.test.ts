import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server";
import {
  addRoleToFriendship,
  cleanupTestDatabase,
  createAgentConnection,
  createFriendship,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";
import {
  canonicalToStorage,
  type PolicyDirection,
} from "../../src/services/policySchema";
import {
  evaluateDirectSendBundleLocally,
  type DirectSendPolicyBundle,
} from "../../plugins/openclaw-mahilo/src";
import * as schema from "../../src/db/schema";

let app: ReturnType<typeof createApp>;

describe("Plugin direct-send policy bundle endpoint (LPE-010)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("requires authentication", async () => {
    const response = await app.request("/api/v1/plugin/bundles/direct-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: "alice",
      }),
    });

    expect(response.status).toBe(401);
  });

  it("requires an active invite-backed account", async () => {
    const { user: sender, apiKey: senderKey } = await createTestUser(
      "bundle_pending_sender",
    );
    const { user: recipient } = await createTestUser("bundle_pending_recipient");
    const db = getTestDb();
    await db
      .update(schema.users)
      .set({ status: "pending", verifiedAt: null })
      .where(eq(schema.users.id, sender.id));
    await createFriendship(sender.id, recipient.id, "accepted");

    const senderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://bundle_pending_sender",
      framework: "openclaw",
      label: "default",
    });

    const response = await app.request("/api/v1/plugin/bundles/direct-send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipient.username,
        sender_connection_id: senderConnection.id,
      }),
    });

    expect(response.status).toBe(403);
  });

  it("rejects recipients outside the authenticated user's accepted friend graph", async () => {
    const { sender, senderKey, senderConnection, recipient } =
      await setupActiveParticipants("bundle_not_friends");

    const db = getTestDb();
    await db
      .delete(schema.friendships)
      .where(eq(schema.friendships.requesterId, sender.id));

    const response = await app.request("/api/v1/plugin/bundles/direct-send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipient.username,
        sender_connection_id: senderConnection.id,
      }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("NOT_FRIENDS");
  });

  it("selects the highest-priority active sender connection when sender_connection_id is omitted", async () => {
    const db = getTestDb();
    const { user: sender, apiKey: senderKey } = await createTestUser(
      "bundle_default_sender",
    );
    const { user: recipient } = await createTestUser(
      "bundle_default_recipient",
    );

    await db
      .update(schema.users)
      .set({ status: "active", verifiedAt: new Date() })
      .where(eq(schema.users.id, sender.id));
    await db
      .update(schema.users)
      .set({ status: "active", verifiedAt: new Date() })
      .where(eq(schema.users.id, recipient.id));
    await createFriendship(sender.id, recipient.id, "accepted");

    const lowerPriorityConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://bundle_default_sender_low",
      framework: "openclaw",
      label: "fallback",
    });
    const higherPriorityConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://bundle_default_sender_high",
      framework: "openclaw",
      label: "preferred",
    });

    await db
      .update(schema.agentConnections)
      .set({ routingPriority: 5 })
      .where(eq(schema.agentConnections.id, lowerPriorityConnection.id));
    await db
      .update(schema.agentConnections)
      .set({ routingPriority: 50 })
      .where(eq(schema.agentConnections.id, higherPriorityConnection.id));

    const response = await app.request("/api/v1/plugin/bundles/direct-send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipient.username,
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.authenticated_identity).toEqual({
      sender_user_id: sender.id,
      sender_connection_id: higherPriorityConnection.id,
    });
  });

  it("returns a canonical direct-send bundle that the shared resolver can evaluate locally", async () => {
    const db = getTestDb();
    const { sender, senderKey, senderConnection, recipient, friendship } =
      await setupActiveParticipants("bundle_local_eval");
    await addRoleToFriendship(friendship.id, "close_friends");

    const roleAskPolicyId = await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "ask",
      evaluator: "structured",
      policy_content: { intent: "manual_review" },
      priority: 80,
      resource: "location.current",
      scope: "role",
      target_id: "close_friends",
      user_id: sender.id,
    });
    const userLlmDenyPolicyId = await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "deny",
      evaluator: "llm",
      policy_content: "Never share a person's exact location without consent.",
      priority: 100,
      resource: "location.current",
      scope: "user",
      target_id: recipient.id,
      user_id: sender.id,
    });
    await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "deny",
      evaluator: "structured",
      policy_content: {},
      priority: 120,
      resource: "calendar.event",
      scope: "global",
      target_id: null,
      user_id: sender.id,
    });
    await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "deny",
      evaluator: "structured",
      policy_content: {},
      priority: 90,
      resource: "location.current",
      scope: "role",
      target_id: "coworkers",
      user_id: sender.id,
    });

    const response = await app.request("/api/v1/plugin/bundles/direct-send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipient.username,
        sender_connection_id: senderConnection.id,
        declared_selectors: {
          action: "SHARE",
          direction: "outbound",
          resource: "LOCATION.CURRENT",
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.contract_version).toBe("1.0.0");
    expect(body.bundle_type).toBe("direct_send");
    expect(body.bundle_metadata).toEqual(
      expect.objectContaining({
        bundle_id: expect.any(String),
        resolution_id: expect.any(String),
        issued_at: expect.any(String),
        expires_at: expect.any(String),
      }),
    );
    expect(body.authenticated_identity).toEqual({
      sender_user_id: sender.id,
      sender_connection_id: senderConnection.id,
    });
    expect(body.selector_context).toEqual({
      action: "share",
      direction: "outbound",
      resource: "location.current",
    });
    expect(body.recipient).toEqual({
      id: recipient.id,
      type: "user",
      username: recipient.username,
    });
    expect(body.recipient.display_name).toBeUndefined();
    expect(body.recipient.roles).toBeUndefined();
    expect(body.policy_guidance).toBeUndefined();
    expect(body.recent_interactions).toBeUndefined();
    expect(body.sender_connection).toBeUndefined();

    expect(body.applicable_policies).toHaveLength(2);
    expect(
      body.applicable_policies.map((policy: { id: string }) => policy.id),
    ).toEqual([userLlmDenyPolicyId, roleAskPolicyId]);
    expect(body.applicable_policies[0].enabled).toBeUndefined();
    expect(body.applicable_policies[0].updated_at).toBeUndefined();
    expect(body.llm).toEqual({
      subject: recipient.username,
      provider_defaults: null,
    });

    const providerCalls: Array<{
      message: string;
      prompt: string;
      subject: string;
    }> = [];
    const localResult = await evaluateDirectSendBundleLocally(
      body as DirectSendPolicyBundle,
      {
        context: "User asked whether Alice is nearby.",
        message: "Alice is at home right now.",
      },
      {
        llmProviderAdapter: async ({ input, prompt }) => {
          providerCalls.push({
            message: input.message,
            prompt,
            subject: input.subject,
          });
          return {
            model: "gpt-4o-mini",
            provider: "openai",
            text: "FAIL\nPlugin-local LLM policy matched the direct send.",
          };
        },
        llmErrorMode: "ask",
        llmUnavailableMode: "ask",
      },
    );

    expect(providerCalls).toEqual([
      expect.objectContaining({
        message: "Alice is at home right now.",
        subject: recipient.username,
      }),
    ]);
    expect(providerCalls[0]?.prompt).toContain(
      "Never share a person's exact location without consent.",
    );
    expect(localResult.local_decision).toEqual(
      expect.objectContaining({
        decision: "deny",
        delivery_mode: "blocked",
        reason_code: "policy.deny.user.llm",
        summary: "Plugin-local LLM policy matched the direct send.",
        winning_policy_id: userLlmDenyPolicyId,
      }),
    );
    expect(localResult.recipient_results).toEqual([
      expect.objectContaining({
        recipient: recipient.username,
        recipient_id: recipient.id,
        resolution_id: body.bundle_metadata.resolution_id,
        should_send: false,
        transport_action: "block",
        local_decision: expect.objectContaining({
          decision: "deny",
          matched_policy_ids: [roleAskPolicyId, userLlmDenyPolicyId],
        }),
      }),
    ]);
    expect(localResult.commit_payload).toEqual(
      expect.objectContaining({
        recipient: recipient.username,
        recipient_type: "user",
        resolution_id: body.bundle_metadata.resolution_id,
        sender_connection_id: senderConnection.id,
      }),
    );
    expect(localResult.commit_payload.local_decision.evaluated_policies).toHaveLength(
      2,
    );

    const storedMessages = await db
      .select({ id: schema.messages.id })
      .from(schema.messages);
    expect(storedMessages).toHaveLength(0);
  });

  it("surfaces configured provider and model defaults from user preferences for local llm evaluation", async () => {
    const { sender, senderKey, senderConnection, recipient } =
      await setupActiveParticipants("bundle_llm_defaults");

    await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "deny",
      evaluator: "llm",
      policy_content: "Never share private medical details.",
      priority: 100,
      resource: "health.summary",
      scope: "user",
      target_id: recipient.id,
      user_id: sender.id,
    });
    await insertUserPreferences(sender.id, {
      defaultLlmModel: "gpt-4o-mini",
      defaultLlmProvider: "openai",
    });

    const response = await app.request("/api/v1/plugin/bundles/direct-send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipient.username,
        sender_connection_id: senderConnection.id,
        declared_selectors: {
          action: "share",
          direction: "outbound",
          resource: "health.summary",
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.llm).toEqual({
      subject: recipient.username,
      provider_defaults: {
        provider: "openai",
        model: "gpt-4o-mini",
      },
    });
    expect(body.llm.provider_defaults.apiKey).toBeUndefined();
    expect(body.llm.provider_defaults.api_key).toBeUndefined();
  });

  it("keeps deterministic-only local evaluation working when llm defaults are missing", async () => {
    const { sender, senderKey, senderConnection, recipient } =
      await setupActiveParticipants("bundle_deterministic_defaults");

    const userAskPolicyId = await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "ask",
      evaluator: "structured",
      policy_content: { intent: "manual_review" },
      priority: 75,
      resource: "location.current",
      scope: "user",
      target_id: recipient.id,
      user_id: sender.id,
    });

    const response = await app.request("/api/v1/plugin/bundles/direct-send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipient.username,
        sender_connection_id: senderConnection.id,
        declared_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current",
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.llm).toEqual({
      subject: recipient.username,
      provider_defaults: null,
    });

    const localResult = await evaluateDirectSendBundleLocally(
      body as DirectSendPolicyBundle,
      {
        message: "Alice is nearby.",
      },
      {},
    );

    expect(localResult.local_decision).toEqual(
      expect.objectContaining({
        decision: "ask",
        reason_code: "policy.ask.user.structured",
        winning_policy_id: userAskPolicyId,
      }),
    );
    expect(localResult.recipient_results).toEqual([
      expect.objectContaining({
        local_decision: expect.objectContaining({
          decision: "ask",
          matched_policy_ids: [userAskPolicyId],
        }),
        should_send: false,
        transport_action: "hold",
      }),
    ]);
  });
});

async function setupActiveParticipants(suffix: string) {
  const db = getTestDb();
  const { user: sender, apiKey: senderKey } = await createTestUser(
    `sender_${suffix}`,
  );
  const { user: recipient } = await createTestUser(`recipient_${suffix}`);

  await db
    .update(schema.users)
    .set({ status: "active", verifiedAt: new Date() })
    .where(eq(schema.users.id, sender.id));
  await db
    .update(schema.users)
    .set({ status: "active", verifiedAt: new Date() })
    .where(eq(schema.users.id, recipient.id));

  const friendship = await createFriendship(sender.id, recipient.id, "accepted");

  const senderConnection = await createAgentConnection(sender.id, {
    callbackUrl: `polling://sender_${suffix}`,
    framework: "openclaw",
    label: `sender_${suffix}`,
  });

  return {
    friendship,
    recipient,
    sender,
    senderConnection,
    senderKey,
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
    updated_at: null,
    user_id: input.user_id,
    learning_provenance: null,
  };
  const stored = canonicalToStorage(canonical);
  const policyId = `pol_${input.scope}_${input.effect}_${Math.random().toString(36).slice(2, 10)}`;

  await db.insert(schema.policies).values({
    action: stored.action,
    derivedFromMessageId: stored.derivedFromMessageId,
    direction: stored.direction,
    effect: stored.effect,
    effectiveFrom: stored.effectiveFrom,
    enabled: canonical.enabled,
    evaluator: stored.evaluator,
    expiresAt: stored.expiresAt,
    id: policyId,
    maxUses: stored.maxUses,
    policyContent: stored.policyContent,
    policyType: stored.policyType,
    priority: canonical.priority,
    remainingUses: stored.remainingUses,
    resource: stored.resource,
    scope: canonical.scope,
    source: stored.source,
    targetId: canonical.target_id,
    userId: canonical.user_id,
  });

  return policyId;
}

async function insertUserPreferences(
  userId: string,
  input: {
    defaultLlmModel?: string | null;
    defaultLlmProvider?: string | null;
  },
) {
  const db = getTestDb();

  await db.insert(schema.userPreferences).values({
    userId,
    defaultLlmModel: input.defaultLlmModel ?? null,
    defaultLlmProvider: input.defaultLlmProvider ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
