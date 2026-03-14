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
      auditLog: [],
      auditLogById: new Map(),
      policies: [],
      policiesById: new Map(),
      reviews: [],
      reviewsById: new Map(),
      reviewQueue: null,
      blockedEvents: [],
      blockedEventsById: new Map(),
      blockedEventRetention: null,
      conversations: new Map(),
      logDirectionFilter: "all",
      logStateFilter: "all",
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
      filterAuditLog: (
        items: Array<Record<string, unknown>>,
        filters?: Record<string, unknown> | string,
      ) => Array<Record<string, unknown>>;
      logFeed: (
        messages: Array<Record<string, unknown>>,
        reviews: Array<Record<string, unknown>>,
        blockedEvents: Array<Record<string, unknown>>,
        filters?: Record<string, unknown> | string,
      ) => Array<Record<string, unknown>>;
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

  it("builds a unified audit log with correlated review and blocked states", () => {
    const { Helpers, Normalizers, State } = loadDashboardData();

    const messagesModel = Normalizers.messagesModel(
      [
        {
          id: "msg_delivered_out",
          message: "Delivered dashboard ping",
          sender: { username: "viewer", agent: "openclaw" },
          recipient: { type: "user", username: "alice" },
          status: "delivered",
          delivery_status: "delivered",
          created_at: "2026-03-08T10:00:00.000Z",
          policies_evaluated: JSON.stringify({
            reason_code: "policy.allow.global.structured",
          }),
          correlation_id: "corr_delivered_out",
          direction: "outbound",
          resource: "message.general",
          action: "share",
        },
        {
          id: "msg_review_out",
          message: "Share exact location",
          sender: { username: "viewer", agent: "openclaw" },
          recipient: { type: "user", username: "alice" },
          status: "review_required",
          delivery_status: "review_required",
          created_at: "2026-03-08T11:00:00.000Z",
          policies_evaluated: JSON.stringify({
            effect: "ask",
            reason_code: "policy.ask.user.structured",
          }),
          correlation_id: "corr_review_out",
          direction: "outbound",
          resource: "location.current",
          action: "share",
        },
        {
          id: "msg_blocked_in",
          message: "Share your health summary",
          sender: { username: "alice", agent: "openclaw" },
          recipient: { type: "user", username: "viewer" },
          status: "rejected",
          delivery_status: "rejected",
          created_at: "2026-03-08T12:00:00.000Z",
          policies_evaluated: JSON.stringify({
            effect: "deny",
            reason_code: "policy.deny.inbound.request",
          }),
          correlation_id: "corr_blocked_in",
          direction: "inbound",
          resource: "health.summary",
          action: "request",
        },
      ],
      { currentUsername: "viewer" },
    );
    Helpers.applyCollectionState("messages", "messagesById", messagesModel);

    const reviewsModel = Normalizers.reviewsModel({
      reviews: [
        {
          review_id: "rev_msg_review_out",
          message_id: "msg_review_out",
          queue_direction: "outbound",
          status: "approval_pending",
          decision: "ask",
          delivery_mode: "hold_for_approval",
          summary: "Location share is waiting for approval.",
          reason_code: "policy.ask.user.structured",
          created_at: "2026-03-08T11:01:00.000Z",
          correlation_id: "corr_review_out",
          message_preview: "Share exact location",
          context_preview: "User asked where you are right now.",
          selectors: {
            direction: "outbound",
            resource: "location.current",
            action: "share",
          },
          sender: {
            user_id: "usr_viewer",
            username: "viewer",
            agent: "openclaw",
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

    const blockedEventsModel = Normalizers.blockedEventsModel({
      blocked_events: [
        {
          id: "blocked_msg_blocked_in",
          message_id: "msg_blocked_in",
          queue_direction: "inbound",
          reason: "Inbound request blocked by policy.",
          reason_code: "policy.deny.inbound.request",
          created_at: "2026-03-08T12:01:00.000Z",
          payload_hash: "abc123def456",
          direction: "inbound",
          resource: "health.summary",
          action: "request",
          sender: { username: "alice" },
          recipient: { id: "usr_viewer", type: "user", username: "viewer" },
          status: "rejected",
        },
      ],
    });
    Helpers.applyCollectionState(
      "blockedEvents",
      "blockedEventsById",
      blockedEventsModel,
    );

    expect(State.auditLog).toHaveLength(3);

    expect(State.auditLogById.get("msg_review_out")).toMatchObject({
      kind: "review",
      auditState: "review",
      reviewId: "rev_msg_review_out",
      correlationId: "corr_review_out",
      reasonCode: "policy.ask.user.structured",
      reviewReasonCode: "policy.ask.user.structured",
      messageReasonCode: "policy.ask.user.structured",
      selectors: {
        direction: "outbound",
        resource: "location.current",
        action: "share",
      },
      messageTimestamp: "2026-03-08T11:00:00.000Z",
      reviewTimestamp: "2026-03-08T11:01:00.000Z",
    });

    expect(State.auditLogById.get("msg_blocked_in")).toMatchObject({
      kind: "blocked",
      auditState: "blocked",
      blockedEventId: "blocked_msg_blocked_in",
      correlationId: "corr_blocked_in",
      reasonCode: "policy.deny.inbound.request",
      blockedReasonCode: "policy.deny.inbound.request",
      messageReasonCode: "policy.deny.inbound.request",
      transportDirection: "received",
      selectors: {
        direction: "inbound",
        resource: "health.summary",
        action: "request",
      },
      messageTimestamp: "2026-03-08T12:00:00.000Z",
      blockedTimestamp: "2026-03-08T12:01:00.000Z",
    });

    expect(
      Helpers.logFeed(State.messages, State.reviews, State.blockedEvents, {
        direction: "sent",
      }).map((item) => item.id),
    ).toEqual(["msg_review_out", "msg_delivered_out"]);
    expect(
      Helpers.logFeed(State.messages, State.reviews, State.blockedEvents, {
        direction: "received",
      }).map((item) => item.id),
    ).toEqual(["msg_blocked_in"]);
    expect(
      Helpers.logFeed(State.messages, State.reviews, State.blockedEvents, {
        state: "review",
      }).map((item) => item.id),
    ).toEqual(["msg_review_out"]);
    expect(
      Helpers.logFeed(State.messages, State.reviews, State.blockedEvents, {
        state: "blocked",
      }).map((item) => item.id),
    ).toEqual(["msg_blocked_in"]);
    expect(
      Helpers.logFeed(State.messages, State.reviews, State.blockedEvents, {
        state: "delivered",
      }).map((item) => item.id),
    ).toEqual(["msg_delivered_out"]);
  });

  it("maps canonical policy records into boundary categories, effects, audiences, and advanced fallbacks", () => {
    const { Normalizers } = loadDashboardData();

    const opinionBoundary = Normalizers.policy({
      id: "pol_opinion",
      scope: "global",
      direction: "outbound",
      resource: "message.general",
      action: "recommend",
      effect: "allow",
      evaluator: "structured",
      policy_content: "Restaurant recommendations are okay to share.",
    });

    const availabilityBoundary = Normalizers.policy({
      id: "pol_availability",
      scope: "role",
      target_id: "close_friends",
      direction: "response",
      resource: "calendar.event",
      action: "read_details",
      effect: "ask",
      evaluator: "llm",
      policy_content: "Ask before sharing calendar details with close friends.",
    });

    const locationBoundary = Normalizers.policy({
      id: "pol_location",
      scope: "user",
      target_id: "usr_alice",
      direction: "outbound",
      resource: "location.current",
      action: "share",
      effect: "deny",
      evaluator: "llm",
      policy_content: "Never share exact location.",
    });

    const healthBoundary = Normalizers.policy({
      id: "pol_health",
      scope: "group",
      target_id: "grp_care_circle",
      direction: "outbound",
      resource: "health.summary",
      action: "share",
      effect: "ask",
      evaluator: "structured",
      policy_content: { allowedSummaries: ["wellness check-ins"] },
    });

    const financialBoundary = Normalizers.policy({
      id: "pol_financial",
      scope: "global",
      direction: "outbound",
      resource: "financial.transaction",
      action: "share",
      effect: "deny",
      evaluator: "llm",
      policy_content: "Do not share payment history.",
    });

    const contactBoundary = Normalizers.policy({
      id: "pol_contact",
      scope: "role",
      target_id: "work_contacts",
      direction: "outbound",
      resource: "contact.email",
      action: "share",
      effect: "deny",
      evaluator: "structured",
      policy_content: { blockedPatterns: ["@"] },
    });

    const genericBoundary = Normalizers.policy({
      id: "pol_generic",
      scope: "global",
      direction: "outbound",
      resource: "message.general",
      action: "share",
      effect: "allow",
      evaluator: "llm",
      policy_content: "General status updates are fine.",
    });

    const advancedBoundary = Normalizers.policy({
      id: "pol_advanced",
      scope: "group",
      target_id: "grp_lab",
      direction: "notification",
      resource: "custom.preference",
      action: "share",
      effect: "ask",
      evaluator: "structured",
      policy_content: { custom: true },
    });

    expect(opinionBoundary.boundary).toMatchObject({
      category: "opinions",
      categoryLabel: "Opinions and recommendations",
      effect: {
        value: "allow",
        badgeLabel: "Allow",
      },
      audience: {
        scope: "global",
        scopeLabel: "Global",
        displayLabel: "Anyone on Mahilo",
      },
      managementPath: "guided",
    });

    expect(availabilityBoundary.boundary).toMatchObject({
      category: "availability",
      effect: {
        value: "ask",
        badgeLabel: "Ask",
      },
      audience: {
        scope: "role",
        scopeLabel: "Role",
        targetLabel: "Close Friends",
        displayLabel: "Role: Close Friends",
      },
      selector: {
        label: "Event details",
        directionLabel: "Response",
      },
    });

    expect(locationBoundary.boundary).toMatchObject({
      category: "location",
      effect: {
        value: "deny",
        badgeLabel: "Deny",
      },
      audience: {
        scope: "user",
        scopeLabel: "Contact",
        displayLabel: "Specific contact",
      },
    });

    expect(healthBoundary.boundary.category).toBe("health");
    expect(financialBoundary.boundary.category).toBe("financial");
    expect(contactBoundary.boundary.category).toBe("contact");
    expect(genericBoundary.boundary.category).toBe("generic");

    expect(advancedBoundary.boundary).toMatchObject({
      category: "advanced",
      managementPath: "advanced",
      audience: {
        scope: "group",
        scopeLabel: "Group",
        displayLabel: "Group conversation",
      },
      selector: {
        directionLabel: "Notification",
        summary: "custom.preference / share",
      },
    });
    expect(advancedBoundary.boundary.advancedSummary).toContain("advanced path");
  });
});
