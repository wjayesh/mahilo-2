import { describe, expect, it } from "bun:test";

import {
  executeMahiloNetworkAction,
  MahiloRequestError,
} from "../src";

interface MockClientState {
  friendConnectionCalls: string[];
  friendConnectionsByUsername: Record<string, unknown[]>;
  friendshipCalls: Array<{ status?: string }>;
  friendshipsResponse: unknown;
  groupCalls: number;
  groupsResponse: unknown;
  outcomeCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
  resolveCalls: Array<Record<string, unknown>>;
  sendCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
}

function createMockClient(options: {
  friendConnectionsByUsername?: Record<string, unknown[]>;
  friendshipsResponse?: unknown;
  groupsResponse?: unknown;
  sendErrorsByRecipient?: Record<string, Error>;
  sendResponseByRecipient?: Record<string, Record<string, unknown>>;
} = {}) {
  const state: MockClientState = {
    friendConnectionCalls: [],
    friendConnectionsByUsername: options.friendConnectionsByUsername ?? {},
    friendshipCalls: [],
    friendshipsResponse:
      options.friendshipsResponse ??
      [
        {
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["close_friends"],
          status: "accepted",
          username: "alice"
        },
        {
          displayName: "Bob",
          friendshipId: "fr_bob",
          roles: ["work_contacts"],
          status: "accepted",
          username: "bob"
        }
      ],
    groupCalls: 0,
    groupsResponse:
      options.groupsResponse ??
      [
        {
          groupId: "grp_hiking",
          memberCount: 4,
          name: "Hiking Crew",
          role: "owner",
          status: "active"
        }
      ],
    outcomeCalls: [],
    resolveCalls: [],
    sendCalls: []
  };

  const client = {
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
    listFriendships: async (params?: { status?: string }) => {
      state.friendshipCalls.push(params ?? {});
      return state.friendshipsResponse;
    },
    listGroups: async () => {
      state.groupCalls += 1;
      return state.groupsResponse;
    },
    reportOutcome: async (payload: Record<string, unknown>, idempotencyKey?: string) => {
      state.outcomeCalls.push({ idempotencyKey, payload });
      return { ok: true };
    },
    resolveDraft: async (payload: Record<string, unknown>) => {
      state.resolveCalls.push(payload);
      return {
        decision: "allow",
        resolution_id: `res_${String(payload.recipient ?? "unknown")}`
      };
    },
    sendMessage: async (payload: Record<string, unknown>, idempotencyKey?: string) => {
      state.sendCalls.push({ idempotencyKey, payload });
      const recipient = String(payload.recipient ?? "");
      const sendError = options.sendErrorsByRecipient?.[recipient];
      if (sendError) {
        throw sendError;
      }

      return (
        options.sendResponseByRecipient?.[recipient] ?? {
          message_id: `msg_${recipient || "unknown"}`
        }
      );
    }
  };

  return {
    client: client as never,
    state
  };
}

describe("executeMahiloNetworkAction", () => {
  it("fans out ask-around questions across matching role-filtered contacts", async () => {
    const { client, state } = createMockClient({
      friendConnectionsByUsername: {
        alice: [{ active: true, id: "conn_alice" }],
        bob: [{ active: true, id: "conn_bob" }],
        carol: [{ active: true, id: "conn_carol" }]
      },
      friendshipsResponse: [
        {
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["close_friends"],
          status: "accepted",
          username: "alice"
        },
        {
          displayName: "Bob",
          friendshipId: "fr_bob",
          roles: ["work_contacts"],
          status: "accepted",
          username: "bob"
        },
        {
          displayName: "Carol",
          friendshipId: "fr_carol",
          roles: ["close_friends", "travel_buddies"],
          status: "accepted",
          username: "carol"
        }
      ]
    });

    const result = await executeMahiloNetworkAction(
      client,
      {
        action: "ask_around",
        correlationId: "corr_ask_1",
        question: "Who has a good dentist in SF?",
        role: "close friends"
      },
      {
        senderConnectionId: "conn_sender"
      }
    );

    expect(result).toMatchObject({
      action: "ask_around",
      correlationId: "corr_ask_1",
      counts: {
        awaitingReplies: 2,
        blocked: 0,
        reviewRequired: 0,
        sendFailed: 0,
        skipped: 0
      },
      question: "Who has a good dentist in SF?",
      status: "success",
      target: {
        contactCount: 2,
        kind: "roles",
        roles: ["close_friends"]
      }
    });
    expect(state.friendshipCalls).toEqual([{ status: "accepted" }]);
    expect(state.friendConnectionCalls).toEqual(["alice", "bob", "carol"]);
    expect(state.sendCalls.map((call) => call.payload.recipient)).toEqual(["alice", "carol"]);
    expect(state.resolveCalls.map((call) => call.correlation_id)).toEqual([
      "corr_ask_1",
      "corr_ask_1"
    ]);
    expect(state.outcomeCalls).toHaveLength(2);
  });

  it("handles unavailable contacts and transport failures without failing the whole ask-around flow", async () => {
    const { client } = createMockClient({
      friendConnectionsByUsername: {
        alice: [{ active: true, id: "conn_alice" }],
        bob: [],
        carol: [{ active: true, id: "conn_carol" }]
      },
      friendshipsResponse: [
        {
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["friends"],
          status: "accepted",
          username: "alice"
        },
        {
          displayName: "Bob",
          friendshipId: "fr_bob",
          roles: ["friends"],
          status: "accepted",
          username: "bob"
        },
        {
          displayName: "Carol",
          friendshipId: "fr_carol",
          roles: ["friends"],
          status: "accepted",
          username: "carol"
        }
      ],
      sendErrorsByRecipient: {
        carol: new MahiloRequestError("Mahilo request failed: timeout", "network")
      }
    });

    const result = await executeMahiloNetworkAction(
      client,
      {
        action: "ask_around",
        question: "Any lunch spots near Soma?"
      },
      {
        senderConnectionId: "conn_sender"
      }
    );

    expect(result).toMatchObject({
      action: "ask_around",
      counts: {
        awaitingReplies: 1,
        blocked: 0,
        reviewRequired: 0,
        sendFailed: 1,
        skipped: 1
      },
      status: "success"
    });
    expect(result.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipient: "alice",
          status: "awaiting_reply"
        }),
        expect.objectContaining({
          connectionState: "no_active_connections",
          recipient: "bob",
          status: "skipped"
        }),
        expect.objectContaining({
          productState: "transport_failure",
          recipient: "carol",
          status: "send_failed"
        })
      ])
    );
    expect(String(result.summary)).toContain("unavailable right now");
    expect(String(result.replyExpectation)).toContain("Replies will show up in this thread");
  });

  it("resolves a named group from Mahilo server data and sends one group ask-around request", async () => {
    const { client, state } = createMockClient({
      sendResponseByRecipient: {
        grp_hiking: {
          message_id: "msg_group_hiking",
          recipient_results: [
            {
              delivery_status: "pending",
              recipient: "grp_hiking"
            }
          ]
        }
      }
    });

    const result = await executeMahiloNetworkAction(
      client,
      {
        action: "ask_around",
        correlationId: "corr_group_1",
        group: "Hiking Crew",
        question: "Has anyone done Half Dome recently?"
      },
      {
        senderConnectionId: "conn_sender"
      }
    );

    expect(result).toMatchObject({
      action: "ask_around",
      correlationId: "corr_group_1",
      counts: {
        awaitingReplies: 1,
        blocked: 0,
        reviewRequired: 0,
        sendFailed: 0,
        skipped: 0
      },
      status: "success",
      target: {
        groupId: "grp_hiking",
        groupName: "Hiking Crew",
        kind: "group",
        memberCount: 4
      }
    });
    expect(state.groupCalls).toBe(1);
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0]?.payload).toMatchObject({
      correlation_id: "corr_group_1",
      recipient: "grp_hiking",
      recipient_type: "group",
      sender_connection_id: "conn_sender"
    });
  });
});
