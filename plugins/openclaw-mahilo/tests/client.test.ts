import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  CONTRACT_ENDPOINTS,
  MAHILO_CONTRACT_VERSION,
  MAHILO_PLUGIN_RELEASE_VERSION,
  MahiloContractClient,
  MahiloRequestError
} from "../src";

interface FetchCall {
  init?: RequestInit;
  input: RequestInfo | URL;
}

const nativeFetch = globalThis.fetch;

const fetchCalls: FetchCall[] = [];
const pluginVersion = MAHILO_PLUGIN_RELEASE_VERSION;

describe("MahiloContractClient", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ init, input });

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = nativeFetch;
  });

  it("uses documented context endpoint and required headers", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    await client.getPromptContext({
      recipient: "alice",
      recipient_type: "user",
      sender_connection_id: "conn_123"
    });

    expect(fetchCalls).toHaveLength(1);

    const call = fetchCalls[0];
    expect(String(call.input)).toBe(`https://mahilo.example${CONTRACT_ENDPOINTS.context}`);
    expect(call.init?.method).toBe("POST");

    const headers = new Headers(call.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer mahilo-key");
    expect(headers.get("x-mahilo-client")).toBe("openclaw-plugin");
    expect(headers.get("x-mahilo-plugin-version")).toBe(pluginVersion);
    expect(headers.get("x-mahilo-contract-version")).toBe(MAHILO_CONTRACT_VERSION);
  });

  it("includes idempotency header for send operations", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example/",
      pluginVersion
    });

    await client.sendMessage({ message: "hello" }, "idem-123");

    expect(fetchCalls).toHaveLength(1);

    const call = fetchCalls[0];
    expect(String(call.input)).toBe(`https://mahilo.example${CONTRACT_ENDPOINTS.sendMessage}`);

    const headers = new Headers(call.init?.headers);
    expect(headers.get("idempotency-key")).toBe("idem-123");
  });

  it("supports listing reviews with query params", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    await client.listReviews({ limit: 20, status: "open" });

    expect(fetchCalls).toHaveLength(1);

    const call = fetchCalls[0];
    expect(String(call.input)).toBe("https://mahilo.example/api/v1/plugin/reviews?status=open&limit=20");
    expect(call.init?.method).toBe("GET");
  });

  it("lists reviews without a query string when params are missing", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    await client.listReviews();

    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0].input)).toBe(`https://mahilo.example${CONTRACT_ENDPOINTS.reviews}`);
  });

  it("encodes review ids for decision endpoints", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    await client.decideReview("review/with space", { decision: "approve" });

    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0].input)).toBe(
      "https://mahilo.example/api/v1/plugin/reviews/review%2Fwith%20space/decision"
    );
    expect(fetchCalls[0].init?.method).toBe("POST");
  });

  it("supports blocked events limit query", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    await client.listBlockedEvents(25);

    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0].input)).toBe("https://mahilo.example/api/v1/plugin/events/blocked?limit=25");
    expect(fetchCalls[0].init?.method).toBe("GET");
  });

  it("normalizes own agent connections into typed summaries", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ init, input });

      return new Response(
        JSON.stringify([
          {
            capabilities: ["chat", "search"],
            created_at: "2026-03-09T09:00:00.000Z",
            description: "Primary OpenClaw route",
            framework: "openclaw",
            id: "conn_sender_default",
            label: "default",
            last_seen: "2026-03-10T09:00:00.000Z",
            public_key: "pk_live",
            public_key_alg: "ed25519",
            routing_priority: 9,
            status: "active"
          }
        ]),
        {
          headers: { "Content-Type": "application/json" },
          status: 200
        }
      );
    }) as typeof fetch;

    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    const result = await client.listOwnAgentConnections();

    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0].input)).toBe("https://mahilo.example/api/v1/agents");
    expect(result).toEqual([
      expect.objectContaining({
        active: true,
        capabilities: ["chat", "search"],
        createdAt: "2026-03-09T09:00:00.000Z",
        description: "Primary OpenClaw route",
        framework: "openclaw",
        id: "conn_sender_default",
        label: "default",
        lastSeen: "2026-03-10T09:00:00.000Z",
        priority: 9,
        publicKey: "pk_live",
        publicKeyAlgorithm: "ed25519",
        status: "active"
      })
    ]);
  });

  it("lists friendships through the Mahilo social endpoint with query params", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ init, input });

      return new Response(
        JSON.stringify({
          friends: [
            {
              direction: "sent",
              display_name: "Alice",
              friendship_id: "fr_123",
              interaction_count: 4,
              roles: ["close_friends"],
              since: "2026-03-01T10:00:00.000Z",
              status: "accepted",
              user_id: "usr_alice",
              username: "alice"
            }
          ]
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200
        }
      );
    }) as typeof fetch;

    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    const result = await client.listFriendships({ status: "accepted" });

    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0].input)).toBe("https://mahilo.example/api/v1/friends?status=accepted");
    expect(fetchCalls[0].init?.method).toBe("GET");
    expect(result).toEqual([
      expect.objectContaining({
        direction: "sent",
        displayName: "Alice",
        friendshipId: "fr_123",
        interactionCount: 4,
        roles: ["close_friends"],
        since: "2026-03-01T10:00:00.000Z",
        status: "accepted",
        userId: "usr_alice",
        username: "alice"
      })
    ]);
  });

  it("lists groups through the Mahilo social endpoint", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ init, input });

      return new Response(
        JSON.stringify([
          {
            created_at: "2026-03-01T10:00:00.000Z",
            description: "Trusted local recs",
            group_id: "grp_hiking",
            invite_only: true,
            member_count: 4,
            name: "Hiking Crew",
            role: "owner",
            status: "active"
          }
        ]),
        {
          headers: { "Content-Type": "application/json" },
          status: 200
        }
      );
    }) as typeof fetch;

    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    const result = await client.listGroups();

    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0].input)).toBe("https://mahilo.example/api/v1/groups");
    expect(fetchCalls[0].init?.method).toBe("GET");
    expect(result).toEqual([
      expect.objectContaining({
        createdAt: "2026-03-01T10:00:00.000Z",
        description: "Trusted local recs",
        groupId: "grp_hiking",
        inviteOnly: true,
        memberCount: 4,
        name: "Hiking Crew",
        role: "owner",
        status: "active"
      })
    ]);
  });

  it("sends friend requests through the Mahilo social endpoint", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    const result = await client.sendFriendRequest("@alice");

    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0].input)).toBe("https://mahilo.example/api/v1/friends/request");
    expect(fetchCalls[0].init?.method).toBe("POST");
    expect(fetchCalls[0].init?.body).toBe(JSON.stringify({ username: "alice" }));
    expect(result).toEqual({
      friendshipId: undefined,
      message: undefined,
      raw: { ok: true },
      status: undefined,
      success: true
    });
  });

  it("accepts and rejects friend requests through typed client methods", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ init, input });

      if (String(input).endsWith("/accept")) {
        return new Response(
          JSON.stringify({
            friendship_id: "fr_accepted",
            status: "accepted"
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200
          }
        );
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    }) as typeof fetch;

    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    const accepted = await client.acceptFriendRequest("fr/accepted");
    const rejected = await client.rejectFriendRequest("fr_rejected");

    expect(fetchCalls).toHaveLength(2);
    expect(String(fetchCalls[0].input)).toBe(
      "https://mahilo.example/api/v1/friends/fr%2Faccepted/accept"
    );
    expect(String(fetchCalls[1].input)).toBe(
      "https://mahilo.example/api/v1/friends/fr_rejected/reject"
    );
    expect(accepted).toEqual({
      friendshipId: "fr_accepted",
      message: undefined,
      raw: {
        friendship_id: "fr_accepted",
        status: "accepted"
      },
      status: "accepted",
      success: true
    });
    expect(rejected).toEqual({
      friendshipId: "fr_rejected",
      message: undefined,
      raw: { success: true },
      status: undefined,
      success: true
    });
  });

  it("surfaces friend connection availability as a product-level state", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ init, input });

      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    }) as typeof fetch;

    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    const result = await client.getFriendAgentConnections("@alice");

    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0].input)).toBe("https://mahilo.example/api/v1/contacts/alice/connections");
    expect(result).toEqual({
      connections: [],
      raw: [],
      state: "no_active_connections",
      username: "alice"
    });
  });

  it("returns undefined for 204 responses", async () => {
    globalThis.fetch = (async () => {
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    const result = await client.reportOutcome({ outcome: "sent" }, "idem-204");
    expect(result).toBeUndefined();
  });

  it("uses explicit contract version when provided", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      contractVersion: "9.9.9",
      pluginVersion
    });

    await client.resolveDraft({ message: "hello" });

    expect(fetchCalls).toHaveLength(1);
    const headers = new Headers(fetchCalls[0].init?.headers);
    expect(headers.get("x-mahilo-contract-version")).toBe("9.9.9");
  });

  it("throws when Mahilo API returns a non-2xx response", async () => {
    globalThis.fetch = (async () => {
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;

    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    await expect(client.resolveDraft({ message: "hello" })).rejects.toThrow(
      "Mahilo request failed with status 403: forbidden"
    );
  });

  it("maps social HTTP errors to stable product states", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          code: "ALREADY_FRIENDS",
          error: "Already friends with this user"
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 409
        }
      );
    }) as typeof fetch;

    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    try {
      await client.sendFriendRequest("alice");
      throw new Error("expected sendFriendRequest to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(MahiloRequestError);
      expect((error as MahiloRequestError).code).toBe("ALREADY_FRIENDS");
      expect((error as MahiloRequestError).productState).toBe("already_connected");
      expect((error as MahiloRequestError).message).toBe(
        "Mahilo request failed with status 409: Already friends with this user"
      );
    }
  });

  it("wraps network fetch failures in a stable request error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;

    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    await expect(client.resolveDraft({ message: "hello" })).rejects.toBeInstanceOf(MahiloRequestError);
    await expect(client.resolveDraft({ message: "hello" })).rejects.toThrow(
      "Mahilo request failed: socket hang up"
    );
  });

  it("includes status only when error response body is empty", async () => {
    globalThis.fetch = (async () => {
      return new Response("", { status: 500 });
    }) as typeof fetch;

    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion
    });

    await expect(client.resolveDraft({ message: "hello" })).rejects.toThrow(
      "Mahilo request failed with status 500"
    );
  });
});
