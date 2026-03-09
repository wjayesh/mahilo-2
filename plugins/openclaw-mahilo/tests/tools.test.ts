import { describe, expect, it } from "bun:test";

import {
  createMahiloOverride,
  getMahiloContext,
  listMahiloContacts,
  previewMahiloSend,
  talkToAgent,
  talkToGroup
} from "../src";

type Decision = "allow" | "ask" | "deny";

interface MockClientState {
  agentConnectionCalls: number;
  agentConnectionsResponse: unknown;
  friendConnectionCalls: string[];
  friendConnectionsByUsername: Record<string, unknown[]>;
  friendshipCalls: Array<{ status?: string }>;
  friendshipsResponse: unknown;
  overrideCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
  overrideResponse: unknown;
  outcomeCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
  promptContextCalls: Array<Record<string, unknown>>;
  promptContextResponse: unknown;
  reportOutcomeError?: Error;
  resolveCalls: Array<Record<string, unknown>>;
  resolveResponse: unknown;
  sendCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
  sendResponse: unknown;
}

function createMockClient(options: {
  agentConnectionsResponse?: unknown;
  friendConnectionsByUsername?: Record<string, unknown[]>;
  friendshipsResponse?: unknown;
  overrideResponse?: unknown;
  promptContextResponse?: unknown;
  reportOutcomeError?: Error;
  resolveResponse?: unknown;
  sendResponse?: unknown;
} = {}) {
  const state: MockClientState = {
    agentConnectionCalls: 0,
    agentConnectionsResponse:
      options.agentConnectionsResponse ??
      [
        {
          active: true,
          framework: "openclaw",
          id: "conn_sender_default",
          label: "default"
        }
      ],
    friendConnectionCalls: [],
    friendConnectionsByUsername: options.friendConnectionsByUsername ?? {},
    friendshipCalls: [],
    friendshipsResponse:
      options.friendshipsResponse ??
      [
        {
          direction: "sent",
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["friends"],
          status: "accepted",
          userId: "usr_alice",
          username: "alice"
        }
      ],
    overrideCalls: [],
    overrideResponse: options.overrideResponse ?? {
      created: true,
      kind: "one_time",
      policy_id: "pol_789"
    },
    outcomeCalls: [],
    promptContextCalls: [],
    promptContextResponse: options.promptContextResponse ?? {
      policy_guidance: {
        default_decision: "ask",
        reason_code: "context.ask.role.structured",
        summary: "Share only high-level details."
      },
      recipient: {
        relationship: "friend",
        roles: ["close_friends"],
        username: "alice"
      },
      suggested_selectors: {
        action: "share",
        direction: "outbound",
        resource: "message.general"
      }
    },
    reportOutcomeError: options.reportOutcomeError,
    resolveCalls: [],
    resolveResponse: options.resolveResponse ?? {
      decision: "allow",
      resolution_id: "res_123"
    },
    sendCalls: [],
    sendResponse: options.sendResponse ?? {
      deduplicated: false,
      message_id: "msg_123"
    }
  };

  const client = {
    createOverride: async (payload: Record<string, unknown>, idempotencyKey?: string) => {
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
        username
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
    reportOutcome: async (payload: Record<string, unknown>, idempotencyKey?: string) => {
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
    sendMessage: async (payload: Record<string, unknown>, idempotencyKey?: string) => {
      state.sendCalls.push({ idempotencyKey, payload });
      return state.sendResponse;
    }
  };

  return {
    client: client as never,
    state
  };
}

function createResolveResponse(decision: Decision) {
  return {
    decision,
    resolution_id: "res_123"
  };
}

describe("send tools", () => {
  it("sends message when decision is allow", async () => {
    const { client, state } = createMockClient({
      resolveResponse: createResolveResponse("allow")
    });

    const result = await talkToAgent(
      client,
      {
        message: "hello",
        recipient: "alice"
      },
      {
        senderConnectionId: "conn_sender"
      }
    );

    expect(result.status).toBe("sent");
    expect(result.messageId).toBe("msg_123");
    expect(state.sendCalls).toHaveLength(1);
    expect(state.outcomeCalls).toHaveLength(1);
  });

  it("resolves a default sender connection when send tools omit senderConnectionId", async () => {
    const { client, state } = createMockClient({
      agentConnectionsResponse: [
        {
          active: true,
          framework: "other",
          id: "conn_other",
          label: "zeta"
        },
        {
          active: true,
          framework: "openclaw",
          id: "conn_sender_default",
          label: "primary"
        }
      ],
      resolveResponse: createResolveResponse("allow")
    });

    const result = await talkToAgent(
      client,
      {
        message: "hello",
        recipient: "alice"
      },
      {}
    );

    expect(result.status).toBe("sent");
    expect(state.agentConnectionCalls).toBe(1);
    expect(state.resolveCalls[0]?.sender_connection_id).toBe("conn_sender_default");
    expect(state.sendCalls[0]?.payload.sender_connection_id).toBe("conn_sender_default");
  });

  it("returns review_required for ask decisions in ask mode", async () => {
    const { client, state } = createMockClient({
      resolveResponse: createResolveResponse("ask"),
      sendResponse: {
        message_id: "msg_review",
        recipient_results: [
          {
            decision: "ask",
            delivery_mode: "review_required",
            delivery_status: "review_required",
            recipient: "alice"
          }
        ],
        resolution: {
          decision: "ask",
          delivery_mode: "review_required",
          summary: "Message requires review before delivery."
        },
        status: "review_required"
      }
    });

    const result = await talkToAgent(
      client,
      {
        message: "share location",
        recipient: "alice"
      },
      {
        reviewMode: "ask",
        senderConnectionId: "conn_sender"
      }
    );

    expect(result.status).toBe("review_required");
    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("requires review");
    expect(state.sendCalls).toHaveLength(1);
    expect(state.outcomeCalls).toHaveLength(1);
    expect(state.outcomeCalls[0]?.payload.outcome).toBe("review_requested");
  });

  it("returns denied and reports blocked outcome when server rejects delivery", async () => {
    const { client, state } = createMockClient({
      resolveResponse: createResolveResponse("deny"),
      sendResponse: {
        message_id: "msg_blocked",
        recipient_results: [
          {
            decision: "deny",
            delivery_mode: "blocked",
            delivery_status: "rejected",
            recipient: "alice"
          }
        ],
        resolution: {
          decision: "deny",
          delivery_mode: "blocked",
          summary: "Message blocked by policy."
        },
        status: "rejected"
      }
    });

    const result = await talkToAgent(
      client,
      {
        message: "secret",
        recipient: "alice"
      },
      {
        senderConnectionId: "conn_sender"
      }
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toContain("blocked");
    expect(state.sendCalls).toHaveLength(1);
    expect(state.outcomeCalls).toHaveLength(1);
    expect(state.outcomeCalls[0]?.payload.outcome).toBe("blocked");
  });

  it("keeps ask decisions review_required even in auto review mode", async () => {
    const { client, state } = createMockClient({
      resolveResponse: createResolveResponse("ask"),
      sendResponse: {
        message_id: "msg_auto_review",
        recipient_results: [
          {
            decision: "ask",
            delivery_mode: "review_required",
            delivery_status: "review_required",
            recipient: "alice"
          }
        ],
        status: "review_required"
      }
    });

    const result = await talkToAgent(
      client,
      {
        message: "share location",
        recipient: "alice"
      },
      {
        reviewMode: "auto",
        senderConnectionId: "conn_sender"
      }
    );

    expect(result.status).toBe("review_required");
    expect(result.decision).toBe("ask");
    expect(state.sendCalls).toHaveLength(1);
    expect(state.outcomeCalls).toHaveLength(1);
    expect(state.outcomeCalls[0]?.payload.outcome).toBe("review_requested");
  });

  it("keeps local policy guard as advisory while server allow drives send behavior", async () => {
    const { client, state } = createMockClient({
      resolveResponse: createResolveResponse("allow")
    });

    const result = await talkToAgent(
      client,
      {
        declaredSelectors: {
          action: "share",
          resource: "location.current"
        },
        message: "My SSN is 123-45-6789",
        recipient: "alice"
      },
      {
        reviewMode: "ask",
        senderConnectionId: "conn_sender"
      }
    );

    expect(result.status).toBe("sent");
    expect(result.decision).toBe("allow");
    expect(result.localPolicyGuard?.decision).toBe("ask");
    expect(result.localPolicyGuard?.reason).toContain("sensitive resource");
    expect(state.sendCalls).toHaveLength(1);
    expect(state.outcomeCalls[0]?.payload.outcome).toBe("sent");
  });

  it("can skip local policy guard when requested", async () => {
    const { client, state } = createMockClient({
      resolveResponse: createResolveResponse("allow")
    });

    const result = await talkToAgent(
      client,
      {
        declaredSelectors: {
          action: "share",
          resource: "location.current"
        },
        message: "My SSN is 123-45-6789",
        recipient: "alice"
      },
      {
        reviewMode: "ask",
        senderConnectionId: "conn_sender"
      },
      {
        skipLocalPolicyGuard: true
      }
    );

    expect(result.status).toBe("sent");
    expect(result.localPolicyGuard).toBeUndefined();
    expect(state.sendCalls).toHaveLength(1);
  });

  it("supports disabling outcome reports", async () => {
    const { client, state } = createMockClient({
      resolveResponse: createResolveResponse("allow")
    });

    const result = await talkToAgent(
      client,
      {
        message: "hello",
        recipient: "alice"
      },
      {
        senderConnectionId: "conn_sender"
      },
      {
        reportOutcomes: false
      }
    );

    expect(result.status).toBe("sent");
    expect(state.sendCalls).toHaveLength(1);
    expect(state.outcomeCalls).toHaveLength(0);
  });

  it("does not fail send when outcome reporting fails", async () => {
    const { client, state } = createMockClient({
      reportOutcomeError: new Error("network down"),
      resolveResponse: createResolveResponse("allow")
    });

    const result = await talkToAgent(
      client,
      {
        message: "hello",
        recipient: "alice"
      },
      {
        senderConnectionId: "conn_sender"
      }
    );

    expect(result.status).toBe("sent");
    expect(state.sendCalls).toHaveLength(1);
    expect(state.outcomeCalls).toHaveLength(1);
  });

  it("builds resolve and send payloads with normalized selectors and idempotency key", async () => {
    const { client, state } = createMockClient({
      resolveResponse: createResolveResponse("allow")
    });

    await talkToAgent(
      client,
      {
        context: "greeting",
        correlationId: "corr_123",
        declaredSelectors: {
          action: " Share ",
          resource: "Location Current"
        },
        idempotencyKey: "idem_123",
        message: "hello",
        recipient: "alice",
        routingHints: { labels: ["work"] }
      },
      {
        agentSessionId: "sess_123",
        senderConnectionId: "conn_sender"
      }
    );

    expect(state.resolveCalls).toHaveLength(1);
    expect(state.resolveCalls[0]).toEqual({
      agent_session_id: "sess_123",
      context: "greeting",
      correlation_id: "corr_123",
      declared_selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current"
      },
      idempotency_key: "idem_123",
      message: "hello",
      payload_type: "text/plain",
      recipient: "alice",
      recipient_type: "user",
      routing_hints: { labels: ["work"] },
      sender_connection_id: "conn_sender"
    });

    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0].idempotencyKey).toBe("idem_123");
    expect(state.sendCalls[0].payload).toEqual({
      agent_session_id: "sess_123",
      context: "greeting",
      correlation_id: "corr_123",
      declared_selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current"
      },
      idempotency_key: "idem_123",
      message: "hello",
      payload_type: "text/plain",
      recipient: "alice",
      recipient_type: "user",
      resolution_id: "res_123",
      routing_hints: { labels: ["work"] },
      sender_connection_id: "conn_sender"
    });

    expect(state.outcomeCalls).toHaveLength(1);
    expect(state.outcomeCalls[0].idempotencyKey).toBe("idem_123");
    expect(state.outcomeCalls[0].payload).toEqual({
      message_id: "msg_123",
      outcome: "sent",
      recipient_results: [
        {
          outcome: "sent",
          recipient: "alice"
        }
      ],
      resolution_id: "res_123",
      sender_connection_id: "conn_sender"
    });
  });

  it("extracts message id and dedupe flag from nested send result", async () => {
    const { client } = createMockClient({
      resolveResponse: createResolveResponse("allow"),
      sendResponse: {
        result: {
          deduplicated: true,
          message_id: "msg_nested"
        }
      }
    });

    const result = await talkToAgent(
      client,
      {
        message: "hello",
        recipient: "alice"
      },
      {
        senderConnectionId: "conn_sender"
      }
    );

    expect(result.status).toBe("sent");
    expect(result.messageId).toBe("msg_nested");
    expect(result.deduplicated).toBe(true);
  });

  it("can send group messages", async () => {
    const { client, state } = createMockClient({
      resolveResponse: createResolveResponse("allow"),
      sendResponse: {
        message_id: "msg_group_partial",
        recipient_results: [
          {
            decision: "allow",
            delivery_mode: "full_send",
            delivery_status: "delivered",
            recipient: "alice"
          },
          {
            decision: "ask",
            delivery_mode: "review_required",
            delivery_status: "review_required",
            recipient: "bob"
          }
        ],
        status: "delivered"
      }
    });

    const result = await talkToGroup(
      client,
      {
        message: "hello group",
        recipient: "engineering"
      },
      {
        senderConnectionId: "conn_sender"
      }
    );

    expect(result.status).toBe("sent");
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0].payload.recipient_type).toBe("group");
    expect(state.outcomeCalls).toHaveLength(1);
    expect(state.outcomeCalls[0]?.payload.outcome).toBe("partial_sent");
    expect(state.outcomeCalls[0]?.payload.recipient_results).toEqual([
      { outcome: "sent", recipient: "alice" },
      { outcome: "review_requested", recipient: "bob" }
    ]);
  });
});

describe("native contract tools", () => {
  it("fetches compact Mahilo context through the prompt-context contract", async () => {
    const { client, state } = createMockClient();

    const result = await getMahiloContext(client, {
      declaredSelectors: {
        action: "share",
        resource: "location.current"
      },
      includeRecentInteractions: true,
      interactionLimit: 8,
      recipient: "alice",
      senderConnectionId: "conn_sender"
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("live");
    expect(result.context?.guidance.decision).toBe("ask");
    expect(state.promptContextCalls).toHaveLength(1);
    expect(state.promptContextCalls[0]).toEqual({
      draft_selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current"
      },
      include_recent_interactions: true,
      interaction_limit: 5,
      recipient: "alice",
      recipient_type: "user",
      sender_connection_id: "conn_sender"
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
          recipient_type: "user"
        },
        review: {
          required: true,
          review_id: "rev_123"
        },
        server_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current"
        }
      }
    });

    const result = await previewMahiloSend(
      client,
      {
        context: "travel update",
        correlationId: "corr_preview",
        declaredSelectors: {
          action: " Share ",
          resource: "Location Current"
        },
        idempotencyKey: "idem_preview",
        message: "Alice is at home right now.",
        recipient: "alice",
        recipientConnectionId: "conn_alice",
        routingHints: { labels: ["friends"] }
      },
      {
        agentSessionId: "sess_preview",
        senderConnectionId: "conn_sender"
      }
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
        recipientType: "user"
      },
      review: {
        required: true,
        reviewId: "rev_123"
      },
      serverSelectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current"
      }
    });
    expect(state.resolveCalls).toHaveLength(1);
    expect(state.resolveCalls[0]).toEqual({
      agent_session_id: "sess_preview",
      context: "travel update",
      correlation_id: "corr_preview",
      declared_selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current"
      },
      idempotency_key: "idem_preview",
      message: "Alice is at home right now.",
      payload_type: "text/plain",
      recipient: "alice",
      recipient_connection_id: "conn_alice",
      recipient_type: "user",
      routing_hints: { labels: ["friends"] },
      sender_connection_id: "conn_sender"
    });
    expect(state.sendCalls).toHaveLength(0);
  });

  it("creates overrides with normalized selectors and idempotency key", async () => {
    const { client, state } = createMockClient({
      overrideResponse: {
        created: true,
        kind: "temporary",
        policy_id: "pol_temp_1"
      }
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
        resource: "Location Current"
      },
      senderConnectionId: "conn_sender",
      sourceResolutionId: "res_123",
      targetId: "usr_alice",
      ttlSeconds: 600
    });

    expect(result).toMatchObject({
      created: true,
      kind: "temporary",
      policyId: "pol_temp_1"
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
          resource: "location.current"
        },
        sender_connection_id: "conn_sender",
        source_resolution_id: "res_123",
        target_id: "usr_alice",
        ttl_seconds: 600
      }
    });
  });

  it("resolves user target ids from prompt context for recipient-based temporary overrides", async () => {
    const { client, state } = createMockClient({
      overrideResponse: {
        created: true,
        kind: "temporary",
        policy_id: "pol_temp_2"
      },
      promptContextResponse: {
        policy_guidance: {
          default_decision: "ask",
          summary: "Location shares require review by default."
        },
        recipient: {
          id: "usr_alice",
          relationship: "friend",
          username: "alice"
        },
        suggested_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current"
        }
      }
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
        resource: "location.current"
      },
      senderConnectionId: "conn_sender",
      sourceResolutionId: "res_123"
    });

    expect(result).toMatchObject({
      created: true,
      kind: "temporary",
      policyId: "pol_temp_2",
      resolvedTargetId: "usr_alice"
    });
    expect(result.summary).toContain("temporary rule for 30 minutes");
    expect(state.promptContextCalls).toEqual([
      {
        draft_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current"
        },
        include_recent_interactions: false,
        interaction_limit: 1,
        recipient: "alice",
        recipient_type: "user",
        sender_connection_id: "conn_sender"
      }
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
        resource: "location.current"
      },
      sender_connection_id: "conn_sender",
      source_resolution_id: "res_123",
      target_id: "usr_alice",
      ttl_seconds: 1800
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
        senderConnectionId: "conn_sender"
      })
    ).rejects.toThrow(
      "temporary overrides require expiresAt, ttlSeconds, durationMinutes, or durationHours"
    );
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
            priority: 1
          },
          {
            active: true,
            id: "conn_alice_primary",
            label: "primary",
            priority: 5
          }
        ],
        bob: []
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
          username: "alice"
        },
        {
          direction: "received",
          displayName: "Bob",
          friendshipId: "fr_bob",
          roles: [],
          status: "accepted",
          userId: "usr_bob",
          username: "bob"
        }
      ]
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
        roles: ["close_friends"]
      },
      type: "user"
    });
    expect(contacts[0]?.connections?.map((connection) => connection.id)).toEqual([
      "conn_alice_primary",
      "conn_alice_secondary"
    ]);
    expect(contacts[1]).toMatchObject({
      connectionId: undefined,
      connectionState: "no_active_connections",
      id: "bob",
      label: "Bob",
      metadata: {
        connectionCount: 0,
        connectionState: "no_active_connections",
        friendshipId: "fr_bob"
      },
      type: "user"
    });
  });

  it("falls back to provider results with trimmed labels when a client is not available", async () => {
    const contacts = await listMahiloContacts(async () => [
      { id: "alice", label: " Alice ", type: "user" }
    ]);

    expect(contacts).toHaveLength(1);
    expect(contacts[0].id).toBe("alice");
    expect(contacts[0].label).toBe("Alice");
  });
});
