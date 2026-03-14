import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
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
import { canonicalToStorage } from "../../src/services/policySchema";

let app: ReturnType<typeof createApp>;

describe("Plugin local decision commit contract (LPE-012)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("records local ask and deny decisions without creating delivered messages", async () => {
    const db = getTestDb();
    const { sender, senderKey, senderConnection, recipient } =
      await setupParticipants("local_commit_artifacts");

    const askPolicyId = await insertDirectPolicy({
      userId: sender.id,
      recipientId: recipient.id,
      effect: "ask",
      maxUses: 1,
      remainingUses: 1,
      source: "override",
      priority: 1,
    });

    const askResponse = await app.request(
      "/api/v1/plugin/local-decisions/commit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender_connection_id: senderConnection.id,
          recipient: recipient.username,
          resolution_id: "res_local_commit_ask",
          message: "Need local review before this share goes out.",
          local_decision: {
            decision: "ask",
            delivery_mode: "review_required",
            reason: "Local review is required before sharing.",
            reason_code: "policy.ask.user.structured",
            winning_policy_id: askPolicyId,
          },
        }),
      },
    );

    expect(askResponse.status).toBe(200);
    const askBody = await askResponse.json();
    expect(askBody).toEqual(
      expect.objectContaining({
        recorded: true,
        message_id: expect.any(String),
        status: "review_required",
        resolution: expect.objectContaining({
          resolution_id: "res_local_commit_ask",
          decision: "ask",
          delivery_mode: "review_required",
        }),
      }),
    );

    const [storedAsk] = await db
      .select({
        deliveredAt: schema.messages.deliveredAt,
        outcome: schema.messages.outcome,
        policiesEvaluated: schema.messages.policiesEvaluated,
        recipientConnectionId: schema.messages.recipientConnectionId,
        resolutionId: schema.messages.resolutionId,
        status: schema.messages.status,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, askBody.message_id))
      .limit(1);

    expect(storedAsk).toEqual(
      expect.objectContaining({
        outcome: "ask",
        recipientConnectionId: null,
        resolutionId: "res_local_commit_ask",
        status: "review_required",
      }),
    );
    expect(storedAsk?.deliveredAt).toBeNull();
    expect(storedAsk?.policiesEvaluated).toBeTruthy();

    const askEvaluation = JSON.parse(storedAsk!.policiesEvaluated!);
    expect(askEvaluation.local_decision_commit).toEqual(
      expect.objectContaining({
        resolution_id: "res_local_commit_ask",
      }),
    );
    expect(askEvaluation.winning_policy_id).toBe(askPolicyId);

    const [askPolicyAfterCommit] = await db
      .select({ remainingUses: schema.policies.remainingUses })
      .from(schema.policies)
      .where(eq(schema.policies.id, askPolicyId))
      .limit(1);
    expect(askPolicyAfterCommit?.remainingUses).toBe(0);

    const denyPolicyId = await insertDirectPolicy({
      userId: sender.id,
      recipientId: recipient.id,
      effect: "deny",
      maxUses: null,
      remainingUses: null,
      source: "user_created",
      priority: 5,
    });

    const denyResponse = await app.request(
      "/api/v1/plugin/local-decisions/commit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender_connection_id: senderConnection.id,
          recipient: recipient.username,
          resolution_id: "res_local_commit_deny",
          message: "This local draft should be blocked outright.",
          local_decision: {
            decision: "deny",
            delivery_mode: "blocked",
            reason: "Local deny prevented delivery.",
            reason_code: "policy.deny.user.structured",
            winning_policy_id: denyPolicyId,
          },
        }),
      },
    );

    expect(denyResponse.status).toBe(200);
    const denyBody = await denyResponse.json();
    expect(denyBody).toEqual(
      expect.objectContaining({
        recorded: true,
        message_id: expect.any(String),
        status: "rejected",
        resolution: expect.objectContaining({
          resolution_id: "res_local_commit_deny",
          decision: "deny",
          delivery_mode: "blocked",
        }),
      }),
    );

    const [storedDeny] = await db
      .select({
        deliveredAt: schema.messages.deliveredAt,
        recipientConnectionId: schema.messages.recipientConnectionId,
        rejectionReason: schema.messages.rejectionReason,
        resolutionId: schema.messages.resolutionId,
        status: schema.messages.status,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, denyBody.message_id))
      .limit(1);

    expect(storedDeny).toEqual(
      expect.objectContaining({
        recipientConnectionId: null,
        rejectionReason: "Local deny prevented delivery.",
        resolutionId: "res_local_commit_deny",
        status: "rejected",
      }),
    );
    expect(storedDeny?.deliveredAt).toBeNull();

    const reviewResponse = await app.request(
      "/api/v1/plugin/reviews?direction=outbound&status=review_required",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${senderKey}`,
        },
      },
    );

    expect(reviewResponse.status).toBe(200);
    const reviewBody = await reviewResponse.json();
    expect(reviewBody.reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message_id: askBody.message_id,
          queue_direction: "outbound",
          status: "review_required",
        }),
      ]),
    );

    const blockedResponse = await app.request(
      "/api/v1/plugin/events/blocked?direction=outbound",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${senderKey}`,
        },
      },
    );

    expect(blockedResponse.status).toBe(200);
    const blockedBody = await blockedResponse.json();
    expect(blockedBody.blocked_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message_id: denyBody.message_id,
          queue_direction: "outbound",
          reason_code: "policy.deny.user.structured",
        }),
      ]),
    );
  });

  it("deduplicates local commit retries without double-spending one-time overrides", async () => {
    const db = getTestDb();
    const { sender, senderKey, senderConnection, recipient } =
      await setupParticipants("local_commit_retry");

    const askPolicyId = await insertDirectPolicy({
      userId: sender.id,
      recipientId: recipient.id,
      effect: "ask",
      maxUses: 1,
      remainingUses: 1,
      source: "override",
      priority: 1,
    });

    const requestBody = {
      sender_connection_id: senderConnection.id,
      recipient: recipient.username,
      resolution_id: "res_local_commit_retry",
      message: "Retry-safe local review artifact.",
      idempotency_key: "idem_local_commit_retry",
      local_decision: {
        decision: "ask",
        delivery_mode: "review_required",
        reason: "First local review commit should consume the override once.",
        reason_code: "policy.ask.user.structured",
        winning_policy_id: askPolicyId,
      },
    };

    const firstResponse = await app.request(
      "/api/v1/plugin/local-decisions/commit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
    );

    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json();
    expect(firstBody.recorded).toBe(true);

    const secondResponse = await app.request(
      "/api/v1/plugin/local-decisions/commit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
    );

    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json();
    expect(secondBody).toEqual(
      expect.objectContaining({
        recorded: true,
        deduplicated: true,
        message_id: firstBody.message_id,
      }),
    );

    const conflictingRetry = await app.request(
      "/api/v1/plugin/local-decisions/commit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...requestBody,
          resolution_id: "res_local_commit_retry_conflict",
        }),
      },
    );

    expect(conflictingRetry.status).toBe(409);
    const conflictingBody = await conflictingRetry.json();
    expect(conflictingBody.code).toBe("LOCAL_DECISION_CONFLICT");

    const [policyAfterCommit] = await db
      .select({ remainingUses: schema.policies.remainingUses })
      .from(schema.policies)
      .where(eq(schema.policies.id, askPolicyId))
      .limit(1);
    expect(policyAfterCommit?.remainingUses).toBe(0);

    const committedMessages = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.senderUserId, sender.id),
          eq(schema.messages.resolutionId, "res_local_commit_retry"),
        ),
      );
    expect(committedMessages).toHaveLength(1);

    const [committedMessage] = await db
      .select({ idempotencyKey: schema.messages.idempotencyKey })
      .from(schema.messages)
      .where(eq(schema.messages.id, firstBody.message_id))
      .limit(1);
    expect(committedMessage?.idempotencyKey).toBe("idem_local_commit_retry");
  });

  it("rejects local commits when the winning policy is no longer lifecycle-eligible", async () => {
    const { sender, senderKey, senderConnection, recipient } =
      await setupParticipants("local_commit_stale");

    const spentPolicyId = await insertDirectPolicy({
      userId: sender.id,
      recipientId: recipient.id,
      effect: "allow",
      maxUses: 1,
      remainingUses: 0,
      source: "override",
      priority: 1,
    });

    const response = await app.request(
      "/api/v1/plugin/local-decisions/commit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender_connection_id: senderConnection.id,
          recipient: recipient.username,
          resolution_id: "res_local_commit_stale",
          message:
            "This local allow should fail because the override is already spent.",
          local_decision: {
            decision: "allow",
            delivery_mode: "full_send",
            reason: "Spent override should not be accepted again.",
            reason_code: "policy.allow.user.structured",
            winning_policy_id: spentPolicyId,
          },
        }),
      },
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("LOCAL_DECISION_STALE");
  });

  it("ties local allow commits to the later send path with resolution-based idempotency", async () => {
    const db = getTestDb();
    const {
      sender,
      senderKey,
      senderConnection,
      recipient,
      recipientConnection,
    } = await setupParticipants("local_commit_allow_send");

    const allowPolicyId = await insertDirectPolicy({
      userId: sender.id,
      recipientId: recipient.id,
      effect: "allow",
      maxUses: 1,
      remainingUses: 1,
      source: "override",
      priority: 1,
    });
    await insertDirectPolicy({
      userId: sender.id,
      recipientId: recipient.id,
      effect: "deny",
      maxUses: null,
      remainingUses: null,
      source: "user_created",
      priority: 5,
    });

    const resolutionId = "res_local_allow_send";
    const committedMessage = "Local allow should bind to the real send path.";
    const sharedIdempotencyKey = "idem_local_allow_send_shared";

    const commitResponse = await app.request(
      "/api/v1/plugin/local-decisions/commit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender_connection_id: senderConnection.id,
          recipient: recipient.username,
          resolution_id: resolutionId,
          message: committedMessage,
          idempotency_key: sharedIdempotencyKey,
          local_decision: {
            decision: "allow",
            delivery_mode: "full_send",
            reason: "Local policy evaluation allowed this draft.",
            reason_code: "policy.allow.user.structured",
            winning_policy_id: allowPolicyId,
          },
        }),
      },
    );

    expect(commitResponse.status).toBe(200);
    const commitBody = await commitResponse.json();
    expect(commitBody).toEqual(
      expect.objectContaining({
        recorded: true,
        message_id: expect.any(String),
        status: "pending",
        resolution: expect.objectContaining({
          resolution_id: resolutionId,
          decision: "allow",
          delivery_mode: "full_send",
        }),
      }),
    );

    const [policyAfterCommit] = await db
      .select({ remainingUses: schema.policies.remainingUses })
      .from(schema.policies)
      .where(eq(schema.policies.id, allowPolicyId))
      .limit(1);
    expect(policyAfterCommit?.remainingUses).toBe(0);

    const sendResponse = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: senderConnection.id,
        recipient: recipient.username,
        recipient_connection_id: recipientConnection.id,
        recipient_type: "user",
        message: committedMessage,
        resolution_id: resolutionId,
        idempotency_key: sharedIdempotencyKey,
      }),
    });

    expect(sendResponse.status).toBe(200);
    const sendBody = await sendResponse.json();
    expect(sendBody.deduplicated).toBeUndefined();
    expect(sendBody).toEqual(
      expect.objectContaining({
        message_id: commitBody.message_id,
        status: "delivered",
        resolution: expect.objectContaining({
          resolution_id: resolutionId,
          decision: "allow",
        }),
      }),
    );

    const [storedMessage] = await db
      .select({
        deliveredAt: schema.messages.deliveredAt,
        idempotencyKey: schema.messages.idempotencyKey,
        policiesEvaluated: schema.messages.policiesEvaluated,
        recipientConnectionId: schema.messages.recipientConnectionId,
        resolutionId: schema.messages.resolutionId,
        status: schema.messages.status,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, commitBody.message_id))
      .limit(1);

    expect(storedMessage).toEqual(
      expect.objectContaining({
        idempotencyKey: sharedIdempotencyKey,
        recipientConnectionId: recipientConnection.id,
        resolutionId,
        status: "delivered",
      }),
    );
    expect(storedMessage?.deliveredAt).toEqual(expect.any(Date));

    const storedEvaluation = JSON.parse(storedMessage!.policiesEvaluated!);
    expect(storedEvaluation.local_decision_commit).toEqual(
      expect.objectContaining({
        resolution_id: resolutionId,
      }),
    );
    expect(storedEvaluation.winning_policy_id).toBe(allowPolicyId);

    const idempotencyReplayResponse = await app.request(
      "/api/v1/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender_connection_id: senderConnection.id,
          recipient: recipient.username,
          recipient_connection_id: recipientConnection.id,
          recipient_type: "user",
          message: committedMessage,
          resolution_id: resolutionId,
          idempotency_key: sharedIdempotencyKey,
        }),
      },
    );

    expect(idempotencyReplayResponse.status).toBe(200);
    const idempotencyReplayBody = await idempotencyReplayResponse.json();
    expect(idempotencyReplayBody).toEqual(
      expect.objectContaining({
        deduplicated: true,
        message_id: commitBody.message_id,
      }),
    );

    const resolutionReplayResponse = await app.request(
      "/api/v1/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender_connection_id: senderConnection.id,
          recipient: recipient.username,
          recipient_connection_id: recipientConnection.id,
          recipient_type: "user",
          message: committedMessage,
          resolution_id: resolutionId,
          idempotency_key: "idem_local_allow_send_2",
        }),
      },
    );

    expect(resolutionReplayResponse.status).toBe(200);
    const resolutionReplayBody = await resolutionReplayResponse.json();
    expect(resolutionReplayBody).toEqual(
      expect.objectContaining({
        deduplicated: true,
        message_id: commitBody.message_id,
      }),
    );

    const committedMessages = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.senderUserId, sender.id),
          eq(schema.messages.resolutionId, resolutionId),
        ),
      );
    expect(committedMessages).toHaveLength(1);
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
  await db
    .update(schema.users)
    .set({ status: "active", verifiedAt: new Date() })
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

async function insertDirectPolicy(input: {
  userId: string;
  recipientId: string;
  effect: "allow" | "ask" | "deny";
  maxUses: number | null;
  remainingUses: number | null;
  source: "override" | "user_created";
  priority: number;
}) {
  const db = getTestDb();
  const storage = canonicalToStorage({
    scope: "user",
    target_id: input.recipientId,
    direction: "outbound",
    resource: "message.general",
    action: "share",
    effect: input.effect,
    evaluator: "structured",
    policy_content: {},
    effective_from: null,
    expires_at: null,
    max_uses: input.maxUses,
    remaining_uses: input.remainingUses,
    source: input.source,
    derived_from_message_id: null,
    priority: input.priority,
    enabled: true,
  });

  const policyId = nanoid();
  await db.insert(schema.policies).values({
    id: policyId,
    userId: input.userId,
    scope: "user",
    targetId: input.recipientId,
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
    priority: input.priority,
    enabled: true,
    createdAt: new Date(),
  });

  return policyId;
}
