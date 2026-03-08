import { describe, expect, it } from "bun:test";

import { listMahiloContacts, talkToAgent, talkToGroup } from "../src";

interface MockClientState {
  outcomes: number;
  sends: number;
}

function createMockClient(decision: "allow" | "ask" | "deny", state: MockClientState) {
  return {
    reportOutcome: async () => {
      state.outcomes += 1;
      return { ok: true };
    },
    resolveDraft: async () => ({
      decision,
      resolution_id: "res_123"
    }),
    sendMessage: async () => {
      state.sends += 1;
      return {
        deduplicated: false,
        message_id: "msg_123"
      };
    }
  };
}

describe("send tools", () => {
  it("sends message when decision is allow", async () => {
    const state = { outcomes: 0, sends: 0 };
    const client = createMockClient("allow", state);

    const result = await talkToAgent(client as never, {
      message: "hello",
      recipient: "alice"
    }, {
      senderConnectionId: "conn_sender"
    });

    expect(result.status).toBe("sent");
    expect(result.messageId).toBe("msg_123");
    expect(state.sends).toBe(1);
    expect(state.outcomes).toBe(1);
  });

  it("returns review_required for ask decisions in ask mode", async () => {
    const state = { outcomes: 0, sends: 0 };
    const client = createMockClient("ask", state);

    const result = await talkToAgent(client as never, {
      message: "share location",
      recipient: "alice"
    }, {
      reviewMode: "ask",
      senderConnectionId: "conn_sender"
    });

    expect(result.status).toBe("review_required");
    expect(state.sends).toBe(0);
    expect(state.outcomes).toBe(0);
  });

  it("can send group messages", async () => {
    const state = { outcomes: 0, sends: 0 };
    const client = createMockClient("allow", state);

    const result = await talkToGroup(client as never, {
      message: "hello group",
      recipient: "engineering"
    }, {
      senderConnectionId: "conn_sender"
    });

    expect(result.status).toBe("sent");
    expect(state.sends).toBe(1);
  });
});

describe("listMahiloContacts", () => {
  it("returns provider results", async () => {
    const contacts = await listMahiloContacts(async () => [
      { id: "alice", label: "Alice", type: "user" }
    ]);

    expect(contacts).toHaveLength(1);
    expect(contacts[0].id).toBe("alice");
  });
});
