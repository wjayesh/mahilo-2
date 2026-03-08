import { describe, expect, it } from "bun:test";

import { listMahiloContacts, talkToAgent, talkToGroup } from "../src";

type Decision = "allow" | "ask" | "deny";

interface MockClientState {
  outcomeCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
  reportOutcomeError?: Error;
  resolveCalls: Array<Record<string, unknown>>;
  resolveResponse: unknown;
  sendCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
  sendResponse: unknown;
}

function createMockClient(options: {
  reportOutcomeError?: Error;
  resolveResponse?: unknown;
  sendResponse?: unknown;
} = {}) {
  const state: MockClientState = {
    outcomeCalls: [],
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

  it("returns review_required for ask decisions in ask mode", async () => {
    const { client, state } = createMockClient({
      resolveResponse: createResolveResponse("ask")
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
    expect(state.sendCalls).toHaveLength(0);
    expect(state.outcomeCalls).toHaveLength(0);
  });

  it("returns denied without sending when server denies", async () => {
    const { client, state } = createMockClient({
      resolveResponse: createResolveResponse("deny")
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
    expect(result.reason).toContain("denied");
    expect(state.sendCalls).toHaveLength(0);
    expect(state.outcomeCalls).toHaveLength(0);
  });

  it("sends ask decisions automatically in auto review mode", async () => {
    const { client, state } = createMockClient({
      resolveResponse: createResolveResponse("ask")
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

    expect(result.status).toBe("sent");
    expect(result.decision).toBe("ask");
    expect(state.sendCalls).toHaveLength(1);
    expect(state.outcomeCalls).toHaveLength(1);
  });

  it("applies local sensitive guard before sending", async () => {
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

    expect(result.status).toBe("review_required");
    expect(result.decision).toBe("ask");
    expect(state.sendCalls).toHaveLength(0);
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
      resolveResponse: createResolveResponse("allow")
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
  });
});

describe("listMahiloContacts", () => {
  it("returns empty array when provider is missing", async () => {
    expect(await listMahiloContacts()).toEqual([]);
  });

  it("returns provider results with trimmed labels", async () => {
    const contacts = await listMahiloContacts(async () => [
      { id: "alice", label: " Alice ", type: "user" }
    ]);

    expect(contacts).toHaveLength(1);
    expect(contacts[0].id).toBe("alice");
    expect(contacts[0].label).toBe("Alice");
  });
});
