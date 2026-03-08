import { describe, expect, it } from "bun:test";

import { InMemoryDedupeState, InMemoryPluginState } from "../src";

describe("InMemoryDedupeState", () => {
  it("marks new messages and rejects duplicates within TTL", () => {
    const state = new InMemoryDedupeState(1_000);

    expect(state.markSeen("msg_1", 100)).toBe(true);
    expect(state.markSeen("msg_1", 200)).toBe(false);
    expect(state.markSeen("msg_1", 1_300)).toBe(true);
  });
});

describe("InMemoryPluginState", () => {
  it("stores and expires cached context entries", () => {
    const state = new InMemoryPluginState({ contextCacheTtlSeconds: 1 });

    state.setCachedContext("alice", { relationship: "friend" }, 100);
    expect(state.getCachedContext("alice", 500)).toEqual({ relationship: "friend" });
    expect(state.getCachedContext("alice", 1_500)).toBeUndefined();
  });
});
