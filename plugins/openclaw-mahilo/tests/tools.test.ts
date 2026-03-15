import { describe, expect, it } from "bun:test";

import {
  createMahiloBoundaryChange,
  createMahiloOverride,
  getMahiloContext,
  listMahiloContacts,
  previewMahiloSend,
  talkToAgent,
  talkToGroup,
  type LocalDirectPolicyRuntimeResult,
  type LocalGroupPolicyRuntimeResult,
} from "../src";

type Decision = "allow" | "ask" | "deny";

interface MockClientState {
  agentConnectionCalls: number;
  agentConnectionsResponse: unknown;
  friendConnectionCalls: string[];
  friendConnectionsByUsername: Record<string, unknown[]>;
  friendshipCalls: Array<{ status?: string }>;
  friendshipsResponse: unknown;
  localDecisionCommitCalls: Array<{
    idempotencyKey?: string;
    payload: Record<string, unknown>;
  }>;
  overrideCalls: Array<{
    idempotencyKey?: string;
    payload: Record<string, unknown>;
  }>;
  overrideResponse: unknown;
  outcomeCalls: Array<{
    idempotencyKey?: string;
    payload: Record<string, unknown>;
  }>;
  promptContextCalls: Array<Record<string, unknown>>;
  promptContextResponse: unknown;
  reportOutcomeError?: Error;
  resolveCalls: Array<Record<string, unknown>>;
  resolveResponse: unknown;
  sendCalls: Array<{
    idempotencyKey?: string;
    payload: Record<string, unknown>;
  }>;
  sendResponse: unknown;
}

function createMockClient(
  options: {
    agentConnectionsResponse?: unknown;
    friendConnectionsByUsername?: Record<string, unknown[]>;
    friendshipsResponse?: unknown;
    localDecisionCommitResponse?: unknown;
    overrideResponse?: unknown;
    promptContextResponse?: unknown;
    reportOutcomeError?: Error;
    resolveResponse?: unknown;
    sendResponse?: unknown;
  } = {},
) {
  const state: MockClientState = {
    agentConnectionCalls: 0,
    agentConnectionsResponse: options.agentConnectionsResponse ?? [
      {
        active: true,
        framework: "openclaw",
        id: "conn_sender_default",
        label: "default",
      },
    ],
    friendConnectionCalls: [],
    friendConnectionsByUsername: options.friendConnectionsByUsername ?? {},
    friendshipCalls: [],
    friendshipsResponse: options.friendshipsResponse ?? [
      {
        direction: "sent",
        displayName: "Alice",
        friendshipId: "fr_alice",
        roles: ["friends"],
        status: "accepted",
        userId: "usr_alice",
        username: "alice",
      },
    ],
    localDecisionCommitCalls: [],
    overrideCalls: [],
    overrideResponse: options.overrideResponse ?? {
      created: true,
      kind: "one_time",
      policy_id: "pol_789",
    },
    outcomeCalls: [],
    promptContextCalls: [],
    promptContextResponse: options.promptContextResponse ?? {
      policy_guidance: {
        default_decision: "ask",
        reason_code: "context.ask.role.structured",
        summary: "Share only high-level details.",
      },
      recipient: {
        relationship: "friend",
        roles: ["close_friends"],
        username: "alice",
      },
      suggested_selectors: {
        action: "share",
        direction: "outbound",
        resource: "message.general",
      },
    },
    reportOutcomeError: options.reportOutcomeError,
    resolveCalls: [],
    resolveResponse: options.resolveResponse ?? {
      decision: "allow",
      resolution_id: "res_123",
    },
    sendCalls: [],
    sendResponse: options.sendResponse ?? {
      deduplicated: false,
      message_id: "msg_123",
    },
  };

  const client = {
    commitLocalDecision: async (
      payload: Record<string, unknown>,
      idempotencyKey?: string,
    ) => {
      state.localDecisionCommitCalls.push({ idempotencyKey, payload });
      return (
        options.localDecisionCommitResponse ??
        buildLocalDecisionCommitResponse(payload)
      );
    },
    createOverride: async (
      payload: Record<string, unknown>,
      idempotencyKey?: string,
    ) => {
      state.overrideCalls.push({ idempotencyKey, payload });
      return state.overrideResponse;
    },
    getPromptContext: async (payload: Record<string, unknown>) => {
      state.promptContextCalls.push(payload);
      return state.promptContextResponse;
    },
    getFriendAgentConnections: async (username: string) => {
      state.friendConnectionCalls.push(username);
      const connections = state.friendConnectionsByUsername[username] ?? [];
      return {
        connections,
        raw: connections,
        state: connections.length > 0 ? "available" : "no_active_connections",
        username,
      };
    },
    listOwnAgentConnections: async () => {
      state.agentConnectionCalls += 1;
      return state.agentConnectionsResponse;
    },
    listFriendships: async (params?: { status?: string }) => {
      state.friendshipCalls.push(params ?? {});
      return state.friendshipsResponse;
    },
    reportOutcome: async (
      payload: Record<string, unknown>,
      idempotencyKey?: string,
    ) => {
      state.outcomeCalls.push({ idempotencyKey, payload });
      if (state.reportOutcomeError) {
        throw state.reportOutcomeError;
      }

      return { ok: true };
    },
    resolveDraft: async (payload: Record<string, unknown>) => {
      state.resolveCalls.push(payload);
      return state.resolveResponse;
    },
    sendMessage: async (
      payload: Record<string, unknown>,
      idempotencyKey?: string,
    ) => {
      state.sendCalls.push({ idempotencyKey, payload });
      return state.sendResponse;
    },
  };

  return {
    client: client as never,
    state,
  };
}

function createResolveResponse(decision: Decision) {
  return {
    decision,
    resolution_id: "res_123",
  };
}

function buildLocalDecisionCommitResponse(payload: Record<string, unknown>) {
  const localDecision = payload.local_decision as
    | Record<string, unknown>
    | undefined;
  const decision = (localDecision?.decision as Decision | undefined) ?? "allow";
  const deliveryMode =
    (localDecision?.delivery_mode as string | undefined) ??
    (decision === "allow"
      ? "full_send"
      : decision === "ask"
        ? "review_required"
        : "blocked");
  const status =
    decision === "allow"
      ? "pending"
      : decision === "ask"
        ? "review_required"
        : "rejected";
  const deliveryStatus =
    decision === "allow"
      ? "pending"
      : decision === "ask"
        ? "review_required"
        : "rejected";
  const resolutionId = String(payload.resolution_id ?? "res_local_1");
  const recipient = String(payload.recipient ?? "alice");

  return {
    committed: true,
    message_id: `msg_commit_${resolutionId}`,
    recorded: true,
    recipient_results: [
      {
        decision,
        delivery_mode: deliveryMode,
        delivery_status: deliveryStatus,
        recipient,
      },
    ],
    resolution: {
      decision,
      delivery_mode: deliveryMode,
      reason_code:
        typeof localDecision?.reason_code === "string"
          ? localDecision.reason_code
          : undefined,
      resolution_id: resolutionId,
      summary:
        typeof localDecision?.summary === "string"
          ? localDecision.summary
          : typeof localDecision?.reason === "string"
            ? localDecision.reason
            : undefined,
    },
    status,
  };
}

function createLocalDirectResult(
  decision: Decision,
  overrides: Partial<LocalDirectPolicyRuntimeResult> = {},
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
  const resolutionId =
    overrides.bundle_metadata?.resolution_id ?? "res_local_direct_1";
  const recipient = overrides.recipient?.username ?? "alice";
  const senderConnectionId =
    overrides.authenticated_identity?.sender_connection_id ?? "conn_sender";

  return {
    authenticated_identity: {
      sender_connection_id: senderConnectionId,
      sender_user_id: "usr_sender",
      ...overrides.authenticated_identity,
    },
    bundle_metadata: {
      bundle_id: "bundle_local_direct_1",
      expires_at: "2026-03-14T10:35:00.000Z",
      issued_at: "2026-03-14T10:30:00.000Z",
      resolution_id: resolutionId,
      ...overrides.bundle_metadata,
    },
    bundle_type: "direct_send",
    commit_payload: {
      declared_selectors: {
        action: "share",
        direction: "outbound",
        resource: "message.general",
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
      message: "hello",
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
      id: "usr_alice",
      type: "user",
      username: recipient,
      ...overrides.recipient,
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
        recipient_id: "usr_alice",
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
      declared_selectors: {
        action: "share",
        direction: "outbound",
        resource: "message.general",
      },
      message: "hello",
      payload_type: "text/plain",
      recipient,
      recipient_type: "user",
      resolution_id: resolutionId,
      sender_connection_id: senderConnectionId,
    },
    ...overrides,
  };
}

function createLocalGroupResult(options: {
  recipientDecisions: Decision[];
  resolutionId?: string;
}): LocalGroupPolicyRuntimeResult {
  const resolutionId = options.resolutionId ?? "res_local_group_1";
  const recipientResults = options.recipientDecisions.map((decision, index) => {
    const recipient = `friend_${index + 1}`;
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
        ? "Partial group delivery: 1 delivered, 0 pending, 1 denied, 0 review-required, 0 failed."
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
      sender_connection_id: "conn_sender",
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
    group_overlay_policies: [],
    recipient_results: recipientResults,
    selector_context: {
      action: "share",
      direction: "outbound",
      resource: "message.general",
    },
    transport_payload: {
      declared_selectors: {
        action: "share",
        direction: "outbound",
        resource: "message.general",
      },
      message: "hello group",
      payload_type: "text/plain",
      recipient: "grp_hiking",
      recipient_type: "group",
      resolution_id: resolutionId,
      sender_connection_id: "conn_sender",
    },
  };
}

describe("send tools", () => {
  it("sends message when server allows", async () => {
    const { client, state } = createMockClient();

    const result = await talkToAgent(
      client,
      {
        message: "hello",
        recipient: "alice",
      },
      {
        senderConnectionId: "conn_sender",
      },
    );

    expect(result.status).toBe("sent");
    expect(result.messageId).toBe("msg_123");
    expect(state.sendCalls).toHaveLength(1);
  });

  it("resolves a default sender connection when send tools omit senderConnectionId", async () => {
    const { client, state } = createMockClient({
      agentConnectionsResponse: [
        {
          active: true,
          framework: "other",
          id: "conn_other",
          label: "zeta",
        },
        {
          active: true,
          framework: "openclaw",
          id: "conn_sender_default",
          label: "primary",
        },
      ],
    });

    const result = await talkToAgent(
      client,
      {
        message: "hello",
        recipient: "alice",
      },
      {},
    );

    expect(result.status).toBe("sent");
    expect(state.agentConnectionCalls).toBe(1);
    expect(state.sendCalls[0]?.payload.sender_connection_id).toBe(
      "conn_sender_default",
    );
  });

  it("returns review_required when server holds message for review", async () => {
    const { client, state } = createMockClient({
      sendResponse: {
        message_id: "msg_review",
        recipient_results: [
          {
            decision: "ask",
            delivery_mode: "review_required",
            delivery_status: "review_required",
            recipient: "alice",
          },
        ],
        resolution: {
          decision: "ask",
          delivery_mode: "review_required",
          summary: "Message requires review before delivery.",
        },
        status: "review_required",
      },
    });

    const result = await talkToAgent(
      client,
      {
        message: "share location",
        recipient: "alice",
      },
      {
        senderConnectionId: "conn_sender",
      },
    );

    expect(result.status).toBe("review_required");
    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("requires review");
    expect(state.sendCalls).toHaveLength(1);
  });

  it("returns denied when server rejects delivery", async () => {
    const { client, state } = createMockClient({
      sendResponse: {
        message_id: "msg_blocked",
        recipient_results: [
          {
            decision: "deny",
            delivery_mode: "blocked",
            delivery_status: "rejected",
            recipient: "alice",
          },
        ],
        resolution: {
          decision: "deny",
          delivery_mode: "blocked",
          summary: "Message blocked by policy.",
        },
        status: "rejected",
      },
    });

    const result = await talkToAgent(
      client,
      {
        message: "secret",
        recipient: "alice",
      },
      {
        senderConnectionId: "conn_sender",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toContain("blocked");
    expect(state.sendCalls).toHaveLength(1);
  });

  it("builds send payload with normalized selectors and idempotency key", async () => {
    const { client, state } = createMockClient();

    await talkToAgent(
      client,
      {
        context: "greeting",
        correlationId: "corr_123",
        declaredSelectors: {
          action: " Share ",
          resource: "Location Current",
        },
        idempotencyKey: "idem_123",
        message: "hello",
        recipient: "alice",
        routingHints: { labels: ["work"] },
      },
      {
        agentSessionId: "sess_123",
        senderConnectionId: "conn_sender",
      },
    );

    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0].idempotencyKey).toBe("idem_123");
    expect(state.sendCalls[0].payload).toEqual({
      agent_session_id: "sess_123",
      context: "greeting",
      correlation_id: "corr_123",
      declared_selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current",
      },
      idempotency_key: "idem_123",
      message: "hello",
      payload_type: "text/plain",
      recipient: "alice",
      recipient_type: "user",
      routing_hints: { labels: ["work"] },
      sender_connection_id: "conn_sender",
    });
  });

  it("extracts message id and dedupe flag from nested send result", async () => {
    const { client } = createMockClient({
      sendResponse: {
        result: {
          deduplicated: true,
          message_id: "msg_nested",
        },
      },
    });

    const result = await talkToAgent(
      client,
      {
        message: "hello",
        recipient: "alice",
      },
      {
        senderConnectionId: "conn_sender",
      },
    );

    expect(result.status).toBe("sent");
    expect(result.messageId).toBe("msg_nested");
    expect(result.deduplicated).toBe(true);
  });

  it("can send group messages", async () => {
    const { client, state } = createMockClient({
      sendResponse: {
        message_id: "msg_group_partial",
        recipient_results: [
          {
            decision: "allow",
            delivery_mode: "full_send",
            delivery_status: "delivered",
            recipient: "alice",
          },
          {
            decision: "ask",
            delivery_mode: "review_required",
            delivery_status: "review_required",
            recipient: "bob",
          },
        ],
        status: "delivered",
      },
    });

    const result = await talkToGroup(
      client,
      {
        message: "hello group",
        recipient: "engineering",
      },
      {
        senderConnectionId: "conn_sender",
      },
    );

    expect(result.status).toBe("sent");
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0].payload.recipient_type).toBe("group");
  });

  it("commits local direct review decisions and skips transport", async () => {
    const { client, state } = createMockClient();
    const localRuntime = {
      evaluateDirectSend: async () => createLocalDirectResult("ask"),
    };

    const result = await talkToAgent(
      client,
      {
        message: "share location",
        recipient: "alice",
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
      decision: "ask",
      reason: "Message requires review before delivery.",
      resolutionId: "res_local_direct_1",
      status: "review_required",
    });
    expect(result.messageId).toBeUndefined();
    expect(state.localDecisionCommitCalls).toHaveLength(1);
    expect(state.sendCalls).toHaveLength(0);
  });

  it("commits local direct denies and skips transport", async () => {
    const { client, state } = createMockClient();
    const localRuntime = {
      evaluateDirectSend: async () => createLocalDirectResult("deny"),
    };

    const result = await talkToAgent(
      client,
      {
        message: "share ssn",
        recipient: "alice",
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
      decision: "deny",
      reason: "Message blocked by policy.",
      resolutionId: "res_local_direct_1",
      status: "denied",
    });
    expect(result.messageId).toBeUndefined();
    expect(state.localDecisionCommitCalls).toHaveLength(1);
    expect(state.sendCalls).toHaveLength(0);
  });

  it("commits local direct allows before transport and reuses the local resolution id", async () => {
    const { client, state } = createMockClient({
      sendResponse: {
        message_id: "msg_local_allow",
        resolution: {
          decision: "allow",
          resolution_id: "res_local_direct_allow",
        },
        status: "delivered",
      },
    });
    const localRuntime = {
      evaluateDirectSend: async () =>
        createLocalDirectResult("allow", {
          bundle_metadata: {
            bundle_id: "bundle_local_direct_allow",
            expires_at: "2026-03-14T10:35:00.000Z",
            issued_at: "2026-03-14T10:30:00.000Z",
            resolution_id: "res_local_direct_allow",
          },
          recipient: {
            id: "usr_alice",
            type: "user",
            username: "alice",
          },
        }),
    };

    const result = await talkToAgent(
      client,
      {
        message: "hello",
        recipient: "Alice ",
        recipientConnectionId: "conn_alice",
        routingHints: { labels: ["friends"] },
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
      decision: "allow",
      messageId: "msg_local_allow",
      resolutionId: "res_local_direct_allow",
      status: "sent",
    });
    expect(state.localDecisionCommitCalls).toHaveLength(1);
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0]?.payload).toMatchObject({
      recipient: "alice",
      recipient_connection_id: "conn_alice",
      resolution_id: "res_local_direct_allow",
      routing_hints: { labels: ["friends"] },
      sender_connection_id: "conn_sender",
    });
  });

  it("fans out only locally allowed group recipients and skips held or denied members", async () => {
    const { client, state } = createMockClient();
    const localRuntime = {
      evaluateGroupFanout: async () =>
        createLocalGroupResult({
          recipientDecisions: ["allow", "ask", "deny"],
          resolutionId: "res_local_group_partial",
        }),
    };

    const result = await talkToGroup(
      client,
      {
        idempotencyKey: "idem_group_partial",
        message: "hello group",
        recipient: "grp_hiking",
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
      decision: "allow",
      reason:
        "Partial group delivery: 1 delivered, 0 pending, 1 denied, 1 review-required, 0 failed.",
      resolutionId: "res_local_group_partial",
      status: "sent",
    });
    expect(result.messageId).toBeUndefined();
    expect(state.localDecisionCommitCalls).toHaveLength(3);
    expect(
      state.localDecisionCommitCalls.map((call) => call.idempotencyKey),
    ).toEqual([
      "idem_group_partial:friend_1",
      "idem_group_partial:friend_2",
      "idem_group_partial:friend_3",
    ]);
    expect(
      state.localDecisionCommitCalls.every(
        (call) => call.payload.group_id === "grp_hiking",
      ),
    ).toBe(true);
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0]).toMatchObject({
      idempotencyKey: "idem_group_partial:friend_1",
      payload: {
        recipient: "friend_1",
        recipient_type: "user",
        resolution_id: "res_local_group_partial_friend_1",
        sender_connection_id: "conn_sender",
      },
    });
  });

  it("keeps fully held local group results out of failed transport semantics", async () => {
    const { client, state } = createMockClient();
    const localRuntime = {
      evaluateGroupFanout: async () =>
        createLocalGroupResult({
          recipientDecisions: ["ask", "ask"],
          resolutionId: "res_local_group_review",
        }),
    };

    const result = await talkToGroup(
      client,
      {
        message: "hello group",
        recipient: "grp_hiking",
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
      decision: "ask",
      reason: "Message requires review before delivery.",
      resolutionId: "res_local_group_review",
      response: {
        delivery_status: "review_required",
        recipient_results: [
          expect.objectContaining({
            delivery_status: "review_required",
            recipient: "friend_1",
          }),
          expect.objectContaining({
            delivery_status: "review_required",
            recipient: "friend_2",
          }),
        ],
        status: "review_required",
      },
      status: "review_required",
    });
    expect(result.messageId).toBeUndefined();
    expect(state.localDecisionCommitCalls).toHaveLength(2);
    expect(state.sendCalls).toHaveLength(0);
  });

  it("keeps fully blocked local group results out of failed transport semantics", async () => {
    const { client, state } = createMockClient();
    const localRuntime = {
      evaluateGroupFanout: async () =>
        createLocalGroupResult({
          recipientDecisions: ["deny", "deny"],
          resolutionId: "res_local_group_blocked",
        }),
    };

    const result = await talkToGroup(
      client,
      {
        message: "hello group",
        recipient: "grp_hiking",
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
      decision: "deny",
      reason: "Message blocked by policy.",
      resolutionId: "res_local_group_blocked",
      response: {
        delivery_status: "rejected",
        recipient_results: [
          expect.objectContaining({
            delivery_status: "rejected",
            recipient: "friend_1",
          }),
          expect.objectContaining({
            delivery_status: "rejected",
            recipient: "friend_2",
          }),
        ],
        status: "rejected",
      },
      status: "denied",
    });
    expect(result.messageId).toBeUndefined();
    expect(state.localDecisionCommitCalls).toHaveLength(2);
    expect(state.sendCalls).toHaveLength(0);
  });

  it("commits and transports each allowed group recipient with member resolution ids", async () => {
    const { client, state } = createMockClient({
      sendResponse: {
        message_id: "msg_group_allowed",
        resolution: {
          decision: "allow",
          resolution_id: "res_local_group_allowed",
        },
        status: "delivered",
      },
    });
    const localRuntime = {
      evaluateGroupFanout: async () =>
        createLocalGroupResult({
          recipientDecisions: ["allow", "allow"],
          resolutionId: "res_local_group_allowed",
        }),
    };

    const result = await talkToGroup(
      client,
      {
        message: "hello group",
        recipient: "team-hiking",
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
      decision: "allow",
      resolutionId: "res_local_group_allowed",
      status: "sent",
    });
    expect(result.messageId).toBeUndefined();
    expect(state.localDecisionCommitCalls).toHaveLength(2);
    expect(state.sendCalls).toHaveLength(2);
    expect(state.sendCalls.map((call) => call.payload)).toEqual([
      expect.objectContaining({
        recipient: "friend_1",
        recipient_type: "user",
        resolution_id: "res_local_group_allowed_friend_1",
        sender_connection_id: "conn_sender",
      }),
      expect.objectContaining({
        recipient: "friend_2",
        recipient_type: "user",
        resolution_id: "res_local_group_allowed_friend_2",
        sender_connection_id: "conn_sender",
      }),
    ]);
  });
});

describe("native contract tools", () => {
  it("fetches compact Mahilo context through the prompt-context contract", async () => {
    const { client, state } = createMockClient();

    const result = await getMahiloContext(client, {
      declaredSelectors: {
        action: "share",
        resource: "location.current",
      },
      includeRecentInteractions: true,
      interactionLimit: 8,
      recipient: "alice",
      senderConnectionId: "conn_sender",
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("live");
    expect(result.context?.guidance.decision).toBe("ask");
    expect(state.promptContextCalls).toHaveLength(1);
    expect(state.promptContextCalls[0]).toEqual({
      draft_selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current",
      },
      include_recent_interactions: true,
      interaction_limit: 5,
      recipient: "alice",
      recipient_type: "user",
      sender_connection_id: "conn_sender",
    });
  });

  it("previews send policy using the resolve contract without sending", async () => {
    const { client, state } = createMockClient({
      resolveResponse: {
        agent_guidance: "Ask for approval before sending.",
        decision: "ask",
        delivery_mode: "review_required",
        expires_at: "2026-03-08T12:40:00.000Z",
        reason_code: "policy.ask.resolved",
        resolution_id: "res_preview",
        resolution_summary: "Message requires review before delivery.",
        resolved_recipient: {
          recipient: "alice",
          recipient_connection_id: "conn_alice",
          recipient_type: "user",
        },
        review: {
          required: true,
          review_id: "rev_123",
        },
        server_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current",
        },
      },
    });

    const result = await previewMahiloSend(
      client,
      {
        context: "travel update",
        correlationId: "corr_preview",
        declaredSelectors: {
          action: " Share ",
          resource: "Location Current",
        },
        idempotencyKey: "idem_preview",
        message: "Alice is at home right now.",
        recipient: "alice",
        recipientConnectionId: "conn_alice",
        routingHints: { labels: ["friends"] },
      },
      {
        agentSessionId: "sess_preview",
        senderConnectionId: "conn_sender",
      },
    );

    expect(result).toMatchObject({
      agentGuidance: "Ask for approval before sending.",
      decision: "ask",
      deliveryMode: "review_required",
      reasonCode: "policy.ask.resolved",
      resolutionId: "res_preview",
      resolvedRecipient: {
        recipient: "alice",
        recipientConnectionId: "conn_alice",
        recipientType: "user",
      },
      review: {
        required: true,
        reviewId: "rev_123",
      },
      serverSelectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current",
      },
    });
    expect(state.resolveCalls).toHaveLength(1);
    expect(state.resolveCalls[0]).toEqual({
      agent_session_id: "sess_preview",
      context: "travel update",
      correlation_id: "corr_preview",
      declared_selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current",
      },
      idempotency_key: "idem_preview",
      message: "Alice is at home right now.",
      payload_type: "text/plain",
      recipient: "alice",
      recipient_connection_id: "conn_alice",
      recipient_type: "user",
      routing_hints: { labels: ["friends"] },
      sender_connection_id: "conn_sender",
    });
    expect(state.sendCalls).toHaveLength(0);
  });

  it("keeps advisory context and preview separate from live local send enforcement", async () => {
    const { client, state } = createMockClient({
      promptContextResponse: {
        policy_guidance: {
          default_decision: "allow",
          reason_code: "context.allow.preview",
          summary: "Advisory only. This does not authorize a live send.",
        },
        recipient: {
          relationship: "friend",
          username: "alice",
        },
        suggested_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current",
        },
      },
      resolveResponse: {
        agent_guidance:
          "Preview only. Do not treat this as send authorization.",
        decision: "allow",
        delivery_mode: "full_send",
        reason_code: "plugin.resolve.preview_only",
        resolution_id: "res_preview_only",
        resolution_summary:
          "Preview only. Live non-trusted sends require bundle evaluation and local decision commit before transport.",
        server_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current",
        },
      },
    });
    const localRuntime = {
      evaluateDirectSend: async () =>
        createLocalDirectResult("ask", {
          bundle_metadata: {
            bundle_id: "bundle_local_live_review",
            expires_at: "2026-03-14T10:35:00.000Z",
            issued_at: "2026-03-14T10:30:00.000Z",
            resolution_id: "res_local_live_review",
          },
          recipient: {
            id: "usr_alice",
            type: "user",
            username: "alice",
          },
        }),
    };

    const contextResult = await getMahiloContext(client, {
      declaredSelectors: {
        action: "share",
        resource: "location.current",
      },
      recipient: "alice",
      senderConnectionId: "conn_sender",
    });
    const previewResult = await previewMahiloSend(
      client,
      {
        declaredSelectors: {
          action: "share",
          resource: "location.current",
        },
        message: "Alice is at home right now.",
        recipient: "alice",
      },
      {
        senderConnectionId: "conn_sender",
      },
    );
    const sendResult = await talkToAgent(
      client,
      {
        declaredSelectors: {
          action: "share",
          resource: "location.current",
        },
        message: "Alice is at home right now.",
        recipient: "alice",
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

    expect(contextResult.context?.guidance.decision).toBe("allow");
    expect(previewResult).toMatchObject({
      decision: "allow",
      reasonCode: "plugin.resolve.preview_only",
      resolutionId: "res_preview_only",
    });
    expect(sendResult).toMatchObject({
      decision: "ask",
      resolutionId: "res_local_live_review",
      status: "review_required",
    });
    expect(state.promptContextCalls).toHaveLength(1);
    expect(state.resolveCalls).toHaveLength(1);
    expect(state.localDecisionCommitCalls).toHaveLength(1);
    expect(state.localDecisionCommitCalls[0]?.payload.resolution_id).toBe(
      "res_local_live_review",
    );
    expect(state.sendCalls).toHaveLength(0);
  });

  it("creates overrides with normalized selectors and idempotency key", async () => {
    const { client, state } = createMockClient({
      overrideResponse: {
        created: true,
        kind: "temporary",
        policy_id: "pol_temp_1",
      },
    });

    const result = await createMahiloOverride(client, {
      derivedFromMessageId: "msg_source",
      effect: "allow",
      idempotencyKey: "idem_override",
      kind: "temporary",
      priority: 90,
      reason: "User approved sharing current location one time with Alice.",
      scope: "user",
      selectors: {
        action: " Share ",
        resource: "Location Current",
      },
      senderConnectionId: "conn_sender",
      sourceResolutionId: "res_123",
      targetId: "usr_alice",
      ttlSeconds: 600,
    });

    expect(result).toMatchObject({
      created: true,
      kind: "temporary",
      policyId: "pol_temp_1",
    });
    expect(state.overrideCalls).toHaveLength(1);
    expect(state.overrideCalls[0]).toEqual({
      idempotencyKey: "idem_override",
      payload: {
        derived_from_message_id: "msg_source",
        effect: "allow",
        kind: "temporary",
        priority: 90,
        reason: "User approved sharing current location one time with Alice.",
        scope: "user",
        selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current",
        },
        sender_connection_id: "conn_sender",
        source_resolution_id: "res_123",
        target_id: "usr_alice",
        ttl_seconds: 600,
      },
    });
  });

  it("resolves user target ids from prompt context for recipient-based temporary overrides", async () => {
    const { client, state } = createMockClient({
      overrideResponse: {
        created: true,
        kind: "temporary",
        policy_id: "pol_temp_2",
      },
      promptContextResponse: {
        policy_guidance: {
          default_decision: "ask",
          summary: "Location shares require review by default.",
        },
        recipient: {
          id: "usr_alice",
          relationship: "friend",
          username: "alice",
        },
        suggested_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current",
        },
      },
    });

    const result = await createMahiloOverride(client, {
      durationMinutes: 30,
      effect: "allow",
      kind: "expiring",
      reason: "User approved sharing this for the next 30 minutes.",
      recipient: "alice",
      scope: "user",
      selectors: {
        action: "Share",
        resource: "location.current",
      },
      senderConnectionId: "conn_sender",
      sourceResolutionId: "res_123",
    });

    expect(result).toMatchObject({
      created: true,
      kind: "temporary",
      policyId: "pol_temp_2",
      resolvedTargetId: "usr_alice",
    });
    expect(result.summary).toContain("temporary rule for 30 minutes");
    expect(state.promptContextCalls).toEqual([
      {
        draft_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current",
        },
        include_recent_interactions: false,
        interaction_limit: 1,
        recipient: "alice",
        recipient_type: "user",
        sender_connection_id: "conn_sender",
      },
    ]);
    expect(state.overrideCalls).toHaveLength(1);
    expect(state.overrideCalls[0]?.payload).toEqual({
      effect: "allow",
      kind: "temporary",
      reason: "User approved sharing this for the next 30 minutes.",
      scope: "user",
      selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current",
      },
      sender_connection_id: "conn_sender",
      source_resolution_id: "res_123",
      target_id: "usr_alice",
      ttl_seconds: 1800,
    });
  });

  it("rejects temporary overrides without an expiry window", async () => {
    const { client } = createMockClient();

    await expect(
      createMahiloOverride(client, {
        effect: "allow",
        kind: "temporary",
        reason: "User approved it for a while.",
        scope: "global",
        senderConnectionId: "conn_sender",
      }),
    ).rejects.toThrow(
      "temporary overrides require expiresAt, ttlSeconds, durationMinutes, or durationHours",
    );
  });
});

describe("createMahiloBoundaryChange", () => {
  it("creates conservative persistent boundaries for contact details by default", async () => {
    const { client, state } = createMockClient();

    const result = await createMahiloBoundaryChange(client, {
      category: "contact_details",
      senderConnectionId: "conn_sender",
    });

    expect(result).toMatchObject({
      action: "set",
      category: "contact",
      effect: "deny",
      kind: "persistent",
      scope: "global",
      writes: [
        {
          selector: {
            action: "share",
            direction: "outbound",
            resource: "contact.email",
          },
        },
        {
          selector: {
            action: "share",
            direction: "outbound",
            resource: "contact.phone",
          },
        },
      ],
    });
    expect(result.summary).toContain(
      "Boundary updated: stop sharing contact details with anyone from now on.",
    );
    expect(state.promptContextCalls).toHaveLength(0);
    expect(state.overrideCalls).toHaveLength(2);
    expect(state.overrideCalls[0]?.payload).toMatchObject({
      effect: "deny",
      kind: "persistent",
      scope: "global",
      selectors: {
        action: "share",
        direction: "outbound",
        resource: "contact.email",
      },
      sender_connection_id: "conn_sender",
    });
    expect(state.overrideCalls[0]?.payload.reason).toEqual(
      expect.stringContaining("contact details"),
    );
    expect(state.overrideCalls[1]?.payload).toMatchObject({
      effect: "deny",
      kind: "persistent",
      scope: "global",
      selectors: {
        action: "share",
        direction: "outbound",
        resource: "contact.phone",
      },
      sender_connection_id: "conn_sender",
    });
  });

  it("creates temporary location boundary exceptions for a specific recipient", async () => {
    const { client, state } = createMockClient({
      promptContextResponse: {
        policy_guidance: {
          default_decision: "ask",
          summary: "Location shares require review by default.",
        },
        recipient: {
          id: "usr_alice",
          relationship: "friend",
          username: "alice",
        },
        suggested_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current",
        },
      },
    });

    const result = await createMahiloBoundaryChange(client, {
      action: "exception",
      category: "location",
      durationMinutes: 30,
      idempotencyKey: "idem_boundary",
      recipient: "alice",
      senderConnectionId: "conn_sender",
      sourceResolutionId: "res_123",
    });

    expect(result).toMatchObject({
      action: "exception",
      category: "location",
      effect: "allow",
      kind: "temporary",
      resolvedTargetId: "usr_alice",
      scope: "user",
      writes: [
        {
          selector: {
            action: "share",
            direction: "outbound",
            resource: "location.current",
          },
        },
        {
          selector: {
            action: "share",
            direction: "outbound",
            resource: "location.history",
          },
        },
      ],
    });
    expect(result.summary).toContain(
      "Boundary exception saved: allow sharing location with alice for 30 minutes.",
    );
    expect(state.promptContextCalls).toEqual([
      {
        draft_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current",
        },
        include_recent_interactions: false,
        interaction_limit: 1,
        recipient: "alice",
        recipient_type: "user",
        sender_connection_id: "conn_sender",
      },
    ]);
    expect(state.overrideCalls).toHaveLength(2);
    expect(state.overrideCalls[0]).toMatchObject({
      idempotencyKey: "idem_boundary:1",
      payload: {
        effect: "allow",
        kind: "temporary",
        scope: "user",
        selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current",
        },
        sender_connection_id: "conn_sender",
        source_resolution_id: "res_123",
        target_id: "usr_alice",
        ttl_seconds: 1800,
      },
    });
    expect(state.overrideCalls[1]).toMatchObject({
      idempotencyKey: "idem_boundary:2",
      payload: {
        effect: "allow",
        kind: "temporary",
        scope: "user",
        selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.history",
        },
        sender_connection_id: "conn_sender",
        source_resolution_id: "res_123",
        target_id: "usr_alice",
        ttl_seconds: 1800,
      },
    });
  });
});

describe("listMahiloContacts", () => {
  it("returns empty array when provider is missing", async () => {
    expect(await listMahiloContacts()).toEqual([]);
  });

  it("lists accepted Mahilo friends from the server with connection availability", async () => {
    const { client, state } = createMockClient({
      friendConnectionsByUsername: {
        alice: [
          {
            active: true,
            id: "conn_alice_secondary",
            label: "secondary",
            priority: 1,
          },
          {
            active: true,
            id: "conn_alice_primary",
            label: "primary",
            priority: 5,
          },
        ],
        bob: [],
      },
      friendshipsResponse: [
        {
          direction: "sent",
          displayName: " Alice ",
          friendshipId: "fr_alice",
          interactionCount: 7,
          roles: ["close_friends"],
          since: "2026-03-01T10:00:00.000Z",
          status: "accepted",
          userId: "usr_alice",
          username: "alice",
        },
        {
          direction: "received",
          displayName: "Bob",
          friendshipId: "fr_bob",
          roles: [],
          status: "accepted",
          userId: "usr_bob",
          username: "bob",
        },
      ],
    });

    const contacts = await listMahiloContacts(client);

    expect(state.friendshipCalls).toEqual([{ status: "accepted" }]);
    expect(state.friendConnectionCalls).toEqual(["alice", "bob"]);
    expect(contacts).toHaveLength(2);
    expect(contacts[0]).toMatchObject({
      connectionId: "conn_alice_primary",
      connectionState: "available",
      id: "alice",
      label: "Alice",
      metadata: {
        connectionCount: 2,
        connectionState: "available",
        friendshipId: "fr_alice",
        interactionCount: 7,
        roles: ["close_friends"],
      },
      type: "user",
    });
    expect(
      contacts[0]?.connections?.map((connection) => connection.id),
    ).toEqual(["conn_alice_primary", "conn_alice_secondary"]);
    expect(contacts[1]).toMatchObject({
      connectionId: undefined,
      connectionState: "no_active_connections",
      id: "bob",
      label: "Bob",
      metadata: {
        connectionCount: 0,
        connectionState: "no_active_connections",
        friendshipId: "fr_bob",
      },
      type: "user",
    });
  });

  it("falls back to provider results with trimmed labels when a client is not available", async () => {
    const contacts = await listMahiloContacts(async () => [
      { id: "alice", label: " Alice ", type: "user" },
    ]);

    expect(contacts).toHaveLength(1);
    expect(contacts[0].id).toBe("alice");
    expect(contacts[0].label).toBe("Alice");
  });
});
