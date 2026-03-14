import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DashboardDataSurface = {
  Helpers: Record<string, (...args: any[]) => any>;
  Normalizers: Record<string, (...args: any[]) => any>;
  State: Record<string, any>;
};

type DashboardAppSurface = DashboardDataSurface & {
  UI: Record<string, (...args: any[]) => any>;
};

type MockFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

type FetchHandler = (
  path: string,
  options?: RequestInit,
) => MockFetchResponse | Promise<MockFetchResponse>;

type DashboardHarness = {
  boot: () => Promise<void>;
  dashboard: DashboardAppSurface;
  fetchCalls: string[];
  getElement: (id: string) => ElementStub;
};

let activeCleanup: (() => void) | null = null;

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
  parentElement: ElementStub | null = null;
  previousElementSibling: { style: Record<string, string> } | null = {
    style: {},
  };
  scrollHeight = 0;
  scrollTop = 0;
  textContent = "";
  type = "text";
  value = "";

  constructor(id = "") {
    this.id = id;
  }

  addEventListener() {}

  appendChild(child: ElementStub) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  closest() {
    return null;
  }

  focus() {}

  getAttribute(name: string) {
    return this.dataset[name] ?? null;
  }

  querySelector() {
    return new ElementStub();
  }

  querySelectorAll() {
    return [] as ElementStub[];
  }

  remove() {
    if (!this.parentElement) {
      return;
    }

    this.parentElement.removeChild(this);
  }

  removeChild(child: ElementStub) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
    }
  }

  reset() {}

  scrollIntoView() {}

  select() {}

  setAttribute(name: string, value: string) {
    this.dataset[name] = value;
  }
}

class WebSocketStub {
  static readonly OPEN = 1;
  onclose?: () => void;
  onerror?: (error: unknown) => void;
  onmessage?: (event: { data: string }) => void;
  onopen?: () => void;
  readyState = WebSocketStub.OPEN;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
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

function createJsonResponse(
  body: unknown,
  status = 200,
  ok = status >= 200 && status < 300,
): MockFetchResponse {
  return {
    ok,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function extractHtmlElementMeta() {
  const html = readFileSync(
    resolve(process.cwd(), "public/index.html"),
    "utf8",
  );
  const elements = new Map<
    string,
    {
      classes: string[];
      type: string;
    }
  >();

  for (const match of html.matchAll(/<[^>]*id=\"([^\"]+)\"[^>]*>/g)) {
    const id = match[1];
    const tag = match[0];
    const classMatch = tag.match(/class=\"([^\"]*)\"/);
    const typeMatch = tag.match(/type=\"([^\"]*)\"/);

    elements.set(id, {
      classes: classMatch?.[1]?.split(/\s+/).filter(Boolean) ?? [],
      type: typeMatch?.[1] ?? "text",
    });
  }

  return elements;
}

function createDocumentStub(
  elementMeta: Map<string, { classes: string[]; type: string }>,
) {
  const elements = new Map(
    Array.from(elementMeta.entries()).map(([id, meta]) => {
      const element = new ElementStub(id);
      element.type = meta.type;
      if (meta.classes.length) {
        element.className = meta.classes.join(" ");
        element.classList.add(...meta.classes);
      }
      return [id, element];
    }),
  );

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
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

function setStubbedGlobal(
  name: string,
  value: unknown,
  originals: Map<string, PropertyDescriptor | undefined>,
) {
  if (!originals.has(name)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }

  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function installDashboardGlobals(fetchImpl: FetchHandler) {
  const { documentStub, getElement } = createDocumentStub(
    extractHtmlElementMeta(),
  );
  const sessionStore = new Map<string, string>();
  const fetchCalls: string[] = [];
  const originals = new Map<string, PropertyDescriptor | undefined>();

  const localStorageStub = {
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
  const fetchStub = async (url: string, requestOptions?: RequestInit) => {
    const requestUrl = new URL(url);
    const path = `${requestUrl.pathname}${requestUrl.search}`;
    fetchCalls.push(path);
    return await fetchImpl(path, requestOptions);
  };
  const navigatorStub = {
    clipboard: {
      writeText: async () => {},
    },
  };
  const windowStub: Record<string, any> = {
    addEventListener: () => {},
    confirm: () => true,
    document: documentStub,
    fetch: fetchStub,
    IntersectionObserver: IntersectionObserverStub,
    localStorage: localStorageStub,
    location: { origin: "http://localhost" },
    navigator: navigatorStub,
    removeEventListener: () => {},
    scrollY: 0,
    WebSocket: WebSocketStub,
  };
  windowStub.window = windowStub;

  setStubbedGlobal("window", windowStub, originals);
  setStubbedGlobal("document", documentStub, originals);
  setStubbedGlobal("fetch", fetchStub, originals);
  setStubbedGlobal("localStorage", localStorageStub, originals);
  setStubbedGlobal("navigator", navigatorStub, originals);
  setStubbedGlobal("IntersectionObserver", IntersectionObserverStub, originals);
  setStubbedGlobal("WebSocket", WebSocketStub, originals);
  setStubbedGlobal("setInterval", () => 1, originals);
  setStubbedGlobal("clearInterval", () => {}, originals);
  setStubbedGlobal("setTimeout", () => 1, originals);
  setStubbedGlobal("clearTimeout", () => {}, originals);
  setStubbedGlobal("confirm", () => true, originals);
  setStubbedGlobal("__MAHILO_DASHBOARD_TEST_HOOKS__", true, originals);

  return {
    documentStub,
    fetchCalls,
    getElement,
    cleanup() {
      delete (globalThis as Record<string, unknown>).__MAHILO_DASHBOARD__;

      for (const [name, descriptor] of originals.entries()) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete (globalThis as Record<string, unknown>)[name];
        }
      }
    },
  };
}

async function loadDashboardData(): Promise<DashboardDataSurface> {
  const harness = await createDashboardHarness(async (path) => {
    throw new Error(
      `Unexpected fetch while testing dashboard helpers: ${path}`,
    );
  });

  return harness.dashboard;
}

async function createDashboardHarness(
  fetchImpl: FetchHandler,
): Promise<DashboardHarness> {
  const installed = installDashboardGlobals(fetchImpl);
  activeCleanup = installed.cleanup;
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await import(`../../public/app.js?dashboard-regression=${cacheBust}`);

  const dashboard = (globalThis as Record<string, unknown>)
    .__MAHILO_DASHBOARD__ as DashboardAppSurface | undefined;

  if (!dashboard) {
    throw new Error("Dashboard test hooks were not exposed by public/app.js");
  }

  return {
    async boot() {
      for (const callback of installed.documentStub._readyCallbacks) {
        callback();
      }
      await flushDashboardWork();
    },
    dashboard,
    fetchCalls: installed.fetchCalls,
    getElement: installed.getElement,
  };
}

function createAuthFlowFetchHandler() {
  let authenticated = false;
  let browserLoginStatus = "pending";

  const user = {
    user_id: "usr_viewer",
    username: "viewer",
    display_name: "Viewer",
    created_at: "2026-03-14T12:00:00.000Z",
    registration_source: "invite",
    status: "active",
    verified: true,
    verified_at: "2026-03-14T12:00:00.000Z",
  };

  const handler: FetchHandler = (path) => {
    if (path === "/api/v1/auth/me") {
      if (!authenticated) {
        return createJsonResponse(
          { error: "Unauthorized", code: "UNAUTHORIZED" },
          401,
          false,
        );
      }

      return createJsonResponse(user);
    }

    if (path === "/api/v1/auth/browser-login/attempts") {
      return createJsonResponse(
        {
          attempt_id: "attempt_dash",
          browser_token: "browser_token_dash",
          approval_code: "ABC123",
          expires_at: "2026-03-14T12:05:00.000Z",
          status: "pending",
        },
        201,
      );
    }

    if (path === "/api/v1/auth/browser-login/attempts/attempt_dash") {
      return createJsonResponse({
        attempt_id: "attempt_dash",
        browser_token: "browser_token_dash",
        approval_code: "ABC123",
        expires_at: "2026-03-14T12:05:00.000Z",
        approved_at:
          browserLoginStatus === "approved" ? "2026-03-14T12:01:00.000Z" : null,
        status: browserLoginStatus,
      });
    }

    if (path === "/api/v1/auth/browser-login/attempts/attempt_dash/redeem") {
      authenticated = true;
      browserLoginStatus = "redeemed";
      return createJsonResponse({
        redeemed_at: "2026-03-14T12:01:30.000Z",
      });
    }

    if (path === "/api/v1/agents") {
      return createJsonResponse([
        {
          id: "conn_default",
          framework: "openclaw",
          label: "default",
          callback_url: "polling://default",
          mode: "polling",
          routing_priority: 1,
          status: "active",
          created_at: "2026-03-14T11:00:00.000Z",
        },
      ]);
    }

    if (path === "/api/v1/friends?status=accepted") {
      return createJsonResponse({
        friends: [
          {
            friendship_id: "fr_alice",
            user_id: "usr_alice",
            username: "alice",
            display_name: "Alice",
            status: "accepted",
            direction: "received",
            roles: ["close_friends"],
            interaction_count: 4,
            created_at: "2026-03-14T10:00:00.000Z",
          },
        ],
      });
    }

    if (
      path === "/api/v1/friends?status=pending" ||
      path === "/api/v1/friends?status=blocked"
    ) {
      return createJsonResponse({ friends: [] });
    }

    if (path === "/api/v1/roles") {
      return createJsonResponse([]);
    }

    if (path === "/api/v1/groups") {
      return createJsonResponse([]);
    }

    if (path === "/api/v1/messages?limit=50") {
      return createJsonResponse([
        {
          id: "msg_dashboard_delivered",
          sender: { username: "viewer", agent: "default" },
          recipient: { type: "user", username: "alice" },
          message: "Dashboard hello",
          status: "delivered",
          delivery_status: "delivered",
          correlation_id: "corr_dashboard",
          direction: "outbound",
          resource: "message.general",
          action: "share",
          created_at: "2026-03-14T12:02:00.000Z",
        },
      ]);
    }

    if (path === "/api/v1/plugin/reviews?limit=25") {
      return createJsonResponse({
        review_queue: {
          count: 1,
          direction: "outbound",
          statuses: ["review_required"],
        },
        reviews: [
          {
            review_id: "rev_dashboard",
            message_id: "msg_review_dashboard",
            status: "review_required",
            queue_direction: "outbound",
            decision: "ask",
            delivery_mode: "review_required",
            summary: "Share exact location",
            reason_code: "policy.ask.user.structured",
            created_at: "2026-03-14T12:03:00.000Z",
            message_preview: "Share exact location",
            selectors: {
              direction: "outbound",
              resource: "location.current",
              action: "share",
            },
            sender: {
              username: "viewer",
            },
            recipient: {
              type: "user",
              username: "alice",
            },
          },
        ],
      });
    }

    if (
      path ===
      "/api/v1/plugin/events/blocked?limit=25&include_payload_excerpt=true"
    ) {
      return createJsonResponse({
        retention: {
          blocked_event_log: "metadata_only",
          payload_excerpt_default: "omitted",
          payload_excerpt_included: true,
          payload_hash_algorithm: "sha256",
          source_message_payload: "messages table may retain payload",
        },
        blocked_events: [
          {
            id: "blocked_dashboard",
            message_id: "msg_blocked_dashboard",
            queue_direction: "outbound",
            reason: "Blocked by boundary.",
            reason_code: "policy.deny.user.structured",
            created_at: "2026-03-14T12:04:00.000Z",
            payload_hash: "abc123",
            stored_payload_excerpt: "Share health summary",
            direction: "outbound",
            resource: "health.summary",
            action: "share",
            sender: { username: "viewer" },
            recipient: { type: "user", username: "alice" },
            status: "rejected",
          },
        ],
      });
    }

    if (path === "/api/v1/plugin/suggestions/promotions?limit=20") {
      return createJsonResponse({
        learning: {
          evaluated_override_count: 0,
          lookback_days: 30,
          min_repetitions: 3,
          total_pattern_count: 0,
        },
        promotion_suggestions: [],
      });
    }

    if (path === "/api/v1/policies") {
      return createJsonResponse([
        {
          id: "pol_common",
          scope: "role",
          target_id: "close_friends",
          direction: "outbound",
          resource: "calendar.availability",
          action: "share",
          effect: "allow",
          evaluator: "structured",
          policy_content: "Availability can be shared with close friends.",
          created_at: "2026-03-14T09:00:00.000Z",
        },
        {
          id: "pol_advanced",
          scope: "group",
          target_id: "grp_lab",
          direction: "notification",
          resource: "custom.preference",
          action: "share",
          effect: "ask",
          evaluator: "structured",
          policy_content: { custom: true },
          created_at: "2026-03-14T09:30:00.000Z",
        },
      ]);
    }

    if (path === "/api/v1/preferences") {
      return createJsonResponse({
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
    }

    throw new Error(`Unexpected fetch in dashboard Vitest harness: ${path}`);
  };

  return {
    handler,
    markApproved() {
      browserLoginStatus = "approved";
    },
  };
}

describe("Dashboard frontend regression harness", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    activeCleanup?.();
    activeCleanup = null;
    vi.restoreAllMocks();
  });

  it("covers normalization helpers for frontend collection models", async () => {
    const { Helpers, Normalizers, State } = await loadDashboardData();

    const friendsModel = Helpers.mergeCollectionModels(
      [
        Normalizers.friendsModel({
          friends: [
            {
              friendship_id: "fr_accepted",
              user_id: "usr_alice",
              username: "alice",
              display_name: "Alice",
              status: "accepted",
              direction: "received",
              roles: ["close_friends"],
              interaction_count: 12,
              since: "2026-03-08T10:00:00.000Z",
            },
          ],
        }),
        Normalizers.friendsModel({
          friends: [
            {
              friendship_id: "fr_blocked",
              user_id: "usr_delta",
              username: "delta",
              display_name: "Delta",
              status: "blocked",
              direction: "sent",
              roles: [],
              interaction_count: 1,
              since: "2026-03-08T12:00:00.000Z",
            },
          ],
        }),
      ],
      (friend: { friendshipId: string }) => friend.friendshipId,
    );
    Helpers.applyCollectionState("friends", "friendsById", friendsModel);

    const messagesModel = Normalizers.messagesModel(
      [
        {
          id: "msg_sent",
          sender: "viewer",
          recipient: "alice",
          recipient_type: "user",
          message: "Ping from the dashboard",
          status: "delivered",
          delivery_status: "delivered",
          payload_type: "text/plain",
          correlation_id: "corr_sent",
          direction: "outbound",
          resource: "message.general",
          action: "share",
          created_at: "2026-03-08T10:00:00.000Z",
        },
        {
          id: "msg_nested",
          sender: {
            user_id: "usr_alice",
            username: null,
            connection_id: "conn_alice",
          },
          recipient: {
            id: "usr_viewer",
            username: "viewer",
            type: "user",
            connection_id: "conn_viewer",
          },
          message: { text: "Nested participant payload" },
          status: "delivered",
          direction: "outbound",
          resource: "calendar.availability",
          action: "share",
          created_at: "2026-03-08T11:00:00.000Z",
        },
      ],
      { currentUsername: "viewer" },
    );
    Helpers.applyCollectionState("messages", "messagesById", messagesModel);

    const groupsModel = Normalizers.groupsModel([
      {
        group_id: "grp_1",
        name: "weekend-plan",
        invite_only: true,
        member_count: 4,
        role: "owner",
        status: "active",
        created_at: "2026-03-08T09:00:00.000Z",
      },
    ]);
    Helpers.applyCollectionState("groups", "groupsById", groupsModel);

    const blockedRetention = Normalizers.blockedEventRetention({
      retention: {
        blocked_event_log: "metadata_only",
        payload_excerpt_default: "omitted",
        payload_excerpt_included: false,
        payload_hash_algorithm: "sha256",
        source_message_payload: "messages table may retain payload",
      },
    });

    expect(State.friendsById.get("fr_accepted")).toMatchObject({
      friendshipId: "fr_accepted",
      username: "alice",
      status: "accepted",
      roles: ["close_friends"],
    });
    expect(State.friendsById.get("fr_blocked")).toMatchObject({
      friendshipId: "fr_blocked",
      status: "blocked",
    });
    expect(State.messagesById.get("msg_sent")).toMatchObject({
      counterpart: "alice",
      transportDirection: "sent",
      payloadType: "text/plain",
    });
    expect(State.messagesById.get("msg_nested")).toMatchObject({
      sender: "usr_alice",
      recipient: "viewer",
      transportDirection: "received",
    });
    expect(State.groupsById.get("grp_1")).toMatchObject({
      id: "grp_1",
      inviteOnly: true,
      memberCount: 4,
    });
    expect(blockedRetention).toMatchObject({
      blockedEventLog: "metadata_only",
      payloadHashAlgorithm: "sha256",
      payloadExcerptIncluded: false,
    });
  });

  it("covers boundary mapping for common categories and unmatched canonical policies", async () => {
    const { Normalizers } = await loadDashboardData();

    const availabilityBoundary = Normalizers.policy({
      id: "pol_availability",
      scope: "role",
      target_id: "close_friends",
      direction: "response",
      resource: "calendar.event",
      action: "read_details",
      effect: "ask",
      evaluator: "llm",
      policy_content: "Ask before sharing calendar details.",
    });

    const locationBoundary = Normalizers.policy({
      id: "pol_location",
      scope: "user",
      target_id: "usr_alice",
      direction: "outbound",
      resource: "location.current",
      action: "share",
      effect: "deny",
      evaluator: "structured",
      policy_content: "Never share exact location.",
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

    expect(availabilityBoundary.boundary).toMatchObject({
      category: "availability",
      managementPath: "guided",
      effect: {
        value: "ask",
        badgeLabel: "Ask",
      },
      audience: {
        scope: "role",
        targetLabel: "Close Friends",
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
        displayLabel: "Specific contact",
      },
    });
    expect(advancedBoundary.boundary).toMatchObject({
      category: "advanced",
      managementPath: "advanced",
      selector: {
        directionLabel: "Notification",
        summary: "custom.preference / share",
      },
    });
  });

  it("covers review queue and activity grouping for delivered, review, and blocked states", async () => {
    const { Helpers, Normalizers } = await loadDashboardData();

    const delivered = Normalizers.message(
      {
        id: "msg_delivered",
        message: "Delivered dashboard ping",
        sender: { username: "viewer", agent: "default" },
        recipient: { type: "user", username: "alice" },
        status: "delivered",
        delivery_status: "delivered",
        created_at: "2026-03-14T12:00:00.000Z",
        direction: "outbound",
        resource: "message.general",
        action: "share",
      },
      { currentUsername: "viewer" },
    );

    const reviewMessage = Normalizers.message(
      {
        id: "msg_review",
        message: "Share exact location",
        sender: { username: "viewer", agent: "default" },
        recipient: { type: "user", username: "alice" },
        status: "review_required",
        delivery_status: "review_required",
        created_at: "2026-03-14T12:01:00.000Z",
        direction: "outbound",
        resource: "location.current",
        action: "share",
      },
      { currentUsername: "viewer" },
    );

    const blockedMessage = Normalizers.message(
      {
        id: "msg_blocked",
        message: "Share health summary",
        sender: { username: "alice", agent: "peer_default" },
        recipient: { type: "user", username: "viewer" },
        status: "rejected",
        delivery_status: "rejected",
        created_at: "2026-03-14T12:02:00.000Z",
        direction: "inbound",
        resource: "health.summary",
        action: "request",
      },
      { currentUsername: "viewer" },
    );

    const reviewQueue = Normalizers.reviewQueue({
      review_queue: {
        count: 1,
        direction: "outbound",
        statuses: ["approval_pending"],
      },
    });
    const review = Normalizers.review({
      review_id: "rev_1",
      message_id: "msg_review",
      queue_direction: "outbound",
      status: "approval_pending",
      decision: "ask",
      delivery_mode: "hold_for_approval",
      summary: "Needs approval before delivery.",
      reason_code: "policy.ask.user.structured",
      created_at: "2026-03-14T12:01:30.000Z",
      message_preview: "Share exact location",
      selectors: {
        direction: "outbound",
        resource: "location.current",
        action: "share",
      },
      sender: { username: "viewer" },
      recipient: { type: "user", username: "alice" },
    });
    const blocked = Normalizers.blockedEvent({
      id: "blocked_1",
      message_id: "msg_blocked",
      queue_direction: "inbound",
      status: "rejected",
      reason: "Blocked by boundary.",
      reason_code: "policy.deny.inbound.request",
      created_at: "2026-03-14T12:02:30.000Z",
      direction: "inbound",
      resource: "health.summary",
      action: "request",
      sender: { username: "alice" },
      recipient: { type: "user", username: "viewer" },
      payload_hash: "abc123def456",
    });

    const auditModel = Helpers.auditLogModel(
      [delivered, reviewMessage, blockedMessage],
      [review],
      [blocked],
    );

    expect(reviewQueue).toMatchObject({
      count: 1,
      direction: "outbound",
      statuses: ["approval_pending"],
    });
    expect(
      Helpers.logFeed(
        [delivered, reviewMessage, blockedMessage],
        [review],
        [blocked],
      ).map((item: { id: string }) => item.id),
    ).toEqual(["msg_blocked", "msg_review", "msg_delivered"]);
    expect(
      Helpers.logFeed(
        [delivered, reviewMessage, blockedMessage],
        [review],
        [blocked],
        { state: "review" },
      ).map((item: { id: string }) => item.id),
    ).toEqual(["msg_review"]);
    expect(
      Helpers.logFeed(
        [delivered, reviewMessage, blockedMessage],
        [review],
        [blocked],
        { state: "blocked" },
      ).map((item: { id: string }) => item.id),
    ).toEqual(["msg_blocked"]);
    expect(
      Helpers.logFeed(
        [delivered, reviewMessage, blockedMessage],
        [review],
        [blocked],
        { state: "delivered" },
      ).map((item: { id: string }) => item.id),
    ).toEqual(["msg_delivered"]);
    expect(Helpers.auditCounts(auditModel.items)).toMatchObject({
      delivered: 1,
      review: 1,
      approvalPending: 1,
      blocked: 1,
    });
    expect(
      Helpers.overviewActivityFeed(auditModel.items).map(
        (entry: { kind: string; item?: { auditState?: string } }) =>
          entry.item?.auditState || entry.kind,
      ),
    ).toEqual(["blocked", "review", "delivered"]);
  });

  it("covers landing-to-dashboard auth gating for the agent-backed browser sign-in path", async () => {
    const authFlow = createAuthFlowFetchHandler();
    const harness = await createDashboardHarness(authFlow.handler);

    await harness.boot();

    expect(
      harness.getElement("landing-page").classList.contains("hidden"),
    ).toBe(false);
    expect(
      harness.getElement("dashboard-screen").classList.contains("hidden"),
    ).toBe(true);
    expect(harness.fetchCalls).toContain("/api/v1/auth/me");

    harness.getElement("agent-login-username").value = "viewer";

    await harness.dashboard.UI.handleAgentBrowserLogin();
    await flushDashboardWork();

    expect(harness.dashboard.State.browserLogin).toMatchObject({
      username: "viewer",
      approvalCode: "ABC123",
      status: "pending",
    });
    expect(harness.fetchCalls).toContain("/api/v1/auth/browser-login/attempts");

    authFlow.markApproved();
    await harness.dashboard.UI.pollBrowserLoginAttempt();
    await flushDashboardWork();

    expect(harness.dashboard.State.browserLogin.status).toBe("approved");
    expect(
      harness.getElement("agent-login-continue").classList.contains("hidden"),
    ).toBe(false);

    await harness.dashboard.UI.redeemBrowserLoginAttempt();
    await flushDashboardWork();

    expect(harness.dashboard.State.user).toMatchObject({
      username: "viewer",
    });
    expect(harness.dashboard.State.currentView).toBe("overview");
    expect(harness.dashboard.State.friends).toHaveLength(1);
    expect(harness.dashboard.State.policies).toHaveLength(2);
    expect(harness.dashboard.State.auditLog).toHaveLength(3);
    expect(
      harness.getElement("landing-page").classList.contains("hidden"),
    ).toBe(true);
    expect(
      harness.getElement("dashboard-screen").classList.contains("hidden"),
    ).toBe(false);
    expect(harness.fetchCalls).toEqual(
      expect.arrayContaining([
        "/api/v1/auth/browser-login/attempts",
        "/api/v1/auth/browser-login/attempts/attempt_dash",
        "/api/v1/auth/browser-login/attempts/attempt_dash/redeem",
        "/api/v1/agents",
        "/api/v1/friends?status=accepted",
        "/api/v1/friends?status=pending",
        "/api/v1/friends?status=blocked",
        "/api/v1/messages?limit=50",
        "/api/v1/plugin/reviews?limit=25",
        "/api/v1/plugin/events/blocked?limit=25&include_payload_excerpt=true",
        "/api/v1/plugin/suggestions/promotions?limit=20",
        "/api/v1/policies",
      ]),
    );
    expect(harness.getElement("overview-audit-cues").innerHTML).toContain(
      "Blocked",
    );
  });
});
