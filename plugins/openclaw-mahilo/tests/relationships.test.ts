import { describe, expect, it } from "bun:test";

import {
  executeMahiloRelationshipAction,
  MahiloRequestError,
  type MahiloRelationshipActionResult
} from "../src";

function createMockClient(options: {
  acceptFriendRequestError?: Error;
  acceptedFriendships?: unknown;
  agentConnections?: unknown;
  blockedEventsResponse?: unknown;
  friendConnectionsByUsername?: Record<string, unknown[]>;
  listBlockedEventsError?: Error;
  listOwnAgentConnectionsError?: Error;
  listReviewsError?: Error;
  pendingFriendships?: unknown;
  rejectFriendRequestError?: Error;
  reviewsResponse?: unknown;
  sendFriendRequestError?: Error;
} = {}) {
  const state = {
    acceptFriendRequestCalls: [] as string[],
    agentConnectionCalls: 0,
    blockedEventCalls: [] as number[],
    friendConnectionCalls: [] as string[],
    friendshipCalls: [] as Array<{ status?: string }>,
    listReviewCalls: [] as Array<{ limit?: number; status?: string }>,
    rejectFriendRequestCalls: [] as string[],
    sendFriendRequestCalls: [] as string[]
  };

  const client = {
    acceptFriendRequest: async (friendshipId: string) => {
      state.acceptFriendRequestCalls.push(friendshipId);
      if (options.acceptFriendRequestError) {
        throw options.acceptFriendRequestError;
      }

      return {
        friendshipId,
        raw: {
          friendshipId,
          status: "accepted"
        },
        status: "accepted",
        success: true
      };
    },
    getFriendAgentConnections: async (username: string) => {
      state.friendConnectionCalls.push(username);
      const connections = options.friendConnectionsByUsername?.[username] ?? [];
      return {
        connections,
        raw: connections,
        state: connections.length > 0 ? "available" : "no_active_connections",
        username
      };
    },
    listBlockedEvents: async (limit?: number) => {
      state.blockedEventCalls.push(limit ?? 0);
      if (options.listBlockedEventsError) {
        throw options.listBlockedEventsError;
      }

      return options.blockedEventsResponse ?? { items: [] };
    },
    listFriendships: async (params?: { status?: string }) => {
      state.friendshipCalls.push(params ?? {});

      if (params?.status === "pending") {
        return options.pendingFriendships ?? [];
      }

      return options.acceptedFriendships ?? [];
    },
    listOwnAgentConnections: async () => {
      state.agentConnectionCalls += 1;
      if (options.listOwnAgentConnectionsError) {
        throw options.listOwnAgentConnectionsError;
      }

      return options.agentConnections ?? [];
    },
    listReviews: async (params?: { limit?: number; status?: string }) => {
      state.listReviewCalls.push(params ?? {});
      if (options.listReviewsError) {
        throw options.listReviewsError;
      }

      return options.reviewsResponse ?? { items: [] };
    },
    rejectFriendRequest: async (friendshipId: string) => {
      state.rejectFriendRequestCalls.push(friendshipId);
      if (options.rejectFriendRequestError) {
        throw options.rejectFriendRequestError;
      }

      return {
        friendshipId,
        raw: {
          friendshipId,
          status: "declined"
        },
        status: "declined",
        success: true
      };
    },
    sendFriendRequest: async (username: string) => {
      state.sendFriendRequestCalls.push(username);
      if (options.sendFriendRequestError) {
        throw options.sendFriendRequestError;
      }

      return {
        friendshipId: `fr_${username}`,
        raw: {
          friendshipId: `fr_${username}`,
          status: "pending"
        },
        status: "pending",
        success: true
      };
    }
  };

  return {
    client: client as never,
    state
  };
}

function requireErrorResult(
  result: MahiloRelationshipActionResult
): MahiloRelationshipActionResult & { error: NonNullable<MahiloRelationshipActionResult["error"]> } {
  if (!result.error) {
    throw new Error("expected relationship action to return an error result");
  }

  return result as MahiloRelationshipActionResult & {
    error: NonNullable<MahiloRelationshipActionResult["error"]>;
  };
}

describe("executeMahiloRelationshipAction", () => {
  it("lists contacts and pending requests from Mahilo server state", async () => {
    const { client, state } = createMockClient({
      acceptedFriendships: [
        {
          direction: "sent",
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["close_friends"],
          status: "accepted",
          username: "alice"
        }
      ],
      agentConnections: [
        {
          active: true,
          id: "conn_sender_default",
          label: "default",
          priority: 10
        }
      ],
      blockedEventsResponse: {
        blocked_events: [
          {
            action: "share",
            id: "blocked_msg_123",
            reason: "Message blocked by policy.",
            reason_code: "policy.deny.user.structured",
            resource: "location.current",
            timestamp: "2026-03-09T12:00:00.000Z"
          }
        ]
      },
      friendConnectionsByUsername: {
        alice: [
          {
            active: true,
            id: "conn_alice_primary",
            label: "primary",
            priority: 5
          }
        ]
      },
      pendingFriendships: [
        {
          direction: "received",
          displayName: "Bob",
          friendshipId: "fr_bob_pending",
          status: "pending",
          username: "bob"
        },
        {
          direction: "sent",
          displayName: "Carol",
          friendshipId: "fr_carol_pending",
          status: "pending",
          username: "carol"
        }
      ],
      reviewsResponse: {
        reviews: [
          {
            created_at: "2026-03-10T12:00:00.000Z",
            review_id: "rev_123",
            status: "review_required",
            summary: "Current location share requires confirmation."
          }
        ]
      }
    });

    const result = await executeMahiloRelationshipAction(client, { action: "list" });

    expect(result).toMatchObject({
      action: "list",
      agentConnections: [
        {
          id: "conn_sender_default",
          label: "default"
        }
      ],
      counts: {
        contacts: 1,
        pendingIncoming: 1,
        pendingOutgoing: 1
      },
      pendingIncoming: [
        {
          friendshipId: "fr_bob_pending",
          username: "bob"
        }
      ],
      pendingOutgoing: [
        {
          friendshipId: "fr_carol_pending",
          username: "carol"
        }
      ],
      recentActivity: [
        {
          kind: "review",
          reviewId: "rev_123",
          summary: "Current location share requires confirmation."
        },
        {
          kind: "blocked_event",
          messageId: "blocked_msg_123",
          summary: "Message blocked by policy."
        }
      ],
      recentActivityCounts: {
        blockedEvents: 1,
        reviews: 1,
        total: 2
      },
      source: "mahilo_server",
      status: "success",
      summary:
        "Mahilo network: 1 sender connection, 1 contact (Alice), 1 incoming request (@bob), 1 outgoing request (@carol), 2 recent activity items."
    });
    expect(state.friendshipCalls).toEqual([{ status: "accepted" }, { status: "pending" }]);
    expect(state.friendConnectionCalls).toEqual(["alice"]);
    expect(state.agentConnectionCalls).toBe(1);
    expect(state.blockedEventCalls).toEqual([6]);
    expect(state.listReviewCalls).toEqual([
      {
        limit: 6,
        status: "review_required,approval_pending"
      }
    ]);
  });

  it("keeps the network view usable when recent activity probes fail", async () => {
    const { client } = createMockClient({
      acceptedFriendships: [
        {
          direction: "sent",
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["close_friends"],
          status: "accepted",
          username: "alice"
        }
      ],
      listReviewsError: new Error("review queue unavailable")
    });

    const result = await executeMahiloRelationshipAction(client, { action: "list" });

    expect(result).toMatchObject({
      action: "list",
      counts: {
        contacts: 1,
        pendingIncoming: 0,
        pendingOutgoing: 0
      },
      source: "mahilo_server",
      status: "success",
      summary:
        "Mahilo network: 0 sender connections, 1 contact (Alice), 0 incoming requests, 0 outgoing requests, recent activity unavailable.",
      warnings: [
        "Couldn't load recent Mahilo activity: review queue unavailable"
      ]
    });
    expect(result.recentActivity).toBeUndefined();
  });

  it("turns a zero-contact directory into an invite-loop next step", async () => {
    const { client } = createMockClient({
      acceptedFriendships: [],
      agentConnections: [
        {
          active: true,
          id: "conn_sender_default",
          label: "default",
          priority: 10
        }
      ],
      pendingFriendships: []
    });

    const result = await executeMahiloRelationshipAction(client, { action: "list" });

    expect(result).toMatchObject({
      action: "list",
      counts: {
        contacts: 0,
        pendingIncoming: 0,
        pendingOutgoing: 0
      },
      source: "mahilo_server",
      status: "success",
      summary:
        "Mahilo network: 1 sender connection, 0 contacts, 0 incoming requests, 0 outgoing requests, no recent activity yet. Build your circle next: use manage_network with action=send_friend_request to invite one person you trust. Once they accept and finish Mahilo setup in OpenClaw, use ask_network for your first working reply."
    });
  });

  it("tells the user how to keep the invite loop moving when requests are still pending", async () => {
    const { client } = createMockClient({
      acceptedFriendships: [],
      pendingFriendships: [
        {
          direction: "sent",
          displayName: "Alice",
          friendshipId: "fr_alice_pending",
          status: "pending",
          username: "alice"
        }
      ]
    });

    const result = await executeMahiloRelationshipAction(client, { action: "list" });

    expect(result).toMatchObject({
      action: "list",
      counts: {
        contacts: 0,
        pendingIncoming: 0,
        pendingOutgoing: 1
      },
      source: "mahilo_server",
      status: "success",
      summary:
        "Mahilo network: 0 sender connections, 0 contacts, 0 incoming requests, 1 outgoing request (@alice), no recent activity yet. Build your circle next: ask the person you invited to accept the pending Mahilo request and finish Mahilo setup in OpenClaw. Then ask around here for your first working reply."
    });
  });

  it("sends friend requests using usernames with a leading @", async () => {
    const { client, state } = createMockClient();

    const result = await executeMahiloRelationshipAction(client, {
      action: "send_request",
      username: "@alice"
    });

    expect(result).toMatchObject({
      action: "send_request",
      request: {
        friendshipId: "fr_alice",
        status: "pending",
        username: "alice"
      },
      status: "success",
      summary: "Sent a Mahilo friend request to @alice."
    });
    expect(state.sendFriendRequestCalls).toEqual(["alice"]);
  });

  it("returns a human-friendly already-connected error", async () => {
    const { client } = createMockClient({
      sendFriendRequestError: new MahiloRequestError(
        "Mahilo request failed with status 409: Already friends with this user",
        {
          code: "ALREADY_FRIENDS",
          kind: "http",
          status: 409
        }
      )
    });

    const result = requireErrorResult(
      await executeMahiloRelationshipAction(client, {
        action: "send_request",
        username: "alice"
      })
    );

    expect(result.error).toMatchObject({
      message:
        "You're already connected with @alice on Mahilo. Use action=list to check whether their agent is live before asking around.",
      productState: "already_connected",
      retryable: false
    });
    expect(result.summary).toBe(
      "You're already connected with @alice on Mahilo. Use action=list to check whether their agent is live before asking around."
    );
  });

  it("returns a human-friendly not-found error", async () => {
    const { client } = createMockClient({
      sendFriendRequestError: new MahiloRequestError(
        "Mahilo request failed with status 404: User not found",
        {
          code: "USER_NOT_FOUND",
          kind: "http",
          status: 404
        }
      )
    });

    const result = requireErrorResult(
      await executeMahiloRelationshipAction(client, {
        action: "send_request",
        username: "alice"
      })
    );

    expect(result.error).toMatchObject({
      message:
        "Could not find @alice on Mahilo. Check the username. If they have not joined yet, ask them to set up Mahilo in OpenClaw, then send the request again.",
      productState: "not_found",
      retryable: false
    });
  });

  it("returns a transport-friendly retryable error when Mahilo is unreachable", async () => {
    const { client } = createMockClient({
      sendFriendRequestError: new MahiloRequestError(
        "Mahilo request failed: socket hang up",
        "network"
      )
    });

    const result = requireErrorResult(
      await executeMahiloRelationshipAction(client, {
        action: "send_request",
        username: "alice"
      })
    );

    expect(result.error).toMatchObject({
      message: "Couldn't reach Mahilo right now. Check the server connection and try again.",
      productState: "transport_failure",
      retryable: true
    });
  });
});
