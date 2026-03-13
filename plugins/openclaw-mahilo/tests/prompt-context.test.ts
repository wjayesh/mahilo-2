import { describe, expect, it } from "bun:test";

import {
  InMemoryPluginState,
  fetchMahiloPromptContext,
  formatMahiloPromptInjection,
  type CompactMahiloPromptContext,
  type MahiloContractClient
} from "../src";

function createContextClient(options: { error?: Error; response?: unknown } = {}) {
  const calls: Array<Record<string, unknown>> = [];

  const client = {
    getPromptContext: async (payload: Record<string, unknown>) => {
      calls.push(payload);
      if (options.error) {
        throw options.error;
      }

      return options.response ?? {};
    }
  };

  return {
    calls,
    client: client as MahiloContractClient
  };
}

describe("fetchMahiloPromptContext", () => {
  it("fetches selector-aware context and builds a compact deterministic injection block", async () => {
    const { calls, client } = createContextClient({
      response: {
        policy_guidance: {
          default_decision: "ask",
          reason_code: "context.ask.role.structured",
          summary:
            "Share only city-level location details for close_friends unless explicit consent is present."
        },
        recipient: {
          display_name: "Alice Liddell",
          id: "usr_alice",
          relationship: "friend",
          roles: ["close_friends", "teammate", "vip", "ignored_extra_role"],
          username: "alice"
        },
        recent_interactions: [
          {
            direction: "outbound",
            summary: "Shared city-level location update with minimal details.",
            timestamp: "2026-03-08T11:00:00.000Z"
          },
          {
            direction: "inbound",
            summary: "Recipient asked whether nearby availability could be shared.",
            timestamp: "2026-03-08T10:00:00.000Z"
          },
          {
            direction: "outbound",
            summary: "Earlier planning conversation.",
            timestamp: "2026-03-08T09:00:00.000Z"
          }
        ],
        suggested_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current"
        }
      }
    });

    const result = await fetchMahiloPromptContext(
      client,
      {
        declaredSelectors: {
          action: "  Share ",
          direction: "outbound",
          resource: "Location Current"
        },
        recipient: "alice",
        senderConnectionId: "conn_sender"
      },
      {
        maxRecentInteractions: 2
      }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      draft_selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current"
      },
      include_recent_interactions: true,
      interaction_limit: 3,
      recipient: "alice",
      recipient_type: "user",
      sender_connection_id: "conn_sender"
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("live");
    expect(result.context).toEqual({
      guidance: {
        decision: "ask",
        reasonCode: "context.ask.role.structured",
        summary: "Share only city-level location details for close_friends unless explicit consent is present."
      },
      recipient: {
        id: "usr_alice",
        label: "Alice Liddell",
        relationship: "friend",
        roles: ["close_friends", "teammate", "vip"]
      },
      recentInteractions: [
        {
          direction: "outbound",
          summary: "Shared city-level location update with minimal details.",
          timestamp: "2026-03-08T11:00:00.000Z"
        },
        {
          direction: "inbound",
          summary: "Recipient asked whether nearby availability could be shared.",
          timestamp: "2026-03-08T10:00:00.000Z"
        },
        {
          direction: "outbound",
          summary: "Earlier planning conversation.",
          timestamp: "2026-03-08T09:00:00.000Z"
        }
      ],
      selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current"
      }
    });

    expect(result.injection).toBe(
      [
        "[MahiloContext/v1]",
        "recipient=name=Alice Liddell; relationship=friend; roles=close_friends,teammate,vip",
        "guidance=ask:context.ask.role.structured",
        "summary=Share only city-level location details for close_friends unless explicit consent is present.",
        "selectors=outbound/location.current/share",
        "recent_1=2026-03-08T11:00:00.000Z outbound Shared city-level location update with minimal details.",
        "recent_2=2026-03-08T10:00:00.000Z inbound Recipient asked whether nearby availability could be shared."
      ].join("\n")
    );
  });

  it("uses cached compact context for repeated identical requests", async () => {
    const { calls, client } = createContextClient({
      response: {
        policy_guidance: {
          default_decision: "allow",
          reason_code: "policy.allow.no_match",
          summary: "No policy concerns detected."
        },
        recipient: {
          username: "bob"
        },
        recent_interactions: [],
        suggested_selectors: {
          action: "share",
          direction: "outbound",
          resource: "message.general"
        }
      }
    });
    const cache = new InMemoryPluginState({ contextCacheTtlSeconds: 60 });

    const first = await fetchMahiloPromptContext(
      client,
      {
        recipient: "bob",
        senderConnectionId: "conn_sender"
      },
      {
        cache,
        nowMs: 100
      }
    );
    const second = await fetchMahiloPromptContext(
      client,
      {
        recipient: "bob",
        senderConnectionId: "conn_sender"
      },
      {
        cache,
        nowMs: 200
      }
    );

    expect(first.source).toBe("live");
    expect(second.source).toBe("cache");
    expect(calls).toHaveLength(1);
    expect(second.injection).toBe(first.injection);
    expect(second.context).toEqual(first.context);
  });

  it("degrades gracefully when context fetch fails", async () => {
    const { client } = createContextClient({
      error: new Error("request timeout")
    });

    const result = await fetchMahiloPromptContext(client, {
      recipient: "alice",
      senderConnectionId: "conn_sender"
    });

    expect(result).toEqual(
      expect.objectContaining({
        error: "request timeout",
        injection: "",
        ok: false,
        source: "fallback"
      })
    );
  });
});

describe("formatMahiloPromptInjection", () => {
  it("keeps a stable concise line format with bounded content", () => {
    const context: CompactMahiloPromptContext = {
      guidance: {
        decision: "ask",
        reasonCode:
          "context.ask.with.very.long.reason.code.that.should.be.trimmed.for.prompt.safety",
        summary: "word ".repeat(80)
      },
      recipient: {
        label: "Carol",
        roles: [],
        relationship: "teammate"
      },
      recentInteractions: [
        {
          direction: "outbound",
          summary: "detail ".repeat(40),
          timestamp: "2026-03-08T11:00:00.000Z"
        },
        {
          direction: "inbound",
          summary: "older",
          timestamp: "2026-03-08T10:00:00.000Z"
        }
      ],
      selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current"
      }
    };

    const injection = formatMahiloPromptInjection(context, { maxRecentInteractions: 1 });
    const lines = injection.split("\n");

    expect(lines[0]).toBe("[MahiloContext/v1]");
    expect(lines[1]).toBe("recipient=name=Carol; relationship=teammate");
    expect(lines[2]).toContain("guidance=ask:");
    expect(lines[2]?.length).toBeLessThanOrEqual("guidance=ask:".length + 72);
    expect(lines[3]?.length).toBeLessThanOrEqual("summary=".length + 180);
    expect(lines[4]).toBe("selectors=outbound/location.current/share");
    expect(lines).toHaveLength(6);
    expect(lines[5]?.length).toBeLessThanOrEqual("recent_1=".length + 140);
  });
});
