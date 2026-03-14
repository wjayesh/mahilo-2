import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createApp } from "../../src/server";
import * as schema from "../../src/db/schema";
import {
  BROWSER_LOGIN_TOKEN_HEADER,
  BROWSER_SESSION_COOKIE_NAME,
} from "../../src/services/browserAuth";
import { canonicalToStorage } from "../../src/services/policySchema";
import {
  addRoleToFriendship,
  cleanupTestDatabase,
  createAgentConnection,
  createFriendship,
  createTestUser,
  getTestDb,
  seedTestSystemRoles,
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
    handleAcceptFriend: (id: string) => Promise<void>;
    handleAddFriendRequest: () => Promise<void>;
    handleAgentBrowserLogin: () => Promise<void>;
    handleAddFriendRole: (
      friendshipId: string,
      roleName: string,
    ) => Promise<void>;
    handleBlockFriend: (id: string) => Promise<void>;
    handleCreatePolicy: () => Promise<void>;
    handleEditPolicy: (id: string) => void;
    handleInspectPolicy: (id: string) => Promise<void>;
    handleInviteToGroup: (groupId?: string) => Promise<void>;
    handleJoinGroup: (groupId: string) => Promise<void>;
    handleLeaveGroup: (groupId: string) => Promise<void>;
    handleLogin: () => Promise<void>;
    handleLogout: () => Promise<void>;
    handlePingAgent: (id: string) => Promise<void>;
    handleRotateKey: () => Promise<void>;
    handleRejectFriend: (id: string) => Promise<void>;
    handleRemoveFriendRole: (
      friendshipId: string,
      roleName: string,
    ) => Promise<void>;
    handleSendTestMessage: () => Promise<void>;
    openBoundaryEditor: (policy?: Record<string, unknown> | null) => void;
    populateBoundaryPresetOptions: (
      category: string,
      selectedPresetId?: string | null,
    ) => void;
    populatePolicyTargets: (
      scope: string,
      selectedTargetId?: string | null,
      config?: Record<string, unknown>,
    ) => void;
    renderLogs: (direction?: string) => void;
    renderFriends: (filter?: string) => void;
    renderOverviewMessages: () => void;
    handleSaveAgent: () => Promise<void>;
    handleSendMessage: () => Promise<void>;
    handleUnfriend: (id: string) => Promise<void>;
    pollBrowserLoginAttempt: () => Promise<void>;
    redeemBrowserLoginAttempt: () => Promise<void>;
    resetBrowserLogin: (options?: { preserveUsername?: boolean }) => void;
    getSenderConnectionWorkspaceItems: () => Array<Record<string, any>>;
    openAgentEditor: (agent?: string | Record<string, unknown> | null) => void;
    renderDeveloperConsole: () => void;
    renderPolicies: (scope?: string) => void;
    selectChat: (username: string) => void;
    selectDevChat: (username: string) => void;
    showAgentDetails: (agentId: string) => void;
    switchView: (view: string) => void;
    toggleDevApiKeyVisibility: () => void;
  };
};

type DashboardHarness = {
  boot: () => Promise<void>;
  dashboard: DashboardInternals;
  fetchCalls: string[];
  getCookieHeader: () => string;
  getElement: (id: string) => ElementStub;
};

type HarnessOptions = {
  app?: ReturnType<typeof createApp>;
  apiKey?: string;
  initialCookieHeader?: string;
  fetchImpl?: (
    url: string,
    options?: RequestInit,
  ) => Promise<{
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
      [
        ...readFileSync("public/index.html", "utf8").matchAll(
          /id=\"([^\"]+)\"/g,
        ),
      ].map((match) => match[1]),
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

function mergeCookieHeader(existingCookieHeader: string, setCookie: string) {
  const cookies = new Map<string, string>();

  for (const cookie of existingCookieHeader.split(/;\s*/).filter(Boolean)) {
    const [name, ...valueParts] = cookie.split("=");
    if (!name || !valueParts.length) {
      continue;
    }

    cookies.set(name.trim(), valueParts.join("="));
  }

  const [cookiePair] = setCookie.split(";");
  const [name, ...valueParts] = cookiePair.split("=");
  if (name && valueParts.length) {
    cookies.set(name.trim(), valueParts.join("="));
  }

  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function createDashboardHarness(
  options: HarnessOptions = {},
): DashboardHarness {
  const { documentStub, getElement } = createDocumentStub(extractHtmlIds());
  const sessionStore = new Map<string, string>();
  let cookieHeader = options.initialCookieHeader ?? "";

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

      const requestHeaders = new Headers(requestOptions?.headers ?? {});
      if (cookieHeader && !requestHeaders.has("Cookie")) {
        requestHeaders.set("Cookie", cookieHeader);
      }

      const response = await options.app.request(path, {
        ...requestOptions,
        headers: Object.fromEntries(requestHeaders.entries()),
      });

      const setCookie = response.headers.get("set-cookie");
      if (setCookie) {
        cookieHeader = mergeCookieHeader(cookieHeader, setCookie);
      }

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
    getCookieHeader() {
      return cookieHeader;
    },
    getElement,
  };
}

async function createBrowserSessionCookie(
  app: ReturnType<typeof createApp>,
  username: string,
  apiKey: string,
) {
  const start = await app.request("/api/v1/auth/browser-login/attempts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  expect(start.status).toBe(201);
  const started = await start.json();

  const approve = await app.request("/api/v1/auth/browser-login/approve", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      attempt_id: started.attempt_id,
      approval_code: started.approval_code,
    }),
  });
  expect(approve.status).toBe(200);

  const redeem = await app.request(
    `/api/v1/auth/browser-login/attempts/${started.attempt_id}/redeem`,
    {
      method: "POST",
      headers: {
        [BROWSER_LOGIN_TOKEN_HEADER]: started.browser_token,
      },
    },
  );
  expect(redeem.status).toBe(200);

  const setCookieHeader = redeem.headers.get("set-cookie");
  expect(setCookieHeader).toContain(`${BROWSER_SESSION_COOKIE_NAME}=`);

  const [cookiePair] = String(setCookieHeader).split(";");
  return cookiePair;
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
        throw new Error(
          `Unexpected fetch while testing group-thread guard: ${url}`,
        );
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
    expect(harness.getElement("chat-recipient-status").textContent).toBe(
      "Group thread",
    );
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
        "/api/v1/auth/me",
        `/api/v1/contacts/${peer.username}/connections`,
        "/api/v1/friends?status=accepted",
        "/api/v1/friends?status=blocked",
        "/api/v1/friends?status=pending",
        "/api/v1/groups",
        `/api/v1/groups/${groupId}`,
        `/api/v1/groups/${groupId}/members`,
        "/api/v1/messages?limit=50",
        "/api/v1/preferences",
        "/api/v1/plugin/events/blocked?limit=25&include_payload_excerpt=true",
        "/api/v1/plugin/reviews?limit=25",
        "/api/v1/plugin/suggestions/promotions?limit=20",
        "/api/v1/policies",
        "/api/v1/roles",
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
    expect(
      harness.getElement("dashboard-screen").classList.contains("hidden"),
    ).toBe(false);
    expect(harness.getElement("pref-urgent").value).toBe("preferred_only");
    expect(harness.getElement("groups-grid").innerHTML.length).toBeGreaterThan(
      0,
    );
    expect(harness.getElement("logs-list").innerHTML.length).toBeGreaterThan(0);
    expect(
      harness.getElement("overview-message-list").innerHTML.length,
    ).toBeGreaterThan(0);
  });
});

describe("Dashboard sender connections workspace (DASH-030)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("renders routing order, mode, status, last seen, and the default sender candidate from live connection data", async () => {
    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_sender_viewer",
      "Sender Viewer",
    );

    const olderWebhook = await createAgentConnection(viewer.id, {
      framework: "openclaw",
      label: "work",
    });
    const newerPolling = await createAgentConnection(viewer.id, {
      framework: "openclaw",
      label: "personal",
    });
    const inactiveRoute = await createAgentConnection(viewer.id, {
      framework: "langchain",
      label: "ops",
    });

    await db
      .update(schema.agentConnections)
      .set({
        callbackUrl: "https://work.example/callback",
        createdAt: new Date("2026-03-11T09:00:00.000Z"),
        lastSeen: new Date("2026-03-14T05:15:00.000Z"),
        routingPriority: 8,
      })
      .where(eq(schema.agentConnections.id, olderWebhook.id));

    await db
      .update(schema.agentConnections)
      .set({
        callbackSecret: null,
        callbackUrl: "polling://inbox",
        createdAt: new Date("2026-03-12T10:00:00.000Z"),
        lastSeen: new Date("2026-03-14T06:30:00.000Z"),
        routingPriority: 8,
      })
      .where(eq(schema.agentConnections.id, newerPolling.id));

    await db
      .update(schema.agentConnections)
      .set({
        callbackUrl: "https://ops.example/callback",
        createdAt: new Date("2026-03-13T08:00:00.000Z"),
        routingPriority: 12,
        status: "inactive",
      })
      .where(eq(schema.agentConnections.id, inactiveRoute.id));

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

    const workspaceItems =
      harness.dashboard.UI.getSenderConnectionWorkspaceItems();

    expect(workspaceItems.map((item) => item.label)).toEqual([
      "personal",
      "work",
      "ops",
    ]);
    expect(workspaceItems[0]).toEqual(
      expect.objectContaining({
        isDefaultSenderCandidate: true,
        label: "personal",
        mode: "polling",
        modeLabel: "Polling",
        status: "active",
      }),
    );
    expect(workspaceItems[1]).toEqual(
      expect.objectContaining({
        isDefaultSenderCandidate: false,
        label: "work",
        mode: "webhook",
        modeLabel: "Webhook",
      }),
    );
    expect(workspaceItems[2]).toEqual(
      expect.objectContaining({
        isDefaultSenderCandidate: false,
        label: "ops",
        status: "inactive",
      }),
    );

    const gridHtml = harness.getElement("agents-grid").innerHTML;
    expect(gridHtml).toContain("Routing priority");
    expect(gridHtml).toContain("Last seen");
    expect(gridHtml).toContain("Connection mode");
    expect(gridHtml).toContain("Callback health");
    expect(gridHtml).toContain("Default sender");
    expect(gridHtml).toContain("Polling");
    expect(gridHtml).toContain("Webhook");
    expect(gridHtml).toContain("Inactive");

    harness.dashboard.UI.showAgentDetails(newerPolling.id);
    expect(harness.getElement("detail-agent-mode").textContent).toBe("Polling");
    expect(harness.getElement("detail-agent-default").textContent).toBe(
      "Current default sender",
    );
    expect(harness.getElement("detail-agent-health-badge").textContent).toBe(
      "Polling inbox",
    );
    expect(harness.getElement("detail-agent-route-note").textContent).toContain(
      "highest active routing priority",
    );
    expect(harness.getElement("overview-agent-list").innerHTML).toContain(
      "Default",
    );
  });

  it("keeps ping meaningful for polling connections by surfacing inbox health instead of a callback failure", async () => {
    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_sender_ping_viewer",
      "Sender Ping Viewer",
    );
    const pollingConnection = await createAgentConnection(viewer.id, {
      framework: "openclaw",
      label: "polling-default",
    });

    await db
      .update(schema.agentConnections)
      .set({
        callbackSecret: null,
        callbackUrl: "polling://inbox",
        routingPriority: 5,
      })
      .where(eq(schema.agentConnections.id, pollingConnection.id));

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
    await harness.dashboard.UI.handlePingAgent(pollingConnection.id);
    await flushDashboardWork();

    expect(
      harness.dashboard.State.agentHealthById.get(pollingConnection.id),
    ).toEqual(
      expect.objectContaining({
        mode: "polling",
        success: true,
      }),
    );
    expect(harness.getElement("agents-grid").innerHTML).toContain(
      "Polling inbox",
    );
  });
});

describe("Dashboard agent add/edit UX aligned to the current API (DASH-031)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("registers webhook connections from the dashboard without fabricating unsupported fields", async () => {
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
              return {
                callback_secret: "secret_dashboard_generated",
                connection_id: "conn_dashboard_test",
                mode: "webhook",
              };
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

        throw new Error(`Unexpected fetch while saving webhook agent: ${path}`);
      },
    });

    await harness.boot();

    harness.dashboard.UI.openAgentEditor();
    harness.getElement("agent-framework").value = "openclaw";
    harness.getElement("agent-label").value = "default";
    harness.getElement("agent-description").value = "Primary sender";
    harness.getElement("agent-mode").value = "webhook";
    harness.getElement("agent-callback").value =
      "https://agent.example/callback";
    harness.getElement("agent-public-key").value = "";
    harness.getElement("agent-capabilities").value = "calendar, ask-around";

    await harness.dashboard.UI.handleSaveAgent();

    expect(registerPayload).toEqual(
      expect.objectContaining({
        callback_url: "https://agent.example/callback",
        capabilities: ["calendar", "ask-around"],
        framework: "openclaw",
        label: "default",
        mode: "webhook",
        routing_priority: 0,
      }),
    );
    expect(registerPayload?.public_key).toBeUndefined();
    expect(registerPayload?.public_key_alg).toBeUndefined();
    expect(harness.getElement("new-callback-secret").textContent).toBe(
      "secret_dashboard_generated",
    );
    expect(
      harness.getElement("callback-secret-modal").classList.contains("hidden"),
    ).toBe(false);
    expect(
      harness.getElement("toast-container").children[0]?.innerHTML,
    ).toContain("Connection created successfully");
  });

  it("registers polling connections from the dashboard without forcing a callback URL", async () => {
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
              return {
                connection_id: "conn_dashboard_polling",
                mode: "polling",
              };
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

        throw new Error(`Unexpected fetch while saving polling agent: ${path}`);
      },
    });

    await harness.boot();

    harness.dashboard.UI.openAgentEditor();
    harness.getElement("agent-framework").value = "openclaw";
    harness.getElement("agent-label").value = "polling-default";
    harness.getElement("agent-mode").value = "polling";
    harness.getElement("agent-routing-priority").value = "7";
    harness.getElement("agent-capabilities").value = "ask-around";

    await harness.dashboard.UI.handleSaveAgent();

    expect(registerPayload).toEqual(
      expect.objectContaining({
        capabilities: ["ask-around"],
        framework: "openclaw",
        label: "polling-default",
        mode: "polling",
        routing_priority: 7,
      }),
    );
    expect(registerPayload?.callback_url).toBeUndefined();
    expect(registerPayload?.callback_secret).toBeUndefined();
    expect(
      harness.getElement("toast-container").children[0]?.innerHTML,
    ).toContain("Connection created successfully");
  });

  it("opens a real edit mode and reflects update state when the connection is updated in place", async () => {
    let registerPayload: Record<string, unknown> | null = null;

    const harness = createDashboardHarness({
      fetchImpl: async (url, requestOptions) => {
        const requestUrl = new URL(url);
        const path = `${requestUrl.pathname}${requestUrl.search}`;

        if (path === "/api/v1/agents" && requestOptions?.method === "POST") {
          registerPayload = JSON.parse(String(requestOptions.body));
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                connection_id: "conn_existing",
                mode: "polling",
                updated: true,
              };
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

        throw new Error(`Unexpected fetch while updating agent: ${path}`);
      },
    });

    await harness.boot();

    const model = harness.dashboard.Normalizers.agentsModel([
      {
        callback_url: "https://agent.example/callback",
        capabilities: ["calendar"],
        created_at: "2026-03-14T12:00:00.000Z",
        framework: "openclaw",
        id: "conn_existing",
        label: "default",
        mode: "webhook",
        routing_priority: 3,
        status: "active",
      },
    ]);

    harness.dashboard.Helpers.applyCollectionState(
      "agents",
      "agentsById",
      model,
    );

    harness.dashboard.UI.openAgentEditor("conn_existing");

    expect(harness.getElement("agent-modal-title").textContent).toBe(
      "✏️ Edit Sender Connection",
    );
    expect(harness.getElement("save-agent-label").textContent).toBe(
      "Update Connection",
    );
    expect(harness.getElement("agent-framework").disabled).toBe(true);
    expect(harness.getElement("agent-label").disabled).toBe(true);
    expect(harness.getElement("agent-framework").value).toBe("openclaw");
    expect(harness.getElement("agent-label").value).toBe("default");

    harness.getElement("agent-mode").value = "polling";
    harness.getElement("agent-routing-priority").value = "9";

    await harness.dashboard.UI.handleSaveAgent();

    expect(registerPayload).toEqual(
      expect.objectContaining({
        framework: "openclaw",
        label: "default",
        mode: "polling",
        routing_priority: 9,
      }),
    );
    expect(registerPayload?.callback_url).toBeUndefined();
    expect(
      harness.getElement("toast-container").children[0]?.innerHTML,
    ).toContain("Connection updated successfully");
  });

  it("removes the stale rotate-secret config hint and replaces it with a supported dashboard action", () => {
    const html = readFileSync("public/index.html", "utf8");

    expect(html).not.toContain("rotate_callback_secret: true");
    expect(html).toContain("Generate a fresh callback secret on save");
  });
});

describe("Dashboard developer console and API-key utilities (DASH-032)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("renders developer API-key utilities, diagnostics, and explicit unavailable controls", async () => {
    const html = readFileSync("public/index.html", "utf8");
    expect(html).toContain("Current dashboard API key");
    expect(html).toContain("Sender connection health");
    expect(html).toContain("Recent sign-in attempts");
    expect(html).toContain("Controls intentionally kept out of the dashboard");
    expect(html).toContain("Recover a lost API key");

    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_dev_console_viewer",
      "Developer Viewer",
    );
    const { user: alice } = await createTestUser(
      "dashboard_dev_console_alice",
      "Alice",
    );
    await createAgentConnection(viewer.id, {
      framework: "openclaw",
      label: "primary-sender",
    });
    await createFriendship(viewer.id, alice.id, "accepted");

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
    harness.dashboard.UI.switchView("developer");
    await flushDashboardWork();

    const maskedKey = harness.getElement("dev-api-key-display").textContent;
    expect(maskedKey).not.toBe(apiKey);
    expect(maskedKey).toContain(apiKey.slice(0, 12));
    expect(maskedKey).toContain(apiKey.slice(-6));
    expect(harness.getElement("dev-api-key-context").textContent).toContain(
      "Loaded from this dashboard session",
    );
    expect(harness.getElement("dev-diagnostics-list").innerHTML).toContain(
      "primary-sender",
    );
    expect(harness.getElement("dev-diagnostics-list").innerHTML).toContain(
      "Default sender",
    );
    expect(harness.getElement("dev-browser-login-summary").innerHTML).toContain(
      "Recent attempts",
    );
    expect(harness.getElement("dev-test-messaging-summary").innerHTML).toContain(
      "Eligible contacts",
    );
  });

  it("renders recent browser sign-in diagnostics inside Developer", async () => {
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_dev_browser_logins",
      "Browser Diagnostics Viewer",
    );
    const app = createApp();

    const start = await app.request("/api/v1/auth/browser-login/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: viewer.username }),
    });
    expect(start.status).toBe(201);
    const started = await start.json();

    const approve = await app.request("/api/v1/auth/browser-login/approve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        attempt_id: started.attempt_id,
        approval_code: started.approval_code,
      }),
    });
    expect(approve.status).toBe(200);

    const redeem = await app.request(
      `/api/v1/auth/browser-login/attempts/${started.attempt_id}/redeem`,
      {
        method: "POST",
        headers: {
          [BROWSER_LOGIN_TOKEN_HEADER]: started.browser_token,
        },
      },
    );
    expect(redeem.status).toBe(200);

    const replay = await app.request(
      `/api/v1/auth/browser-login/attempts/${started.attempt_id}/redeem`,
      {
        method: "POST",
        headers: {
          [BROWSER_LOGIN_TOKEN_HEADER]: started.browser_token,
        },
      },
    );
    expect(replay.status).toBe(409);

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
    harness.dashboard.UI.switchView("developer");
    await flushDashboardWork();

    expect(harness.getElement("dev-browser-login-list").innerHTML).toContain(
      started.approval_code,
    );
    expect(harness.getElement("dev-browser-login-list").innerHTML).toContain(
      "Replay blocked",
    );
    expect(harness.getElement("dev-browser-login-summary").innerHTML).toContain(
      "Recent issues",
    );
  });

  it("regenerates the current API key and updates the developer display", async () => {
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_dev_rotate_viewer",
      "Rotate Viewer",
    );

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
    harness.dashboard.UI.switchView("developer");
    await flushDashboardWork();
    harness.dashboard.UI.toggleDevApiKeyVisibility();

    expect(harness.getElement("dev-api-key-display").textContent).toBe(apiKey);

    await harness.dashboard.UI.handleRotateKey();
    await flushDashboardWork();

    const rotatedKey = String(harness.dashboard.State.apiKey);
    expect(rotatedKey).not.toBe(apiKey);
    expect(harness.getElement("new-api-key").textContent).toBe(rotatedKey);
    expect(harness.getElement("dev-api-key-display").textContent).toBe(
      rotatedKey,
    );
    expect(
      harness.getElement("api-key-modal").classList.contains("hidden"),
    ).toBe(false);
  });

  it("refreshes developer diagnostics after a connection health check and keeps test sends on the real message route", async () => {
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_dev_ping_viewer",
      "Ping Viewer",
    );
    const { user: target } = await createTestUser(
      "dashboard_dev_ping_target",
      "Target",
    );
    const connection = await createAgentConnection(viewer.id, {
      framework: "openclaw",
      label: "webhook-debug",
      callbackUrl: "https://agent.example/debug",
    });
    await createAgentConnection(target.id, {
      framework: "openclaw",
      label: "target-receiver",
    });
    await createFriendship(viewer.id, target.id, "accepted");

    const app = createApp();
    let sendPayload: Record<string, unknown> | null = null;
    const harness = createDashboardHarness({
      apiKey,
      sessionUser: {
        display_name: viewer.displayName,
        status: viewer.status,
        user_id: viewer.id,
        username: viewer.username,
        verified_at: viewer.verifiedAt?.toISOString() ?? null,
      },
      fetchImpl: async (url, requestOptions) => {
        const requestUrl = new URL(url);
        const path = `${requestUrl.pathname}${requestUrl.search}`;

        if (
          path === `/api/v1/agents/${connection.id}/ping` &&
          requestOptions?.method === "POST"
        ) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                error: null,
                last_seen: "2026-03-14T16:10:00.000Z",
                latency_ms: 123,
                message: "Connection responded to dashboard ping.",
                mode: "webhook",
                status_code: 200,
                success: true,
              };
            },
            async text() {
              return "";
            },
          };
        }

        if (
          path === "/api/v1/messages/send" &&
          requestOptions?.method === "POST"
        ) {
          sendPayload = JSON.parse(String(requestOptions.body));
        }

        const response = await app.request(path, requestOptions);
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
      },
    });

    await harness.boot();
    harness.dashboard.UI.switchView("developer");
    await flushDashboardWork();

    expect(harness.getElement("dev-diagnostics-list").innerHTML).toContain(
      "Not checked",
    );

    await harness.dashboard.UI.handlePingAgent(connection.id);
    await flushDashboardWork();

    expect(harness.getElement("dev-diagnostics-list").innerHTML).toContain(
      "Healthy",
    );
    expect(harness.getElement("dev-diagnostics-list").innerHTML).toContain(
      "123ms",
    );

    harness.dashboard.UI.selectDevChat(target.username);
    harness.getElement("dev-chat-input").value = "Developer route smoke test";
    await harness.dashboard.UI.handleSendTestMessage();

    expect(sendPayload).toEqual(
      expect.objectContaining({
        context: "Developer console test message",
        message: "Developer route smoke test",
        recipient: target.username,
      }),
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

  it("removes the stale browser register helper from the dashboard frontend", () => {
    const appSource = readFileSync("public/app.js", "utf8");

    expect(appSource).not.toContain("/auth/register");
    expect(appSource).not.toContain("handleRegister");
  });

  it("removes legacy message routing from friends and replaces static group cards with a workspace", async () => {
    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_cta_viewer",
      "Viewer",
    );
    const { user: peer } = await createTestUser("dashboard_cta_peer", "Peer");
    const { user: owner } = await createTestUser(
      "dashboard_group_owner",
      "Owner",
    );

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
    expect(harness.getElement("groups-grid").innerHTML).not.toContain(
      '<div class="group-card" onclick=',
    );
    expect(harness.getElement("groups-grid").innerHTML).not.toContain(
      "Join Invite",
    );
    expect(harness.getElement("groups-grid").innerHTML).not.toContain(
      "Leave Group",
    );
    expect(harness.getElement("groups-grid").innerHTML).not.toContain(
      "Tap to join",
    );
    expect(harness.fetchCalls).toContain(`/api/v1/groups/${activeGroupId}`);
    expect(harness.fetchCalls).toContain(
      `/api/v1/groups/${activeGroupId}/members`,
    );
    expect(harness.getElement("group-detail-panel").innerHTML).toContain(
      "Invite and membership actions",
    );
    expect(harness.getElement("group-detail-panel").innerHTML).toContain(
      "Leave group",
    );
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
    harness.getElement("agent-callback").value =
      "https://agent.example/callback";
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

describe("Dashboard invite-only browser access cleanup (DASH-070)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("frames landing auth around agent-backed sign-in with an advanced API-key fallback", () => {
    const html = readFileSync("public/index.html", "utf8");

    expect(html).toContain('id="browser-access-section"');
    expect(html).toContain("Sign in with your agent");
    expect(html).toContain("self-serve browser registration flow");
    expect(html).toContain('id="agent-login-form"');
    expect(html).toContain('id="agent-login-status"');
    expect(html).toContain("Start browser sign-in");
    expect(html).toContain("Manual API-key entry");
    expect(html).toContain("Advanced fallback");
    expect(html).toContain('id="login-form"');
    expect(html).toContain("existing invite-backed Mahilo account");
  });

  it("keeps manual API-key sign-in available only as the advanced browser fallback", async () => {
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_browser_access_viewer",
      "Browser Viewer",
    );
    const app = createApp();

    const harness = createDashboardHarness({
      app,
    });

    await harness.boot();

    harness.getElement("login-api-key").value = apiKey;

    await harness.dashboard.UI.handleLogin();
    await flushDashboardWork();

    expect(harness.dashboard.State.user).toEqual(
      expect.objectContaining({
        username: viewer.username,
      }),
    );
    expect(harness.dashboard.State.apiKey).toBe(apiKey);
    expect(harness.fetchCalls).toContain("/api/v1/auth/me");
    expect(harness.fetchCalls).not.toContain("/api/v1/auth/register");
    expect(
      harness.getElement("landing-page").classList.contains("hidden"),
    ).toBe(true);
    expect(
      harness.getElement("dashboard-screen").classList.contains("hidden"),
    ).toBe(false);
    expect(harness.getElement("toast-container").children[0]?.innerHTML).toContain(
      "Welcome back!",
    );
  });
});

describe("Dashboard sign in with agent UX (DASH-072)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("starts browser sign-in, shows the approval code, and opens the dashboard after agent approval", async () => {
    await seedTestSystemRoles();
    const { user, apiKey } = await createTestUser(
      "dashboard_browser_agent",
      "Agent Approved",
    );
    const app = createApp();
    const harness = createDashboardHarness({ app });

    await harness.boot();

    harness.getElement("agent-login-username").value = user.username;

    await harness.dashboard.UI.handleAgentBrowserLogin();
    await flushDashboardWork();

    expect(harness.dashboard.State.browserLogin).toEqual(
      expect.objectContaining({
        approvalCode: expect.stringMatching(/^[A-Z2-9]{6}$/),
        status: "pending",
        username: user.username,
      }),
    );
    expect(harness.getElement("agent-login-status-title").textContent).toContain(
      "approve",
    );
    expect(harness.getElement("agent-login-instructions").textContent).toContain(
      user.username,
    );
    expect(harness.fetchCalls).toContain("/api/v1/auth/browser-login/attempts");

    const approve = await app.request("/api/v1/auth/browser-login/approve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        attempt_id: harness.dashboard.State.browserLogin.attemptId,
        approval_code: harness.dashboard.State.browserLogin.approvalCode,
      }),
    });
    expect(approve.status).toBe(200);

    await harness.dashboard.UI.pollBrowserLoginAttempt();
    await flushDashboardWork();

    expect(harness.dashboard.State.browserLogin.status).toBe("approved");
    expect(
      harness.getElement("agent-login-continue").classList.contains("hidden"),
    ).toBe(false);

    await harness.dashboard.UI.redeemBrowserLoginAttempt();
    await flushDashboardWork();

    expect(harness.dashboard.State.user).toEqual(
      expect.objectContaining({
        username: user.username,
      }),
    );
    expect(
      harness.getElement("landing-page").classList.contains("hidden"),
    ).toBe(true);
    expect(
      harness.getElement("dashboard-screen").classList.contains("hidden"),
    ).toBe(false);
    expect(harness.fetchCalls).toContain("/api/v1/auth/me");
    expect(
      harness.getElement("toast-container").children[0]?.innerHTML,
    ).toContain("Signed in with agent approval");
  });

  it("shows retry guidance when the username does not map to an active invite-backed account", async () => {
    const app = createApp();
    const harness = createDashboardHarness({ app });

    await harness.boot();

    harness.getElement("agent-login-username").value = "missing_browser_user";

    await harness.dashboard.UI.handleAgentBrowserLogin();
    await flushDashboardWork();

    expect(harness.dashboard.State.browserLogin).toEqual(
      expect.objectContaining({
        errorCode: "USER_NOT_FOUND",
        status: "retry",
        username: "missing_browser_user",
      }),
    );
    expect(harness.getElement("agent-login-status-title").textContent).toContain(
      "No active Mahilo account found",
    );
    expect(harness.getElement("agent-login-guidance").innerHTML).toContain(
      "Finish invite setup",
    );
    expect(
      harness.getElement("agent-login-retry").classList.contains("hidden"),
    ).toBe(false);
  });

  it("surfaces denied and expired approval outcomes without a manual page refresh", async () => {
    const { user, apiKey } = await createTestUser(
      "dashboard_browser_states",
      "Browser States",
    );
    const app = createApp();
    const harness = createDashboardHarness({ app });

    await harness.boot();

    harness.getElement("agent-login-username").value = user.username;
    await harness.dashboard.UI.handleAgentBrowserLogin();
    await flushDashboardWork();

    const firstAttemptId = harness.dashboard.State.browserLogin.attemptId;
    const firstApprovalCode = harness.dashboard.State.browserLogin.approvalCode;

    const deny = await app.request("/api/v1/auth/browser-login/deny", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        attempt_id: firstAttemptId,
        approval_code: firstApprovalCode,
      }),
    });
    expect(deny.status).toBe(200);

    await harness.dashboard.UI.pollBrowserLoginAttempt();
    await flushDashboardWork();

    expect(harness.dashboard.State.browserLogin.status).toBe("denied");
    expect(harness.getElement("agent-login-status-title").textContent).toContain(
      "declined",
    );
    expect(harness.getElement("agent-login-guidance").innerHTML).toContain(
      "Start another code",
    );

    await harness.dashboard.UI.handleAgentBrowserLogin();
    await flushDashboardWork();

    const secondAttemptId = harness.dashboard.State.browserLogin.attemptId;
    const db = getTestDb();
    await db
      .update(schema.browserLoginAttempts)
      .set({
        expiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(schema.browserLoginAttempts.id, secondAttemptId));

    await harness.dashboard.UI.pollBrowserLoginAttempt();
    await flushDashboardWork();

    expect(harness.dashboard.State.browserLogin.status).toBe("expired");
    expect(harness.getElement("agent-login-status-title").textContent).toContain(
      "expired",
    );
    expect(harness.getElement("agent-login-status-copy").textContent).toContain(
      "timed out",
    );
  });

  it("shows explicit retry guidance when redeem is throttled", async () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url: string) => {
        const path = new URL(url).pathname;

        if (path === "/api/v1/auth/browser-login/attempts/attempt_rate/redeem") {
          return {
            ok: false,
            status: 429,
            async json() {
              return {
                error: "Too many redeem attempts. Wait before trying again.",
                code: "BROWSER_LOGIN_REDEEM_RATE_LIMITED",
                failure_state: "rate_limited",
                retry_after_seconds: 42,
              };
            },
            async text() {
              return "";
            },
          };
        }

        throw new Error(`Unexpected fetch during redeem throttle test: ${url}`);
      },
    });

    await harness.boot();

    Object.assign(harness.dashboard.State.browserLogin, {
      approvalCode: "ABCD23",
      approvedAt: new Date().toISOString(),
      attemptId: "attempt_rate",
      browserToken: "browser_rate_token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "approved",
      username: "rate_limit_user",
    });
    harness.dashboard.UI.renderBrowserLogin();

    await harness.dashboard.UI.redeemBrowserLoginAttempt();
    await flushDashboardWork();

    expect(harness.dashboard.State.browserLogin.status).toBe("retry");
    expect(harness.dashboard.State.browserLogin.failureState).toBe(
      "rate_limited",
    );
    expect(harness.getElement("agent-login-status-title").textContent).toContain(
      "throttling",
    );
    expect(harness.getElement("agent-login-guidance").innerHTML).toContain(
      "42 seconds",
    );
  });
});

describe("Dashboard session-backed bootstrap and logout (DASH-073)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("boots from a browser session cookie before falling back to any stored API key", async () => {
    await seedTestSystemRoles();
    const { user, apiKey } = await createTestUser(
      "dashboard_session_boot",
      "Session Boot",
    );
    const app = createApp();
    const sessionCookie = await createBrowserSessionCookie(
      app,
      user.username,
      apiKey,
    );

    const harness = createDashboardHarness({
      app,
      apiKey: "mhl_invalid_stored_key",
      initialCookieHeader: sessionCookie,
    });

    await harness.boot();

    expect(harness.dashboard.State.user).toEqual(
      expect.objectContaining({
        username: user.username,
      }),
    );
    expect(harness.dashboard.State.apiKey).toBeNull();
    expect(
      harness.fetchCalls.filter((call) => call === "/api/v1/auth/me"),
    ).toHaveLength(1);
    expect(
      harness.getElement("landing-page").classList.contains("hidden"),
    ).toBe(true);
    expect(
      harness.getElement("dashboard-screen").classList.contains("hidden"),
    ).toBe(false);
  });

  it("logs out through the server, clears the browser session, and returns to a signed-out landing state", async () => {
    const { user, apiKey } = await createTestUser(
      "dashboard_session_logout",
      "Session Logout",
    );
    const app = createApp();
    const sessionCookie = await createBrowserSessionCookie(
      app,
      user.username,
      apiKey,
    );

    const harness = createDashboardHarness({
      app,
      initialCookieHeader: sessionCookie,
    });

    await harness.boot();
    await harness.dashboard.UI.handleLogout();
    await flushDashboardWork();

    expect(harness.fetchCalls).toContain("/api/v1/auth/logout");
    expect(harness.dashboard.State.user).toBeNull();
    expect(harness.dashboard.State.apiKey).toBeNull();
    expect(
      harness.getElement("landing-page").classList.contains("hidden"),
    ).toBe(false);
    expect(
      harness.getElement("dashboard-screen").classList.contains("hidden"),
    ).toBe(true);

    const me = await app.request("/api/v1/auth/me", {
      headers: {
        Cookie: harness.getCookieHeader(),
      },
    });
    expect(me.status).toBe(401);
  });
});

describe("Dashboard navigation and audit IA (DASH-010)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

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
    expect(harness.getElement("page-subtitle").textContent).toContain(
      "Advanced",
    );
  });

  it("renders boundary taxonomy cards with user-facing audience labels and an explicit advanced fallback", async () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(
          `Unexpected fetch while testing boundary taxonomy rendering: ${url}`,
        );
      },
    });

    await harness.boot();

    const { Helpers, Normalizers, State, UI } = harness.dashboard;

    State.friends = [
      {
        displayName: "Alice",
        friendshipId: "fr_alice",
        status: "accepted",
        userId: "usr_alice",
        username: "alice",
      },
    ];
    State.groups = [
      {
        id: "grp_weekend_plan",
        name: "weekend-plan",
      },
    ];
    State.availableRoles = [
      {
        name: "close_friends",
      },
    ];
    State.availableRolesByName = new Map([
      [
        "close_friends",
        {
          name: "close_friends",
        },
      ],
    ]);

    const policiesModel = Normalizers.policiesModel([
      {
        id: "pol_global_opinion",
        scope: "global",
        direction: "outbound",
        resource: "message.general",
        action: "recommend",
        effect: "allow",
        evaluator: "structured",
        policy_content: "Share restaurant recommendations freely.",
        enabled: true,
      },
      {
        id: "pol_role_calendar",
        scope: "role",
        target_id: "close_friends",
        direction: "response",
        resource: "calendar.availability",
        action: "share",
        effect: "ask",
        evaluator: "llm",
        policy_content: "Pause for review before sharing schedule details.",
        enabled: true,
      },
      {
        id: "pol_user_location",
        scope: "user",
        target_id: "usr_alice",
        direction: "outbound",
        resource: "location.current",
        action: "share",
        effect: "deny",
        evaluator: "llm",
        policy_content: "Never share exact location with Alice.",
        enabled: true,
      },
      {
        id: "pol_group_finance",
        scope: "group",
        target_id: "grp_weekend_plan",
        direction: "outbound",
        resource: "financial.transaction",
        action: "share",
        effect: "deny",
        evaluator: "structured",
        policy_content: { blockedPatterns: ["invoice"] },
        enabled: true,
      },
      {
        id: "pol_custom",
        scope: "global",
        direction: "notification",
        resource: "custom.preference",
        action: "share",
        effect: "ask",
        evaluator: "structured",
        policy_content: { custom: true },
        enabled: true,
      },
    ]);

    Helpers.applyCollectionState("policies", "policiesById", policiesModel);
    UI.renderPolicies("all");

    const html = harness.getElement("policies-list").innerHTML;

    expect(html).toContain("Opinions and recommendations");
    expect(html).toContain("Availability and schedule");
    expect(html).toContain("Location");
    expect(html).toContain("Financial details");
    expect(html).toContain("Anyone on Mahilo");
    expect(html).toContain("Role: Close Friends");
    expect(html).toContain("Contact: Alice");
    expect(html).toContain("Group: weekend-plan");
    expect(html).toContain(">Allow<");
    expect(html).toContain(">Ask<");
    expect(html).toContain(">Deny<");
    expect(html).toContain("Advanced path");
    expect(html).toContain("Custom selector combination");
    expect(html).toContain("handleEditPolicy('pol_global_opinion')");
    expect(html).toContain("handleEditPolicy('pol_role_calendar')");
    expect(html).not.toContain("handleEditPolicy('pol_custom')");
  });

  it("surfaces override lifecycle and provenance details directly in the Boundaries browser", async () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(
          `Unexpected fetch while testing boundary lifecycle rendering: ${url}`,
        );
      },
    });

    await harness.boot();

    const { Helpers, Normalizers, State, UI } = harness.dashboard;

    State.friends = [
      {
        displayName: "Alice",
        friendshipId: "fr_alice",
        status: "accepted",
        userId: "usr_alice",
        username: "alice",
      },
    ];

    const policiesModel = Normalizers.policiesModel([
      {
        id: "pol_override_once",
        scope: "user",
        target_id: "usr_alice",
        direction: "outbound",
        resource: "location.current",
        action: "share",
        effect: "allow",
        evaluator: "structured",
        policy_content: {
          _mahilo_override: {
            kind: "one_time",
            reason: "Approved once for a current-location share.",
            source_resolution_id: "res_override_once",
          },
        },
        effective_from: "2026-03-14T10:00:00.000Z",
        max_uses: 1,
        remaining_uses: 1,
        source: "override",
        derived_from_message_id: "msg_override_source",
        learning_provenance: {
          source_interaction_id: "res_override_once",
          promoted_from_policy_ids: [],
        },
        enabled: true,
      },
      {
        id: "pol_override_temp",
        scope: "global",
        direction: "outbound",
        resource: "calendar.availability",
        action: "share",
        effect: "ask",
        evaluator: "structured",
        policy_content: {
          _mahilo_override: {
            kind: "temporary",
            reason: "Keep this conversation on manual review for now.",
          },
        },
        expires_at: "2026-03-15T15:00:00.000Z",
        source: "override",
        enabled: true,
      },
      {
        id: "pol_learned",
        scope: "global",
        direction: "outbound",
        resource: "health.summary",
        action: "share",
        effect: "deny",
        evaluator: "structured",
        policy_content: { note: "Learned caution around health sharing." },
        source: "learned",
        learning_provenance: {
          source_interaction_id: "res_learned_boundary",
          promoted_from_policy_ids: [],
        },
        enabled: true,
      },
    ]);

    Helpers.applyCollectionState("policies", "policiesById", policiesModel);
    UI.renderPolicies("all");

    const html = harness.getElement("policies-list").innerHTML;

    expect(html).toContain("One-time override");
    expect(html).toContain("Temporary override");
    expect(html).toContain("Remaining uses");
    expect(html).toContain("1 of 1");
    expect(html).toContain("Effective from");
    expect(html).toContain("Expires at");
    expect(html).toContain("Derived from message");
    expect(html).toContain("msg_override_source");
    expect(html).toContain(">Learned<");
    expect(html).toContain("handleInspectPolicy('pol_override_once')");
    expect(html).toContain("handleInspectPolicy('pol_override_temp')");
  });

  it("renders promotion suggestions in a separate learning section with a promotion CTA", async () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(
          `Unexpected fetch while testing promotion suggestion rendering: ${url}`,
        );
      },
    });

    await harness.boot();

    const { Helpers, Normalizers, State, UI } = harness.dashboard;

    State.friends = [
      {
        displayName: "Alice",
        friendshipId: "fr_alice",
        status: "accepted",
        userId: "usr_alice",
        username: "alice",
      },
    ];

    Helpers.applyCollectionState(
      "policies",
      "policiesById",
      Normalizers.policiesModel([
        {
          id: "pol_generic_guardrail",
          scope: "global",
          direction: "outbound",
          resource: "message.general",
          action: "share",
          effect: "ask",
          evaluator: "structured",
          policy_content: "Pause generic sharing for review.",
          enabled: true,
          source: "user_created",
        },
      ]),
    );

    const suggestionPayload = {
      learning: {
        lookback_days: 30,
        min_repetitions: 3,
      },
      promotion_suggestions: [
        {
          suggestion_id: "sugg_location_alice",
          repeated_override_pattern: {
            count: 3,
            first_seen_at: "2026-03-10T10:00:00.000Z",
            kinds: ["one_time"],
            last_seen_at: "2026-03-14T12:00:00.000Z",
            override_policy_ids: [
              "pol_override_1",
              "pol_override_2",
              "pol_override_3",
            ],
            sample_reasons: ["Approved current location for pickup."],
            source_resolution_ids: ["res_override_1"],
          },
          selectors: {
            action: "share",
            direction: "outbound",
            resource: "location.current",
          },
          suggested_policy: {
            scope: "user",
            target_id: "usr_alice",
            direction: "outbound",
            resource: "location.current",
            action: "share",
            effect: "allow",
            evaluator: "structured",
            source: "user_confirmed",
            learning_provenance: {
              source_interaction_id: null,
              promoted_from_policy_ids: [
                "pol_override_1",
                "pol_override_2",
                "pol_override_3",
              ],
            },
          },
        },
      ],
    };

    State.promotionSuggestionLearning =
      Normalizers.promotionSuggestionLearning(suggestionPayload);
    State.promotionSuggestionsStatus = "loaded";
    Helpers.applyCollectionState(
      "promotionSuggestions",
      "promotionSuggestionsById",
      Normalizers.promotionSuggestionsModel(suggestionPayload),
    );

    UI.renderPolicies("all");

    const suggestionHtml = harness.getElement(
      "boundary-suggestions-list",
    ).innerHTML;
    const boundaryHtml = harness.getElement("policies-list").innerHTML;

    expect(
      harness.getElement("boundary-suggestions-panel").classList.contains(
        "hidden",
      ),
    ).toBe(false);
    expect(suggestionHtml).toContain("Current location");
    expect(suggestionHtml).toContain("Contact: Alice");
    expect(suggestionHtml).toContain("Not enforced yet");
    expect(suggestionHtml).toContain("Promote to boundary");
    expect(suggestionHtml).toContain(
      "handlePromoteSuggestion('sugg_location_alice')",
    );
    expect(boundaryHtml).toContain("handleEditPolicy('pol_generic_guardrail')");
    expect(boundaryHtml).not.toContain(
      "handlePromoteSuggestion('sugg_location_alice')",
    );
  });

  it("prefills the boundary editor from a promotion suggestion and hides it once a durable boundary exists", async () => {
    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "promotion_boundary_viewer",
    );
    const { user: recipient } = await createTestUser(
      "promotion_boundary_recipient",
    );
    await createFriendship(viewer.id, recipient.id, "accepted");

    const makeOverrideStorage = (
      sourceResolutionId: string,
      reason: string,
    ) =>
      canonicalToStorage({
        scope: "user",
        target_id: recipient.id,
        direction: "outbound",
        resource: "location.current",
        action: "share",
        effect: "allow",
        evaluator: "structured",
        policy_content: {
          _mahilo_override: {
            kind: "one_time",
            reason,
            sender_connection_id: "conn_promotion_seed",
            source_resolution_id: sourceResolutionId,
          },
        },
        effective_from: null,
        expires_at: null,
        max_uses: 1,
        remaining_uses: 1,
        source: "override",
        derived_from_message_id: null,
        learning_provenance: {
          source_interaction_id: sourceResolutionId,
          promoted_from_policy_ids: [],
        },
        priority: 90,
        enabled: true,
      });

    const overrideSeeds = [
      {
        createdAt: new Date("2026-03-10T10:00:00.000Z"),
        id: "pol_override_seed_1",
        storage: makeOverrideStorage(
          "res_override_seed_1",
          "Approved current location for pickup.",
        ),
      },
      {
        createdAt: new Date("2026-03-12T11:00:00.000Z"),
        id: "pol_override_seed_2",
        storage: makeOverrideStorage(
          "res_override_seed_2",
          "Approved current location for arrival coordination.",
        ),
      },
      {
        createdAt: new Date("2026-03-14T09:00:00.000Z"),
        id: "pol_override_seed_3",
        storage: makeOverrideStorage(
          "res_override_seed_3",
          "Approved current location for meeting up.",
        ),
      },
    ];

    await db.insert(schema.policies).values(
      overrideSeeds.map(({ createdAt, id, storage }) => ({
        action: storage.action,
        createdAt,
        derivedFromMessageId: storage.derivedFromMessageId,
        direction: storage.direction,
        effect: storage.effect,
        effectiveFrom: storage.effectiveFrom,
        enabled: true,
        evaluator: storage.evaluator,
        expiresAt: storage.expiresAt,
        id,
        maxUses: storage.maxUses,
        policyContent: storage.policyContent,
        policyType: storage.policyType,
        priority: 90,
        remainingUses: storage.remainingUses,
        resource: storage.resource,
        scope: "user",
        source: storage.source,
        targetId: recipient.id,
        userId: viewer.id,
      })),
    );

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
    harness.dashboard.UI.renderPolicies("all");

    expect(harness.dashboard.State.promotionSuggestions).toHaveLength(1);
    const suggestion = harness.dashboard.State.promotionSuggestions[0];

    expect(harness.getElement("boundary-suggestions-list").innerHTML).toContain(
      `handlePromoteSuggestion('${suggestion.id}')`,
    );

    harness.dashboard.UI.handlePromoteSuggestion(suggestion.id);

    expect(harness.getElement("policy-modal-title").textContent).toBe(
      "🛡️ Promote Boundary Suggestion",
    );
    expect(harness.getElement("policy-scope").value).toBe("user");
    expect(harness.getElement("policy-target-id").value).toBe(recipient.id);
    expect(harness.getElement("policy-category").value).toBe("location");
    expect(harness.getElement("policy-preset").value).toBe("location_current");
    expect(harness.getElement("policy-effect").value).toBe("allow");
    expect(harness.getElement("policy-direction-note").textContent).toContain(
      "outbound sharing",
    );

    await harness.dashboard.UI.handleCreatePolicy();
    await flushDashboardWork();

    const policies = await db
      .select()
      .from(schema.policies)
      .where(eq(schema.policies.userId, viewer.id));
    const durablePolicies = policies.filter((policy) => policy.source !== "override");

    expect(durablePolicies).toHaveLength(1);
    expect(durablePolicies[0]).toEqual(
      expect.objectContaining({
        action: "share",
        direction: "outbound",
        effect: "allow",
        evaluator: "structured",
        resource: "location.current",
        scope: "user",
        targetId: recipient.id,
      }),
    );
    expect(
      harness.getElement("boundary-suggestions-panel").classList.contains(
        "hidden",
      ),
    ).toBe(true);
  });

  it("creates guided common boundaries for global, contact, role, and group scopes against the live policies API", async () => {
    await seedTestSystemRoles();

    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser("boundary_viewer");
    const { user: alice } = await createTestUser("boundary_alice");
    await createFriendship(viewer.id, alice.id, "accepted");

    const groupId = nanoid();
    await db.insert(schema.groups).values({
      createdAt: new Date("2026-03-14T09:00:00.000Z"),
      description: "Weekend coordination circle",
      id: groupId,
      inviteOnly: true,
      name: "weekend-plan",
      ownerUserId: viewer.id,
      updatedAt: new Date("2026-03-14T09:00:00.000Z"),
    });
    await db.insert(schema.groupMemberships).values({
      createdAt: new Date("2026-03-14T09:00:00.000Z"),
      groupId,
      id: nanoid(),
      role: "owner",
      status: "active",
      userId: viewer.id,
    });

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

    const createBoundary = async ({
      scope,
      targetId = null,
      category,
      presetId,
      effect,
    }: {
      scope: "global" | "user" | "role" | "group";
      targetId?: string | null;
      category: string;
      presetId: string;
      effect: "allow" | "ask" | "deny";
    }) => {
      harness.dashboard.UI.openBoundaryEditor();
      harness.getElement("policy-scope").value = scope;
      harness.dashboard.UI.populatePolicyTargets(scope, targetId);
      harness.getElement("policy-target-id").value = targetId ?? "";
      harness.getElement("policy-category").value = category;
      harness.dashboard.UI.populateBoundaryPresetOptions(category, presetId);
      harness.getElement("policy-preset").value = presetId;
      harness.getElement("policy-effect").value = effect;

      await harness.dashboard.UI.handleCreatePolicy();
      await flushDashboardWork();
    };

    await createBoundary({
      scope: "global",
      category: "opinions",
      presetId: "opinions_recommend",
      effect: "allow",
    });
    await createBoundary({
      scope: "user",
      targetId: alice.id,
      category: "location",
      presetId: "location_current",
      effect: "deny",
    });
    await createBoundary({
      scope: "role",
      targetId: "close_friends",
      category: "availability",
      presetId: "availability_event_details",
      effect: "ask",
    });
    await createBoundary({
      scope: "group",
      targetId: groupId,
      category: "financial",
      presetId: "financial_transactions",
      effect: "deny",
    });

    const policies = await db
      .select()
      .from(schema.policies)
      .where(eq(schema.policies.userId, viewer.id));

    expect(policies).toHaveLength(4);

    const globalPolicy = policies.find((policy) => policy.scope === "global");
    const userPolicy = policies.find(
      (policy) => policy.scope === "user" && policy.targetId === alice.id,
    );
    const rolePolicy = policies.find(
      (policy) =>
        policy.scope === "role" && policy.targetId === "close_friends",
    );
    const groupPolicy = policies.find(
      (policy) => policy.scope === "group" && policy.targetId === groupId,
    );

    expect(globalPolicy).toEqual(
      expect.objectContaining({
        action: "recommend",
        direction: "outbound",
        effect: "allow",
        evaluator: "structured",
        policyType: "structured",
        resource: "message.general",
      }),
    );
    expect(JSON.parse(globalPolicy!.policyContent)).toEqual(
      expect.objectContaining({
        action: "recommend",
        direction: "outbound",
        effect: "allow",
        evaluator: "structured",
        policy_content: {},
        resource: "message.general",
        schema_version: "canonical_policy_v1",
      }),
    );

    expect(userPolicy).toEqual(
      expect.objectContaining({
        action: "share",
        direction: "outbound",
        effect: "deny",
        evaluator: "structured",
        policyType: "structured",
        resource: "location.current",
      }),
    );
    expect(rolePolicy).toEqual(
      expect.objectContaining({
        action: "read_details",
        direction: "outbound",
        effect: "ask",
        evaluator: "structured",
        policyType: "structured",
        resource: "calendar.event",
      }),
    );
    expect(groupPolicy).toEqual(
      expect.objectContaining({
        action: "share",
        direction: "outbound",
        effect: "deny",
        evaluator: "structured",
        policyType: "structured",
        resource: "financial.transaction",
      }),
    );
  });

  it("opens guided edit mode for common boundaries and patches canonical selector fields without raw JSON", async () => {
    await seedTestSystemRoles();

    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "edit_boundary_viewer",
    );
    const storage = canonicalToStorage({
      scope: "role",
      target_id: "close_friends",
      direction: "response",
      resource: "calendar.availability",
      action: "share",
      effect: "ask",
      evaluator: "llm",
      policy_content: "Pause for review before sharing schedule details.",
      effective_from: null,
      expires_at: null,
      max_uses: null,
      remaining_uses: null,
      source: "user_created",
      derived_from_message_id: null,
      learning_provenance: null,
      priority: 0,
      enabled: true,
    });
    const policyId = nanoid();

    await db.insert(schema.policies).values({
      action: storage.action,
      createdAt: new Date("2026-03-14T10:00:00.000Z"),
      derivedFromMessageId: storage.derivedFromMessageId,
      direction: storage.direction,
      effect: storage.effect,
      effectiveFrom: storage.effectiveFrom,
      enabled: true,
      evaluator: storage.evaluator,
      expiresAt: storage.expiresAt,
      id: policyId,
      maxUses: storage.maxUses,
      policyContent: storage.policyContent,
      policyType: storage.policyType,
      priority: 0,
      remainingUses: storage.remainingUses,
      resource: storage.resource,
      scope: "role",
      source: storage.source,
      targetId: "close_friends",
      userId: viewer.id,
    });

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
    harness.dashboard.UI.renderPolicies("all");

    expect(harness.getElement("policies-list").innerHTML).toContain(
      `handleEditPolicy('${policyId}')`,
    );

    harness.dashboard.UI.handleEditPolicy(policyId);

    expect(harness.getElement("policy-modal-title").textContent).toBe(
      "✏️ Edit Boundary",
    );
    expect(harness.getElement("policy-scope").disabled).toBe(true);
    expect(harness.getElement("policy-target-id").disabled).toBe(true);
    expect(harness.getElement("policy-direction-note").textContent).toContain(
      "response",
    );

    harness.getElement("policy-category").value = "location";
    harness.dashboard.UI.populateBoundaryPresetOptions(
      "location",
      "location_current",
    );
    harness.getElement("policy-preset").value = "location_current";
    harness.getElement("policy-effect").value = "deny";

    await harness.dashboard.UI.handleCreatePolicy();
    await flushDashboardWork();

    expect(harness.fetchCalls).toContain(`/api/v1/policies/${policyId}`);

    const [updatedPolicy] = await db
      .select()
      .from(schema.policies)
      .where(eq(schema.policies.id, policyId))
      .limit(1);

    expect(updatedPolicy).toEqual(
      expect.objectContaining({
        action: "share",
        direction: "response",
        effect: "deny",
        evaluator: "structured",
        policyType: "structured",
        resource: "location.current",
        scope: "role",
        targetId: "close_friends",
      }),
    );
    expect(JSON.parse(updatedPolicy.policyContent)).toEqual(
      expect.objectContaining({
        action: "share",
        direction: "response",
        effect: "deny",
        evaluator: "structured",
        policy_content: {},
        resource: "location.current",
        schema_version: "canonical_policy_v1",
      }),
    );
  });

  it("loads policy provenance drill-down inside the dashboard without leaving the Boundaries view", async () => {
    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "boundary_provenance_viewer",
    );
    const { user: recipient } = await createTestUser(
      "boundary_provenance_recipient",
    );

    const sourceMessageId = "msg_boundary_provenance_source";
    await db.insert(schema.messages).values({
      action: "share",
      createdAt: new Date("2026-03-14T12:00:00.000Z"),
      direction: "outbound",
      id: sourceMessageId,
      payload: "Source interaction that produced a boundary.",
      payloadType: "text/plain",
      recipientId: recipient.id,
      recipientType: "user",
      resource: "location.current",
      senderAgent: "dashboard",
      senderConnectionId: null,
      senderUserId: viewer.id,
      status: "delivered",
    });

    const overrideStorage = canonicalToStorage({
      scope: "user",
      target_id: recipient.id,
      direction: "outbound",
      resource: "location.current",
      action: "share",
      effect: "allow",
      evaluator: "structured",
      policy_content: {
        _mahilo_override: {
          created_via: "plugin.overrides",
          kind: "one_time",
          reason: "Approved one time before promotion.",
          sender_connection_id: "conn_override_seed",
          source_resolution_id: "res_boundary_override",
        },
      },
      effective_from: null,
      expires_at: null,
      max_uses: 1,
      remaining_uses: 1,
      source: "override",
      derived_from_message_id: sourceMessageId,
      learning_provenance: {
        source_interaction_id: "res_boundary_override",
        promoted_from_policy_ids: [],
      },
      priority: 90,
      enabled: true,
    });
    const promotedStorage = canonicalToStorage({
      scope: "user",
      target_id: recipient.id,
      direction: "outbound",
      resource: "location.current",
      action: "share",
      effect: "allow",
      evaluator: "structured",
      policy_content: {
        note: "Promoted durable boundary after repeated overrides.",
      },
      effective_from: null,
      expires_at: null,
      max_uses: null,
      remaining_uses: null,
      source: "user_confirmed",
      derived_from_message_id: sourceMessageId,
      learning_provenance: {
        source_interaction_id: "res_boundary_promoted",
        promoted_from_policy_ids: ["pol_boundary_override"],
      },
      priority: 95,
      enabled: true,
    });

    await db.insert(schema.policies).values([
      {
        action: overrideStorage.action,
        createdAt: new Date("2026-03-14T12:10:00.000Z"),
        derivedFromMessageId: overrideStorage.derivedFromMessageId,
        direction: overrideStorage.direction,
        effect: overrideStorage.effect,
        effectiveFrom: overrideStorage.effectiveFrom,
        enabled: true,
        evaluator: overrideStorage.evaluator,
        expiresAt: overrideStorage.expiresAt,
        id: "pol_boundary_override",
        maxUses: overrideStorage.maxUses,
        policyContent: overrideStorage.policyContent,
        policyType: overrideStorage.policyType,
        priority: 90,
        remainingUses: overrideStorage.remainingUses,
        resource: overrideStorage.resource,
        scope: "user",
        source: overrideStorage.source,
        targetId: recipient.id,
        userId: viewer.id,
      },
      {
        action: promotedStorage.action,
        createdAt: new Date("2026-03-14T12:20:00.000Z"),
        derivedFromMessageId: promotedStorage.derivedFromMessageId,
        direction: promotedStorage.direction,
        effect: promotedStorage.effect,
        effectiveFrom: promotedStorage.effectiveFrom,
        enabled: true,
        evaluator: promotedStorage.evaluator,
        expiresAt: promotedStorage.expiresAt,
        id: "pol_boundary_promoted",
        maxUses: promotedStorage.maxUses,
        policyContent: promotedStorage.policyContent,
        policyType: promotedStorage.policyType,
        priority: 95,
        remainingUses: promotedStorage.remainingUses,
        resource: promotedStorage.resource,
        scope: "user",
        source: promotedStorage.source,
        targetId: recipient.id,
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
    await harness.dashboard.UI.handleInspectPolicy("pol_boundary_promoted");
    await flushDashboardWork();

    expect(harness.fetchCalls).toContain(
      "/api/v1/policies/audit/provenance/pol_boundary_promoted",
    );
    expect(
      harness
        .getElement("policy-provenance-modal")
        .classList.contains("hidden"),
    ).toBe(false);

    const html = harness.getElement("policy-provenance-content").innerHTML;

    expect(html).toContain("Source message");
    expect(html).toContain(sourceMessageId);
    expect(html).toContain("Lineage");
    expect(html).toContain("pol_boundary_override");
    expect(html).toContain("Override promotion history");
    expect(html).toContain("res_boundary_promoted");
  });

  it("enriches delivery logs with review, blocked, and ask-around audit cues", async () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(
          `Unexpected fetch while testing log audit cues: ${url}`,
        );
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
    UI.renderOverviewMessages();

    expect(harness.getElement("logs-summary").innerHTML).toContain(
      "Review Queue",
    );
    expect(harness.getElement("logs-summary").innerHTML).toContain(
      "Blocked Events",
    );
    expect(harness.getElement("logs-summary").innerHTML).toContain(
      "Ask-around Threads",
    );
    expect(harness.getElement("logs-summary").innerHTML).toContain(
      "Approval pending 1",
    );
    expect(harness.getElement("logs-list").innerHTML).toContain("Review queue");
    expect(harness.getElement("logs-list").innerHTML).toContain("Blocked");
    expect(harness.getElement("logs-list").innerHTML).toContain(
      "Ask-around thread (2)",
    );
    expect(harness.getElement("overview-audit-cues").innerHTML).toContain(
      "Approval pending",
    );
    expect(harness.getElement("overview-audit-cues").innerHTML).toContain(
      "Blocked",
    );
    expect(harness.getElement("overview-message-list").innerHTML).toContain(
      "Approval pending",
    );
    expect(harness.getElement("overview-message-list").innerHTML).toContain(
      "Blocked",
    );
  });

  it("shows ask-around replies, no-grounded outcomes, waiting states, and readiness context", () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(
          `Unexpected fetch while testing ask-around timeline signals: ${url}`,
        );
      },
    });

    const { Helpers, Normalizers, UI } = harness.dashboard;

    const askAroundMessages = [
      Normalizers.message(
        {
          action: "share",
          correlation_id: "corr_ask_timeline",
          created_at: "2026-03-14T12:00:00.000Z",
          direction: "outbound",
          id: "msg_ask_alice",
          message: "Who knows a good ramen spot?",
          recipient: { type: "user", username: "alice" },
          resource: "message.general",
          sender: { agent: "default", username: "viewer" },
          status: "delivered",
        },
        { currentUsername: "viewer" },
      ),
      Normalizers.message(
        {
          action: "share",
          correlation_id: "corr_ask_timeline",
          created_at: "2026-03-14T12:01:00.000Z",
          direction: "outbound",
          id: "msg_ask_bob",
          message: "Who knows a good ramen spot?",
          recipient: { type: "user", username: "bob" },
          resource: "message.general",
          sender: { agent: "default", username: "viewer" },
          status: "delivered",
        },
        { currentUsername: "viewer" },
      ),
      Normalizers.message(
        {
          action: "share",
          context: "Went last month",
          correlation_id: "corr_ask_timeline",
          created_at: "2026-03-14T12:02:00.000Z",
          direction: "inbound",
          id: "msg_reply_alice",
          in_response_to: "msg_ask_alice",
          message: "Try Mensho for the broth.",
          recipient: { type: "user", username: "viewer" },
          resource: "message.general",
          sender: { agent: "openclaw", username: "alice" },
          status: "delivered",
        },
        { currentUsername: "viewer" },
      ),
      Normalizers.message(
        {
          action: "share",
          correlation_id: "corr_ask_timeline",
          created_at: "2026-03-14T12:02:30.000Z",
          direction: "outbound",
          id: "msg_ask_dana",
          message: "Who knows a good ramen spot?",
          recipient: { type: "user", username: "dana" },
          resource: "message.general",
          sender: { agent: "default", username: "viewer" },
          status: "delivered",
        },
        { currentUsername: "viewer" },
      ),
      Normalizers.message(
        {
          action: "share",
          correlation_id: "corr_ask_timeline",
          created_at: "2026-03-14T12:03:00.000Z",
          direction: "inbound",
          id: "msg_reply_bob",
          in_response_to: "msg_ask_bob",
          message: JSON.stringify({
            message: "I don't know.",
            outcome: "no_grounded_answer",
          }),
          payload_type: "application/json",
          recipient: { type: "user", username: "viewer" },
          resource: "message.general",
          sender: { agent: "openclaw", username: "bob" },
          status: "delivered",
        },
        { currentUsername: "viewer" },
      ),
    ];

    const review = Normalizers.review({
      correlation_id: "corr_ask_timeline",
      created_at: "2026-03-14T12:01:30.000Z",
      decision: "ask",
      delivery_mode: "review_required",
      message_id: "msg_ask_charlie",
      message_preview: "Who knows a good ramen spot?",
      queue_direction: "outbound",
      recipient: { type: "user", username: "charlie" },
      review_id: "rev_ask_charlie",
      sender: { username: "viewer" },
      selectors: {
        action: "share",
        direction: "outbound",
        resource: "message.general",
      },
      status: "review_required",
      summary: "Needs review before asking Charlie.",
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

    UI.renderLogs();
    UI.renderOverviewMessages();

    const logHtml = harness.getElement("logs-list").innerHTML;
    expect(logHtml).toContain("Ask-around to alice");
    expect(logHtml).toContain("Ask-around reply from bob");
    expect(logHtml).toContain("Ask-around outcome");
    expect(logHtml).toContain("alice replied: Try Mensho for the broth.");
    expect(logHtml).toContain(
      "bob reported no grounded answer: I don&#39;t know.",
    );
    expect(logHtml).toContain(
      "charlie: review required before this ask can go out.",
    );
    expect(logHtml).toContain("Ready when asked: alice, bob, dana.");
    expect(logHtml).toContain("Policy constrained: charlie (Review required).");
    expect(logHtml).toContain("Reply context");
    expect(logHtml).toContain("Went last month");
    expect(logHtml).toContain("reply to msg_ask_alice");

    const summaryHtml = harness.getElement("logs-summary").innerHTML;
    expect(summaryHtml).toContain("Replies 1");
    expect(summaryHtml).toContain("No grounded 1");
    expect(summaryHtml).toContain("No reply yet 1");

    const cueHtml = harness.getElement("overview-audit-cues").innerHTML;
    expect(cueHtml).toContain("Ask-around");
    expect(cueHtml).toContain("No reply yet");
    expect(cueHtml).toContain("No grounded");

    const overviewHtml = harness.getElement("overview-message-list").innerHTML;
    expect(overviewHtml).toContain("Ask-around");
    expect(overviewHtml).toContain("Who knows a good ramen spot?");
    expect(overviewHtml).toContain("Replies: alice");
    expect(overviewHtml).toContain("No grounded: bob");
    expect(overviewHtml).toContain("No reply: dana");
    expect(overviewHtml).toContain("Held: charlie (Review required)");
  });

  it("separates ready, not-ready, and constrained recipients for grouped ask-around activity", () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(
          `Unexpected fetch while testing grouped ask-around readiness: ${url}`,
        );
      },
    });

    const { Helpers, Normalizers, UI } = harness.dashboard;

    Helpers.applyCollectionState(
      "groups",
      "groupsById",
      Helpers.collectionModel(
        Normalizers.groups([
          {
            created_at: "2026-03-14T11:00:00.000Z",
            id: "grp_foodies",
            member_count: 3,
            name: "foodies",
            status: "active",
          },
        ]),
      ),
    );

    const groupedAsk = Normalizers.message(
      {
        action: "share",
        correlation_id: "corr_group_ask",
        created_at: "2026-03-14T12:00:00.000Z",
        direction: "outbound",
        id: "msg_group_ask",
        message: "Which lunch spot is actually worth it today?",
        policies_evaluated: {
          recipients: [
            {
              decision: "allow",
              delivery_status: "delivered",
              recipient_user_id: "usr_alice",
              recipient_username: "alice",
            },
            {
              decision: "allow",
              delivery_status: "failed",
              recipient_user_id: "usr_bob",
              recipient_username: "bob",
            },
            {
              decision: "ask",
              delivery_status: "review_required",
              recipient_user_id: "usr_charlie",
              recipient_username: "charlie",
            },
          ],
        },
        recipient: null,
        recipient_id: "grp_foodies",
        recipient_type: "group",
        resource: "message.general",
        sender: { agent: "default", username: "viewer" },
        status: "delivered",
      },
      { currentUsername: "viewer" },
    );

    Helpers.applyCollectionState(
      "messages",
      "messagesById",
      Helpers.collectionModel([groupedAsk]),
    );

    UI.renderLogs();
    UI.renderOverviewMessages();

    const logHtml = harness.getElement("logs-list").innerHTML;
    expect(logHtml).toContain("Ask-around to group foodies");
    expect(logHtml).toContain("Ready when asked: alice.");
    expect(logHtml).toContain("Not ready when asked: bob.");
    expect(logHtml).toContain("Policy constrained: charlie (Review required).");

    const overviewHtml = harness.getElement("overview-message-list").innerHTML;
    expect(overviewHtml).toContain("Group foodies");
    expect(overviewHtml).toContain("Ready: alice");
    expect(overviewHtml).toContain("Not ready: bob");
    expect(overviewHtml).toContain("Held: charlie (Review required)");
  });

  it("renders compact overview cues for review-required, approval-pending, and blocked activity", () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(`Unexpected fetch while testing overview cues: ${url}`);
      },
    });

    const { Helpers, Normalizers, UI } = harness.dashboard;

    const reviewRequired = Normalizers.review({
      created_at: "2026-03-14T12:00:00.000Z",
      decision: "ask",
      delivery_mode: "review_required",
      message_preview: "Share neighborhood-level location",
      queue_direction: "outbound",
      recipient: { type: "user", username: "alice" },
      review_id: "rev_overview_required",
      sender: { username: "viewer" },
      selectors: {
        direction: "outbound",
        resource: "location.current",
        action: "share",
      },
      status: "review_required",
      summary: "Needs review before delivery.",
    });

    const approvalPending = Normalizers.review({
      created_at: "2026-03-14T12:01:00.000Z",
      decision: "ask",
      delivery_mode: "hold_for_approval",
      message_preview: "Share exact location",
      queue_direction: "outbound",
      recipient: { type: "user", username: "bob" },
      review_id: "rev_overview_pending",
      sender: { username: "viewer" },
      selectors: {
        direction: "outbound",
        resource: "location.current",
        action: "share",
      },
      status: "approval_pending",
      summary: "Waiting for explicit approval.",
    });

    const blocked = Normalizers.blockedEvent({
      created_at: "2026-03-14T12:02:00.000Z",
      id: "blocked_overview",
      queue_direction: "outbound",
      reason: "Blocked by boundary.",
      recipient: { type: "user", username: "charlie" },
      resource: "health.summary",
      action: "share",
      sender: { username: "viewer" },
      status: "rejected",
      stored_payload_excerpt: "Share my health summary with Charlie",
    });

    Helpers.applyCollectionState(
      "reviews",
      "reviewsById",
      Helpers.collectionModel([reviewRequired, approvalPending]),
    );
    Helpers.applyCollectionState(
      "blockedEvents",
      "blockedEventsById",
      Helpers.collectionModel([blocked]),
    );

    UI.renderOverviewMessages();

    const cueHtml = harness.getElement("overview-audit-cues").innerHTML;
    expect(cueHtml).toContain("Review required");
    expect(cueHtml).toContain("Approval pending");
    expect(cueHtml).toContain("Blocked");

    const overviewHtml = harness.getElement("overview-message-list").innerHTML;
    expect(overviewHtml).toContain("Review required");
    expect(overviewHtml).toContain("Approval pending");
    expect(overviewHtml).toContain("Blocked");
    expect(overviewHtml).toContain("To bob");
    expect(overviewHtml).toContain("To charlie");
  });

  it("filters delivery logs by unified audit state and direction", async () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(`Unexpected fetch while testing log filters: ${url}`);
      },
    });

    const { Helpers, Normalizers, State, UI } = harness.dashboard;

    const messages = [
      Normalizers.message(
        {
          created_at: "2026-03-14T12:00:00.000Z",
          id: "msg_delivered_ui",
          message: "Delivered dashboard ping",
          recipient: { type: "user", username: "alice" },
          sender: { agent: "default", username: "viewer" },
          status: "delivered",
          correlation_id: "corr_delivered_ui",
          policies_evaluated: JSON.stringify({
            reason_code: "policy.allow.global.structured",
          }),
          direction: "outbound",
          resource: "message.general",
          action: "share",
        },
        { currentUsername: "viewer" },
      ),
      Normalizers.message(
        {
          created_at: "2026-03-14T12:01:00.000Z",
          id: "msg_review_ui",
          message: "Share exact location",
          recipient: { type: "user", username: "alice" },
          sender: { agent: "default", username: "viewer" },
          status: "review_required",
          correlation_id: "corr_review_ui",
          policies_evaluated: JSON.stringify({
            effect: "ask",
            reason_code: "policy.ask.user.structured",
          }),
          direction: "outbound",
          resource: "location.current",
          action: "share",
        },
        { currentUsername: "viewer" },
      ),
      Normalizers.message(
        {
          created_at: "2026-03-14T12:02:00.000Z",
          id: "msg_blocked_ui",
          message: "Share your health summary",
          recipient: { type: "user", username: "viewer" },
          sender: { agent: "default", username: "alice" },
          status: "rejected",
          correlation_id: "corr_blocked_ui",
          policies_evaluated: JSON.stringify({
            effect: "deny",
            reason_code: "policy.deny.inbound.request",
          }),
          direction: "inbound",
          resource: "health.summary",
          action: "request",
        },
        { currentUsername: "viewer" },
      ),
    ];

    const review = Normalizers.review({
      audit: {
        resolver_layer: "user_policies",
        resolution_explanation: "User policy requires explicit approval.",
      },
      created_at: "2026-03-14T12:01:30.000Z",
      decision: "ask",
      delivery_mode: "hold_for_approval",
      message_id: "msg_review_ui",
      message_preview: "Share exact location",
      context_preview: "User asked where you are right now.",
      queue_direction: "outbound",
      recipient: { type: "user", username: "alice" },
      review_id: "rev_review_ui",
      sender: { username: "viewer" },
      selectors: {
        direction: "outbound",
        resource: "location.current",
        action: "share",
      },
      status: "approval_pending",
      reason_code: "policy.ask.user.structured",
      correlation_id: "corr_review_ui",
      summary: "Needs approval before delivery.",
    });

    const blocked = Normalizers.blockedEvent({
      audit: {
        resolver_layer: "user_policies",
        resolution_explanation: "Inbound request matched a deny policy.",
      },
      created_at: "2026-03-14T12:02:30.000Z",
      id: "blocked_review_ui",
      message_id: "msg_blocked_ui",
      payload_hash: "abc123def456",
      queue_direction: "inbound",
      reason: "Blocked by boundary.",
      recipient: { type: "user", username: "viewer" },
      resource: "health.summary",
      action: "request",
      reason_code: "policy.deny.inbound.request",
      sender: { username: "alice" },
      status: "rejected",
      stored_payload_excerpt: "Share your health summary",
    });

    Helpers.applyCollectionState(
      "messages",
      "messagesById",
      Helpers.collectionModel(messages),
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

    State.logDirectionFilter = "all";
    State.logStateFilter = "review";
    UI.renderLogs();

    const reviewHtml = harness.getElement("logs-list").innerHTML;
    expect(reviewHtml).toContain("Review queue");
    expect(reviewHtml).toContain("State: Approval pending");
    expect(reviewHtml).toContain("Mode: Hold for approval");
    expect(reviewHtml).toContain("Reason code: policy.ask.user.structured");
    expect(reviewHtml).toContain("Draft preview");
    expect(reviewHtml).toContain("Context");
    expect(reviewHtml).toContain("Layer: User Policies");
    expect(reviewHtml).toContain("Thread: corr_review_ui");
    expect(reviewHtml.match(/class=\"log-item/g)?.length ?? 0).toBe(1);

    State.logDirectionFilter = "all";
    State.logStateFilter = "blocked";
    UI.renderLogs();

    const blockedHtml = harness.getElement("logs-list").innerHTML;
    expect(blockedHtml).toContain("Blocked event");
    expect(blockedHtml).toContain("Reason code: policy.deny.inbound.request");
    expect(blockedHtml).toContain("Stored excerpt");
    expect(blockedHtml).toContain("Inbound request matched a deny policy.");
    expect(blockedHtml).toContain("Payload hash: abc123def456");
    expect(blockedHtml).toContain("Layer: User Policies");
    expect(blockedHtml).toContain("Thread: corr_blocked_ui");
    expect(blockedHtml.match(/class=\"log-item/g)?.length ?? 0).toBe(1);

    State.logDirectionFilter = "received";
    State.logStateFilter = "all";
    UI.renderLogs();

    const receivedHtml = harness.getElement("logs-list").innerHTML;
    expect(receivedHtml).toContain("Blocked event • From: alice");
    expect(receivedHtml).toContain("Inbound / health.summary / request");
    expect(receivedHtml).not.toContain("Share exact location");
    expect(receivedHtml).not.toContain("Delivered dashboard ping");
    expect(receivedHtml.match(/class=\"log-item/g)?.length ?? 0).toBe(1);
  });
});

describe("Dashboard overview readiness (DASH-011)", () => {
  it("surfaces readiness counts, sender status, pending requests, and recent activity from overview state", () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(
          `Unexpected fetch while testing overview readiness: ${url}`,
        );
      },
    });

    const { Helpers, Normalizers, State, UI } = harness.dashboard;

    Helpers.applyCollectionState(
      "agents",
      "agentsById",
      Normalizers.agentsModel([
        {
          callback_url: "polling://inbox",
          created_at: "2026-03-14T10:00:00.000Z",
          framework: "openclaw",
          id: "conn_default",
          label: "default",
          mode: "polling",
          routing_priority: 5,
          status: "active",
        },
      ]),
    );

    Helpers.applyCollectionState(
      "friends",
      "friendsById",
      Normalizers.friendsModel([
        {
          created_at: "2026-03-10T00:00:00.000Z",
          direction: "sent",
          display_name: "Alice",
          id: "fr_alice",
          interaction_count: 4,
          status: "accepted",
          username: "alice",
        },
        {
          created_at: "2026-03-11T00:00:00.000Z",
          direction: "sent",
          display_name: "Bob",
          id: "fr_bob",
          interaction_count: 1,
          status: "accepted",
          username: "bob",
        },
        {
          created_at: "2026-03-12T00:00:00.000Z",
          direction: "received",
          display_name: "Charlie",
          id: "fr_charlie",
          status: "pending",
          username: "charlie",
        },
        {
          created_at: "2026-03-13T00:00:00.000Z",
          direction: "sent",
          display_name: "Dana",
          id: "fr_dana",
          status: "pending",
          username: "dana",
        },
      ]),
    );

    State.contactConnectionsByUsername.set("alice", {
      error: null,
      items: Normalizers.agentsModel([
        {
          callback_url: "polling://peer",
          created_at: "2026-03-14T09:00:00.000Z",
          framework: "openclaw",
          id: "conn_peer_alice",
          label: "peer_default",
          mode: "polling",
          routing_priority: 1,
          status: "active",
        },
      ]).items,
      loadedAt: "2026-03-14T10:30:00.000Z",
      status: "loaded",
    });
    State.contactConnectionsByUsername.set("bob", {
      error: null,
      items: [],
      loadedAt: "2026-03-14T10:31:00.000Z",
      status: "loaded",
    });

    Helpers.applyCollectionState(
      "messages",
      "messagesById",
      Helpers.collectionModel([
        Normalizers.message(
          {
            action: "share",
            correlation_id: "corr_overview_readiness",
            created_at: "2026-03-14T12:00:00.000Z",
            direction: "outbound",
            id: "msg_overview_ask",
            message: "Who has a ramen spot worth trusting?",
            recipient: { type: "user", username: "alice" },
            resource: "message.general",
            sender: { agent: "default", username: "viewer" },
            status: "delivered",
          },
          { currentUsername: "viewer" },
        ),
        Normalizers.message(
          {
            action: "share",
            correlation_id: "corr_overview_readiness",
            created_at: "2026-03-14T12:02:00.000Z",
            direction: "inbound",
            id: "msg_overview_reply",
            in_response_to: "msg_overview_ask",
            message: "Try Mensho for the broth.",
            recipient: { type: "user", username: "viewer" },
            resource: "message.general",
            sender: { agent: "peer_default", username: "alice" },
            status: "delivered",
          },
          { currentUsername: "viewer" },
        ),
      ]),
    );
    Helpers.applyCollectionState(
      "reviews",
      "reviewsById",
      Helpers.collectionModel([
        Normalizers.review({
          created_at: "2026-03-14T12:03:00.000Z",
          decision: "ask",
          delivery_mode: "review_required",
          message_preview: "Share exact location",
          queue_direction: "outbound",
          recipient: { type: "user", username: "charlie" },
          review_id: "rev_overview_readiness",
          sender: { username: "viewer" },
          selectors: {
            action: "share",
            direction: "outbound",
            resource: "location.current",
          },
          status: "review_required",
          summary: "Needs review before delivery.",
        }),
      ]),
    );
    Helpers.applyCollectionState(
      "blockedEvents",
      "blockedEventsById",
      Helpers.collectionModel([
        Normalizers.blockedEvent({
          created_at: "2026-03-14T12:04:00.000Z",
          id: "blocked_overview_readiness",
          queue_direction: "outbound",
          reason: "Blocked by boundary.",
          recipient: { type: "user", username: "dana" },
          resource: "health.summary",
          action: "share",
          sender: { username: "viewer" },
          status: "rejected",
          stored_payload_excerpt: "Share my health summary with Dana",
        }),
      ]),
    );

    UI.renderOverviewAgents();
    UI.renderOverviewFriends();
    UI.renderOverviewMessages();

    const readinessHtml =
      harness.getElement("overview-readiness-summary").innerHTML;
    expect(readinessHtml).toContain("Ready to ask around");
    expect(readinessHtml).toContain(
      "route through default and reach 1 contact with active connections right now.",
    );
    expect(readinessHtml).toContain("2 deliveries");
    expect(readinessHtml).toContain("1 review item");
    expect(readinessHtml).toContain("1 blocked event");
    expect(readinessHtml).toMatch(
      /Accepted contacts<\/span>\s*<span class="network-summary-value">2<\/span>/,
    );
    expect(readinessHtml).toMatch(
      /Ready contacts<\/span>\s*<span class="network-summary-value">1<\/span>/,
    );
    expect(readinessHtml).toMatch(
      /Incoming requests<\/span>\s*<span class="network-summary-value">1<\/span>/,
    );
    expect(readinessHtml).toMatch(
      /Outgoing requests<\/span>\s*<span class="network-summary-value">1<\/span>/,
    );
    expect(readinessHtml).toMatch(
      /Review queue<\/span>\s*<span class="network-summary-value">1<\/span>/,
    );
    expect(readinessHtml).toMatch(
      /Blocked events<\/span>\s*<span class="network-summary-value">1<\/span>/,
    );

    const senderHtml = harness.getElement("overview-sender-summary").innerHTML;
    expect(senderHtml).toContain("Ready via default");
    expect(senderHtml).toContain("1 active sender connection available.");
    expect(senderHtml).toContain("No obvious sender blocker.");

    const networkCuesHtml =
      harness.getElement("overview-network-cues").innerHTML;
    expect(networkCuesHtml).toContain("Accepted");
    expect(networkCuesHtml).toContain("Ready now");
    expect(networkCuesHtml).toContain("Incoming");
    expect(networkCuesHtml).toContain("Outgoing");

    const networkListHtml = harness.getElement("overview-friend-list").innerHTML;
    expect(networkListHtml).toContain("Alice");
    expect(networkListHtml).toContain("1 active connection live");
    expect(networkListHtml).toContain("Bob");
    expect(networkListHtml).toContain(
      "Accepted, but no active Mahilo connection is live right now.",
    );
    expect(networkListHtml).toContain("Incoming requests");
    expect(networkListHtml).toContain("Outgoing requests");

    const overviewMessageHtml =
      harness.getElement("overview-message-list").innerHTML;
    expect(overviewMessageHtml).toContain("Blocked");
    expect(overviewMessageHtml).toContain("Review required");
    expect(overviewMessageHtml).toContain(
      "Who has a ramen spot worth trusting?",
    );
  });

  it("shows the sender blocker in overview when no active sender route is available", () => {
    const harness = createDashboardHarness({
      fetchImpl: async (url) => {
        throw new Error(
          `Unexpected fetch while testing sender blocker readiness: ${url}`,
        );
      },
    });

    const { Helpers, Normalizers, State, UI } = harness.dashboard;

    Helpers.applyCollectionState(
      "agents",
      "agentsById",
      Normalizers.agentsModel([
        {
          callback_url: "https://agent.example/callback",
          created_at: "2026-03-14T10:00:00.000Z",
          framework: "openclaw",
          id: "conn_inactive",
          label: "default",
          mode: "webhook",
          routing_priority: 5,
          status: "inactive",
        },
      ]),
    );
    Helpers.applyCollectionState(
      "friends",
      "friendsById",
      Normalizers.friendsModel([
        {
          created_at: "2026-03-10T00:00:00.000Z",
          direction: "sent",
          display_name: "Alice",
          id: "fr_ready_alice",
          status: "accepted",
          username: "alice",
        },
      ]),
    );

    State.contactConnectionsByUsername.set("alice", {
      error: null,
      items: Normalizers.agentsModel([
        {
          callback_url: "polling://peer",
          created_at: "2026-03-14T09:00:00.000Z",
          framework: "openclaw",
          id: "conn_peer_ready",
          label: "peer_default",
          mode: "polling",
          routing_priority: 1,
          status: "active",
        },
      ]).items,
      loadedAt: "2026-03-14T10:35:00.000Z",
      status: "loaded",
    });

    UI.renderOverviewAgents();
    UI.renderOverviewFriends();

    const readinessHtml =
      harness.getElement("overview-readiness-summary").innerHTML;
    expect(readinessHtml).toContain("Activate a sender route");
    expect(readinessHtml).toContain(
      "none are active for automatic routing.",
    );

    const senderHtml = harness.getElement("overview-sender-summary").innerHTML;
    expect(senderHtml).toContain("No active sender route");
    expect(senderHtml).toContain(
      "Activate one sender connection so Mahilo can route messages.",
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

    const accepted = await createFriendship(
      viewer.id,
      acceptedPeer.id,
      "accepted",
    );
    const incoming = await createFriendship(
      incomingPeer.id,
      viewer.id,
      "pending",
    );
    const outgoing = await createFriendship(
      viewer.id,
      outgoingPeer.id,
      "pending",
    );
    const blocked = await createFriendship(
      viewer.id,
      blockedPeer.id,
      "blocked",
    );

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
        throw new Error(
          `Unexpected fetch while testing network empty states: ${url}`,
        );
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
    expect(detailHtml).toContain(
      "Framework, label, capabilities, and live status",
    );
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

describe("Dashboard relationship actions and role management (DASH-022)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("loads available roles from /roles and renders editable role controls for a contact", async () => {
    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_role_viewer",
      "Viewer",
    );
    const { user: peer } = await createTestUser("dashboard_role_peer", "Peer");
    const friendship = await createFriendship(viewer.id, peer.id, "accepted");

    await addRoleToFriendship(friendship.id, "close_friends");
    await db.insert(schema.userRoles).values({
      description: "Travel recommendations and itinerary checks",
      id: `role_${nanoid(10)}`,
      isSystem: false,
      name: "travel_buddies",
      userId: viewer.id,
    });

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

    expect(harness.fetchCalls).toContain("/api/v1/roles");
    expect(harness.dashboard.State.availableRoles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: "Travel recommendations and itinerary checks",
          isSystem: false,
          name: "travel_buddies",
        }),
      ]),
    );

    const detailHtml = harness.getElement("network-detail-panel").innerHTML;
    expect(detailHtml).toContain("Trust roles");
    expect(detailHtml).toContain("Current roles");
    expect(detailHtml).toContain("Available roles");
    expect(detailHtml).toContain("Close Friends");
    expect(detailHtml).toContain("travel_buddies");
    expect(detailHtml).toContain("Travel recommendations and itinerary checks");
    expect(detailHtml).toContain(
      `handleRemoveFriendRole('${friendship.id}', 'close_friends')`,
    );
    expect(detailHtml).toContain(
      `handleAddFriendRole('${friendship.id}', 'travel_buddies')`,
    );
  });

  it("uses real friendship ids for accept, reject, block, and unfriend actions", async () => {
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_action_viewer",
      "Viewer",
    );
    const { user: acceptedPeer } = await createTestUser(
      "dashboard_action_accepted",
      "Accepted Peer",
    );
    const { user: incomingPeer } = await createTestUser(
      "dashboard_action_incoming",
      "Incoming Peer",
    );
    const { user: rejectPeer } = await createTestUser(
      "dashboard_action_reject",
      "Reject Peer",
    );
    const { user: outgoingPeer } = await createTestUser(
      "dashboard_action_outgoing",
      "Outgoing Peer",
    );

    const accepted = await createFriendship(
      viewer.id,
      acceptedPeer.id,
      "accepted",
    );
    const incoming = await createFriendship(
      incomingPeer.id,
      viewer.id,
      "pending",
    );
    const rejectable = await createFriendship(
      rejectPeer.id,
      viewer.id,
      "pending",
    );
    const outgoing = await createFriendship(
      viewer.id,
      outgoingPeer.id,
      "pending",
    );

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

    let initialCallCount = harness.fetchCalls.length;
    await harness.dashboard.UI.handleAcceptFriend(incoming.id);
    expect(harness.fetchCalls.slice(initialCallCount)).toEqual(
      expect.arrayContaining([
        `/api/v1/friends/${incoming.id}/accept`,
        "/api/v1/friends?status=accepted",
        "/api/v1/friends?status=blocked",
        "/api/v1/friends?status=pending",
      ]),
    );
    expect(harness.dashboard.State.friendsById.get(incoming.id)).toEqual(
      expect.objectContaining({
        friendshipId: incoming.id,
        status: "accepted",
      }),
    );

    initialCallCount = harness.fetchCalls.length;
    await harness.dashboard.UI.handleRejectFriend(rejectable.id);
    expect(harness.fetchCalls.slice(initialCallCount)).toEqual(
      expect.arrayContaining([
        `/api/v1/friends/${rejectable.id}/reject`,
        "/api/v1/friends?status=accepted",
        "/api/v1/friends?status=blocked",
        "/api/v1/friends?status=pending",
      ]),
    );
    expect(harness.dashboard.State.friendsById.has(rejectable.id)).toBe(false);

    initialCallCount = harness.fetchCalls.length;
    await harness.dashboard.UI.handleBlockFriend(accepted.id);
    expect(harness.fetchCalls.slice(initialCallCount)).toEqual(
      expect.arrayContaining([
        `/api/v1/friends/${accepted.id}/block`,
        "/api/v1/friends?status=accepted",
        "/api/v1/friends?status=blocked",
        "/api/v1/friends?status=pending",
      ]),
    );
    expect(harness.dashboard.State.friendsById.get(accepted.id)).toEqual(
      expect.objectContaining({
        friendshipId: accepted.id,
        status: "blocked",
      }),
    );

    initialCallCount = harness.fetchCalls.length;
    await harness.dashboard.UI.handleUnfriend(outgoing.id);
    expect(harness.fetchCalls.slice(initialCallCount)).toEqual(
      expect.arrayContaining([
        `/api/v1/friends/${outgoing.id}`,
        "/api/v1/friends?status=accepted",
        "/api/v1/friends?status=blocked",
        "/api/v1/friends?status=pending",
      ]),
    );
    expect(harness.dashboard.State.friendsById.has(outgoing.id)).toBe(false);
  });

  it("adds and removes contact roles through the friendship role endpoints", async () => {
    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_role_action_viewer",
      "Viewer",
    );
    const { user: peer } = await createTestUser(
      "dashboard_role_action_peer",
      "Role Peer",
    );
    const friendship = await createFriendship(viewer.id, peer.id, "accepted");

    await addRoleToFriendship(friendship.id, "close_friends");
    await db.insert(schema.userRoles).values({
      description: "Trusted answers for private recommendations",
      id: `role_${nanoid()}`,
      isSystem: false,
      name: "trusted_circle",
      userId: viewer.id,
    });

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

    let initialCallCount = harness.fetchCalls.length;
    await harness.dashboard.UI.handleAddFriendRole(
      friendship.id,
      "trusted_circle",
    );
    expect(harness.fetchCalls.slice(initialCallCount)).toEqual(
      expect.arrayContaining([
        `/api/v1/friends/${friendship.id}/roles`,
        "/api/v1/friends?status=accepted",
        "/api/v1/friends?status=blocked",
        "/api/v1/friends?status=pending",
      ]),
    );
    expect(
      harness.dashboard.State.friendsById.get(friendship.id)?.roles || [],
    ).toEqual(expect.arrayContaining(["close_friends", "trusted_circle"]));

    initialCallCount = harness.fetchCalls.length;
    await harness.dashboard.UI.handleRemoveFriendRole(
      friendship.id,
      "close_friends",
    );
    expect(harness.fetchCalls.slice(initialCallCount)).toEqual(
      expect.arrayContaining([
        `/api/v1/friends/${friendship.id}/roles/close_friends`,
        "/api/v1/friends?status=accepted",
        "/api/v1/friends?status=blocked",
        "/api/v1/friends?status=pending",
      ]),
    );
    expect(
      harness.dashboard.State.friendsById.get(friendship.id)?.roles || [],
    ).not.toContain("close_friends");
  });
});

describe("Dashboard group detail, members, and readiness (DASH-023)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("loads live group detail and members and separates active members from pending invites", async () => {
    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_group_detail_viewer",
      "Viewer",
    );
    const { user: activePeer } = await createTestUser(
      "dashboard_group_detail_active",
      "Active Peer",
    );
    const { user: invitedPeer } = await createTestUser(
      "dashboard_group_detail_invited",
      "Invited Peer",
    );

    const groupId = nanoid();
    await db.insert(schema.groups).values({
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      description: "Trusted travel planners",
      id: groupId,
      inviteOnly: true,
      name: "travel_circle",
      ownerUserId: viewer.id,
      updatedAt: new Date("2026-03-03T00:00:00.000Z"),
    });
    await db.insert(schema.groupMemberships).values([
      {
        createdAt: new Date("2026-03-03T00:00:00.000Z"),
        groupId,
        id: nanoid(),
        invitedByUserId: null,
        role: "owner",
        status: "active",
        userId: viewer.id,
      },
      {
        createdAt: new Date("2026-03-03T00:00:00.000Z"),
        groupId,
        id: nanoid(),
        invitedByUserId: viewer.id,
        role: "member",
        status: "active",
        userId: activePeer.id,
      },
      {
        createdAt: new Date("2026-03-03T00:00:00.000Z"),
        groupId,
        id: nanoid(),
        invitedByUserId: viewer.id,
        role: "member",
        status: "invited",
        userId: invitedPeer.id,
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

    expect(harness.dashboard.State.selectedGroupId).toBe(groupId);
    expect(harness.fetchCalls).toContain(`/api/v1/groups/${groupId}`);
    expect(harness.fetchCalls).toContain(`/api/v1/groups/${groupId}/members`);

    const detailHtml = harness.getElement("group-detail-panel").innerHTML;
    expect(detailHtml).toContain("Group detail");
    expect(detailHtml).toContain("Useful for targeted ask-around");
    expect(detailHtml).toContain("Targeted ask-around");
    expect(detailHtml).toContain("Group boundaries");
    expect(detailHtml).toContain("Active members");
    expect(detailHtml).toContain("Pending invites");
    expect(detailHtml).toContain(activePeer.username);
    expect(detailHtml).toContain(invitedPeer.username);
    expect(detailHtml).toContain("Invite member");
    expect(detailHtml).toContain("Pending invites: 1");
  });

  it("uses the real invite and leave endpoints from the selected group workspace", async () => {
    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_group_action_viewer",
      "Viewer",
    );
    const { user: owner } = await createTestUser(
      "dashboard_group_action_owner",
      "Owner",
    );
    const { user: invitee } = await createTestUser(
      "dashboard_group_action_invitee",
      "Invitee",
    );

    const groupId = nanoid();
    await db.insert(schema.groups).values({
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
      description: "Admin-managed travel group",
      id: groupId,
      inviteOnly: true,
      name: "travel_admins",
      ownerUserId: owner.id,
      updatedAt: new Date("2026-03-04T00:00:00.000Z"),
    });
    await db.insert(schema.groupMemberships).values([
      {
        createdAt: new Date("2026-03-04T00:00:00.000Z"),
        groupId,
        id: nanoid(),
        invitedByUserId: null,
        role: "owner",
        status: "active",
        userId: owner.id,
      },
      {
        createdAt: new Date("2026-03-04T00:00:00.000Z"),
        groupId,
        id: nanoid(),
        invitedByUserId: owner.id,
        role: "admin",
        status: "active",
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

    harness.getElement("group-invite-username").value = `@${invitee.username}`;

    let initialCallCount = harness.fetchCalls.length;
    await harness.dashboard.UI.handleInviteToGroup(groupId);
    await flushDashboardWork();

    expect(harness.fetchCalls.slice(initialCallCount)).toEqual(
      expect.arrayContaining([
        `/api/v1/groups/${groupId}/invite`,
        "/api/v1/groups",
        `/api/v1/groups/${groupId}`,
        `/api/v1/groups/${groupId}/members`,
      ]),
    );

    const membershipsAfterInvite = await db
      .select()
      .from(schema.groupMemberships)
      .where(eq(schema.groupMemberships.groupId, groupId));
    expect(
      membershipsAfterInvite.find(
        (membership) => membership.userId === invitee.id,
      ),
    ).toEqual(
      expect.objectContaining({
        status: "invited",
      }),
    );
    expect(harness.getElement("group-detail-panel").innerHTML).toContain(
      invitee.username,
    );

    initialCallCount = harness.fetchCalls.length;
    await harness.dashboard.UI.handleLeaveGroup(groupId);
    await flushDashboardWork();

    expect(harness.fetchCalls.slice(initialCallCount)).toEqual(
      expect.arrayContaining([
        `/api/v1/groups/${groupId}/leave`,
        "/api/v1/groups",
      ]),
    );

    const membershipsAfterLeave = await db
      .select()
      .from(schema.groupMemberships)
      .where(eq(schema.groupMemberships.groupId, groupId));
    expect(
      membershipsAfterLeave.find(
        (membership) => membership.userId === viewer.id,
      ),
    ).toBeUndefined();
    expect(harness.dashboard.State.groupsById.has(groupId)).toBe(false);
  });

  it("uses the real join endpoint when accepting a pending group invite", async () => {
    const db = getTestDb();
    const { user: viewer, apiKey } = await createTestUser(
      "dashboard_group_join_viewer",
      "Viewer",
    );
    const { user: owner } = await createTestUser(
      "dashboard_group_join_owner",
      "Owner",
    );
    const { user: activePeer } = await createTestUser(
      "dashboard_group_join_peer",
      "Active Peer",
    );

    const groupId = nanoid();
    await db.insert(schema.groups).values({
      createdAt: new Date("2026-03-05T00:00:00.000Z"),
      description: "Invite-only planning group",
      id: groupId,
      inviteOnly: true,
      name: "planning_circle",
      ownerUserId: owner.id,
      updatedAt: new Date("2026-03-05T00:00:00.000Z"),
    });
    await db.insert(schema.groupMemberships).values([
      {
        createdAt: new Date("2026-03-05T00:00:00.000Z"),
        groupId,
        id: nanoid(),
        invitedByUserId: null,
        role: "owner",
        status: "active",
        userId: owner.id,
      },
      {
        createdAt: new Date("2026-03-05T00:00:00.000Z"),
        groupId,
        id: nanoid(),
        invitedByUserId: owner.id,
        role: "member",
        status: "active",
        userId: activePeer.id,
      },
      {
        createdAt: new Date("2026-03-05T00:00:00.000Z"),
        groupId,
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

    expect(harness.getElement("group-detail-panel").innerHTML).toContain(
      "Accept invite",
    );
    expect(harness.getElement("group-detail-panel").innerHTML).toContain(
      "Decline invite",
    );

    const initialCallCount = harness.fetchCalls.length;
    await harness.dashboard.UI.handleJoinGroup(groupId);
    await flushDashboardWork();

    expect(harness.fetchCalls.slice(initialCallCount)).toEqual(
      expect.arrayContaining([
        `/api/v1/groups/${groupId}/join`,
        "/api/v1/groups",
        `/api/v1/groups/${groupId}`,
        `/api/v1/groups/${groupId}/members`,
      ]),
    );
    expect(harness.dashboard.State.groupsById.get(groupId)).toEqual(
      expect.objectContaining({
        status: "active",
      }),
    );

    const memberships = await db
      .select()
      .from(schema.groupMemberships)
      .where(eq(schema.groupMemberships.groupId, groupId));
    expect(
      memberships.find((membership) => membership.userId === viewer.id),
    ).toEqual(
      expect.objectContaining({
        status: "active",
      }),
    );

    const detailHtml = harness.getElement("group-detail-panel").innerHTML;
    expect(detailHtml).toContain("Useful for targeted ask-around");
    expect(detailHtml).toContain("Active member");
  });
});
