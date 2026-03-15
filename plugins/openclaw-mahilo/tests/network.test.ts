import { describe, expect, it } from "bun:test";

import {
  executeMahiloNetworkAction,
  MahiloRequestError,
  type LocalDirectPolicyRuntimeResult,
  type LocalGroupPolicyRuntimeResult,
} from "../src";

interface MockClientState {
  friendConnectionCalls: string[];
  friendConnectionsByUsername: Record<string, unknown[]>;
  friendshipCalls: Array<{ status?: string }>;
  friendshipsResponse: unknown;
  groupCalls: number;
  groupsResponse: unknown;
  localDecisionCommitCalls: Array<{
    idempotencyKey?: string;
    payload: Record<string, unknown>;
  }>;
  outcomeCalls: Array<{
    idempotencyKey?: string;
    payload: Record<string, unknown>;
  }>;
  resolveCalls: Array<Record<string, unknown>>;
  sendCalls: Array<{
    idempotencyKey?: string;
    payload: Record<string, unknown>;
  }>;
}

type LocalDecision = "allow" | "ask" | "deny";

function createMockClient(
  options: {
    friendConnectionErrorsByUsername?: Record<string, Error>;
    friendConnectionsByUsername?: Record<string, unknown[]>;
    friendshipsResponse?: unknown;
    groupsResponse?: unknown;
    sendErrorsByRecipient?: Record<string, Error>;
    sendResponseByRecipient?: Record<string, Record<string, unknown>>;
  } = {},
) {
  const state: MockClientState = {
    friendConnectionCalls: [],
    friendConnectionsByUsername: options.friendConnectionsByUsername ?? {},
    friendshipCalls: [],
    friendshipsResponse: options.friendshipsResponse ?? [
      {
        displayName: "Alice",
        friendshipId: "fr_alice",
        roles: ["close_friends"],
        status: "accepted",
        username: "alice",
      },
      {
        displayName: "Bob",
        friendshipId: "fr_bob",
        roles: ["work_contacts"],
        status: "accepted",
        username: "bob",
      },
    ],
    groupCalls: 0,
    groupsResponse: options.groupsResponse ?? [
      {
        groupId: "grp_hiking",
        memberCount: 4,
        name: "Hiking Crew",
        role: "owner",
        status: "active",
      },
    ],
    localDecisionCommitCalls: [],
    outcomeCalls: [],
    resolveCalls: [],
    sendCalls: [],
  };

  const client = {
    getFriendAgentConnections: async (username: string) => {
      state.friendConnectionCalls.push(username);
      const error = options.friendConnectionErrorsByUsername?.[username];
      if (error) {
        throw error;
      }

      const connections = state.friendConnectionsByUsername[username] ?? [];
      return {
        connections,
        raw: connections,
        state: connections.length > 0 ? "available" : "no_active_connections",
        username,
      };
    },
    listFriendships: async (params?: { status?: string }) => {
      state.friendshipCalls.push(params ?? {});
      return state.friendshipsResponse;
    },
    listGroups: async () => {
      state.groupCalls += 1;
      return state.groupsResponse;
    },
    reportOutcome: async (
      payload: Record<string, unknown>,
      idempotencyKey?: string,
    ) => {
      state.outcomeCalls.push({ idempotencyKey, payload });
      return { ok: true };
    },
    resolveDraft: async (payload: Record<string, unknown>) => {
      state.resolveCalls.push(payload);
      return {
        decision: "allow",
        resolution_id: `res_${String(payload.recipient ?? "unknown")}`,
      };
    },
    commitLocalDecision: async (
      payload: Record<string, unknown>,
      idempotencyKey?: string,
    ) => {
      state.localDecisionCommitCalls.push({ idempotencyKey, payload });
      return buildLocalDecisionCommitResponse(payload);
    },
    sendMessage: async (
      payload: Record<string, unknown>,
      idempotencyKey?: string,
    ) => {
      state.sendCalls.push({ idempotencyKey, payload });
      const recipient = String(payload.recipient ?? "");
      const sendError = options.sendErrorsByRecipient?.[recipient];
      if (sendError) {
        throw sendError;
      }

      return (
        options.sendResponseByRecipient?.[recipient] ?? {
          message_id: `msg_${recipient || "unknown"}`,
        }
      );
    },
  };

  return {
    client: client as never,
    state,
  };
}

function buildLocalDecisionCommitResponse(payload: Record<string, unknown>) {
  const localDecision = payload.local_decision as
    | Record<string, unknown>
    | undefined;
  const decision =
    typeof localDecision?.decision === "string"
      ? localDecision.decision
      : "allow";
  const deliveryMode =
    typeof localDecision?.delivery_mode === "string"
      ? localDecision.delivery_mode
      : decision === "allow"
        ? "full_send"
        : decision === "ask"
          ? "review_required"
          : "blocked";
  const status =
    decision === "allow"
      ? "pending"
      : decision === "ask"
        ? "review_required"
        : "rejected";
  const recipient =
    typeof payload.recipient === "string" ? payload.recipient : "unknown";
  const resolutionId =
    typeof payload.resolution_id === "string"
      ? payload.resolution_id
      : `res_${recipient}`;

  return {
    recipient_results: [
      {
        decision,
        delivery_mode: deliveryMode,
        delivery_status: status,
        recipient,
      },
    ],
    resolution: {
      decision,
      delivery_mode: deliveryMode,
      resolution_id: resolutionId,
      summary:
        typeof localDecision?.summary === "string"
          ? localDecision.summary
          : undefined,
    },
    status,
  };
}

function createLocalDirectResult(
  decision: LocalDecision,
  recipient: string,
  senderConnectionId: string = "conn_sender",
): LocalDirectPolicyRuntimeResult {
  const deliveryMode =
    decision === "allow"
      ? "full_send"
      : decision === "ask"
        ? "review_required"
        : "blocked";
  const summary =
    decision === "allow"
      ? "Message allowed by policy."
      : decision === "ask"
        ? "Message requires review before delivery."
        : "Message blocked by policy.";
  const resolutionId = `res_local_${recipient}`;

  return {
    authenticated_identity: {
      sender_connection_id: senderConnectionId,
      sender_user_id: "usr_sender",
    },
    bundle_metadata: {
      bundle_id: `bundle_local_${recipient}`,
      expires_at: "2026-03-14T10:35:00.000Z",
      issued_at: "2026-03-14T10:30:00.000Z",
      resolution_id: resolutionId,
    },
    bundle_type: "direct_send",
    commit_payload: {
      correlation_id: "corr_local_ask_1",
      declared_selectors: {
        action: "share",
        direction: "outbound",
        resource: "message.general",
      },
      idempotency_key: `idem_local_ask_1:${recipient}`,
      local_decision: {
        decision,
        delivery_mode: deliveryMode,
        evaluated_policies: [],
        matched_policy_ids: [],
        reason_code:
          decision === "allow"
            ? "policy.allow.resolved"
            : decision === "ask"
              ? "policy.ask.user.structured"
              : "policy.deny.user.structured",
        resolution_explanation: summary,
        summary,
      },
      message: "Who has a good ramen spot?",
      payload_type: "text/plain",
      recipient,
      recipient_type: "user",
      resolution_id: resolutionId,
      sender_connection_id: senderConnectionId,
    },
    contract_version: "1.0.0",
    llm: {
      provider_defaults: null,
      subject: recipient,
    },
    local_decision: {
      decision,
      delivery_mode: deliveryMode,
      evaluated_policies: [],
      matched_policy_ids: [],
      reason_code:
        decision === "allow"
          ? "policy.allow.resolved"
          : decision === "ask"
            ? "policy.ask.user.structured"
            : "policy.deny.user.structured",
      resolution_explanation: summary,
      summary,
    },
    recipient: {
      id: `usr_${recipient}`,
      type: "user",
      username: recipient,
    },
    recipient_results: [
      {
        llm: {
          provider_defaults: null,
          subject: recipient,
        },
        local_decision: {
          decision,
          delivery_mode: deliveryMode,
          evaluated_policies: [],
          matched_policy_ids: [],
          reason_code:
            decision === "allow"
              ? "policy.allow.resolved"
              : decision === "ask"
                ? "policy.ask.user.structured"
                : "policy.deny.user.structured",
          resolution_explanation: summary,
          summary,
        },
        recipient,
        recipient_id: `usr_${recipient}`,
        recipient_type: "user",
        resolution_id: resolutionId,
        roles: [],
        should_send: decision === "allow",
        transport_action:
          decision === "allow" ? "send" : decision === "ask" ? "hold" : "block",
      },
    ],
    selector_context: {
      action: "share",
      direction: "outbound",
      resource: "message.general",
    },
    transport_payload: {
      correlation_id: "corr_local_ask_1",
      declared_selectors: {
        action: "share",
        direction: "outbound",
        resource: "message.general",
      },
      idempotency_key: `idem_local_ask_1:${recipient}`,
      message: "Who has a good ramen spot?",
      payload_type: "text/plain",
      recipient,
      recipient_type: "user",
      resolution_id: resolutionId,
      sender_connection_id: senderConnectionId,
    },
  };
}

function createLocalGroupResult(options: {
  recipientDecisions: LocalDecision[];
  resolutionId?: string;
  senderConnectionId?: string;
}): LocalGroupPolicyRuntimeResult {
  const senderConnectionId = options.senderConnectionId ?? "conn_sender";
  const resolutionId = options.resolutionId ?? "res_local_group_1";
  const recipientResults = options.recipientDecisions.map((decision, index) => {
    const recipient =
      index === 0
        ? "alice"
        : index === 1
          ? "bob"
          : index === 2
            ? "carol"
            : `friend_${index + 1}`;
    const summary =
      decision === "allow"
        ? "Message allowed by policy."
        : decision === "ask"
          ? "Message requires review before delivery."
          : "Message blocked by policy.";

    return {
      llm: {
        provider_defaults: null,
        subject: recipient,
      },
      local_decision: {
        decision,
        delivery_mode:
          decision === "allow"
            ? "full_send"
            : decision === "ask"
              ? "review_required"
              : "blocked",
        evaluated_policies: [],
        matched_policy_ids: [],
        reason_code:
          decision === "allow"
            ? "policy.allow.resolved"
            : decision === "ask"
              ? "policy.ask.user.structured"
              : "policy.deny.user.structured",
        resolution_explanation: summary,
        summary,
      },
      recipient,
      recipient_id: `usr_${recipient}`,
      recipient_type: "user" as const,
      resolution_id: `${resolutionId}_${recipient}`,
      roles: [],
      should_send: decision === "allow",
      transport_action:
        decision === "allow" ? "send" : decision === "ask" ? "hold" : "block",
    };
  });
  const partialDelivery = new Set(options.recipientDecisions).size > 1;

  return {
    aggregate: {
      counts: {
        delivered: recipientResults.filter((result) => result.should_send)
          .length,
        denied: recipientResults.filter(
          (result) => result.local_decision.decision === "deny",
        ).length,
        failed: 0,
        pending: 0,
        review_required: recipientResults.filter(
          (result) => result.local_decision.decision === "ask",
        ).length,
      },
      decision: partialDelivery
        ? "allow"
        : (options.recipientDecisions[0] ?? "allow"),
      has_sendable_recipients: recipientResults.some(
        (result) => result.should_send,
      ),
      partial_delivery: partialDelivery,
      reason_code: partialDelivery
        ? "policy.partial.group_fanout"
        : (recipientResults[0]?.local_decision.reason_code ??
          "policy.allow.resolved"),
      summary: partialDelivery
        ? "Partial group delivery: 1 delivered, 0 pending, 1 denied, 1 review-required, 0 failed."
        : (recipientResults[0]?.local_decision.summary ??
          "No active recipients in group."),
    },
    aggregate_metadata: {
      empty_group_summary: "No active recipients in group.",
      fanout_mode: "per_recipient",
      mixed_decision_priority: ["allow", "ask", "deny"],
      partial_reason_code: "policy.partial.group_fanout",
      partial_summary_template:
        "Partial group delivery: {delivered} delivered, {pending} pending, {denied} denied, {review_required} review-required, {failed} failed.",
      policy_evaluation_mode: "group_outbound_fanout",
    },
    authenticated_identity: {
      sender_connection_id: senderConnectionId,
      sender_user_id: "usr_sender",
    },
    bundle_metadata: {
      bundle_id: "bundle_local_group_1",
      expires_at: "2026-03-14T10:35:00.000Z",
      issued_at: "2026-03-14T10:30:00.000Z",
      resolution_id: resolutionId,
    },
    bundle_type: "group_fanout",
    contract_version: "1.0.0",
    group: {
      id: "grp_hiking",
      member_count: recipientResults.length,
      name: "Hiking Crew",
      type: "group",
    },
    recipient_results: recipientResults,
    selector_context: {
      action: "share",
      direction: "outbound",
      resource: "message.general",
    },
    transport_payload: {
      correlation_id: "corr_group_local_1",
      declared_selectors: {
        action: "share",
        direction: "outbound",
        resource: "message.general",
      },
      idempotency_key: "idem_group_local_1",
      message: "Has anyone done Half Dome recently?",
      payload_type: "text/plain",
      recipient: "grp_hiking",
      recipient_type: "group",
      resolution_id: resolutionId,
      sender_connection_id: senderConnectionId,
    },
  } as LocalGroupPolicyRuntimeResult;
}

describe("executeMahiloNetworkAction", () => {
  it("fans out ask-around questions across matching role-filtered contacts", async () => {
    const { client, state } = createMockClient({
      friendConnectionsByUsername: {
        alice: [{ active: true, id: "conn_alice" }],
        bob: [{ active: true, id: "conn_bob" }],
        carol: [{ active: true, id: "conn_carol" }],
      },
      friendshipsResponse: [
        {
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["close_friends"],
          status: "accepted",
          username: "alice",
        },
        {
          displayName: "Bob",
          friendshipId: "fr_bob",
          roles: ["work_contacts"],
          status: "accepted",
          username: "bob",
        },
        {
          displayName: "Carol",
          friendshipId: "fr_carol",
          roles: ["close_friends", "travel_buddies"],
          status: "accepted",
          username: "carol",
        },
      ],
    });

    const result = await executeMahiloNetworkAction(
      client,
      {
        action: "ask_around",
        correlationId: "corr_ask_1",
        question: "Who has a good dentist in SF?",
        role: "close friends",
      },
      {
        senderConnectionId: "conn_sender",
      },
    );

    expect(result).toMatchObject({
      action: "ask_around",
      correlationId: "corr_ask_1",
      counts: {
        awaitingReplies: 2,
        blocked: 0,
        reviewRequired: 0,
        sendFailed: 0,
        skipped: 0,
      },
      question: "Who has a good dentist in SF?",
      status: "success",
      target: {
        contactCount: 2,
        kind: "roles",
        roles: ["close_friends"],
      },
    });
    expect(result.replyOutcomeKinds).toEqual([
      "direct_reply",
      "no_grounded_answer",
      "attribution_unverified",
    ]);
    expect(String(result.replyExpectation)).toContain('clear "I don\'t know"');
    expect(state.friendshipCalls).toEqual([{ status: "accepted" }]);
    expect(state.friendConnectionCalls).toEqual(["alice", "bob", "carol"]);
    expect(state.sendCalls.map((call) => call.payload.recipient)).toEqual([
      "alice",
      "carol",
    ]);
    expect(state.sendCalls.map((call) => call.payload.correlation_id)).toEqual([
      "corr_ask_1",
      "corr_ask_1",
    ]);
  });

  it("applies local policy per contact and preserves mixed delivery reporting", async () => {
    const { client, state } = createMockClient({
      friendConnectionsByUsername: {
        alice: [{ active: true, id: "conn_alice" }],
        bob: [{ active: true, id: "conn_bob" }],
        carol: [{ active: true, id: "conn_carol" }],
      },
      friendshipsResponse: [
        {
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["friends"],
          status: "accepted",
          username: "alice",
        },
        {
          displayName: "Bob",
          friendshipId: "fr_bob",
          roles: ["friends"],
          status: "accepted",
          username: "bob",
        },
        {
          displayName: "Carol",
          friendshipId: "fr_carol",
          roles: ["friends"],
          status: "accepted",
          username: "carol",
        },
      ],
    });
    const localRuntime = {
      evaluateDirectSend: async ({
        recipient,
        senderConnectionId,
      }: {
        recipient: string;
        senderConnectionId?: string;
      }) => {
        const decisionByRecipient: Record<string, LocalDecision> = {
          alice: "allow",
          bob: "ask",
          carol: "deny",
        };
        return createLocalDirectResult(
          decisionByRecipient[recipient] ?? "allow",
          recipient,
          senderConnectionId,
        );
      },
    };

    const result = await executeMahiloNetworkAction(
      client,
      {
        action: "ask_around",
        correlationId: "corr_local_ask_1",
        idempotencyKey: "idem_local_ask_1",
        question: "Who has a good ramen spot?",
      },
      {
        senderConnectionId: "conn_sender",
      },
      {
        localPolicy: {
          runtime: localRuntime as never,
        },
      },
    );

    expect(result).toMatchObject({
      action: "ask_around",
      counts: {
        awaitingReplies: 1,
        blocked: 1,
        reviewRequired: 1,
        sendFailed: 0,
        skipped: 0,
      },
      status: "success",
      summary: expect.stringContaining("asked 1 of 3 your contacts"),
      target: {
        contactCount: 3,
        kind: "all_contacts",
      },
    });
    expect(result.deliveries).toEqual([
      expect.objectContaining({
        decision: "allow",
        messageId: "msg_alice",
        recipient: "alice",
        status: "awaiting_reply",
      }),
      expect.objectContaining({
        decision: "ask",
        recipient: "bob",
        status: "review_required",
      }),
      expect.objectContaining({
        decision: "deny",
        recipient: "carol",
        status: "blocked",
      }),
    ]);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        kind: "blocked",
        recipientLabels: ["Carol"],
      }),
    ]);
    expect(String(result.replyExpectation)).toContain(
      "Replies will show up in this thread",
    );
    expect(
      state.localDecisionCommitCalls.map((call) => call.idempotencyKey),
    ).toEqual([
      "idem_local_ask_1:alice",
      "idem_local_ask_1:bob",
      "idem_local_ask_1:carol",
    ]);
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0]).toMatchObject({
      idempotencyKey: "idem_local_ask_1:alice",
      payload: {
        correlation_id: "corr_local_ask_1",
        recipient: "alice",
        resolution_id: "res_local_alice",
        sender_connection_id: "conn_sender",
      },
    });
  });

  it("handles unavailable contacts and transport failures without failing the whole ask-around flow", async () => {
    const { client } = createMockClient({
      friendConnectionsByUsername: {
        alice: [{ active: true, id: "conn_alice" }],
        bob: [],
        carol: [{ active: true, id: "conn_carol" }],
      },
      friendshipsResponse: [
        {
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["friends"],
          status: "accepted",
          username: "alice",
        },
        {
          displayName: "Bob",
          friendshipId: "fr_bob",
          roles: ["friends"],
          status: "accepted",
          username: "bob",
        },
        {
          displayName: "Carol",
          friendshipId: "fr_carol",
          roles: ["friends"],
          status: "accepted",
          username: "carol",
        },
      ],
      sendErrorsByRecipient: {
        carol: new MahiloRequestError(
          "Mahilo request failed: timeout",
          "network",
        ),
      },
    });

    const result = await executeMahiloNetworkAction(
      client,
      {
        action: "ask_around",
        question: "Any lunch spots near Soma?",
      },
      {
        senderConnectionId: "conn_sender",
      },
    );

    expect(result).toMatchObject({
      action: "ask_around",
      counts: {
        awaitingReplies: 1,
        blocked: 0,
        reviewRequired: 0,
        sendFailed: 1,
        skipped: 1,
      },
      status: "success",
    });
    expect(result.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipient: "alice",
          status: "awaiting_reply",
        }),
        expect.objectContaining({
          connectionState: "no_active_connections",
          recipient: "bob",
          status: "skipped",
        }),
        expect.objectContaining({
          productState: "transport_failure",
          recipient: "carol",
          status: "send_failed",
        }),
      ]),
    );
    expect(result.gaps).toEqual([
      expect.objectContaining({
        kind: "needs_agent_connection",
        recipientLabels: ["Bob"],
      }),
      expect.objectContaining({
        kind: "transport_failure",
        recipientLabels: ["Carol"],
      }),
    ]);
    expect(String(result.summary)).toContain(
      "Bob is already in your Mahilo circle and still finishing setup",
    );
    expect(String(result.summary)).toContain(
      "Mahilo could not reach Carol right now",
    );
    expect(String(result.replyExpectation)).toContain(
      "Replies will show up in this thread",
    );
  });

  it("turns an empty Mahilo circle into an invite-loop next step", async () => {
    const { client } = createMockClient({
      friendshipsResponse: [],
    });

    const result = await executeMahiloNetworkAction(
      client,
      {
        action: "ask_around",
        question: "Who has a good dentist in SF?",
      },
      {
        senderConnectionId: "conn_sender",
      },
    );

    expect(result).toMatchObject({
      action: "ask_around",
      counts: {
        awaitingReplies: 0,
        blocked: 0,
        reviewRequired: 0,
        sendFailed: 0,
        skipped: 0,
      },
      deliveries: [],
      gaps: [
        expect.objectContaining({
          kind: "empty_network",
          recipientLabels: [],
          suggestedAction: expect.stringContaining(
            "Build your circle from this same tool",
          ),
        }),
      ],
      status: "success",
      summary: "Mahilo ask-around: your Mahilo circle is still empty.",
      target: {
        contactCount: 0,
        kind: "all_contacts",
      },
    });
    expect(String(result.replyExpectation)).toContain(
      "Nothing is waiting on a reply.",
    );
    expect(String(result.replyExpectation)).toContain(
      "Build your circle from this same tool: use action=send_request",
    );
    expect(String(result.replyExpectation)).toContain("first working reply");
  });

  it("distinguishes network gaps from no-answer states when nobody can be asked", async () => {
    const { client } = createMockClient({
      friendConnectionErrorsByUsername: {
        bob: new MahiloRequestError(
          "Mahilo request failed with status 403: Not friends",
          {
            code: "NOT_FRIENDS",
            kind: "http",
            status: 403,
          },
        ),
      },
      friendConnectionsByUsername: {
        alice: [],
      },
      friendshipsResponse: [
        {
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["friends"],
          status: "accepted",
          username: "alice",
        },
        {
          displayName: "Bob",
          friendshipId: "fr_bob",
          roles: ["friends"],
          status: "accepted",
          username: "bob",
        },
      ],
    });

    const result = await executeMahiloNetworkAction(
      client,
      {
        action: "ask_around",
        question: "Who has a good dentist in SF?",
      },
      {
        senderConnectionId: "conn_sender",
      },
    );

    expect(result).toMatchObject({
      action: "ask_around",
      counts: {
        awaitingReplies: 0,
        blocked: 0,
        reviewRequired: 0,
        sendFailed: 0,
        skipped: 2,
      },
      status: "success",
    });
    expect(result.gaps).toEqual([
      expect.objectContaining({
        kind: "needs_agent_connection",
        recipientLabels: ["Alice"],
      }),
      expect.objectContaining({
        kind: "not_in_network",
        recipientLabels: ["Bob"],
      }),
    ]);
    expect(String(result.summary)).toContain(
      "couldn't ask your 2 contacts right now",
    );
    expect(String(result.summary)).toContain(
      "Alice is already in your Mahilo circle and still finishing setup",
    );
    expect(String(result.summary)).toContain(
      "Bob is not in your Mahilo network yet",
    );
    expect(String(result.replyExpectation)).toContain(
      "Nothing is waiting on a reply.",
    );
    expect(String(result.replyExpectation)).toContain(
      "Your circle is started. Ask them to finish Mahilo setup in OpenClaw",
    );
    expect(String(result.replyExpectation)).toContain(
      "Build your circle from this same tool: use action=send_request",
    );
  });

  it("applies local group fanout policy and preserves full-send ask-around results", async () => {
    const { client, state } = createMockClient();
    const localRuntime = {
      evaluateGroupFanout: async () =>
        createLocalGroupResult({
          recipientDecisions: ["allow", "allow"],
          resolutionId: "res_local_group_allow",
        }),
    };

    const result = await executeMahiloNetworkAction(
      client,
      {
        action: "ask_around",
        correlationId: "corr_group_local_allow_1",
        group: "Hiking Crew",
        idempotencyKey: "idem_group_local_allow_1",
        question: "Has anyone done Half Dome recently?",
      },
      {
        senderConnectionId: "conn_sender",
      },
      {
        localPolicy: {
          runtime: localRuntime as never,
        },
      },
    );

    expect(result).toMatchObject({
      counts: {
        awaitingReplies: 2,
        blocked: 0,
        reviewRequired: 0,
        sendFailed: 0,
        skipped: 0,
      },
      replyRecipients: [
        expect.objectContaining({
          messageId: "msg_alice",
          recipient: "alice",
          recipientType: "user",
        }),
        expect.objectContaining({
          messageId: "msg_bob",
          recipient: "bob",
          recipientType: "user",
        }),
      ],
      status: "success",
      summary: 'Mahilo ask-around: asked group "Hiking Crew".',
      target: {
        groupId: "grp_hiking",
        kind: "group",
      },
    });
    expect(result.deliveries).toEqual([
      expect.objectContaining({
        decision: "allow",
        messageId: "msg_alice",
        recipient: "alice",
        resolutionId: "res_local_group_allow_alice",
        status: "awaiting_reply",
      }),
      expect.objectContaining({
        decision: "allow",
        messageId: "msg_bob",
        recipient: "bob",
        resolutionId: "res_local_group_allow_bob",
        status: "awaiting_reply",
      }),
    ]);
    expect(state.localDecisionCommitCalls).toHaveLength(2);
    expect(state.sendCalls.map((call) => call.payload.recipient)).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("keeps group ask-around on review when every local member decision is hold", async () => {
    const { client, state } = createMockClient();
    const localRuntime = {
      evaluateGroupFanout: async () =>
        createLocalGroupResult({
          recipientDecisions: ["ask", "ask"],
          resolutionId: "res_local_group_hold",
        }),
    };

    const result = await executeMahiloNetworkAction(
      client,
      {
        action: "ask_around",
        correlationId: "corr_group_local_hold_1",
        group: "Hiking Crew",
        idempotencyKey: "idem_group_local_hold_1",
        question: "Has anyone done Half Dome recently?",
      },
      {
        senderConnectionId: "conn_sender",
      },
      {
        localPolicy: {
          runtime: localRuntime as never,
        },
      },
    );

    expect(result).toMatchObject({
      counts: {
        awaitingReplies: 0,
        blocked: 0,
        reviewRequired: 2,
        sendFailed: 0,
        skipped: 0,
      },
      replyExpectation:
        "Mahilo is waiting on review before the group ask can go out.",
      replyRecipients: undefined,
      status: "success",
      summary:
        'Mahilo ask-around: group "Hiking Crew" needs review before the question can go out.',
    });
    expect(result.deliveries).toEqual([
      expect.objectContaining({
        decision: "ask",
        recipient: "alice",
        status: "review_required",
      }),
      expect.objectContaining({
        decision: "ask",
        recipient: "bob",
        status: "review_required",
      }),
    ]);
    expect(state.localDecisionCommitCalls).toHaveLength(2);
    expect(state.sendCalls).toHaveLength(0);
  });

  it("blocks group ask-around locally when every group member is denied", async () => {
    const { client, state } = createMockClient();
    const localRuntime = {
      evaluateGroupFanout: async () =>
        createLocalGroupResult({
          recipientDecisions: ["deny", "deny"],
          resolutionId: "res_local_group_block",
        }),
    };

    const result = await executeMahiloNetworkAction(
      client,
      {
        action: "ask_around",
        correlationId: "corr_group_local_block_1",
        group: "Hiking Crew",
        idempotencyKey: "idem_group_local_block_1",
        question: "Has anyone done Half Dome recently?",
      },
      {
        senderConnectionId: "conn_sender",
      },
      {
        localPolicy: {
          runtime: localRuntime as never,
        },
      },
    );

    expect(result).toMatchObject({
      counts: {
        awaitingReplies: 0,
        blocked: 2,
        reviewRequired: 0,
        sendFailed: 0,
        skipped: 0,
      },
      gaps: [
        expect.objectContaining({
          kind: "blocked",
          recipientLabels: ["alice", "bob"],
        }),
      ],
      replyRecipients: undefined,
      status: "success",
      summary:
        'Mahilo ask-around: boundaries blocked asking group "Hiking Crew".',
    });
    expect(result.deliveries).toEqual([
      expect.objectContaining({
        decision: "deny",
        recipient: "alice",
        status: "blocked",
      }),
      expect.objectContaining({
        decision: "deny",
        recipient: "bob",
        status: "blocked",
      }),
    ]);
    expect(String(result.replyExpectation)).toContain(
      "Nothing is waiting on a reply.",
    );
    expect(state.localDecisionCommitCalls).toHaveLength(2);
    expect(state.sendCalls).toHaveLength(0);
  });

  it("preserves mixed member outcomes for local group ask-around partial fanout", async () => {
    const { client, state } = createMockClient();
    const localRuntime = {
      evaluateGroupFanout: async () =>
        createLocalGroupResult({
          recipientDecisions: ["allow", "ask", "deny"],
          resolutionId: "res_local_group_partial",
        }),
    };

    const result = await executeMahiloNetworkAction(
      client,
      {
        action: "ask_around",
        correlationId: "corr_group_local_partial_1",
        group: "Hiking Crew",
        idempotencyKey: "idem_group_local_partial_1",
        question: "Has anyone done Half Dome recently?",
      },
      {
        senderConnectionId: "conn_sender",
      },
      {
        localPolicy: {
          runtime: localRuntime as never,
        },
      },
    );

    expect(result).toMatchObject({
      counts: {
        awaitingReplies: 1,
        blocked: 1,
        reviewRequired: 1,
        sendFailed: 0,
        skipped: 0,
      },
      replyRecipients: [
        expect.objectContaining({
          messageId: "msg_alice",
          recipient: "alice",
          recipientType: "user",
        }),
      ],
      status: "success",
      target: {
        groupId: "grp_hiking",
        groupName: "Hiking Crew",
        kind: "group",
        memberCount: 4,
      },
    });
    expect(String(result.summary)).toContain(
      'asked 1 of 4 members in group "Hiking Crew"',
    );
    expect(String(result.summary)).toContain("1 waiting on review");
    expect(String(result.summary)).toContain(
      "carol was blocked by Mahilo boundaries",
    );
    expect(result.deliveries).toEqual([
      expect.objectContaining({
        decision: "allow",
        messageId: "msg_alice",
        recipient: "alice",
        reasonCode: "policy.allow.resolved",
        status: "awaiting_reply",
      }),
      expect.objectContaining({
        decision: "ask",
        recipient: "bob",
        reasonCode: "policy.ask.user.structured",
        status: "review_required",
      }),
      expect.objectContaining({
        decision: "deny",
        recipient: "carol",
        reasonCode: "policy.deny.user.structured",
        status: "blocked",
      }),
    ]);
    expect(
      state.localDecisionCommitCalls.map((call) => call.idempotencyKey),
    ).toEqual([
      "idem_group_local_partial_1:grp_hiking:alice",
      "idem_group_local_partial_1:grp_hiking:bob",
      "idem_group_local_partial_1:grp_hiking:carol",
    ]);
    expect(
      state.localDecisionCommitCalls.every(
        (call) => call.payload.group_id === "grp_hiking",
      ),
    ).toBe(true);
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0]?.payload).toMatchObject({
      correlation_id: "corr_group_local_partial_1",
      recipient: "alice",
      resolution_id: "res_local_group_partial_alice",
      sender_connection_id: "conn_sender",
    });
  });

  it("matches conversational group references for ask-around", async () => {
    const { client, state } = createMockClient({
      groupsResponse: [
        {
          groupId: "grp_hiking",
          memberCount: 4,
          name: "Hiking Crew",
          role: "owner",
          status: "active",
        },
      ],
      sendResponseByRecipient: {
        grp_hiking: {
          message_id: "msg_group_hiking_alias",
          recipient_results: [
            {
              delivery_status: "pending",
              recipient: "grp_hiking",
            },
          ],
        },
      },
    });

    const result = await executeMahiloNetworkAction(
      client,
      {
        action: "ask_around",
        correlationId: "corr_group_alias_1",
        group: "the hiking group",
        question: "Which trailhead has the easiest parking?",
      },
      {
        senderConnectionId: "conn_sender",
      },
    );

    expect(result).toMatchObject({
      action: "ask_around",
      correlationId: "corr_group_alias_1",
      counts: {
        awaitingReplies: 1,
        blocked: 0,
        reviewRequired: 0,
        sendFailed: 0,
        skipped: 0,
      },
      status: "success",
      target: {
        groupId: "grp_hiking",
        groupName: "Hiking Crew",
        kind: "group",
        memberCount: 4,
      },
    });
    expect(state.groupCalls).toBe(1);
    expect(state.sendCalls[0]?.payload).toMatchObject({
      correlation_id: "corr_group_alias_1",
      recipient: "grp_hiking",
      recipient_type: "group",
      sender_connection_id: "conn_sender",
    });
  });

  it("resolves a named group from Mahilo server data and sends one group ask-around request", async () => {
    const { client, state } = createMockClient({
      sendResponseByRecipient: {
        grp_hiking: {
          message_id: "msg_group_hiking",
          recipient_results: [
            {
              delivery_status: "pending",
              recipient: "grp_hiking",
            },
          ],
        },
      },
    });

    const result = await executeMahiloNetworkAction(
      client,
      {
        action: "ask_around",
        correlationId: "corr_group_1",
        group: "Hiking Crew",
        question: "Has anyone done Half Dome recently?",
      },
      {
        senderConnectionId: "conn_sender",
      },
    );

    expect(result).toMatchObject({
      action: "ask_around",
      correlationId: "corr_group_1",
      counts: {
        awaitingReplies: 1,
        blocked: 0,
        reviewRequired: 0,
        sendFailed: 0,
        skipped: 0,
      },
      status: "success",
      target: {
        groupId: "grp_hiking",
        groupName: "Hiking Crew",
        kind: "group",
        memberCount: 4,
      },
    });
    expect(state.groupCalls).toBe(1);
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0]?.payload).toMatchObject({
      correlation_id: "corr_group_1",
      recipient: "grp_hiking",
      recipient_type: "group",
      sender_connection_id: "conn_sender",
    });
  });
});
