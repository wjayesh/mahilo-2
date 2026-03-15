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

describe("Plugin outcome reporting endpoint (SRV-042)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("requires authentication", async () => {
    const response = await app.request("/api/v1/plugin/outcomes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender_connection_id: "conn_missing",
        message_id: "msg_missing",
        outcome: "sent",
      }),
    });

    expect(response.status).toBe(401);
  });

  it("records reported outcomes and correlates with the source message", async () => {
    const db = getTestDb();
    const { senderKey, senderConnection, recipient, recipientConnection } =
      await setupParticipants("plugin_outcomes_record");

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
        message: "Draft response to correlate outcome reporting.",
        correlation_id: "corr_plugin_outcomes_record",
        in_response_to: "req_plugin_outcomes_record",
      }),
    });

    expect(sendResponse.status).toBe(200);
    const sendBody = await sendResponse.json();
    const resolutionId = sendBody.resolution?.resolution_id;
    expect(typeof resolutionId).toBe("string");

    const outcomeResponse = await app.request("/api/v1/plugin/outcomes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "idem_plugin_outcomes_record_1",
      },
      body: JSON.stringify({
        sender_connection_id: senderConnection.id,
        message_id: sendBody.message_id,
        resolution_id: resolutionId,
        outcome: "review_approved",
        user_action: "created_one_time_override",
        notes: "User approved this share once.",
        recipient_results: [
          {
            recipient: recipient.username,
            outcome: "sent",
          },
        ],
      }),
    });

    expect(outcomeResponse.status).toBe(200);
    const outcomeBody = await outcomeResponse.json();
    expect(outcomeBody).toEqual(
      expect.objectContaining({
        recorded: true,
        event_id: expect.any(String),
      }),
    );

    const [storedMessage] = await db
      .select({
        id: schema.messages.id,
        outcome: schema.messages.outcome,
        outcomeDetails: schema.messages.outcomeDetails,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, sendBody.message_id))
      .limit(1);

    expect(storedMessage?.outcome).toBe("review_approved");
    expect(storedMessage?.outcomeDetails).toBeTruthy();

    const details = JSON.parse(storedMessage!.outcomeDetails!);
    expect(details.latest_plugin_outcome_event_id).toBe(outcomeBody.event_id);
    expect(details.latest_plugin_outcome).toBe("review_approved");
    expect(details.plugin_outcome_reports).toHaveLength(1);
    expect(details.plugin_outcome_reports[0]).toEqual(
      expect.objectContaining({
        event_id: outcomeBody.event_id,
        message_id: sendBody.message_id,
        resolution_id: resolutionId,
        outcome: "review_approved",
        user_action: "created_one_time_override",
        idempotency_key: "idem_plugin_outcomes_record_1",
      }),
    );
    expect(details.plugin_outcome_reports[0].correlation).toEqual(
      expect.objectContaining({
        correlation_id: "corr_plugin_outcomes_record",
        in_response_to: "req_plugin_outcomes_record",
      }),
    );
  });

  it("deduplicates retries when idempotency key is reused", async () => {
    const db = getTestDb();
    const { senderKey, senderConnection, recipient, recipientConnection } =
      await setupParticipants("plugin_outcomes_dedupe");

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
        message: "Send for idempotent outcome reporting.",
      }),
    });

    expect(sendResponse.status).toBe(200);
    const sendBody = await sendResponse.json();

    const firstResponse = await app.request("/api/v1/plugin/outcomes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: senderConnection.id,
        message_id: sendBody.message_id,
        outcome: "sent",
        idempotency_key: "idem_plugin_outcomes_dedupe",
      }),
    });

    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json();
    expect(firstBody.recorded).toBe(true);

    const secondResponse = await app.request("/api/v1/plugin/outcomes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: senderConnection.id,
        message_id: sendBody.message_id,
        outcome: "sent",
        idempotency_key: "idem_plugin_outcomes_dedupe",
      }),
    });

    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json();
    expect(secondBody.recorded).toBe(true);
    expect(secondBody.deduplicated).toBe(true);
    expect(secondBody.event_id).toBe(firstBody.event_id);

    const [storedMessage] = await db
      .select({
        outcomeDetails: schema.messages.outcomeDetails,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, sendBody.message_id))
      .limit(1);

    const details = JSON.parse(storedMessage!.outcomeDetails!);
    expect(details.plugin_outcome_reports).toHaveLength(1);
  });

  it("records outcomes for locally committed allow artifacts and reuses the same audit trail on retries", async () => {
    const db = getTestDb();
    const {
      sender,
      senderKey,
      senderConnection,
      recipient,
      recipientConnection,
    } = await setupParticipants("plugin_outcomes_local_allow");

    const allowPolicyId = await insertDirectPolicy({
      userId: sender.id,
      recipientId: recipient.id,
      effect: "allow",
      maxUses: 1,
      remainingUses: 1,
      source: "override",
      priority: 1,
    });
    const resolutionId = "res_plugin_outcomes_local_allow";
    const sendIdempotencyKey = "idem_plugin_outcomes_local_allow_send";

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
          message: "This local allow should flow into send and report.",
          idempotency_key: sendIdempotencyKey,
          local_decision: {
            decision: "allow",
            delivery_mode: "full_send",
            reason: "Local policy evaluation allowed this message.",
            reason_code: "policy.allow.user.structured",
            winning_policy_id: allowPolicyId,
          },
        }),
      },
    );

    expect(commitResponse.status).toBe(200);
    const commitBody = await commitResponse.json();
    expect(commitBody.status).toBe("pending");

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
        message: "This local allow should flow into send and report.",
        resolution_id: resolutionId,
        idempotency_key: sendIdempotencyKey,
      }),
    });

    expect(sendResponse.status).toBe(200);
    const sendBody = await sendResponse.json();
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

    const firstOutcomeResponse = await app.request("/api/v1/plugin/outcomes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "idem_plugin_outcomes_local_allow_report",
      },
      body: JSON.stringify({
        sender_connection_id: senderConnection.id,
        message_id: commitBody.message_id,
        resolution_id: resolutionId,
        outcome: "sent",
        recipient_results: [
          {
            recipient: recipient.username,
            outcome: "sent",
          },
        ],
      }),
    });

    expect(firstOutcomeResponse.status).toBe(200);
    const firstOutcomeBody = await firstOutcomeResponse.json();
    expect(firstOutcomeBody.recorded).toBe(true);

    const retryOutcomeResponse = await app.request("/api/v1/plugin/outcomes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "idem_plugin_outcomes_local_allow_report",
      },
      body: JSON.stringify({
        sender_connection_id: senderConnection.id,
        message_id: commitBody.message_id,
        resolution_id: resolutionId,
        outcome: "sent",
        recipient_results: [
          {
            recipient: recipient.username,
            outcome: "sent",
          },
        ],
      }),
    });

    expect(retryOutcomeResponse.status).toBe(200);
    const retryOutcomeBody = await retryOutcomeResponse.json();
    expect(retryOutcomeBody).toEqual(
      expect.objectContaining({
        recorded: true,
        deduplicated: true,
        event_id: firstOutcomeBody.event_id,
      }),
    );

    const [policyAfterSendAndReport] = await db
      .select({ remainingUses: schema.policies.remainingUses })
      .from(schema.policies)
      .where(eq(schema.policies.id, allowPolicyId))
      .limit(1);
    expect(policyAfterSendAndReport?.remainingUses).toBe(0);

    const [storedMessage] = await db
      .select({
        outcome: schema.messages.outcome,
        outcomeDetails: schema.messages.outcomeDetails,
        resolutionId: schema.messages.resolutionId,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, commitBody.message_id))
      .limit(1);

    expect(storedMessage?.outcome).toBe("sent");
    expect(storedMessage?.resolutionId).toBe(resolutionId);
    const details = JSON.parse(storedMessage!.outcomeDetails!);
    expect(details.plugin_outcome_reports).toHaveLength(1);
    expect(details.plugin_outcome_reports[0]).toEqual(
      expect.objectContaining({
        resolution_id: resolutionId,
        outcome: "sent",
        idempotency_key: "idem_plugin_outcomes_local_allow_report",
      }),
    );
  });

  it("rejects reports when sender_connection_id does not match the message sender", async () => {
    const {
      sender,
      senderKey,
      senderConnection,
      recipient,
      recipientConnection,
    } = await setupParticipants("plugin_outcomes_sender_mismatch");

    const alternateSenderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://plugin_outcomes_sender_mismatch_alt",
      framework: "openclaw",
      label: "alternate",
    });

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
        message: "Message to test sender connection mismatch handling.",
      }),
    });

    expect(sendResponse.status).toBe(200);
    const sendBody = await sendResponse.json();

    const outcomeResponse = await app.request("/api/v1/plugin/outcomes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: alternateSenderConnection.id,
        message_id: sendBody.message_id,
        outcome: "withheld",
      }),
    });

    expect(outcomeResponse.status).toBe(403);
    const body = await outcomeResponse.json();
    expect(body.code).toBe("MESSAGE_SENDER_MISMATCH");

    const [message] = await getTestDb()
      .select({
        outcome: schema.messages.outcome,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.id, sendBody.message_id),
          eq(schema.messages.senderConnectionId, senderConnection.id),
        ),
      )
      .limit(1);

    expect(message?.outcome).not.toBe("withheld");
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
