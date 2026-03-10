import { describe, expect, it } from "bun:test";

import {
  executeMahiloRelationshipAction,
  MahiloRequestError,
  type MahiloRelationshipActionResult
} from "../src";

function createMockClient(options: {
  acceptFriendRequestError?: Error;
  acceptedFriendships?: unknown;
  friendConnectionsByUsername?: Record<string, unknown[]>;
  pendingFriendships?: unknown;
  rejectFriendRequestError?: Error;
  sendFriendRequestError?: Error;
} = {}) {
  const state = {
    acceptFriendRequestCalls: [] as string[],
    friendConnectionCalls: [] as string[],
    friendshipCalls: [] as Array<{ status?: string }>,
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
    listFriendships: async (params?: { status?: string }) => {
      state.friendshipCalls.push(params ?? {});

      if (params?.status === "pending") {
        return options.pendingFriendships ?? [];
      }

      return options.acceptedFriendships ?? [];
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
      ]
    });

    const result = await executeMahiloRelationshipAction(client, { action: "list" });

    expect(result).toMatchObject({
      action: "list",
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
      source: "mahilo_server",
      status: "success",
      summary: "Mahilo network: 1 contact, 1 incoming request, 1 outgoing request."
    });
    expect(state.friendshipCalls).toEqual([{ status: "accepted" }, { status: "pending" }]);
    expect(state.friendConnectionCalls).toEqual(["alice"]);
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
