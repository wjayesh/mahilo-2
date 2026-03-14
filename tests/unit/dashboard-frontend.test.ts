import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createApp } from "../../src/server";
import * as schema from "../../src/db/schema";
import {
  addRoleToFriendship,
  cleanupTestDatabase,
  createAgentConnection,
  createFriendship,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";

type DashboardInternals = {
  Helpers: {
    applyCollectionState: (
      stateKey: string,
      indexKey: string,
      model: { ids: string[]; byId: Map<string, unknown>; items: unknown[] },
    ) => void;
    collectionModel: (
      items: unknown[],
      getId?: (item: unknown) => unknown,
    ) => { ids: string[]; byId: Map<string, unknown>; items: unknown[] };
    rebuildConversations: () => void;
  };
  Normalizers: {
    blockedEventsModel: (value: unknown) => {
      ids: string[];
      byId: Map<string, unknown>;
      items: unknown[];
    };
    blockedEvent: (value: unknown) => Record<string, unknown>;
    friendsModel: (value: unknown) => {
      ids: string[];
      byId: Map<string, unknown>;
      items: unknown[];
    };
    group: (value: unknown) => unknown;
    message: (
      value: unknown,
      options?: { currentUsername?: string },
    ) => Record<string, unknown>;
    policiesModel: (value: unknown) => {
      ids: string[];
      byId: Map<string, unknown>;
      items: unknown[];
    };
    reviewsModel: (value: unknown) => {
      ids: string[];
      byId: Map<string, unknown>;
      items: unknown[];
    };
    review: (value: unknown) => Record<string, unknown>;
  };
  State: Record<string, any>;
  UI: {
    handleAddFriendRequest: () => Promise<void>;
    handleRegister: () => Promise<void>;
    renderLogs: (direction?: string) => void;
    renderFriends: (filter?: string) => void;
    handleSaveAgent: () => Promise<void>;
    handleSendMessage: () => Promise<void>;
    selectChat: (username: string) => void;
    switchView: (view: string) => void;
  };
};

type DashboardHarness = {
  boot: () => Promise<void>;
  dashboard: DashboardInternals;
  fetchCalls: string[];
  getElement: (id: string) => ElementStub;
};

type HarnessOptions = {
  app?: ReturnType<typeof createApp>;
  apiKey?: string;
  fetchImpl?: (url: string, options?: RequestInit) => Promise<{
    json: () => Promise<unknown>;
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>;
  sessionUser?: Record<string, unknown>;
};

class ClassListStub {
  private readonly values = new Set<string>();

  add(...classes: string[]) {
    for (const className of classes) {
      this.values.add(className);
    }
  }

  contains(className: string) {
    return this.values.has(className);
  }

  remove(...classes: string[]) {
    for (const className of classes) {
      this.values.delete(className);
    }
  }

  toggle(className: string, force?: boolean) {
    if (force === undefined) {
      if (this.values.has(className)) {
        this.values.delete(className);
      } else {
        this.values.add(className);
      }
      return this.values.has(className);
    }

    if (force) {
      this.values.add(className);
    } else {
      this.values.delete(className);
    }

    return this.values.has(className);
  }
}

class ElementStub {
  readonly children: ElementStub[] = [];
  readonly classList = new ClassListStub();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  checked = false;
  className = "";
  disabled = false;
  id: string;
  innerHTML = "";
  onclick: (() => void) | null = null;
  previousElementSibling: { style: Record<string, string> } | null = {
    style: {},
  };
  scrollHeight = 0;
  scrollTop = 0;
  textContent = "";
  value = "";

  constructor(id = "") {
    this.id = id;
  }

  addEventListener() {}

  appendChild(child: ElementStub) {
    this.children.push(child);
    return child;
  }

  querySelector() {
    return new ElementStub();
  }

  querySelectorAll() {
    return [];
  }

  remove() {}

  removeChild(child: ElementStub) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
    }
  }

  reset() {}

  scrollIntoView() {}

  select() {}
}

class WebSocketStub {
  static readonly OPEN = 1;
  onclose?: () => void;
  onopen?: () => void;
  readyState = WebSocketStub.OPEN;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    setTimeout(() => this.onopen?.(), 0);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  send() {}
}

class IntersectionObserverStub {
  observe() {}
  disconnect() {}
}

function extractHtmlIds() {
  return Array.from(
    new Set(
      [...readFileSync("public/index.html", "utf8").matchAll(/id=\"([^\"]+)\"/g)].map(
        (match) => match[1],
      ),
    ),
  );
}

function createDocumentStub(ids: string[]) {
  const elements = new Map(ids.map((id) => [id, new ElementStub(id)]));

  const getElement = (id: string) => {
    const existing = elements.get(id);
    if (existing) {
      return existing;
    }

    const next = new ElementStub(id);
    elements.set(id, next);
    return next;
  };

  const documentStub = {
    _readyCallbacks: [] as Array<() => void>,
    addEventListener(event: string, callback: () => void) {
      if (event === "DOMContentLoaded") {
        this._readyCallbacks.push(callback);
      }
    },
    body: new ElementStub("body"),
    createElement(tag: string) {
      return new ElementStub(tag);
    },
    execCommand() {
      return true;
    },
    getElementById(id: string) {
      return getElement(id);
    },
    querySelector(selector: string) {
      if (selector === ".landing-nav") {
        return new ElementStub("landing-nav");
      }
      return null;
    },
    querySelectorAll() {
      return [] as ElementStub[];
    },
  };

  return {
    documentStub,
    getElement,
  };
}

async function flushDashboardWork() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createDashboardHarness(options: HarnessOptions = {}): DashboardHarness {
  const { documentStub, getElement } = createDocumentStub(extractHtmlIds());
  const sessionStore = new Map<string, string>();

  if (options.apiKey || options.sessionUser) {
    sessionStore.set(
      "mahilo_session",
      JSON.stringify({
        apiKey: options.apiKey ?? null,
        user: options.sessionUser ?? null,
      }),
    );
  }

  const fetchCalls: string[] = [];
  const fetchImpl =
    options.fetchImpl ??
    (async (url: string, requestOptions?: RequestInit) => {
      if (!options.app) {
        throw new Error(`Unexpected fetch without app: ${url}`);
      }

      const requestUrl = new URL(url);
      const path = `${requestUrl.pathname}${requestUrl.search}`;
      fetchCalls.push(path);

      const response = await options.app.request(path, requestOptions);
      return {
        ok: response.ok,
        status: response.status,
        async json() {
          return await response.clone().json();
        },
        async text() {
          return await response.clone().text();
        },
      };
    });

  const localStorage = {
    getItem(key: string) {
      return sessionStore.get(key) ?? null;
    },
    removeItem(key: string) {
      sessionStore.delete(key);
    },
    setItem(key: string, value: string) {
      sessionStore.set(key, value);
    },
  };

  const context: Record<string, any> = {
    Date,
    JSON,
    Map,
    Math,
    Promise,
    URL,
    URLSearchParams,
    WebSocket: WebSocketStub,
    IntersectionObserver: IntersectionObserverStub,
    clearInterval: () => {},
    clearTimeout,
    confirm: () => true,
    console,
    document: documentStub,
    fetch: (url: string, requestOptions?: RequestInit) =>
      fetchImpl(url, requestOptions),
    localStorage,
    navigator: {
      clipboard: {
        writeText: async () => {},
      },
    },
    setInterval: () => 1,
    setTimeout,
  };

  context.window = context;
  context.window.addEventListener = () => {};
  context.window.confirm = context.confirm;
  context.window.document = documentStub;
  context.window.fetch = context.fetch;
  context.window.IntersectionObserver = IntersectionObserverStub;
  context.window.localStorage = localStorage;
  context.window.location = { origin: "http://localhost" };
  context.window.navigator = context.navigator;
  context.window.removeEventListener = () => {};
  context.window.scrollY = 0;
  context.window.WebSocket = WebSocketStub;

  createContext(context);
  runInContext(
    `${readFileSync("public/app.js", "utf8")}\n;globalThis.__dashboard__ = { Helpers, Normalizers, State, UI };`,
    context,
    {
      filename: "public/app.js",
    },
  );

  return {
    async boot() {
      for (const callback of documentStub._readyCallbacks) {
        callback();
      }
      await flushDashboardWork();
    },
    dashboard: context.__dashboard__ as DashboardInternals,
    fetchCalls,
    getElement,
  };
}

describe("Dashboard frontend data adapter (DASH-001)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("normalizes friend collections by friendship_id and resolves nested message participants", () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(`Unexpected fetch while testing normalizers: ${url}`);
      },
    });

    const { Normalizers } = harness.dashboard;
    const friendsModel = Normalizers.friendsModel({
      friends: [
        {
          friendship_id: "fr_dashboard",
          user_id: "usr_peer",
          username: "peer",
          display_name: "Peer User",
          direction: "received",
          interaction_count: 7,
          roles: ["friends"],
          since: "2026-03-14T10:00:00.000Z",
          status: "accepted",
        },
      ],
    });

    expect(friendsModel.ids).toEqual(["fr_dashboard"]);
    expect(friendsModel.byId.get("fr_dashboard")).toEqual(
      expect.objectContaining({
        displayName: "Peer User",
        friendshipId: "fr_dashboard",
        interactionCount: 7,
        username: "peer",
      }),
    );

    const message = Normalizers.message(
      {
        created_at: "2026-03-14T12:00:00.000Z",
        id: "msg_nested",
        message: { body: "Hello from nested sender" },
        recipient: {
          connection_id: "conn_alice",
          type: "user",
          username: "alice",
        },
        sender: {
          agent: "openclaw",
          connection_id: "conn_bob",
          username: "bob",
        },
        status: "delivered",
      },
      { currentUsername: "alice" },
    );

    expect(message).toEqual(
      expect.objectContaining({
        counterpart: "bob",
        recipient: "alice",
        recipientConnectionId: "conn_alice",
        sender: "bob",
        senderAgent: "openclaw",
        senderConnectionId: "conn_bob",
        transportDirection: "received",
      }),
    );
    expect(message.previewText).toContain("Hello from nested sender");
  });

  it("disables user-facing sends for group threads that lack a stable group identifier", async () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(`Unexpected fetch while testing group-thread guard: ${url}`);
      },
    });

    const { Helpers, Normalizers, State, UI } = harness.dashboard;
    const groupMessage = Normalizers.message(
      {
        created_at: "2026-03-14T12:30:00.000Z",
        id: "msg_group_missing_id",
        message: "Group announcement",
        recipient_type: "group",
        sender: "dashboard_viewer",
        status: "delivered",
      },
      { currentUsername: "dashboard_viewer" },
    );

    Helpers.applyCollectionState(
      "messages",
      "messagesById",
      Helpers.collectionModel([groupMessage]),
    );
    Helpers.rebuildConversations();

    expect(State.conversations.get("Group conversation")).toHaveLength(1);

    UI.selectChat("Group conversation");

    const input = harness.getElement("chat-input");
    const sendButton = harness.getElement("send-message-btn");
    input.value = "Can anyone see this?";

    expect(input.disabled).toBe(true);
    expect(sendButton.disabled).toBe(true);

    await UI.handleSendMessage();

    expect(input.value).toBe("Can anyone see this?");
    expect(harness.getElement("chat-recipient-status").textContent).toBe("Group thread");
  });

  it("boots after auth and completes all top-level loaders against current server routes", async () => {
    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_viewer",
      "Viewer",
    );
    const { user: peer } = await createTestUser("dashboard_peer", "Peer");
    const connection = await createAgentConnection(viewer.id, {
      framework: "openclaw",
      label: "default",
    });
    const friendship = await createFriendship(viewer.id, peer.id, "accepted");
    await addRoleToFriendship(friendship.id, "friends");

    const groupId = nanoid();
    await db.insert(schema.groups).values({
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      description: "Garden Club",
      id: groupId,
      inviteOnly: true,
      name: "garden_club",
      ownerUserId: viewer.id,
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    await db.insert(schema.groupMemberships).values([
      {
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        groupId,
        id: nanoid(),
        invitedByUserId: null,
        role: "owner",
        status: "active",
        userId: viewer.id,
      },
      {
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        groupId,
        id: nanoid(),
        invitedByUserId: viewer.id,
        role: "member",
        status: "active",
        userId: peer.id,
      },
    ]);

    await db.insert(schema.policies).values({
      action: "share",
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      direction: "outbound",
      effect: "ask",
      enabled: true,
      evaluator: "llm",
      id: "pol_dashboard",
      policyContent: "Ask before sharing exact location.",
      policyType: "llm",
      priority: 50,
      resource: "message.general",
      scope: "global",
      source: "default",
      targetId: null,
      userId: viewer.id,
    });

    await db.insert(schema.messages).values([
      {
        action: "share",
        context: "Sent from the dashboard",
        correlationId: "corr_dashboard_1",
        createdAt: new Date("2026-03-14T01:00:00.000Z"),
        deliveredAt: new Date("2026-03-14T01:00:05.000Z"),
        direction: "outbound",
        id: "msg_dashboard_outbound",
        payload: "Checking in about dinner",
        payloadType: "text/plain",
        recipientId: peer.id,
        recipientType: "user",
        resource: "message.general",
        senderAgent: connection.label,
        senderConnectionId: connection.id,
        senderUserId: viewer.id,
        status: "delivered",
      },
      {
        action: "share",
        context: null,
        correlationId: "corr_dashboard_2",
        createdAt: new Date("2026-03-14T02:00:00.000Z"),
        deliveredAt: new Date("2026-03-14T02:00:03.000Z"),
        direction: "inbound",
        id: "msg_dashboard_inbound",
        payload: "Sounds good here.",
        payloadType: "text/plain",
        recipientId: viewer.id,
        recipientType: "user",
        resource: "message.general",
        senderAgent: "peer-agent",
        senderConnectionId: null,
        senderUserId: peer.id,
        status: "delivered",
      },
      {
        action: "share",
        context: "plugin preflight",
        createdAt: new Date("2026-03-14T03:00:00.000Z"),
        direction: "outbound",
        id: "msg_dashboard_review",
        payload: "Share exact location",
        payloadType: "text/plain",
        policiesEvaluated: JSON.stringify({
          effect: "ask",
          matched_policy_ids: ["pol_dashboard"],
          reason: "Needs review before delivery.",
          reason_code: "policy.ask.role.structured",
          resolver_layer: "user_policies",
          winning_policy_id: "pol_dashboard",
        }),
        recipientId: peer.id,
        recipientType: "user",
        resource: "location.current",
        senderAgent: connection.label,
        senderConnectionId: connection.id,
        senderUserId: viewer.id,
        status: "approval_pending",
      },
      {
        action: "share",
        context: "plugin send",
        createdAt: new Date("2026-03-14T04:00:00.000Z"),
        direction: "outbound",
        id: "msg_dashboard_blocked",
        payload: "My exact address is 123 Example St",
        payloadType: "text/plain",
        policiesEvaluated: JSON.stringify({
          effect: "deny",
          matched_policy_ids: ["pol_dashboard"],
          reason: "Blocked by policy.",
          reason_code: "policy.deny.role.structured",
          resolver_layer: "user_policies",
          winning_policy_id: "pol_dashboard",
        }),
        recipientId: peer.id,
        recipientType: "user",
        rejectionReason: "Blocked by policy.",
        resource: "location.current",
        senderAgent: connection.label,
        senderConnectionId: connection.id,
        senderUserId: viewer.id,
        status: "rejected",
      },
    ]);

    const app = createApp();
    const harness = createDashboardHarness({
      app,
      apiKey,
      sessionUser: {
        display_name: viewer.displayName,
        status: viewer.status,
        user_id: viewer.id,
        username: viewer.username,
        verified_at: viewer.verifiedAt?.toISOString() ?? null,
      },
    });

    await harness.boot();

    expect(harness.fetchCalls.slice().sort()).toEqual(
      [
        "/api/v1/agents",
        "/api/v1/auth/me",
        `/api/v1/contacts/${peer.username}/connections`,
        "/api/v1/friends?status=accepted",
        "/api/v1/friends?status=blocked",
        "/api/v1/friends?status=pending",
        "/api/v1/groups",
        "/api/v1/messages?limit=50",
        "/api/v1/preferences",
        "/api/v1/plugin/events/blocked?limit=25",
        "/api/v1/plugin/reviews?limit=25",
        "/api/v1/policies",
      ].sort(),
    );

    const { State } = harness.dashboard;
    expect(State.agentsById.size).toBe(1);
    expect(State.friendsById.get(friendship.id)).toEqual(
      expect.objectContaining({
        direction: "sent",
        friendshipId: friendship.id,
        username: peer.username,
      }),
    );
    expect(State.groupsById.get(groupId)).toEqual(
      expect.objectContaining({
        id: groupId,
        inviteOnly: true,
        memberCount: 2,
      }),
    );
    expect(State.messagesById.size).toBe(4);
    expect(State.messagesById.get("msg_dashboard_inbound")).toEqual(
      expect.objectContaining({
        counterpart: peer.username,
        transportDirection: "received",
      }),
    );
    expect(State.policiesById.get("pol_dashboard")).toEqual(
      expect.objectContaining({
        effect: "ask",
        policyType: "llm",
        resource: "message.general",
      }),
    );
    expect(State.reviewsById.size).toBe(1);
    expect(State.blockedEventsById.size).toBe(1);
    expect(State.reviewQueue).toEqual(
      expect.objectContaining({
        count: 1,
      }),
    );
    expect(State.blockedEventRetention).toEqual(
      expect.objectContaining({
        blockedEventLog: "metadata_only",
        payloadHashAlgorithm: "sha256",
      }),
    );
    expect(State.preferences).toEqual(
      expect.objectContaining({
        urgentBehavior: "preferred_only",
        quietHours: expect.objectContaining({
          enabled: false,
          timezone: "UTC",
        }),
      }),
    );
    expect(State.conversations.get(peer.username)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Checking in about dinner",
        }),
      ]),
    );
    expect(harness.getElement("dashboard-screen").classList.contains("hidden")).toBe(
      false,
    );
    expect(harness.getElement("pref-urgent").value).toBe("preferred_only");
    expect(harness.getElement("groups-grid").innerHTML.length).toBeGreaterThan(0);
    expect(harness.getElement("logs-list").innerHTML.length).toBeGreaterThan(0);
    expect(harness.getElement("overview-message-list").innerHTML.length).toBeGreaterThan(
      0,
    );
  });
});

describe("Dashboard dead-end action cleanup (DASH-002)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("submits the add-by-username modal through the real friend-request API", async () => {
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_add_viewer",
      "Viewer",
    );
    const { user: peer } = await createTestUser("dashboard_add_peer", "Peer");
    const app = createApp();

    const harness = createDashboardHarness({
      app,
      apiKey,
      sessionUser: {
        display_name: viewer.displayName,
        status: viewer.status,
        user_id: viewer.id,
        username: viewer.username,
        verified_at: viewer.verifiedAt?.toISOString() ?? null,
      },
    });

    await harness.boot();

    const initialCallCount = harness.fetchCalls.length;
    harness.getElement("add-friend-username").value = `@${peer.username}`;

    await harness.dashboard.UI.handleAddFriendRequest();

    expect(harness.fetchCalls.slice(initialCallCount)).toEqual(
      expect.arrayContaining([
        "/api/v1/friends/request",
        "/api/v1/friends?status=accepted",
        "/api/v1/friends?status=blocked",
        "/api/v1/friends?status=pending",
      ]),
    );
    expect(harness.dashboard.State.friends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "sent",
          status: "pending",
          username: peer.username,
        }),
      ]),
    );
  });

  it("gates the stale browser register path instead of calling the invite-only register API", async () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(`Unexpected fetch from gated browser register path: ${url}`);
      },
    });

    await harness.boot();

    harness.getElement("reg-username").value = "browseruser";
    harness.getElement("reg-display-name").value = "Browser User";

    await harness.dashboard.UI.handleRegister();

    const toastContainer = harness.getElement("toast-container");
    expect(toastContainer.children).toHaveLength(1);
    expect(toastContainer.children[0]?.innerHTML).toContain(
      "Browser signup is not part of the active dashboard flow",
    );
  });

  it("removes legacy message routing from friends and renders explicit group actions", async () => {
    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_cta_viewer",
      "Viewer",
    );
    const { user: peer } = await createTestUser("dashboard_cta_peer", "Peer");
    const { user: owner } = await createTestUser("dashboard_group_owner", "Owner");

    await createFriendship(viewer.id, peer.id, "accepted");

    const activeGroupId = nanoid();
    await db.insert(schema.groups).values({
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      description: "Active project group",
      id: activeGroupId,
      inviteOnly: true,
      name: "active_project_group",
      ownerUserId: owner.id,
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    await db.insert(schema.groupMemberships).values([
      {
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        groupId: activeGroupId,
        id: nanoid(),
        invitedByUserId: null,
        role: "owner",
        status: "active",
        userId: owner.id,
      },
      {
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        groupId: activeGroupId,
        id: nanoid(),
        invitedByUserId: owner.id,
        role: "member",
        status: "active",
        userId: viewer.id,
      },
    ]);

    const invitedGroupId = nanoid();
    await db.insert(schema.groups).values({
      createdAt: new Date("2026-03-02T00:00:00.000Z"),
      description: "Invite-only community",
      id: invitedGroupId,
      inviteOnly: true,
      name: "invite_only_circle",
      ownerUserId: owner.id,
      updatedAt: new Date("2026-03-02T00:00:00.000Z"),
    });
    await db.insert(schema.groupMemberships).values([
      {
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
        groupId: invitedGroupId,
        id: nanoid(),
        invitedByUserId: null,
        role: "owner",
        status: "active",
        userId: owner.id,
      },
      {
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
        groupId: invitedGroupId,
        id: nanoid(),
        invitedByUserId: owner.id,
        role: "member",
        status: "invited",
        userId: viewer.id,
      },
    ]);

    const harness = createDashboardHarness({
      app: createApp(),
      apiKey,
      sessionUser: {
        display_name: viewer.displayName,
        status: viewer.status,
        user_id: viewer.id,
        username: viewer.username,
        verified_at: viewer.verifiedAt?.toISOString() ?? null,
      },
    });

    await harness.boot();

    expect(harness.getElement("friends-list").innerHTML).not.toContain(
      "switchView('messages')",
    );
    expect(harness.getElement("friends-list").innerHTML).toContain(
      "handleBlockFriend",
    );
    expect(harness.getElement("groups-grid").innerHTML).toContain("Join Invite");
    expect(harness.getElement("groups-grid").innerHTML).toContain("Leave Group");
    expect(harness.getElement("groups-grid").innerHTML).not.toContain(
      '<div class="group-card" onclick=',
    );
    expect(harness.getElement("groups-grid").innerHTML).not.toContain("Tap to join");
  });

  it("stops fabricating placeholder public keys in the primary agent flow", async () => {
    let registerPayload: Record<string, unknown> | null = null;

    const harness = createDashboardHarness({
      fetchImpl: async (url, requestOptions) => {
        const requestUrl = new URL(url);
        const path = `${requestUrl.pathname}${requestUrl.search}`;

        if (path === "/api/v1/agents" && requestOptions?.method === "POST") {
          registerPayload = JSON.parse(String(requestOptions.body));
          return {
            ok: true,
            status: 201,
            async json() {
              return { connection_id: "conn_dashboard_test" };
            },
            async text() {
              return "";
            },
          };
        }

        if (path === "/api/v1/agents") {
          return {
            ok: true,
            status: 200,
            async json() {
              return [];
            },
            async text() {
              return "";
            },
          };
        }

        throw new Error(`Unexpected fetch while saving agent: ${path}`);
      },
    });

    harness.getElement("agent-framework").value = "openclaw";
    harness.getElement("agent-label").value = "default";
    harness.getElement("agent-description").value = "Primary sender";
    harness.getElement("agent-callback").value = "https://agent.example/callback";
    harness.getElement("agent-public-key").value = "";
    harness.getElement("agent-capabilities").value = "calendar, ask-around";

    await harness.dashboard.UI.handleSaveAgent();

    expect(registerPayload).toEqual(
      expect.objectContaining({
        callback_url: "https://agent.example/callback",
        capabilities: ["calendar", "ask-around"],
        framework: "openclaw",
        label: "default",
      }),
    );
    expect(registerPayload?.public_key).toBeUndefined();
    expect(registerPayload?.public_key_alg).toBeUndefined();
  });
});

describe("Dashboard navigation and audit IA (DASH-010)", () => {
  it("uses product-aligned navigation labels and titles while keeping legacy view aliases working", async () => {
    const html = readFileSync("public/index.html", "utf8");
    const sidebarNav =
      html.match(/<nav class="sidebar-nav">([\s\S]*?)<\/nav>/)?.[1] ?? "";

    expect(sidebarNav).toContain('data-view="network"');
    expect(sidebarNav).toContain(">Network<");
    expect(sidebarNav).toContain('data-view="connections"');
    expect(sidebarNav).toContain(">Sender Connections<");
    expect(sidebarNav).toContain('data-view="boundaries"');
    expect(sidebarNav).toContain(">Boundaries<");
    expect(sidebarNav).not.toContain(">My Agents<");
    expect(sidebarNav).not.toContain(">Friends<");
    expect(sidebarNav).not.toContain(">Policies<");

    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(`Unexpected fetch while testing view aliases: ${url}`);
      },
    });

    await harness.boot();

    harness.dashboard.UI.switchView("friends");
    expect(harness.dashboard.State.currentView).toBe("network");
    expect(harness.getElement("page-title").textContent).toBe("Network");

    harness.dashboard.UI.switchView("agents");
    expect(harness.dashboard.State.currentView).toBe("connections");
    expect(harness.getElement("page-title").textContent).toBe(
      "Sender Connections",
    );

    harness.dashboard.UI.switchView("policies");
    expect(harness.dashboard.State.currentView).toBe("boundaries");
    expect(harness.getElement("page-title").textContent).toBe("Boundaries");

    harness.dashboard.UI.switchView("developer");
    expect(harness.getElement("page-title").textContent).toBe("Developer");
    expect(harness.getElement("page-subtitle").textContent).toContain("Advanced");
  });

  it("enriches delivery logs with review, blocked, and ask-around audit cues", async () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(`Unexpected fetch while testing log audit cues: ${url}`);
      },
    });

    const { Helpers, Normalizers, UI } = harness.dashboard;

    const askAroundMessages = [
      Normalizers.message(
        {
          created_at: "2026-03-14T12:00:00.000Z",
          id: "msg_ask_alice",
          message: "Anyone know a dentist in SF?",
          correlation_id: "corr_ask_around",
          recipient: { type: "user", username: "alice" },
          sender: { agent: "default", username: "viewer" },
          status: "delivered",
        },
        { currentUsername: "viewer" },
      ),
      Normalizers.message(
        {
          created_at: "2026-03-14T12:01:00.000Z",
          id: "msg_ask_bob",
          message: "Anyone know a dentist in SF?",
          correlation_id: "corr_ask_around",
          recipient: { type: "user", username: "bob" },
          sender: { agent: "default", username: "viewer" },
          status: "delivered",
        },
        { currentUsername: "viewer" },
      ),
    ];

    const review = Normalizers.review({
      created_at: "2026-03-14T12:02:00.000Z",
      decision: "ask",
      delivery_mode: "review_required",
      message_preview: "Share exact location",
      queue_direction: "outbound",
      recipient: { type: "user", username: "alice" },
      review_id: "rev_boundary_1",
      sender: { username: "viewer" },
      selectors: { resource: "location.current" },
      status: "approval_pending",
      summary: "Needs approval before delivery.",
    });

    const blocked = Normalizers.blockedEvent({
      created_at: "2026-03-14T12:03:00.000Z",
      id: "blocked_boundary_1",
      payload_hash: "abc123def456",
      queue_direction: "outbound",
      reason: "Blocked by boundary.",
      recipient: { type: "user", username: "bob" },
      resource: "location.current",
      sender: { username: "viewer" },
      status: "rejected",
    });

    Helpers.applyCollectionState(
      "messages",
      "messagesById",
      Helpers.collectionModel(askAroundMessages),
    );
    Helpers.applyCollectionState(
      "reviews",
      "reviewsById",
      Helpers.collectionModel([review]),
    );
    Helpers.applyCollectionState(
      "blockedEvents",
      "blockedEventsById",
      Helpers.collectionModel([blocked]),
    );

    UI.renderLogs();

    expect(harness.getElement("logs-summary").innerHTML).toContain("Review Queue");
    expect(harness.getElement("logs-summary").innerHTML).toContain("Blocked Events");
    expect(harness.getElement("logs-summary").innerHTML).toContain(
      "Ask-around Threads",
    );
    expect(harness.getElement("logs-list").innerHTML).toContain("Review queue");
    expect(harness.getElement("logs-list").innerHTML).toContain("Blocked");
    expect(harness.getElement("logs-list").innerHTML).toContain(
      "Ask-around thread (2)",
    );
  });
});

describe("Dashboard network list (DASH-020)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("renders accepted, incoming, outgoing, and blocked relationships from the real friendship model", async () => {
    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_network_viewer",
      "Viewer",
    );
    const { user: acceptedPeer } = await createTestUser(
      "dashboard_network_accepted",
      "Accepted Peer",
    );
    const { user: incomingPeer } = await createTestUser(
      "dashboard_network_incoming",
      "Incoming Peer",
    );
    const { user: outgoingPeer } = await createTestUser(
      "dashboard_network_outgoing",
      "Outgoing Peer",
    );
    const { user: blockedPeer } = await createTestUser(
      "dashboard_network_blocked",
      "Blocked Peer",
    );
    const connection = await createAgentConnection(viewer.id, {
      framework: "openclaw",
      label: "default",
    });

    const accepted = await createFriendship(viewer.id, acceptedPeer.id, "accepted");
    const incoming = await createFriendship(incomingPeer.id, viewer.id, "pending");
    const outgoing = await createFriendship(viewer.id, outgoingPeer.id, "pending");
    const blocked = await createFriendship(viewer.id, blockedPeer.id, "blocked");

    await addRoleToFriendship(accepted.id, "close_friends");

    await db
      .update(schema.friendships)
      .set({ createdAt: new Date("2026-03-01T00:00:00.000Z") })
      .where(eq(schema.friendships.id, accepted.id));
    await db
      .update(schema.friendships)
      .set({ createdAt: new Date("2026-03-02T00:00:00.000Z") })
      .where(eq(schema.friendships.id, incoming.id));
    await db
      .update(schema.friendships)
      .set({ createdAt: new Date("2026-03-03T00:00:00.000Z") })
      .where(eq(schema.friendships.id, outgoing.id));
    await db
      .update(schema.friendships)
      .set({ createdAt: new Date("2026-03-04T00:00:00.000Z") })
      .where(eq(schema.friendships.id, blocked.id));

    await db.insert(schema.messages).values([
      {
        action: "share",
        context: "Network test outbound",
        correlationId: "corr_network_outbound",
        createdAt: new Date("2026-03-12T10:00:00.000Z"),
        deliveredAt: new Date("2026-03-12T10:00:05.000Z"),
        direction: "outbound",
        id: "msg_network_outbound",
        payload: "Do you know a good dentist?",
        payloadType: "text/plain",
        recipientId: acceptedPeer.id,
        recipientType: "user",
        resource: "message.general",
        senderAgent: connection.label,
        senderConnectionId: connection.id,
        senderUserId: viewer.id,
        status: "delivered",
      },
      {
        action: "share",
        context: null,
        correlationId: "corr_network_inbound",
        createdAt: new Date("2026-03-13T11:00:00.000Z"),
        deliveredAt: new Date("2026-03-13T11:00:03.000Z"),
        direction: "inbound",
        id: "msg_network_inbound",
        payload: "Yes, try Dr. Chen.",
        payloadType: "text/plain",
        recipientId: viewer.id,
        recipientType: "user",
        resource: "message.general",
        senderAgent: "peer-agent",
        senderConnectionId: null,
        senderUserId: acceptedPeer.id,
        status: "delivered",
      },
    ]);

    const harness = createDashboardHarness({
      app: createApp(),
      apiKey,
      sessionUser: {
        display_name: viewer.displayName,
        status: viewer.status,
        user_id: viewer.id,
        username: viewer.username,
        verified_at: viewer.verifiedAt?.toISOString() ?? null,
      },
    });

    await harness.boot();

    expect(harness.getElement("all-network-count").textContent).toBe("4");
    expect(harness.getElement("accepted-count").textContent).toBe("1");
    expect(harness.getElement("incoming-count").textContent).toBe("1");
    expect(harness.getElement("outgoing-count").textContent).toBe("1");
    expect(harness.getElement("blocked-count").textContent).toBe("1");
    expect(harness.getElement("network-list-total").textContent).toBe(
      "4 relationships",
    );

    expect(harness.dashboard.State.friendsById.get(accepted.id)).toEqual(
      expect.objectContaining({
        friendshipId: accepted.id,
        interactionCount: 2,
        roles: ["close_friends"],
      }),
    );

    const allHtml = harness.getElement("friends-list").innerHTML;
    expect(allHtml).toContain("Pending incoming");
    expect(allHtml).toContain("Pending outgoing");
    expect(allHtml).toContain("Roles: Close Friends");
    expect(allHtml).toContain("Interactions: 2 interactions");
    expect(allHtml).toContain("Connected Mar 1, 2026");
    expect(allHtml).toContain(`handleBlockFriend('${accepted.id}')`);
    expect(allHtml).toContain(`handleAcceptFriend('${incoming.id}')`);
    expect(allHtml).toContain(`handleUnfriend('${outgoing.id}')`);
    expect(allHtml).toContain(`handleUnfriend('${blocked.id}')`);

    harness.dashboard.UI.renderFriends("incoming");
    const incomingHtml = harness.getElement("friends-list").innerHTML;
    expect(incomingHtml).toContain(incomingPeer.username);
    expect(incomingHtml).not.toContain(acceptedPeer.username);
    expect(harness.getElement("network-list-title").textContent).toBe(
      "Incoming requests",
    );

    harness.dashboard.UI.renderFriends("outgoing");
    const outgoingHtml = harness.getElement("friends-list").innerHTML;
    expect(outgoingHtml).toContain(outgoingPeer.username);
    expect(outgoingHtml).not.toContain(incomingPeer.username);
    expect(harness.getElement("network-list-title").textContent).toBe(
      "Outgoing requests",
    );

    harness.dashboard.UI.renderFriends("blocked");
    const blockedHtml = harness.getElement("friends-list").innerHTML;
    expect(blockedHtml).toContain(blockedPeer.username);
    expect(blockedHtml).not.toContain(outgoingPeer.username);
    expect(harness.getElement("network-list-title").textContent).toBe(
      "Blocked relationships",
    );
  });

  it("uses network-specific empty states instead of generic friend-list copy", async () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(`Unexpected fetch while testing network empty states: ${url}`);
      },
    });

    await harness.boot();

    harness.dashboard.UI.renderFriends("accepted");

    expect(harness.getElement("network-list-title").textContent).toBe(
      "Accepted contacts",
    );
    expect(harness.getElement("friends-list").innerHTML).toContain(
      "No accepted contacts yet",
    );
    expect(harness.getElement("friends-list").innerHTML).toContain(
      "useful Mahilo circle",
    );
    expect(harness.getElement("friends-list").innerHTML).toContain(
      "Add by Username",
    );
  });
});

describe("Dashboard contact detail and connection space (DASH-021)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("shows active contact connections with framework, label, capabilities, and readiness", async () => {
    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_connection_viewer",
      "Viewer",
    );
    const { user: peer } = await createTestUser(
      "dashboard_connection_peer",
      "Connection Peer",
    );

    const friendship = await createFriendship(viewer.id, peer.id, "accepted");
    const peerConnection = await createAgentConnection(peer.id, {
      framework: "openclaw",
      label: "travel_helper",
    });

    await db
      .update(schema.agentConnections)
      .set({
        capabilities: JSON.stringify(["ask-around", "calendar"]),
        description: "Travel and availability specialist",
        routingPriority: 4,
      })
      .where(eq(schema.agentConnections.id, peerConnection.id));

    const harness = createDashboardHarness({
      app: createApp(),
      apiKey,
      sessionUser: {
        display_name: viewer.displayName,
        status: viewer.status,
        user_id: viewer.id,
        username: viewer.username,
        verified_at: viewer.verifiedAt?.toISOString() ?? null,
      },
    });

    await harness.boot();

    expect(harness.dashboard.State.selectedNetworkFriendId).toBe(friendship.id);
    expect(harness.fetchCalls).toContain(
      `/api/v1/contacts/${peer.username}/connections`,
    );

    const detailHtml = harness.getElement("network-detail-panel").innerHTML;
    expect(detailHtml).toContain("Connection space");
    expect(detailHtml).toContain("Ready for direct send and ask-around");
    expect(detailHtml).toContain("Framework, label, capabilities, and live status");
    expect(detailHtml).toContain("travel_helper");
    expect(detailHtml).toContain("Openclaw");
    expect(detailHtml).toContain("ask-around");
    expect(detailHtml).toContain("calendar");
    expect(detailHtml).toContain("Ready");
    expect(detailHtml).toContain("1 active connection");
  });

  it("marks accepted contacts with no active connections as not ready for ask-around", async () => {
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_no_connection_viewer",
      "Viewer",
    );
    const { user: peer } = await createTestUser(
      "dashboard_no_connection_peer",
      "No Connection Peer",
    );

    await createFriendship(viewer.id, peer.id, "accepted");

    const harness = createDashboardHarness({
      app: createApp(),
      apiKey,
      sessionUser: {
        display_name: viewer.displayName,
        status: viewer.status,
        user_id: viewer.id,
        username: viewer.username,
        verified_at: viewer.verifiedAt?.toISOString() ?? null,
      },
    });

    await harness.boot();

    const detailHtml = harness.getElement("network-detail-panel").innerHTML;
    expect(detailHtml).toContain("No active Mahilo connections right now");
    expect(detailHtml).toContain(
      "No active Mahilo connections are live for this contact.",
    );
    expect(detailHtml).toContain(
      "Without an active connection, this contact cannot participate in ask-around results.",
    );
    expect(detailHtml).toContain("Not ready");
  });
});
