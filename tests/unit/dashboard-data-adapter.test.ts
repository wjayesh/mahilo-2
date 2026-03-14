import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDashboardData() {
  const source = readFileSync(resolve(process.cwd(), "public/app.js"), "utf8");
  const start = source.indexOf("// ========================================\n// Data Normalization");
  const end = source.indexOf("// ========================================\n// WebSocket Manager");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Unable to locate dashboard normalization section in public/app.js");
  }

  const snippet = source.slice(start, end);
  const factory = new Function(`
    const State = {
      agents: [],
      agentsById: new Map(),
      friends: [],
      friendsById: new Map(),
      groups: [],
      groupsById: new Map(),
      messages: [],
      messagesById: new Map(),
      policies: [],
      policiesById: new Map(),
      reviews: [],
      reviewsById: new Map(),
      blockedEvents: [],
      blockedEventsById: new Map(),
      conversations: new Map(),
    };
    ${snippet}
    return { Helpers, Normalizers, State };
  `);

  return factory() as {
    Helpers: {
      applyCollectionState: (stateKey: string, indexKey: string, model: { items: unknown[]; byId: Map<string, unknown> }) => void;
      mergeCollectionModels: <T>(
        models: Array<{ items: T[] }>,
        getId: (item: T) => string
      ) => { ids: string[]; byId: Map<string, T>; items: T[] };
      rebuildConversations: () => void;
      upsertMessage: (message: Record<string, unknown>) => void;
    };
    Normalizers: Record<string, (...args: unknown[]) => any>;
    State: Record<string, any>;
  };
}

describe("Dashboard Data Adapter", () => {
  it("normalizes friend payloads into a model keyed by friendship_id", () => {
    const { Helpers, Normalizers, State } = loadDashboardData();

    const accepted = Normalizers.friendsModel({
      friends: [
        {
          friendship_id: "fr_accepted",
          user_id: "usr_alice",
          username: "alice",
          display_name: "Alice",
          status: "accepted",
          direction: "received",
          since: "2026-03-08T10:00:00.000Z",
          roles: ["close_friends"],
          interaction_count: 12,
        },
      ],
    });
    const pending = Normalizers.friendsModel({
      friends: [
        {
          friendship_id: "fr_pending",
          user_id: "usr_charlie",
          username: "charlie",
          display_name: "Charlie",
          status: "pending",
          direction: "received",
          since: "2026-03-08T11:00:00.000Z",
          roles: [],
          interaction_count: 0,
        },
      ],
    });
    const blocked = Normalizers.friendsModel({
      friends: [
        {
          friendship_id: "fr_blocked",
          user_id: "usr_delta",
          username: "delta",
          display_name: "Delta",
          status: "blocked",
          direction: "sent",
          since: "2026-03-08T12:00:00.000Z",
          roles: [],
          interaction_count: 1,
        },
      ],
    });

    const merged = Helpers.mergeCollectionModels(
      [accepted, pending, blocked],
      (friend: { friendshipId: string }) => friend.friendshipId
    );
    Helpers.applyCollectionState("friends", "friendsById", merged);

    expect(merged.ids).toEqual(["fr_accepted", "fr_pending", "fr_blocked"]);
    expect(State.friendsById.get("fr_accepted")).toMatchObject({
      friendshipId: "fr_accepted",
      userId: "usr_alice",
      username: "alice",
      displayName: "Alice",
      roles: ["close_friends"],
      interactionCount: 12,
    });
    expect(State.friendsById.get("fr_pending")).toMatchObject({
      friendshipId: "fr_pending",
      status: "pending",
      direction: "received",
    });
  });

  it("normalizes messages, groups, policies, reviews, and blocked events from current route shapes", () => {
    const { Helpers, Normalizers, State } = loadDashboardData();

    const groupsModel = Normalizers.groupsModel([
      {
        group_id: "grp_1",
        name: "weekend-plan",
        description: "Friends discussing weekend plans",
        invite_only: true,
        role: "owner",
        status: "active",
        member_count: 4,
        created_at: "2026-03-08T09:00:00.000Z",
      },
    ]);
    Helpers.applyCollectionState("groups", "groupsById", groupsModel);

    const messagesModel = Normalizers.messagesModel(
      [
        {
          id: "msg_sent",
          message_id: "msg_sent",
          sender: "bob",
          recipient: "alice",
          recipient_type: "user",
          message: "Ping from the dashboard",
          status: "delivered",
          delivery_status: "delivered",
          sender_agent: "openclaw",
          sender_connection_id: "conn_bob",
          correlation_id: "corr_sent",
          direction: "outbound",
          resource: "message.general",
          action: "share",
          created_at: "2026-03-08T10:00:00.000Z",
        },
        {
          id: "msg_received_nested",
          sender: {
            user_id: "usr_alice",
            username: null,
            connection_id: "conn_alice",
            agent: "openclaw",
          },
          recipient: {
            id: "usr_bob",
            username: "bob",
            type: "user",
            connection_id: "conn_bob",
          },
          message: { text: "Nested recipient payload" },
          status: "delivered",
          direction: "outbound",
          resource: "calendar.availability",
          action: "share",
          created_at: "2026-03-08T11:00:00.000Z",
        },
        {
          id: "msg_group",
          message_id: "msg_group",
          sender: "bob",
          recipient: {
            id: "grp_1",
            type: "group",
            name: "weekend-plan",
          },
          recipient_type: "group",
          message: "Group planning update",
          status: "pending",
          direction: "outbound",
          resource: "message.general",
          action: "share",
          created_at: "2026-03-08T11:30:00.000Z",
        },
      ],
      { currentUsername: "bob" }
    );
    Helpers.applyCollectionState("messages", "messagesById", messagesModel);
    Helpers.rebuildConversations();

    const policiesModel = Normalizers.policiesModel([
      {
        id: "pol_1",
        scope: "role",
        target_id: "close_friends",
        direction: "response",
        resource: "calendar.event",
        action: "share",
        effect: "ask",
        evaluator: "structured",
        policy_content: { blockedPatterns: ["meeting title"] },
        priority: 50,
        enabled: true,
        created_at: "2026-03-08T12:00:00.000Z",
      },
    ]);
    Helpers.applyCollectionState("policies", "policiesById", policiesModel);

    const reviewQueue = Normalizers.reviewQueue({
      review_queue: {
        count: 1,
        direction: "outbound",
        statuses: ["review_required"],
      },
    });
    const reviewsModel = Normalizers.reviewsModel({
      reviews: [
        {
          review_id: "rev_msg_sent",
          message_id: "msg_sent",
          status: "review_required",
          queue_direction: "outbound",
          decision: "ask",
          delivery_mode: "review_required",
          summary: "Outbound message requires review.",
          reason_code: "policy.ask.role.structured",
          created_at: "2026-03-08T13:00:00.000Z",
          message_preview: "Need approval",
          context_preview: "Prompt context",
          selectors: {
            direction: "outbound",
            resource: "message.general",
            action: "share",
          },
          sender: {
            user_id: "usr_bob",
            username: "bob",
          },
          recipient: {
            id: "usr_alice",
            type: "user",
            username: "alice",
          },
        },
      ],
    });
    Helpers.applyCollectionState("reviews", "reviewsById", reviewsModel);

    const blockedRetention = Normalizers.blockedEventRetention({
      retention: {
        blocked_event_log: "metadata_only",
        payload_excerpt_default: "omitted",
        payload_excerpt_included: false,
        payload_hash_algorithm: "sha256",
        source_message_payload: "messages table may retain payload",
      },
    });
    const blockedEventsModel = Normalizers.blockedEventsModel({
      blocked_events: [
        {
          id: "blocked_msg_nested",
          message_id: "msg_blocked",
          queue_direction: "inbound",
          sender: {
            user_id: "usr_alice",
            username: null,
          },
          reason: "Blocked by policy",
          reason_code: "policy.deny.user.structured",
          direction: "outbound",
          resource: "location.current",
          action: "share",
          stored_payload_excerpt: null,
          payload_hash: "abc123",
          timestamp: "2026-03-08T14:00:00.000Z",
          status: "rejected",
          recipient: {
            id: "grp_1",
            type: "group",
            username: null,
          },
        },
      ],
    });
    Helpers.applyCollectionState("blockedEvents", "blockedEventsById", blockedEventsModel);

    const preferences = Normalizers.preferences({
      preferred_channel: null,
      urgent_behavior: "preferred_only",
      quiet_hours: {
        enabled: false,
        start: "22:00",
        end: "07:00",
        timezone: "UTC",
      },
      default_llm_provider: "anthropic",
      default_llm_model: "claude-3-7-sonnet",
    });

    expect(State.groupsById.get("grp_1")).toMatchObject({
      id: "grp_1",
      inviteOnly: true,
      memberCount: 4,
    });

    expect(State.messagesById.get("msg_sent")).toMatchObject({
      counterpart: "alice",
      transportDirection: "sent",
      senderAgent: "openclaw",
      correlationId: "corr_sent",
    });
    expect(State.messagesById.get("msg_received_nested")).toMatchObject({
      sender: "usr_alice",
      recipient: "bob",
      transportDirection: "received",
      counterpart: "usr_alice",
      messageText: '{\n  "text": "Nested recipient payload"\n}',
    });
    expect(State.messagesById.get("msg_group")).toMatchObject({
      counterpart: "weekend-plan",
      recipientId: "grp_1",
      recipientType: "group",
      transportDirection: "sent",
    });

    expect(State.policiesById.get("pol_1")).toMatchObject({
      targetId: "close_friends",
      policyType: "structured",
      contentText: '{\n  "blockedPatterns": [\n    "meeting title"\n  ]\n}',
    });

    expect(reviewQueue).toMatchObject({
      count: 1,
      direction: "outbound",
      statuses: ["review_required"],
    });
    expect(State.reviewsById.get("rev_msg_sent")).toMatchObject({
      reviewId: "rev_msg_sent",
      transportDirection: "sent",
      sender: "bob",
      recipient: "alice",
    });

    expect(blockedRetention).toMatchObject({
      blockedEventLog: "metadata_only",
      payloadHashAlgorithm: "sha256",
      payloadExcerptIncluded: false,
    });
    expect(State.blockedEventsById.get("blocked_msg_nested")).toMatchObject({
      sender: "usr_alice",
      recipient: "Group conversation",
      transportDirection: "received",
      payloadHash: "abc123",
    });
    expect(preferences).toMatchObject({
      urgentBehavior: "preferred_only",
      quietHours: {
        enabled: false,
        timezone: "UTC",
      },
      defaultLlmProvider: "anthropic",
      defaultLlmModel: "claude-3-7-sonnet",
    });

    Helpers.upsertMessage({
      ...State.messagesById.get("msg_sent"),
      previewText: "Updated preview",
      status: "review_required",
    });

    expect(State.messagesById.get("msg_sent")).toMatchObject({
      previewText: "Updated preview",
      status: "review_required",
    });
    expect(State.conversations.get("alice")).toHaveLength(1);
    expect(State.conversations.get("weekend-plan")).toHaveLength(1);
  });
});
