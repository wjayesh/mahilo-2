import { describe, expect, it } from "bun:test";

import { InMemoryDedupeState, InMemoryPluginState } from "../src";

describe("InMemoryDedupeState", () => {
  it("marks new messages and rejects duplicates within TTL", () => {
    const state = new InMemoryDedupeState(1_000);

    expect(state.markSeen("msg_1", 100)).toBe(true);
    expect(state.markSeen("msg_1", 200)).toBe(false);
    expect(state.markSeen("msg_1", 1_300)).toBe(true);
  });

  it("supports has(), prune(), and size()", () => {
    const state = new InMemoryDedupeState(1_000);

    expect(state.size()).toBe(0);
    expect(state.has("msg_1", 100)).toBe(false);

    state.markSeen("msg_1", 100);
    state.markSeen("msg_2", 200);
    expect(state.size()).toBe(2);
    expect(state.has("msg_1", 500)).toBe(true);

    expect(state.prune(1_201)).toBe(2);
    expect(state.size()).toBe(0);
    expect(state.has("msg_1", 1_201)).toBe(false);
    expect(state.has("msg_2", 1_201)).toBe(false);
  });
});

describe("InMemoryPluginState", () => {
  it("stores and expires cached context entries", () => {
    const state = new InMemoryPluginState({ contextCacheTtlSeconds: 1 });

    state.setCachedContext("alice", { relationship: "friend" }, 100);
    expect(state.getCachedContext("alice", 500)).toEqual({ relationship: "friend" });
    expect(state.getCachedContext("alice", 1_500)).toBeUndefined();
  });

  it("expires cache entries immediately when ttl is zero", () => {
    const state = new InMemoryPluginState({ contextCacheTtlSeconds: 0 });

    state.setCachedContext("alice", { relationship: "friend" }, 100);
    expect(state.getCachedContext("alice", 100)).toBeUndefined();
    expect(state.contextCacheSize()).toBe(0);
  });

  it("can prune cached context entries", () => {
    const state = new InMemoryPluginState({ contextCacheTtlSeconds: 2 });

    state.setCachedContext("a", { ok: true }, 100);
    state.setCachedContext("b", { ok: true }, 200);

    expect(state.contextCacheSize()).toBe(2);
    expect(state.pruneContextCache(2_101)).toBe(1);
    expect(state.contextCacheSize()).toBe(1);
    expect(state.pruneContextCache(2_201)).toBe(1);
    expect(state.contextCacheSize()).toBe(0);
  });

  it("exposes dedupe state for inbound callback deduping", () => {
    const state = new InMemoryPluginState({ dedupeTtlMs: 500 });

    expect(state.dedupe.markSeen("msg_1", 100)).toBe(true);
    expect(state.dedupe.markSeen("msg_1", 101)).toBe(false);
    expect(state.dedupe.markSeen("msg_1", 700)).toBe(true);
  });

  it("tracks novel Mahilo decisions with TTL-based deduping", () => {
    const state = new InMemoryPluginState({ novelDecisionTtlMs: 1_000 });

    expect(state.markNovelDecision("conn|alice|location.current|share|sent", 100)).toBe(true);
    expect(state.markNovelDecision("conn|alice|location.current|share|sent", 500)).toBe(false);
    expect(state.novelDecisionCount(500)).toBe(1);

    expect(state.markNovelDecision("conn|alice|location.current|share|sent", 1_200)).toBe(true);
    expect(state.novelDecisionCount(1_200)).toBe(1);
  });

  it("queues and consumes learning suggestions per session without duplicate fingerprints", () => {
    const state = new InMemoryPluginState({ learningSuggestionTtlMs: 5_000 });
    const suggestion = {
      decision: "allow" as const,
      fingerprint: "fingerprint-1",
      outcome: "sent" as const,
      recipient: "alice",
      selectors: {
        action: "share",
        direction: "outbound" as const,
        resource: "location.current"
      },
      status: "sent" as const,
      toolName: "talk_to_agent" as const
    };

    state.queueLearningSuggestion("session_1", suggestion, 100);
    state.queueLearningSuggestion("session_1", suggestion, 200);

    expect(state.pendingLearningSuggestionCount(200)).toBe(1);
    expect(state.consumeLearningSuggestions("session_1", 200)).toEqual([suggestion]);
    expect(state.pendingLearningSuggestionCount(200)).toBe(0);
  });

  it("remembers inbound routes across thread, reply, group, connection, and participant lookups", () => {
    const state = new InMemoryPluginState({ inboundRouteTtlMs: 5_000 });

    state.rememberInboundRoute(
      {
        agentId: "agent_1",
        correlationId: "corr_1",
        groupId: "group_1",
        localConnectionId: "conn_local",
        outboundMessageId: "msg_out_1",
        remoteConnectionId: "conn_alice",
        remoteParticipant: "Alice",
        sessionKey: "session_1"
      },
      100
    );

    const expectedRoute = expect.objectContaining({
      agentId: "agent_1",
      sessionKey: "session_1"
    });

    expect(state.resolveInboundRoute({ correlationId: "corr_1" }, 200)).toEqual(expectedRoute);
    expect(state.resolveInboundRoute({ inResponseToMessageId: "msg_out_1" }, 200)).toEqual(expectedRoute);
    expect(state.resolveInboundRoute({ groupId: "group_1" }, 200)).toEqual(expectedRoute);
    expect(
      state.resolveInboundRoute(
        {
          localConnectionId: "conn_local",
          remoteConnectionId: "conn_alice"
        },
        200
      )
    ).toEqual(expectedRoute);
    expect(
      state.resolveInboundRoute(
        {
          localConnectionId: "conn_local",
          remoteParticipant: "alice"
        },
        200
      )
    ).toEqual(expectedRoute);
  });

  it("expires inbound route entries across all lookup indexes", () => {
    const state = new InMemoryPluginState({ inboundRouteTtlMs: 500 });

    state.rememberInboundRoute(
      {
        correlationId: "corr_expire",
        localConnectionId: "conn_local",
        remoteParticipant: "alice",
        sessionKey: "session_expire"
      },
      100
    );

    expect(state.resolveInboundRoute({ correlationId: "corr_expire" }, 200)).toEqual(
      expect.objectContaining({
        sessionKey: "session_expire"
      })
    );
    expect(state.resolveInboundRoute({ correlationId: "corr_expire" }, 700)).toBeUndefined();
    expect(state.inboundRouteCount(700)).toBe(0);
  });
});
