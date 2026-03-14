import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { config } from "../../src/config";
import * as schema from "../../src/db/schema";
import { createApp } from "../../src/server";
import {
  canonicalToStorage,
  type PolicyDirection,
} from "../../src/services/policySchema";
import {
  cleanupTestDatabase,
  createAgentConnection,
  createFriendship,
  createTestUser,
  getTestDb,
  setupTestDatabase,
  addRoleToFriendship,
} from "../helpers/setup";
import {
  evaluateDirectSendBundleLocally,
  evaluateGroupFanoutBundleLocally,
  type DirectSendPolicyBundle,
  type GroupFanoutPolicyBundle,
} from "../../plugins/openclaw-mahilo/src";

let app: ReturnType<typeof createApp>;
let originalFetch: typeof globalThis.fetch;
let originalTrustedMode: boolean;
let originalLLMConfig: {
  apiKey: string;
  enabled: boolean;
  model: string;
  timeoutMs: number;
};

interface MutableConfig {
  trustedMode: boolean;
  llm: {
    apiKey: string;
    enabled: boolean;
    model: string;
    timeoutMs: number;
  };
}

interface DirectParticipants {
  friendship: schema.Friendship;
  recipient: schema.User;
  recipientConnection: schema.AgentConnection;
  sender: schema.User;
  senderConnection: schema.AgentConnection;
  senderKey: string;
}

interface DirectPreviewParityCase {
  name: string;
  message: string;
  selectors: {
    action: string;
    direction: PolicyDirection;
    resource: string;
  };
  expectedDecision: "allow" | "ask" | "deny";
  expectedReasonCode: string;
  setup: (participants: DirectParticipants) => Promise<void>;
}

function mutableConfig(): MutableConfig {
  return config as unknown as MutableConfig;
}

function setTrustedMode(value: boolean) {
  mutableConfig().trustedMode = value;
}

function setLLMConfig(overrides: Partial<MutableConfig["llm"]>) {
  Object.assign(mutableConfig().llm, overrides);
}

beforeEach(async () => {
  await setupTestDatabase();
  originalFetch = globalThis.fetch;
  originalTrustedMode = config.trustedMode;
  originalLLMConfig = { ...mutableConfig().llm };
  setTrustedMode(true);
  app = createApp();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setTrustedMode(originalTrustedMode);
  setLLMConfig(originalLLMConfig);
  cleanupTestDatabase();
});

describe("Trusted vs local policy parity (LPE-055)", () => {
  it("keeps deterministic trusted preview and local direct-send evaluation aligned", async () => {
    const cases: DirectPreviewParityCase[] = [
      {
        name: "allow when selector filtering removes unrelated policies",
        message: "The weather is nice today.",
        selectors: {
          action: "share",
          direction: "outbound",
          resource: "message.general",
        },
        expectedDecision: "allow",
        expectedReasonCode: "policy.allow.no_applicable",
        setup: async ({ sender }) => {
          await insertCanonicalPolicy({
            action: "share",
            direction: "outbound",
            effect: "deny",
            evaluator: "structured",
            policy_content: {},
            priority: 100,
            resource: "location.current",
            scope: "global",
            target_id: null,
            user_id: sender.id,
          });
        },
      },
      {
        name: "ask via role-scoped deterministic policy",
        message: "Alice is on the way.",
        selectors: {
          action: "share",
          direction: "outbound",
          resource: "message.general",
        },
        expectedDecision: "ask",
        expectedReasonCode: "policy.ask.role.structured",
        setup: async ({ friendship, sender }) => {
          await addRoleToFriendship(friendship.id, "close_friends");
          await insertCanonicalPolicy({
            action: "share",
            direction: "outbound",
            effect: "ask",
            evaluator: "structured",
            policy_content: { intent: "manual_review" },
            priority: 80,
            resource: "message.general",
            scope: "role",
            target_id: "close_friends",
            user_id: sender.id,
          });
        },
      },
      {
        name: "deny via user-scoped deterministic policy",
        message: "Alice is at home right now.",
        selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current",
        },
        expectedDecision: "deny",
        expectedReasonCode: "policy.deny.user.structured",
        setup: async ({ recipient, sender }) => {
          await insertCanonicalPolicy({
            action: "share",
            direction: "outbound",
            effect: "deny",
            evaluator: "structured",
            policy_content: {},
            priority: 120,
            resource: "location.current",
            scope: "user",
            target_id: recipient.id,
            user_id: sender.id,
          });
        },
      },
    ];

    for (const testCase of cases) {
      const participants = await setupDirectParticipants(
        `deterministic_${reasonToken(testCase.name)}`,
      );
      await testCase.setup(participants);

      const payload = {
        recipient: participants.recipient.username,
        recipient_type: "user",
        sender_connection_id: participants.senderConnection.id,
        message: testCase.message,
        declared_selectors: {
          action: testCase.selectors.action.toUpperCase(),
          direction: testCase.selectors.direction,
          resource: testCase.selectors.resource.toUpperCase(),
        },
      };

      setTrustedMode(true);
      const trustedResponse = await app.request("/api/v1/plugin/resolve", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${participants.senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      expect(trustedResponse.status).toBe(200);
      const trustedBody = await trustedResponse.json();

      setTrustedMode(false);
      const localBundleResponse = await app.request(
        "/api/v1/plugin/bundles/direct-send",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${participants.senderKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            recipient: participants.recipient.username,
            recipient_type: "user",
            sender_connection_id: participants.senderConnection.id,
            declared_selectors: payload.declared_selectors,
          }),
        },
      );

      expect(localBundleResponse.status).toBe(200);
      const localBundle =
        (await localBundleResponse.json()) as DirectSendPolicyBundle;
      const localResult = await evaluateDirectSendBundleLocally(localBundle, {
        message: testCase.message,
        recipient: participants.recipient.username,
        senderConnectionId: participants.senderConnection.id,
        declaredSelectors: payload.declared_selectors,
      });

      expect(trustedBody.decision).toBe(testCase.expectedDecision);
      expect(trustedBody.reason_code).toBe(testCase.expectedReasonCode);
      expect(localResult.local_decision.decision).toBe(testCase.expectedDecision);
      expect(localResult.local_decision.reason_code).toBe(
        testCase.expectedReasonCode,
      );
      expect(trustedBody.decision).toBe(localResult.local_decision.decision);
      expect(trustedBody.delivery_mode).toBe(
        localResult.local_decision.delivery_mode,
      );
      expect(trustedBody.reason_code).toBe(localResult.local_decision.reason_code);
    }
  });

  it("keeps mocked llm trusted preview and local direct-send evaluation aligned", async () => {
    const participants = await setupDirectParticipants("llm_parity");
    await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "deny",
      evaluator: "llm",
      policy_content: "Never share a person's exact location without consent.",
      priority: 100,
      resource: "location.current",
      scope: "user",
      target_id: participants.recipient.id,
      user_id: participants.sender.id,
    });

    setLLMConfig({
      apiKey: "test-anthropic-key",
      enabled: true,
      model: "claude-test",
      timeoutMs: 5_000,
    });

    const cases = [
      {
        providerText: "PASS\nThe message complies with the policy.",
        expectedDecision: "allow" as const,
        expectedReasonCode: "policy.allow.no_match",
      },
      {
        providerText: "FAIL\nNeed consent for exact location.",
        expectedDecision: "deny" as const,
        expectedReasonCode: "policy.deny.user.llm",
      },
    ];

    for (const testCase of cases) {
      globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url === "https://api.anthropic.com/v1/messages") {
          return new Response(
            JSON.stringify({
              id: "msg_parity_llm",
              type: "message",
              content: [{ type: "text", text: testCase.providerText }],
              stop_reason: "end_turn",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return originalFetch(input, init);
      };

      setTrustedMode(true);
      const trustedResponse = await app.request("/api/v1/plugin/resolve", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${participants.senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recipient: participants.recipient.username,
          recipient_type: "user",
          sender_connection_id: participants.senderConnection.id,
          message: "Alice is at home right now.",
          context: "Checking whether an exact location can be shared.",
          declared_selectors: {
            action: "share",
            direction: "outbound",
            resource: "location.current",
          },
        }),
      });

      expect(trustedResponse.status).toBe(200);
      const trustedBody = await trustedResponse.json();

      setTrustedMode(false);
      const localBundleResponse = await app.request(
        "/api/v1/plugin/bundles/direct-send",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${participants.senderKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            recipient: participants.recipient.username,
            recipient_type: "user",
            sender_connection_id: participants.senderConnection.id,
            declared_selectors: {
              action: "share",
              direction: "outbound",
              resource: "location.current",
            },
          }),
        },
      );

      expect(localBundleResponse.status).toBe(200);
      const localBundle =
        (await localBundleResponse.json()) as DirectSendPolicyBundle;
      const localResult = await evaluateDirectSendBundleLocally(
        localBundle,
        {
          message: "Alice is at home right now.",
          context: "Checking whether an exact location can be shared.",
          recipient: participants.recipient.username,
          senderConnectionId: participants.senderConnection.id,
          declaredSelectors: {
            action: "share",
            direction: "outbound",
            resource: "location.current",
          },
        },
        {
          llmProviderAdapter: async () => ({
            model: "claude-test",
            provider: "anthropic",
            text: testCase.providerText,
          }),
          llmErrorMode: "ask",
          llmUnavailableMode: "ask",
        },
      );

      expect(trustedBody.decision).toBe(testCase.expectedDecision);
      expect(trustedBody.reason_code).toBe(testCase.expectedReasonCode);
      expect(localResult.local_decision.decision).toBe(testCase.expectedDecision);
      expect(localResult.local_decision.reason_code).toBe(
        testCase.expectedReasonCode,
      );
      expect(trustedBody.decision).toBe(localResult.local_decision.decision);
      expect(trustedBody.delivery_mode).toBe(
        localResult.local_decision.delivery_mode,
      );
      expect(trustedBody.reason_code).toBe(localResult.local_decision.reason_code);
    }
  });

  it("commits degraded local llm reviews without claiming an incompatible winning policy", async () => {
    const db = getTestDb();
    const participants = await setupDirectParticipants("llm_degraded_commit");
    await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "deny",
      evaluator: "llm",
      policy_content: "Never share a person's exact location without consent.",
      priority: 100,
      resource: "location.current",
      scope: "user",
      target_id: participants.recipient.id,
      user_id: participants.sender.id,
    });

    await db.insert(schema.userPreferences).values({
      createdAt: new Date(),
      defaultLlmModel: "gpt-4o-mini",
      defaultLlmProvider: "openai",
      quietHoursEnabled: false,
      updatedAt: new Date(),
      urgentBehavior: "preferred_only",
      userId: participants.sender.id,
    });

    setTrustedMode(false);
    const selectors = {
      action: "share",
      direction: "outbound" as const,
      resource: "location.current",
    };
    const localBundleResponse = await app.request(
      "/api/v1/plugin/bundles/direct-send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${participants.senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recipient: participants.recipient.username,
          recipient_type: "user",
          sender_connection_id: participants.senderConnection.id,
          declared_selectors: selectors,
        }),
      },
    );

    expect(localBundleResponse.status).toBe(200);
    const localBundle =
      (await localBundleResponse.json()) as DirectSendPolicyBundle;
    const localResult = await evaluateDirectSendBundleLocally(
      localBundle,
      {
        message: "Alice is at home right now.",
        context: "Checking whether an exact location can be shared.",
        recipient: participants.recipient.username,
        senderConnectionId: participants.senderConnection.id,
        declaredSelectors: selectors,
      },
      {
        llmErrorMode: "ask",
        llmUnavailableMode: "ask",
      },
    );

    expect(localResult.local_decision).toMatchObject({
      decision: "ask",
      delivery_mode: "review_required",
      reason_code: "policy.ask.llm.unavailable",
    });
    expect(localResult.local_decision.winning_policy_id).toBeUndefined();
    expect(localResult.commit_payload.local_decision.winning_policy_id).toBeUndefined();

    const commitResponse = await app.request(
      "/api/v1/plugin/local-decisions/commit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${participants.senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(localResult.commit_payload),
      },
    );

    expect(commitResponse.status).toBe(200);
    const commitBody = await commitResponse.json();
    expect(commitBody).toMatchObject({
      status: "review_required",
      resolution: {
        decision: "ask",
        reason_code: "policy.ask.llm.unavailable",
      },
    });
  });

  it("keeps lifecycle-limited direct decisions aligned once local parity is compared at commit time", async () => {
    const trusted = await setupDirectParticipants("trusted_lifecycle_parity");
    const local = await setupDirectParticipants("local_lifecycle_parity");

    const trustedAskPolicyId = await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "ask",
      evaluator: "structured",
      policy_content: {},
      priority: 1,
      resource: "message.general",
      scope: "user",
      target_id: trusted.recipient.id,
      user_id: trusted.sender.id,
      max_uses: 1,
      remaining_uses: 1,
      source: "override",
    });
    await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "allow",
      evaluator: "structured",
      policy_content: {},
      priority: 50,
      resource: "message.general",
      scope: "global",
      target_id: null,
      user_id: trusted.sender.id,
    });

    const localAskPolicyId = await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "ask",
      evaluator: "structured",
      policy_content: {},
      priority: 1,
      resource: "message.general",
      scope: "user",
      target_id: local.recipient.id,
      user_id: local.sender.id,
      max_uses: 1,
      remaining_uses: 1,
      source: "override",
    });
    await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "allow",
      evaluator: "structured",
      policy_content: {},
      priority: 50,
      resource: "message.general",
      scope: "global",
      target_id: null,
      user_id: local.sender.id,
    });

    setTrustedMode(true);
    const trustedFirstSend = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${trusted.senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: trusted.senderConnection.id,
        recipient: trusted.recipient.username,
        recipient_connection_id: trusted.recipientConnection.id,
        recipient_type: "user",
        message: "Please review this once before it goes out.",
      }),
    });

    expect(trustedFirstSend.status).toBe(200);
    const trustedFirstBody = await trustedFirstSend.json();
    expect(trustedFirstBody.status).toBe("review_required");
    expect(await getPolicyRemainingUses(trustedAskPolicyId)).toBe(0);

    const trustedSecondSend = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${trusted.senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: trusted.senderConnection.id,
        recipient: trusted.recipient.username,
        recipient_connection_id: trusted.recipientConnection.id,
        recipient_type: "user",
        message: "Please review this once before it goes out.",
      }),
    });

    expect(trustedSecondSend.status).toBe(200);
    const trustedSecondBody = await trustedSecondSend.json();
    expect(trustedSecondBody.status).toBe("delivered");

    setTrustedMode(false);
    const localFirstBundleResponse = await app.request(
      "/api/v1/plugin/bundles/direct-send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${local.senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recipient: local.recipient.username,
          recipient_type: "user",
          sender_connection_id: local.senderConnection.id,
        }),
      },
    );

    expect(localFirstBundleResponse.status).toBe(200);
    const localFirstBundle =
      (await localFirstBundleResponse.json()) as DirectSendPolicyBundle;
    const localFirstResult = await evaluateDirectSendBundleLocally(
      localFirstBundle,
      {
        message: "Please review this once before it goes out.",
        recipient: local.recipient.username,
        senderConnectionId: local.senderConnection.id,
      },
    );

    expect(localFirstResult.local_decision.decision).toBe("ask");
    // Bundles are intentionally side-effect free; lifecycle mutation starts on commit.
    expect(await getPolicyRemainingUses(localAskPolicyId)).toBe(1);

    const localCommitResponse = await app.request(
      "/api/v1/plugin/local-decisions/commit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${local.senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(localFirstResult.commit_payload),
      },
    );

    expect(localCommitResponse.status).toBe(200);
    const localCommitBody = await localCommitResponse.json();
    expect(localCommitBody.status).toBe("review_required");
    expect(await getPolicyRemainingUses(localAskPolicyId)).toBe(0);

    const localSecondBundleResponse = await app.request(
      "/api/v1/plugin/bundles/direct-send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${local.senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recipient: local.recipient.username,
          recipient_type: "user",
          sender_connection_id: local.senderConnection.id,
        }),
      },
    );

    expect(localSecondBundleResponse.status).toBe(200);
    const localSecondBundle =
      (await localSecondBundleResponse.json()) as DirectSendPolicyBundle;
    const localSecondResult = await evaluateDirectSendBundleLocally(
      localSecondBundle,
      {
        message: "Please review this once before it goes out.",
        recipient: local.recipient.username,
        senderConnectionId: local.senderConnection.id,
      },
    );

    expect(
      [
        trustedFirstBody.resolution.decision,
        trustedSecondBody.resolution.decision,
      ],
    ).toEqual([
      localFirstResult.local_decision.decision,
      localSecondResult.local_decision.decision,
    ]);
    expect(trustedFirstBody.resolution.reason_code).toBe(
      localFirstResult.local_decision.reason_code,
    );
    expect(trustedSecondBody.resolution.reason_code).toBe(
      localSecondResult.local_decision.reason_code,
    );
  });

  it("keeps trusted group fanout and local group bundle evaluation aligned for partial fanout", async () => {
    const db = getTestDb();
    const { user: sender, apiKey: senderKey } =
      await createTestUser("group_parity_sender");
    const { user: deniedRecipient } = await createTestUser("group_parity_denied");
    const { user: askRecipient } = await createTestUser("group_parity_ask");
    const { user: allowedRecipient } =
      await createTestUser("group_parity_allowed");

    const senderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://group_parity_sender",
      framework: "openclaw",
      label: "group_parity_sender",
    });
    await createAgentConnection(deniedRecipient.id, {
      callbackUrl: "polling://group_parity_denied",
      framework: "openclaw",
      label: "group_parity_denied",
    });
    await createAgentConnection(askRecipient.id, {
      callbackUrl: "polling://group_parity_ask",
      framework: "openclaw",
      label: "group_parity_ask",
    });
    await createAgentConnection(allowedRecipient.id, {
      callbackUrl: "polling://group_parity_allowed",
      framework: "openclaw",
      label: "group_parity_allowed",
    });

    const group = await createGroup(sender.id, [
      deniedRecipient.id,
      askRecipient.id,
      allowedRecipient.id,
    ]);

    await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "allow",
      evaluator: "structured",
      policy_content: {},
      priority: 10,
      resource: "message.general",
      scope: "group",
      target_id: group.id,
      user_id: sender.id,
    });
    await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "deny",
      evaluator: "structured",
      policy_content: {},
      priority: 100,
      resource: "message.general",
      scope: "user",
      target_id: deniedRecipient.id,
      user_id: sender.id,
    });
    await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "ask",
      evaluator: "structured",
      policy_content: { intent: "manual_review" },
      priority: 100,
      resource: "message.general",
      scope: "user",
      target_id: askRecipient.id,
      user_id: sender.id,
    });

    setTrustedMode(true);
    const trustedResponse = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: senderConnection.id,
        recipient: group.id,
        recipient_type: "group",
        message: "Weekend plan update",
      }),
    });

    expect(trustedResponse.status).toBe(200);
    const trustedBody = await trustedResponse.json();

    setTrustedMode(false);
    const localBundleResponse = await app.request(
      "/api/v1/plugin/bundles/group-fanout",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender_connection_id: senderConnection.id,
          recipient: group.id,
          recipient_type: "group",
        }),
      },
    );

    expect(localBundleResponse.status).toBe(200);
    const localBundle =
      (await localBundleResponse.json()) as GroupFanoutPolicyBundle;
    const localResult = await evaluateGroupFanoutBundleLocally(localBundle, {
      message: "Weekend plan update",
      recipient: group.id,
      senderConnectionId: senderConnection.id,
    });

    expect(trustedBody.resolution.decision).toBe(localResult.aggregate.decision);
    expect(trustedBody.resolution.reason_code).toBe(
      localResult.aggregate.reason_code,
    );
    expect(localResult.aggregate.partial_delivery).toBe(true);
    expect(localResult.aggregate.counts).toEqual({
      delivered: trustedBody.delivered,
      pending: trustedBody.pending,
      denied: trustedBody.denied,
      review_required: trustedBody.review_required,
      failed: trustedBody.failed,
    });

    expect(toTrustedDecisionMap(trustedBody.recipient_results)).toEqual(
      toLocalDecisionMap(localResult.recipient_results),
    );
    expect(toTrustedDeliveredRecipients(trustedBody.recipient_results)).toEqual(
      toLocalSendableRecipients(localResult.recipient_results),
    );

    const deliveries = await db
      .select({ status: schema.messageDeliveries.status })
      .from(schema.messageDeliveries)
      .where(eq(schema.messageDeliveries.messageId, trustedBody.message_id));
    expect(deliveries).toHaveLength(3);
  });
});

async function setupDirectParticipants(suffix: string): Promise<DirectParticipants> {
  const { user: sender, apiKey: senderKey } = await createTestUser(
    `sender_${suffix}`,
  );
  const { user: recipient } = await createTestUser(`recipient_${suffix}`);
  const friendship = await createFriendship(sender.id, recipient.id, "accepted");
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
    friendship,
    recipient,
    recipientConnection,
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
  scope: "global" | "group" | "role" | "user";
  target_id: string | null;
  user_id: string;
  max_uses?: number | null;
  remaining_uses?: number | null;
  source?: "override" | "user_created";
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
    max_uses: input.max_uses ?? null,
    policy_content: input.policy_content,
    priority: input.priority,
    remaining_uses: input.remaining_uses ?? null,
    resource: input.resource,
    scope: input.scope,
    source: input.source ?? ("user_created" as const),
    target_id: input.target_id,
    updated_at: null,
    user_id: input.user_id,
    learning_provenance: null,
  };
  const stored = canonicalToStorage(canonical);
  const policyId = `pol_${input.scope}_${input.effect}_${nanoid(8)}`;

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
    createdAt: new Date(),
  });

  return policyId;
}

async function getPolicyRemainingUses(policyId: string) {
  const db = getTestDb();
  const [policy] = await db
    .select({ remainingUses: schema.policies.remainingUses })
    .from(schema.policies)
    .where(eq(schema.policies.id, policyId))
    .limit(1);

  return policy?.remainingUses ?? null;
}

async function createGroup(ownerUserId: string, memberUserIds: string[]) {
  const db = getTestDb();
  const group = {
    id: `grp_${nanoid(10)}`,
    name: `group-${nanoid(6)}`,
  };

  await db.insert(schema.groups).values({
    id: group.id,
    name: group.name,
    ownerUserId,
    inviteOnly: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(schema.groupMemberships).values([
    {
      id: nanoid(),
      groupId: group.id,
      userId: ownerUserId,
      role: "owner",
      status: "active",
      invitedByUserId: ownerUserId,
      createdAt: new Date(),
    },
    ...memberUserIds.map((userId) => ({
      id: nanoid(),
      groupId: group.id,
      userId,
      role: "member",
      status: "active" as const,
      invitedByUserId: ownerUserId,
      createdAt: new Date(),
    })),
  ]);

  return group;
}

function toTrustedDecisionMap(
  recipientResults: Array<{ recipient: string; decision: string }>,
) {
  return new Map(
    recipientResults.map((entry) => [entry.recipient, entry.decision]),
  );
}

function toLocalDecisionMap(
  recipientResults: Array<{
    recipient: string;
    local_decision: { decision: string };
  }>,
) {
  return new Map(
    recipientResults.map((entry) => [
      entry.recipient,
      entry.local_decision.decision,
    ]),
  );
}

function toTrustedDeliveredRecipients(
  recipientResults: Array<{ delivery_status: string; recipient: string }>,
) {
  return recipientResults
    .filter((entry) => entry.delivery_status === "delivered")
    .map((entry) => entry.recipient)
    .sort();
}

function toLocalSendableRecipients(
  recipientResults: Array<{ recipient: string; should_send: boolean }>,
) {
  return recipientResults
    .filter((entry) => entry.should_send)
    .map((entry) => entry.recipient)
    .sort();
}

function reasonToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}
