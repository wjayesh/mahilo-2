/**
 * Mahilo Dashboard - Main Application
 * Soft, squishy 3D game UI for agent management
 */

// ========================================
// Configuration
// ========================================
const APP_ORIGIN =
  typeof window !== "undefined" &&
  window.location.origin &&
  window.location.origin !== "null"
    ? window.location.origin
    : "https://mahilo.io";
const WS_ORIGIN = APP_ORIGIN.replace(/^http:/, "ws:").replace(
  /^https:/,
  "wss:",
);

const CONFIG = {
  API_URL: `${APP_ORIGIN}/api/v1`,
  WS_URL: `${WS_ORIGIN}/api/v1/notifications/ws`,

  STORAGE_KEY: "mahilo_session",
  BROWSER_LOGIN_POLL_INTERVAL_MS: 2000,
  PING_INTERVAL: 30000,
};

const BROWSER_LOGIN_TOKEN_HEADER = "x-browser-login-token";

const VIEW_ALIASES = {
  agents: "connections",
  friends: "network",
  policies: "boundaries",
};

const VIEW_META = {
  overview: {
    title: "Overview",
    subtitle: "Readiness across your Mahilo network",
  },
  network: {
    title: "Network",
    subtitle: "People, roles, and relationship state across your circle",
  },
  connections: {
    title: "Sender Connections",
    subtitle: "Manage the Mahilo connections that can send on your behalf",
  },
  groups: {
    title: "Groups",
    subtitle: "Coordinate trusted circles for targeted ask-around flows",
  },
  messages: {
    title: "Direct Messages",
    subtitle: "Inspect legacy one-to-one message threads and delivery history",
  },
  logs: {
    title: "Delivery Logs",
    subtitle:
      "Audit deliveries, reviews, blocked events, and ask-around threads",
  },
  boundaries: {
    title: "Boundaries",
    subtitle:
      "Control what Mahilo can share, hold for review, or block outright",
  },
  settings: {
    title: "Settings",
    subtitle:
      "Manage notifications, quiet hours, and your default dashboard behavior",
  },
  developer: {
    title: "Developer",
    subtitle: "Advanced API-key utilities, diagnostics, and test tooling",
  },
};

function createEmptyBrowserLoginState() {
  return {
    status: "idle",
    username: "",
    attemptId: null,
    browserToken: null,
    approvalCode: null,
    expiresAt: null,
    approvedAt: null,
    deniedAt: null,
    redeemedAt: null,
    errorCode: null,
    errorMessage: null,
  };
}

// ========================================
// State Management
// ========================================
const State = {
  user: null,
  apiKey: null,
  ws: null,
  agents: [],
  agentsById: new Map(),
  agentHealthById: new Map(),
  friends: [],
  friendsById: new Map(),
  groups: [],
  groupsById: new Map(),
  groupDetailsById: new Map(),
  groupMembersByGroupId: new Map(),
  messages: [],
  messagesById: new Map(),
  auditLog: [],
  auditLogById: new Map(),
  policies: [],
  policiesById: new Map(),
  policyProvenanceById: new Map(),
  reviews: [],
  reviewsById: new Map(),
  reviewQueue: null,
  blockedEvents: [],
  blockedEventsById: new Map(),
  blockedEventRetention: null,
  promotionSuggestions: [],
  promotionSuggestionsById: new Map(),
  promotionSuggestionLearning: null,
  promotionSuggestionsStatus: "idle",
  promotionSuggestionsError: null,
  preferences: null,
  conversations: new Map(),
  currentView: "overview",
  selectedChat: null,
  selectedAgentId: null,
  selectedNetworkFriendId: null,
  selectedGroupId: null,
  wsConnected: false,
  notifications: [],
  logDirectionFilter: "all",
  logStateFilter: "all",
  networkFilter: "all",
  networkSearch: "",
  groupSearch: "",
  boundaryScopeFilter: "all",
  boundaryCategoryFilter: "all",
  contactConnectionsByUsername: new Map(),
  availableRoles: [],
  availableRolesByName: new Map(),
  availableRolesStatus: "idle",
  availableRolesError: null,
  developerApiKeyVisible: false,
  browserLogin: createEmptyBrowserLoginState(),

  readStoredSession() {
    const session = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (session) {
      try {
        const data = JSON.parse(session);
        return {
          apiKey: typeof data.apiKey === "string" ? data.apiKey : null,
          user: Normalizers.user(data.user),
        };
      } catch (e) {
        console.error("Failed to parse session:", e);
      }
    }

    return {
      apiKey: null,
      user: null,
    };
  },

  // Save state to localStorage
  save() {
    if (!this.apiKey) {
      localStorage.removeItem(CONFIG.STORAGE_KEY);
      return;
    }

    const user = this.user
      ? {
          user_id: this.user.user_id,
          username: this.user.username,
          display_name: this.user.display_name,
          created_at: this.user.created_at,
          registration_source: this.user.registration_source,
          status: this.user.status,
          verified: this.user.verified,
          verified_at: this.user.verified_at,
        }
      : null;

    localStorage.setItem(
      CONFIG.STORAGE_KEY,
      JSON.stringify({
        apiKey: this.apiKey,
        user,
      }),
    );
  },

  // Clear state
  clear() {
    this.user = null;
    this.apiKey = null;
    this.agents = [];
    this.agentsById = new Map();
    this.agentHealthById = new Map();
    this.friends = [];
    this.friendsById = new Map();
    this.groups = [];
    this.groupsById = new Map();
    this.groupDetailsById = new Map();
    this.groupMembersByGroupId = new Map();
    this.messages = [];
    this.messagesById = new Map();
    this.auditLog = [];
    this.auditLogById = new Map();
    this.policies = [];
    this.policiesById = new Map();
    this.policyProvenanceById = new Map();
    this.reviews = [];
    this.reviewsById = new Map();
    this.reviewQueue = null;
    this.blockedEvents = [];
    this.blockedEventsById = new Map();
    this.blockedEventRetention = null;
    this.promotionSuggestions = [];
    this.promotionSuggestionsById = new Map();
    this.promotionSuggestionLearning = null;
    this.promotionSuggestionsStatus = "idle";
    this.promotionSuggestionsError = null;
    this.preferences = null;
    this.conversations = new Map();
    this.currentView = "overview";
    this.selectedChat = null;
    this.selectedAgentId = null;
    this.selectedNetworkFriendId = null;
    this.selectedGroupId = null;
    this.wsConnected = false;
    this.logDirectionFilter = "all";
    this.logStateFilter = "all";
    this.networkFilter = "all";
    this.networkSearch = "";
    this.groupSearch = "";
    this.boundaryScopeFilter = "all";
    this.boundaryCategoryFilter = "all";
    this.contactConnectionsByUsername = new Map();
    this.availableRoles = [];
    this.availableRolesByName = new Map();
    this.availableRolesStatus = "idle";
    this.availableRolesError = null;
    this.developerApiKeyVisible = false;
    this.browserLogin = createEmptyBrowserLoginState();
    localStorage.removeItem(CONFIG.STORAGE_KEY);
  },
};

// ========================================
// API Client
// ========================================
const API = {
  // Make authenticated API request
  async request(endpoint, options = {}) {
    const {
      authMode = "default",
      headers: optionHeaders = {},
      ...requestOptions
    } = options;
    const url = `${CONFIG.API_URL}${endpoint}`;
    const headers = {
      "Content-Type": "application/json",
      ...optionHeaders,
    };

    if (authMode !== "omit" && State.apiKey) {
      headers["Authorization"] = `Bearer ${State.apiKey}`;
    }

    try {
      const response = await fetch(url, {
        ...requestOptions,
        credentials: "same-origin",
        headers,
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const error = new Error(
          data?.error || data?.message || `HTTP ${response.status}`,
        );
        error.code = data?.code || null;
        error.status = response.status;
        error.data = data;
        throw error;
      }

      return data;
    } catch (error) {
      console.error("API Error:", error);
      throw error;
    }
  },

  // Auth endpoints
  auth: {
    async me(options = {}) {
      return API.request("/auth/me", options);
    },

    async logout(options = {}) {
      return API.request("/auth/logout", {
        method: "POST",
        ...options,
      });
    },

    browserLogin: {
      async start(username) {
        return API.request("/auth/browser-login/attempts", {
          method: "POST",
          body: JSON.stringify({ username }),
        });
      },

      async status(attemptId, browserToken) {
        return API.request(`/auth/browser-login/attempts/${attemptId}`, {
          headers: {
            [BROWSER_LOGIN_TOKEN_HEADER]: browserToken,
          },
        });
      },

      async redeem(attemptId, browserToken) {
        return API.request(`/auth/browser-login/attempts/${attemptId}/redeem`, {
          method: "POST",
          headers: {
            [BROWSER_LOGIN_TOKEN_HEADER]: browserToken,
          },
        });
      },
    },

    async rotateKey() {
      return API.request("/auth/rotate-key", { method: "POST" });
    },
  },

  // Waitlist endpoint
  waitlist: {
    async join(email) {
      return API.request("/waitlist", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
    },
  },

  // Agent endpoints
  agents: {
    async list() {
      return API.request("/agents");
    },

    async register(agent) {
      return API.request("/agents", {
        method: "POST",
        body: JSON.stringify(agent),
      });
    },

    async delete(id) {
      return API.request(`/agents/${id}`, { method: "DELETE" });
    },

    async ping(id) {
      return API.request(`/agents/${id}/ping`, { method: "POST" });
    },
  },

  // Friend endpoints
  friends: {
    async list(status = "accepted") {
      return API.request(`/friends?status=${status}`);
    },

    async request(username) {
      return API.request("/friends/request", {
        method: "POST",
        body: JSON.stringify({ username }),
      });
    },

    async accept(id) {
      return API.request(`/friends/${id}/accept`, { method: "POST" });
    },

    async reject(id) {
      return API.request(`/friends/${id}/reject`, { method: "POST" });
    },

    async block(id) {
      return API.request(`/friends/${id}/block`, { method: "POST" });
    },

    async unfriend(id) {
      return API.request(`/friends/${id}`, { method: "DELETE" });
    },

    async addRole(id, role) {
      return API.request(`/friends/${id}/roles`, {
        method: "POST",
        body: JSON.stringify({ role }),
      });
    },

    async removeRole(id, roleName) {
      return API.request(
        `/friends/${id}/roles/${encodeURIComponent(roleName)}`,
        {
          method: "DELETE",
        },
      );
    },
  },

  roles: {
    async list(type) {
      const params = new URLSearchParams();
      if (type) {
        params.append("type", type);
      }

      const query = params.toString();
      return API.request(`/roles${query ? `?${query}` : ""}`);
    },
  },

  // Group endpoints
  groups: {
    async list() {
      return API.request("/groups");
    },

    async create(group) {
      return API.request("/groups", {
        method: "POST",
        body: JSON.stringify(group),
      });
    },

    async get(id) {
      return API.request(`/groups/${id}`);
    },

    async invite(id, username) {
      return API.request(`/groups/${id}/invite`, {
        method: "POST",
        body: JSON.stringify({ username }),
      });
    },

    async join(id) {
      return API.request(`/groups/${id}/join`, { method: "POST" });
    },

    async leave(id) {
      return API.request(`/groups/${id}/leave`, { method: "DELETE" });
    },

    async members(id) {
      return API.request(`/groups/${id}/members`);
    },
  },

  // Message endpoints
  messages: {
    async list(options = {}) {
      const params = new URLSearchParams();
      if (options.limit) params.append("limit", options.limit);
      if (options.direction) params.append("direction", options.direction);
      if (options.since) params.append("since", options.since);
      return API.request(`/messages?${params}`);
    },

    async send(message) {
      return API.request("/messages/send", {
        method: "POST",
        body: JSON.stringify(message),
      });
    },
  },

  // Policy endpoints
  policies: {
    async list(scope) {
      const url = scope ? `/policies?scope=${scope}` : "/policies";
      return API.request(url);
    },

    async create(policy) {
      return API.request("/policies", {
        method: "POST",
        body: JSON.stringify(policy),
      });
    },

    async update(id, updates) {
      return API.request(`/policies/${id}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      });
    },

    async delete(id) {
      return API.request(`/policies/${id}`, { method: "DELETE" });
    },

    async provenance(id) {
      return API.request(`/policies/audit/provenance/${id}`);
    },
  },

  // Preferences endpoints
  preferences: {
    async get() {
      return API.request("/preferences");
    },

    async update(prefs) {
      return API.request("/preferences", {
        method: "PATCH",
        body: JSON.stringify(prefs),
      });
    },
  },

  // Contact endpoints
  contacts: {
    async connections(username) {
      return API.request(`/contacts/${username}/connections`);
    },
  },

  // Plugin inspection endpoints
  plugin: {
    async reviews(options = {}) {
      const params = new URLSearchParams();
      if (options.status) params.append("status", options.status);
      if (options.direction) params.append("direction", options.direction);
      if (options.limit) params.append("limit", options.limit);
      const query = params.toString();
      return API.request(`/plugin/reviews${query ? `?${query}` : ""}`);
    },

    async blockedEvents(options = {}) {
      const params = new URLSearchParams();
      if (options.direction) params.append("direction", options.direction);
      if (options.limit) params.append("limit", options.limit);
      if (options.includePayloadExcerpt) {
        params.append("include_payload_excerpt", "true");
      }
      const query = params.toString();
      return API.request(`/plugin/events/blocked${query ? `?${query}` : ""}`);
    },

    async promotionSuggestions(options = {}) {
      const params = new URLSearchParams();
      if (options.minRepetitions) {
        params.append("min_repetitions", options.minRepetitions);
      }
      if (options.lookbackDays) {
        params.append("lookback_days", options.lookbackDays);
      }
      if (options.limit) {
        params.append("limit", options.limit);
      }
      const query = params.toString();
      return API.request(
        `/plugin/suggestions/promotions${query ? `?${query}` : ""}`,
      );
    },
  },
};

// ========================================
// Data Normalization
// ========================================
const Helpers = {
  isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  },

  record(value) {
    return this.isObject(value) ? value : {};
  },

  collection(value, keys = []) {
    if (Array.isArray(value)) {
      return value;
    }

    const record = this.record(value);
    for (const key of keys) {
      if (Array.isArray(record[key])) {
        return record[key];
      }
    }

    return [];
  },

  jsonRecord(value) {
    if (this.isObject(value)) {
      return value;
    }

    if (typeof value !== "string") {
      return {};
    }

    try {
      return this.record(JSON.parse(value));
    } catch {
      return {};
    }
  },

  jsonValue(value) {
    if (value == null) {
      return null;
    }

    if (this.isObject(value) || Array.isArray(value)) {
      return value;
    }

    if (typeof value !== "string") {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  },

  nullableString(value) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length ? trimmed : null;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }

    return null;
  },

  participantLabel(value) {
    if (this.isObject(value)) {
      return (
        this.nullableString(
          value.username ??
            value.user_id ??
            value.display_name ??
            value.displayName ??
            value.name ??
            value.id ??
            value.connection_id,
        ) || null
      );
    }

    return this.nullableString(value);
  },

  participantType(value) {
    return this.isObject(value) ? this.nullableString(value.type) : null;
  },

  recipientLabel(value, recipientType = "user") {
    if (recipientType === "group") {
      if (typeof value === "string") {
        return this.nullableString(value);
      }

      if (this.isObject(value)) {
        return this.nullableString(value.name ?? value.label);
      }

      return null;
    }

    return this.participantLabel(value);
  },

  auditSenderLabel(item) {
    return this.nullableString(item?.sender) || "Unknown sender";
  },

  auditRecipientLabel(item) {
    if (item?.recipientType === "group") {
      const groupId = this.nullableString(item?.recipientId);
      const group = groupId ? State.groupsById.get(groupId) : null;
      return (
        this.nullableString(group?.name ?? group?.displayName) ||
        this.nullableString(item?.recipient) ||
        "Group conversation"
      );
    }

    return this.nullableString(item?.recipient) || "Unknown recipient";
  },

  string(value, fallback = "") {
    return this.nullableString(value) ?? fallback;
  },

  number(value, fallback = 0) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return fallback;
  },

  connectionMode(value) {
    const callbackUrl = this.nullableString(value);

    if (!callbackUrl) {
      return null;
    }

    return callbackUrl.startsWith("polling://") ? "polling" : "webhook";
  },

  connectionModeLabel(value, fallback = "Unknown") {
    const mode = this.nullableString(value);
    if (!mode) {
      return fallback;
    }

    switch (mode) {
      case "polling":
        return "Polling";
      case "webhook":
        return "Webhook";
      default:
        return this.titleizeToken(mode, fallback);
    }
  },

  stringList(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.map((item) => this.nullableString(item)).filter(Boolean);
  },

  iso(value) {
    const raw =
      value instanceof Date
        ? value.toISOString()
        : typeof value === "string"
          ? value
          : null;

    if (!raw) {
      return null;
    }

    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  },

  contentText(value) {
    if (value == null) {
      return "";
    }

    if (typeof value === "string") {
      return value;
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  },

  escapeHtml(value) {
    return this.string(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  },

  truncate(value, limit = 120) {
    const text = this.string(value);
    return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
  },

  maskSecret(value, prefixLength = 18, suffixLength = 8) {
    const text = this.string(value);
    if (!text) {
      return "Unavailable";
    }

    if (text.length <= prefixLength + suffixLength + 3) {
      return text;
    }

    return `${text.slice(0, prefixLength)}...${text.slice(-suffixLength)}`;
  },

  pluralize(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
  },

  titleizeToken(value, fallback = "None yet") {
    const token = this.nullableString(value);
    if (!token) {
      return fallback;
    }

    return token
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  },

  labelList(values, limit = 3) {
    const labels = Array.from(
      new Set(
        (Array.isArray(values) ? values : [])
          .map((value) => this.nullableString(value))
          .filter(Boolean),
      ),
    );

    if (!labels.length) {
      return "None yet";
    }

    if (labels.length <= limit) {
      return labels.join(", ");
    }

    return `${labels.slice(0, limit).join(", ")} +${labels.length - limit} more`;
  },

  auditParticipantKey(label, id = null) {
    return this.nullableString(id) || this.string(label).trim().toLowerCase();
  },

  normalizeAskAroundReplyOutcome(value) {
    const normalized = this
      .string(value)
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

    if (normalized === "i_dont_know") {
      return "no_grounded_answer";
    }

    if (
      normalized === "direct_reply" ||
      normalized === "no_grounded_answer" ||
      normalized === "attribution_unverified"
    ) {
      return normalized;
    }

    return null;
  },

  groupFanoutRecipients(value) {
    const record = this.record(value);
    return (Array.isArray(record.recipients) ? record.recipients : [])
      .map((entry) => {
        const recipient = this.record(entry);
        const label =
          this.nullableString(
            recipient.recipient_username ?? recipient.recipient,
          ) || this.nullableString(recipient.recipient_user_id);

        if (!label) {
          return null;
        }

        return {
          decision: this.nullableString(recipient.decision),
          deliveryStatus: this.nullableString(recipient.delivery_status),
          label,
          reason: this.nullableString(recipient.reason),
          reasonCode: this.nullableString(recipient.reason_code),
          userId: this.nullableString(recipient.recipient_user_id),
        };
      })
      .filter(Boolean);
  },

  askAroundReplyOutcomeLabel(value, fallback = "Reply received") {
    const normalized = this.normalizeAskAroundReplyOutcome(value);

    switch (normalized) {
      case "direct_reply":
        return "Reply received";
      case "no_grounded_answer":
        return "No grounded answer";
      case "attribution_unverified":
        return "Unverified reply";
      default:
        return fallback;
    }
  },

  logStatusLabel(value, fallback = "Pending") {
    const normalized = this.string(value).toLowerCase();

    switch (normalized) {
      case "review_required":
        return "Review required";
      case "approval_pending":
        return "Approval pending";
      case "hold_for_approval":
        return "Hold for approval";
      case "rejected":
        return "Blocked";
      case "delivered":
      case "full_send":
        return "Delivered";
      case "failed":
      case "send_failed":
        return "Failed";
      case "pending":
        return "Pending";
      default:
        return this.titleizeToken(value, fallback);
    }
  },

  selectorTokens(selectors) {
    const record = this.record(selectors);

    return [
      this.nullableString(record.direction)
        ? this.titleizeToken(record.direction, record.direction)
        : null,
      this.nullableString(record.resource) || "message.general",
      this.nullableString(record.action) || "share",
    ].filter(Boolean);
  },

  selectorSummary(selectors) {
    return this.selectorTokens(selectors).join(" / ");
  },

  formatShortDate(value, fallback = "Unknown date") {
    const timestamp = this.timestampValue(value);
    if (!timestamp) {
      return fallback;
    }

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(timestamp));
  },

  formatDateTime(value, fallback = "Unknown time") {
    const timestamp = this.timestampValue(value);
    if (!timestamp) {
      return fallback;
    }

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    }).format(new Date(timestamp));
  },

  timestampValue(value) {
    if (!value) {
      return 0;
    }

    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  },

  compareByTimestampDesc(left, right) {
    return (
      this.timestampValue(right.timestamp || right.createdAt) -
      this.timestampValue(left.timestamp || left.createdAt)
    );
  },

  compareByTimestampAsc(left, right) {
    return (
      this.timestampValue(left.timestamp || left.createdAt) -
      this.timestampValue(right.timestamp || right.createdAt)
    );
  },

  collectionModel(items, getId = (item) => item?.id) {
    const byId = new Map();
    const ids = [];

    items.forEach((item) => {
      const id = this.nullableString(getId(item));
      if (!id) {
        return;
      }

      if (!byId.has(id)) {
        ids.push(id);
      }

      byId.set(id, item);
    });

    return {
      ids,
      byId,
      items: ids.map((id) => byId.get(id)).filter(Boolean),
    };
  },

  mergeCollectionModels(models, getId = (item) => item?.id) {
    return this.collectionModel(
      models.flatMap((model) =>
        Array.isArray(model?.items) ? model.items : [],
      ),
      getId,
    );
  },

  applyCollectionState(stateKey, indexKey, model) {
    State[stateKey] = Array.isArray(model?.items) ? model.items : [];
    State[indexKey] = model?.byId instanceof Map ? model.byId : new Map();

    if (
      stateKey === "messages" ||
      stateKey === "reviews" ||
      stateKey === "blockedEvents"
    ) {
      this.rebuildAuditLog();
    }
  },

  isInternalIdentifier(value) {
    return /^(usr|grp|fr|pol|msg|conn|rev)_[a-z0-9]/i.test(
      this.string(value).trim(),
    );
  },

  policySourceLabel(value) {
    const source = this.string(value).toLowerCase();

    switch (source) {
      case "default":
        return "Default";
      case "learned":
        return "Learned";
      case "user_confirmed":
        return "User confirmed";
      case "override":
        return "Override";
      case "user_created":
        return "User created";
      case "legacy_migrated":
        return "Legacy import";
      default:
        return this.titleizeToken(value, "Unknown source");
    }
  },

  resolvePolicyTargetLabel(policy) {
    const scope = this.string(policy?.scope, "global");
    const targetId = this.nullableString(policy?.targetId);

    if (!targetId) {
      return null;
    }

    if (scope === "user") {
      const match = State.friends.find((friend) => {
        return (
          friend?.userId === targetId ||
          friend?.username === targetId ||
          friend?.friendshipId === targetId
        );
      });
      return match?.displayName || match?.username || null;
    }

    if (scope === "group") {
      const target = this.string(targetId).toLowerCase();
      const match = State.groups.find((group) => {
        return (
          group?.id === targetId ||
          this.string(group?.name).toLowerCase() === target
        );
      });
      return match?.name || null;
    }

    if (scope === "role") {
      return this.titleizeToken(targetId, targetId);
    }

    return null;
  },

  policyAudienceDisplay(policy) {
    const scope = this.string(policy?.scope, "global");
    const audience = policy?.boundary?.audience || {};
    const resolvedTargetLabel =
      this.resolvePolicyTargetLabel(policy) || audience.targetLabel;

    if (scope === "global") {
      return audience.displayLabel || "Anyone on Mahilo";
    }

    if (scope === "user") {
      return resolvedTargetLabel
        ? `Contact: ${resolvedTargetLabel}`
        : audience.displayLabel || "Specific contact";
    }

    if (scope === "role") {
      return resolvedTargetLabel
        ? `Role: ${resolvedTargetLabel}`
        : audience.displayLabel || "Trust role";
    }

    if (scope === "group") {
      return resolvedTargetLabel
        ? `Group: ${resolvedTargetLabel}`
        : audience.displayLabel || "Group conversation";
    }

    return audience.displayLabel || this.titleizeToken(scope, "Audience");
  },

  normalizeTransportDirection(record, currentUsername) {
    const sender = this.participantLabel(record.sender);
    const recipient = this.participantLabel(record.recipient);
    const queueDirection = this.nullableString(record.queue_direction);
    const normalizedCurrentUser = currentUsername?.toLowerCase() || null;

    if (queueDirection === "outbound") {
      return "sent";
    }

    if (queueDirection === "inbound") {
      return "received";
    }

    if (
      normalizedCurrentUser &&
      sender?.toLowerCase() === normalizedCurrentUser
    ) {
      return "sent";
    }

    if (
      normalizedCurrentUser &&
      recipient?.toLowerCase() === normalizedCurrentUser
    ) {
      return "received";
    }

    if (sender && !recipient) {
      return "received";
    }

    if (recipient && !sender) {
      return "sent";
    }

    return "sent";
  },

  buildConversations(messages) {
    const threads = new Map();

    messages
      .filter((message) => message.kind === "message" && message.counterpart)
      .slice()
      .sort((left, right) => this.compareByTimestampAsc(left, right))
      .forEach((message) => {
        const thread = threads.get(message.counterpart) || [];
        thread.push({
          id: message.id,
          message: message.messageText,
          previewText: message.previewText,
          timestamp: message.timestamp,
          sent: message.isSent,
          status: message.status,
          sender: message.sender,
          recipient: message.recipient,
          recipientType: message.recipientType,
          counterpartLabel: message.counterpartLabel,
        });
        threads.set(message.counterpart, thread);
      });

    return threads;
  },

  rebuildConversations() {
    State.conversations = this.buildConversations(State.messages);
  },

  upsertMessage(message) {
    if (!message) {
      return;
    }

    const existing = State.messagesById.get(message.id) || null;
    State.messagesById.set(
      message.id,
      existing
        ? {
            ...existing,
            ...message,
          }
        : message,
    );

    State.messages = Array.from(State.messagesById.values()).sort(
      (left, right) => this.compareByTimestampDesc(left, right),
    );
    this.rebuildConversations();
    this.rebuildAuditLog();
  },

  normalizeLogDirectionFilter(value) {
    const normalized = this.string(value, "all").toLowerCase();

    switch (normalized) {
      case "sent":
      case "outbound":
        return "sent";
      case "received":
      case "inbound":
        return "received";
      default:
        return "all";
    }
  },

  normalizeLogStateFilter(value) {
    const normalized = this.string(value, "all").toLowerCase();

    switch (normalized) {
      case "review":
      case "review_required":
      case "approval_pending":
        return "review";
      case "blocked":
      case "rejected":
        return "blocked";
      case "delivered":
      case "full_send":
        return "delivered";
      case "failed":
        return "failed";
      case "pending":
        return "pending";
      default:
        return "all";
    }
  },

  logStateFromStatus(value) {
    const normalized = this.string(value).toLowerCase();

    switch (normalized) {
      case "review_required":
      case "approval_pending":
      case "hold_for_approval":
        return "review";
      case "blocked":
      case "rejected":
        return "blocked";
      case "delivered":
      case "full_send":
        return "delivered";
      case "failed":
      case "send_failed":
        return "failed";
      default:
        return normalized ? "pending" : "pending";
    }
  },

  latestTimestamp(values, fallback = null) {
    let nextTimestamp = 0;

    values.forEach((value) => {
      nextTimestamp = Math.max(nextTimestamp, this.timestampValue(value));
    });

    if (nextTimestamp > 0) {
      return new Date(nextTimestamp).toISOString();
    }

    return fallback;
  },

  mergeSelectors(...selectorCandidates) {
    const selector = {
      direction: null,
      resource: null,
      action: null,
    };

    selectorCandidates.forEach((candidate) => {
      const record = this.record(candidate);

      selector.direction =
        selector.direction || this.nullableString(record.direction);
      selector.resource =
        selector.resource || this.nullableString(record.resource);
      selector.action = selector.action || this.nullableString(record.action);
    });

    return selector;
  },

  buildAuditEntry({ message = null, review = null, blockedEvent = null }) {
    const primaryMessageId =
      this.nullableString(message?.messageId ?? message?.id) ||
      this.nullableString(review?.messageId) ||
      this.nullableString(blockedEvent?.messageId) ||
      this.nullableString(review?.reviewId) ||
      this.nullableString(blockedEvent?.blockedEventId) ||
      `log_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const primaryTimestamp = this.latestTimestamp(
      [
        blockedEvent?.timestamp,
        review?.timestamp,
        message?.timestamp,
        message?.deliveredAt,
      ],
      new Date().toISOString(),
    );
    const auditState = blockedEvent
      ? "blocked"
      : review
        ? "review"
        : this.logStateFromStatus(
            message?.deliveryStatus || message?.status || null,
          );
    const mergedSelectors = this.mergeSelectors(
      blockedEvent?.selectors,
      review?.selectors,
      message?.selectors,
      message?.classifiedSelectors,
    );
    const transportDirection =
      blockedEvent?.transportDirection ||
      review?.transportDirection ||
      message?.transportDirection ||
      "sent";
    const recipientType =
      blockedEvent?.recipientType ||
      review?.recipientType ||
      message?.recipientType;
    const sourceKinds = [
      message ? "message" : null,
      review ? "review" : null,
      blockedEvent ? "blocked" : null,
    ].filter(Boolean);
    const reviewAudit = this.record(review?.audit);
    const blockedAudit = this.record(blockedEvent?.audit);
    const mergedAudit =
      blockedEvent && Object.keys(blockedAudit).length
        ? blockedAudit
        : review && Object.keys(reviewAudit).length
          ? reviewAudit
          : this.record(message?.policyAudit);

    return {
      kind:
        auditState === "review"
          ? "review"
          : auditState === "blocked"
            ? "blocked"
            : "message",
      id: primaryMessageId,
      messageId: this.nullableString(message?.messageId ?? primaryMessageId),
      reviewId: this.nullableString(review?.reviewId),
      blockedEventId: this.nullableString(blockedEvent?.blockedEventId),
      auditState,
      status:
        this.nullableString(blockedEvent?.status) ||
        this.nullableString(review?.status) ||
        this.string(message?.status, auditState),
      transportDirection,
      sender:
        blockedEvent?.sender ||
        review?.sender ||
        message?.sender ||
        "Unknown sender",
      senderId:
        this.nullableString(blockedEvent?.senderId) ||
        this.nullableString(review?.senderId) ||
        this.nullableString(message?.senderId),
      senderAgent:
        this.nullableString(review?.senderAgent) ||
        this.nullableString(message?.senderAgent),
      senderConnectionId:
        this.nullableString(review?.senderConnectionId) ||
        this.nullableString(message?.senderConnectionId),
      recipient:
        blockedEvent?.recipient ||
        review?.recipient ||
        message?.recipient ||
        "Unknown recipient",
      recipientId:
        this.nullableString(blockedEvent?.recipientId) ||
        this.nullableString(review?.recipientId) ||
        this.nullableString(message?.recipientId),
      recipientType: recipientType || "user",
      recipientConnectionId:
        this.nullableString(review?.recipientConnectionId) ||
        this.nullableString(message?.recipientConnectionId),
      counterpart:
        message?.counterpart ||
        (transportDirection === "sent"
          ? blockedEvent?.recipient || review?.recipient || null
          : blockedEvent?.sender || review?.sender || null),
      counterpartLabel:
        message?.counterpartLabel ||
        (transportDirection === "sent"
          ? blockedEvent?.recipient || review?.recipient || "Unknown recipient"
          : blockedEvent?.sender || review?.sender || "Unknown sender"),
      timestamp: primaryTimestamp,
      createdAt: primaryTimestamp,
      deliveredAt: this.nullableString(message?.deliveredAt),
      correlationId:
        this.nullableString(review?.correlationId) ||
        this.nullableString(blockedEvent?.correlationId) ||
        this.nullableString(message?.correlationId),
      inResponseTo:
        this.nullableString(review?.inResponseTo) ||
        this.nullableString(blockedEvent?.inResponseTo) ||
        this.nullableString(message?.inResponseTo),
      selectors: mergedSelectors,
      messageSelectors: message?.selectors || null,
      reviewSelectors: review?.selectors || null,
      blockedSelectors: blockedEvent?.selectors || null,
      messageText:
        message?.messageText ||
        review?.messagePreview ||
        blockedEvent?.storedPayloadExcerpt ||
        "",
      previewText:
        message?.previewText ||
        review?.messagePreview ||
        blockedEvent?.storedPayloadExcerpt ||
        "",
      context:
        message?.context ||
        review?.contextPreview ||
        blockedEvent?.storedPayloadExcerpt ||
        "",
      messageReasonCode: this.nullableString(message?.reasonCode),
      reviewReasonCode: this.nullableString(review?.reasonCode),
      blockedReasonCode: this.nullableString(blockedEvent?.reasonCode),
      reasonCode:
        this.nullableString(blockedEvent?.reasonCode) ||
        this.nullableString(review?.reasonCode) ||
        this.nullableString(message?.reasonCode),
      resolverLayer:
        this.nullableString(blockedAudit.resolver_layer) ||
        this.nullableString(reviewAudit.resolver_layer) ||
        this.nullableString(message?.resolverLayer),
      winningPolicyId:
        this.nullableString(blockedAudit.winning_policy_id) ||
        this.nullableString(reviewAudit.winning_policy_id) ||
        this.nullableString(message?.winningPolicyId),
      matchedPolicyIds: this.stringList(
        blockedAudit.matched_policy_ids ??
          reviewAudit.matched_policy_ids ??
          message?.matchedPolicyIds,
      ),
      evaluatedPolicyCount: Array.isArray(mergedAudit.evaluated_policies)
        ? mergedAudit.evaluated_policies.length
        : Array.isArray(message?.matchedPolicyIds)
          ? message.matchedPolicyIds.length
          : 0,
      auditExplanation:
        this.nullableString(blockedAudit.resolution_explanation) ||
        this.nullableString(reviewAudit.resolution_explanation) ||
        this.nullableString(mergedAudit.resolution_explanation),
      decision:
        this.nullableString(review?.decision) ||
        this.nullableString(message?.decision) ||
        null,
      deliveryMode:
        this.nullableString(review?.deliveryMode) ||
        this.nullableString(message?.deliveryMode),
      summary:
        this.nullableString(blockedEvent?.reason) ||
        this.nullableString(review?.summary) ||
        this.nullableString(message?.previewText) ||
        null,
      reason: this.nullableString(blockedEvent?.reason),
      messagePreview:
        this.contentText(review?.messagePreview) ||
        this.contentText(message?.previewText),
      contextPreview: this.contentText(review?.contextPreview),
      storedPayloadExcerpt: this.contentText(
        blockedEvent?.storedPayloadExcerpt,
      ),
      payloadHash: this.nullableString(blockedEvent?.payloadHash),
      payloadType:
        this.nullableString(review?.payloadType) ||
        this.nullableString(message?.payloadType),
      replyOutcome: this.normalizeAskAroundReplyOutcome(message?.replyOutcome),
      fanoutRecipients: this.groupFanoutRecipients(message?.policyAudit),
      messageTimestamp: this.nullableString(message?.timestamp),
      reviewTimestamp: this.nullableString(review?.timestamp),
      blockedTimestamp: this.nullableString(blockedEvent?.timestamp),
      sourceKinds,
      sourceIds: {
        blockedEventId: this.nullableString(blockedEvent?.blockedEventId),
        messageId: this.nullableString(message?.messageId ?? message?.id),
        reviewId: this.nullableString(review?.reviewId),
      },
      audit: mergedAudit,
      raw: {
        blockedEvent: blockedEvent?.raw || null,
        message: message?.raw || null,
        review: review?.raw || null,
      },
    };
  },

  auditLogModel(messages = [], reviews = [], blockedEvents = []) {
    const auditItems = [];
    const messagesById = new Map();
    const reviewsByMessageId = new Map();
    const blockedByMessageId = new Map();
    const consumedReviewIds = new Set();
    const consumedBlockedIds = new Set();

    messages.forEach((message) => {
      const messageId = this.nullableString(message?.messageId ?? message?.id);
      if (messageId) {
        messagesById.set(messageId, message);
      }
    });

    reviews.forEach((review) => {
      const reviewId = this.nullableString(review?.reviewId);
      if (!reviewId) {
        return;
      }

      const key =
        this.nullableString(review?.messageId) || `review:${reviewId}`;
      const existing = reviewsByMessageId.get(key);

      if (!existing || this.compareByTimestampDesc(review, existing) < 0) {
        reviewsByMessageId.set(key, review);
      }
    });

    blockedEvents.forEach((blockedEvent) => {
      const blockedEventId = this.nullableString(blockedEvent?.blockedEventId);
      if (!blockedEventId) {
        return;
      }

      const key =
        this.nullableString(blockedEvent?.messageId) ||
        `blocked:${blockedEventId}`;
      const existing = blockedByMessageId.get(key);

      if (
        !existing ||
        this.compareByTimestampDesc(blockedEvent, existing) < 0
      ) {
        blockedByMessageId.set(key, blockedEvent);
      }
    });

    messages.forEach((message) => {
      const messageId = this.nullableString(message?.messageId ?? message?.id);
      const review = messageId
        ? reviewsByMessageId.get(messageId) || null
        : null;
      const blockedEvent = messageId
        ? blockedByMessageId.get(messageId) || null
        : null;

      if (review?.reviewId) {
        consumedReviewIds.add(review.reviewId);
      }

      if (blockedEvent?.blockedEventId) {
        consumedBlockedIds.add(blockedEvent.blockedEventId);
      }

      auditItems.push(
        this.buildAuditEntry({
          blockedEvent,
          message,
          review,
        }),
      );
    });

    reviews.forEach((review) => {
      if (review?.reviewId && consumedReviewIds.has(review.reviewId)) {
        return;
      }

      const message =
        messagesById.get(this.nullableString(review?.messageId) || "") || null;

      auditItems.push(
        this.buildAuditEntry({
          message,
          review,
        }),
      );
    });

    blockedEvents.forEach((blockedEvent) => {
      if (
        blockedEvent?.blockedEventId &&
        consumedBlockedIds.has(blockedEvent.blockedEventId)
      ) {
        return;
      }

      const message =
        messagesById.get(this.nullableString(blockedEvent?.messageId) || "") ||
        null;

      auditItems.push(
        this.buildAuditEntry({
          blockedEvent,
          message,
        }),
      );
    });

    const threadSummary = this.askAroundThreadSummary(auditItems);
    const model = this.collectionModel(
      auditItems
        .map((item) => ({
          ...item,
          askAroundTag: this.askAroundTag(item, threadSummary),
          correlationCount: item.correlationId
            ? threadSummary.correlationCounts.get(item.correlationId) || 1
            : 0,
        }))
        .sort((left, right) => this.compareByTimestampDesc(left, right)),
      (item) => item.id,
    );

    return {
      ...model,
      threadSummary,
    };
  },

  rebuildAuditLog() {
    const auditModel = this.auditLogModel(
      State.messages,
      State.reviews,
      State.blockedEvents,
    );
    State.auditLog = auditModel.items;
    State.auditLogById = auditModel.byId;
  },

  filterAuditLog(items, filters = {}) {
    const record =
      typeof filters === "string"
        ? { direction: filters }
        : this.record(filters);
    const direction = this.normalizeLogDirectionFilter(record.direction);
    const state = this.normalizeLogStateFilter(record.state);

    return items
      .filter((item) => {
        if (direction !== "all" && item.transportDirection !== direction) {
          return false;
        }

        if (state !== "all" && item.auditState !== state) {
          return false;
        }

        return true;
      })
      .sort((left, right) => this.compareByTimestampDesc(left, right));
  },

  logFeed(messages, reviews, blockedEvents, filters = {}) {
    return this.filterAuditLog(
      this.auditLogModel(messages, reviews, blockedEvents).items,
      filters,
    );
  },

  askAroundThreadId(item) {
    if (!item) {
      return null;
    }

    if (item.correlationId) {
      return item.correlationId;
    }

    if (
      item.transportDirection === "sent" &&
      item.recipientType === "group"
    ) {
      return `group:${item.messageId || item.id}`;
    }

    return null;
  },

  askAroundParticipantKey(value) {
    const normalized = this.nullableString(value);
    return normalized ? normalized.replace(/^@+/, "").toLowerCase() : null;
  },

  normalizeAskAroundOutcomeToken(value) {
    const token = this.nullableString(value);
    return token ? token.toLowerCase().replace(/[\s-]+/g, "_") : null;
  },

  isExplicitNoGroundedAnswer(value) {
    const normalized = this.string(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

    return [
      "i dont know",
      "i do not know",
      "no grounded answer",
      "no grounded answer available",
      "i do not have a grounded answer",
    ].includes(normalized);
  },

  readAskAroundReplyPayload(item) {
    if (
      !item ||
      item.kind !== "message" ||
      item.transportDirection !== "received"
    ) {
      return null;
    }

    const rawText = this.string(item.messageText || item.previewText);
    const payloadType = this.string(item.payloadType).toLowerCase();
    let parsed = this.isObject(item.parsedPayload) ? item.parsedPayload : null;
    let text = rawText || "(no content)";
    let context = this.nullableString(item.context);
    let outcome = this.normalizeAskAroundReplyOutcome(item.replyOutcome);

    if (!parsed && (rawText.trim().startsWith("{") || payloadType.includes("json"))) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = null;
      }
    }

    if (this.isObject(parsed)) {
      const candidates = [
        parsed.outcome,
        parsed.answer_status,
        parsed.answerStatus,
        parsed.kind,
        parsed.status,
      ];

      candidates.forEach((candidate) => {
        const normalized = this.normalizeAskAroundReplyOutcome(candidate);
        if (normalized === "no_grounded_answer") {
          outcome = "no_grounded_answer";
        } else if (normalized === "direct_reply") {
          outcome = outcome || "direct_reply";
        }
      });

      text =
        this.nullableString(
          parsed.message ??
            parsed.reply ??
            parsed.answer ??
            parsed.text ??
            parsed.body,
        ) || text;
      context =
        this.nullableString(
          parsed.context ??
            parsed.experience_context ??
            parsed.experienceContext,
        ) || context;
    }

    if (!outcome && this.isExplicitNoGroundedAnswer(text)) {
      outcome = "no_grounded_answer";
    }

    return {
      context,
      outcome: outcome || "direct_reply",
      text,
    };
  },

  askAroundTargetSendState(value) {
    const normalized = this.string(value).toLowerCase();

    switch (normalized) {
      case "approval_pending":
        return "approval_pending";
      case "review_required":
      case "hold_for_approval":
        return "review_required";
      case "rejected":
      case "blocked":
        return "blocked";
      case "failed":
      case "send_failed":
        return "failed";
      default:
        return "asked";
    }
  },

  askAroundTargetFinalState(target) {
    if (!target) {
      return "no_reply";
    }

    if (target.replyOutcome === "no_grounded_answer") {
      return "no_grounded_answer";
    }

    if (target.replyOutcome === "direct_reply") {
      return "replied";
    }

    switch (target.askState) {
      case "approval_pending":
        return "approval_pending";
      case "review_required":
        return "review_required";
      case "blocked":
        return "blocked";
      case "failed":
        return "failed";
      default:
        return "no_reply";
    }
  },

  buildAskAroundThread(items, threadId) {
    const sortedItems = (Array.isArray(items) ? [...items] : []).sort(
      (left, right) => this.compareByTimestampAsc(left, right),
    );
    const targetsByKey = new Map();
    const unattributedReplies = [];
    const itemIds = [];
    let correlationId = null;
    let groupLabel = null;
    let latestTimestamp = null;
    let questionPreview = null;
    let hasGroup = false;

    sortedItems.forEach((item) => {
      itemIds.push(item.id);
      correlationId = correlationId || this.nullableString(item.correlationId);
      if (
        this.timestampValue(item.timestamp) >
        this.timestampValue(latestTimestamp)
      ) {
        latestTimestamp = item.timestamp;
      }

      if (
        !questionPreview &&
        item.transportDirection === "sent" &&
        this.nullableString(item.messageText)
      ) {
        questionPreview = this.string(item.messageText);
      }

      if (item.transportDirection !== "sent") {
        return;
      }

      const addTarget = (key, seed) => {
        const existing = targetsByKey.get(key) || {};
        targetsByKey.set(key, {
          ...existing,
          ...seed,
          key,
        });
      };

      if (item.recipientType === "group") {
        hasGroup = true;
        groupLabel = this.auditRecipientLabel(item) || groupLabel;
        const recipientAudits = Array.isArray(item.audit?.recipients)
          ? item.audit.recipients
          : [];

        if (!recipientAudits.length) {
          addTarget(
            this.askAroundParticipantKey(this.auditRecipientLabel(item)) ||
              threadId,
            {
              askState: this.askAroundTargetSendState(item.status),
              askTimestamp: item.timestamp,
              decision: item.decision,
              label: this.auditRecipientLabel(item),
              reason: this.nullableString(item.summary || item.reason),
              reasonCode: this.nullableString(item.reasonCode),
              readyAtAsk: null,
              recipientType: "group",
              sourceMessageId: item.messageId || item.id,
            },
          );
          return;
        }

        recipientAudits.forEach((recipientAudit) => {
          const label =
            this.nullableString(recipientAudit.recipient_username) ||
            this.nullableString(recipientAudit.recipient_user_id);
          const key =
            this.askAroundParticipantKey(label) ||
            this.askAroundParticipantKey(recipientAudit.recipient_user_id) ||
            `${threadId}:${targetsByKey.size}`;

          addTarget(key, {
            askState: this.askAroundTargetSendState(
              recipientAudit.delivery_status,
            ),
            askTimestamp: item.timestamp,
            decision: this.nullableString(recipientAudit.decision),
            groupLabel: this.auditRecipientLabel(item) || groupLabel,
            label: label || "Unknown member",
            reason: this.nullableString(recipientAudit.reason),
            reasonCode: this.nullableString(recipientAudit.reason_code),
            readyAtAsk:
              recipientAudit.delivery_status === "delivered" ||
              recipientAudit.delivery_status === "pending"
                ? true
                : recipientAudit.delivery_status === "failed"
                  ? false
                  : null,
            recipientType: "user",
            sourceMessageId: item.messageId || item.id,
          });
        });
        return;
      }

      const key =
        this.askAroundParticipantKey(this.auditRecipientLabel(item)) ||
        this.askAroundParticipantKey(item.recipientId) ||
        `${threadId}:${targetsByKey.size}`;

      addTarget(key, {
        askState: this.askAroundTargetSendState(item.status),
        askTimestamp: item.timestamp,
        decision: item.decision,
        label: this.auditRecipientLabel(item),
        reason: this.nullableString(item.summary || item.reason),
        reasonCode: this.nullableString(item.reasonCode),
        readyAtAsk:
          item.recipientConnectionId
            ? true
            : this.askAroundTargetSendState(item.status) === "asked"
              ? true
              : this.askAroundTargetSendState(item.status) === "failed"
                ? false
                : null,
        recipientType: item.recipientType || "user",
        sourceMessageId: item.messageId || item.id,
      });
    });

    sortedItems.forEach((item) => {
      const reply = this.readAskAroundReplyPayload(item);
      if (!reply) {
        return;
      }

      const key =
        this.askAroundParticipantKey(item.sender) ||
        this.askAroundParticipantKey(item.senderId) ||
        this.askAroundParticipantKey(item.senderConnectionId) ||
        `${threadId}:reply:${item.messageId || item.id}`;
      const target = targetsByKey.get(key) || null;
      const replySignal = {
        context: reply.context,
        inResponseTo: this.nullableString(item.inResponseTo),
        messageId: item.messageId || item.id,
        outcome: target ? reply.outcome : "attribution_unverified",
        preview: reply.text,
        sender: item.sender || "Unknown sender",
        senderAgent: this.nullableString(item.senderAgent),
        timestamp: item.timestamp,
      };

      if (!target) {
        unattributedReplies.push(replySignal);
        return;
      }

      targetsByKey.set(key, {
        ...target,
        replyContext: replySignal.context,
        replyInResponseTo: replySignal.inResponseTo,
        replyMessageId: replySignal.messageId,
        replyOutcome: reply.outcome,
        replyPreview: reply.text,
        replySenderAgent: replySignal.senderAgent,
        replyTimestamp: item.timestamp,
      });
    });

    const targets = [...targetsByKey.values()].sort((left, right) =>
      this.string(left.label).localeCompare(this.string(right.label)),
    );
    const outboundTargets = targets.filter(
      (target) => target.recipientType !== "group",
    );
    const replyParticipants = new Set(
      targets
        .filter((target) => Boolean(target.replyOutcome))
        .map((target) => target.key),
    );
    const isAskAround =
      hasGroup || outboundTargets.length > 1 || replyParticipants.size > 1;

    if (!isAskAround) {
      return null;
    }

    const counts = {
      approvalPending: 0,
      blocked: 0,
      failed: 0,
      noGrounded: 0,
      ready: 0,
      replied: 0,
      reviewRequired: 0,
      targets: targets.length,
      unattributedReplies: unattributedReplies.length,
      waiting: 0,
    };

    targets.forEach((target) => {
      if (target.readyAtAsk === true) {
        counts.ready += 1;
      }

      switch (this.askAroundTargetFinalState(target)) {
        case "replied":
          counts.replied += 1;
          break;
        case "no_grounded_answer":
          counts.noGrounded += 1;
          break;
        case "approval_pending":
          counts.approvalPending += 1;
          break;
        case "review_required":
          counts.reviewRequired += 1;
          break;
        case "blocked":
          counts.blocked += 1;
          break;
        case "failed":
          counts.failed += 1;
          break;
        default:
          counts.waiting += 1;
      }
    });

    return {
      correlationId,
      counts,
      groupLabel,
      id: threadId,
      isAskAround: true,
      itemIds,
      kind: hasGroup ? "group" : "fanout",
      latestTimestamp,
      questionPreview,
      targets,
      targetCount: targets.length,
      unattributedReplies,
    };
  },

  askAroundThread(item, threadSummary) {
    const threadId = this.askAroundThreadId(item);
    if (!threadId) {
      return null;
    }

    return threadSummary?.threadsById?.get(threadId) || null;
  },

  askAroundThreadSummary(items) {
    const correlationCounts = new Map();
    const threadIds = new Set();
    const itemsByThreadId = new Map();
    const threadsById = new Map();

    items.forEach((item) => {
      if (item.correlationId) {
        correlationCounts.set(
          item.correlationId,
          (correlationCounts.get(item.correlationId) || 0) + 1,
        );
      }

      const threadId = this.askAroundThreadId(item);
      if (!threadId) {
        return;
      }

      const existing = itemsByThreadId.get(threadId) || [];
      existing.push(item);
      itemsByThreadId.set(threadId, existing);
    });

    itemsByThreadId.forEach((threadItems, threadId) => {
      const thread = this.buildAskAroundThread(threadItems, threadId);
      if (!thread) {
        return;
      }

      threadIds.add(threadId);
      threadsById.set(threadId, thread);
    });

    const counts = {
      noGrounded: 0,
      replies: 0,
      threads: threadsById.size,
      unattributedReplies: 0,
      waiting: 0,
    };

    threadsById.forEach((thread) => {
      counts.replies += thread.counts.replied;
      counts.noGrounded += thread.counts.noGrounded;
      counts.waiting += thread.counts.waiting;
      counts.unattributedReplies += thread.counts.unattributedReplies;
    });

    return {
      counts,
      correlationCounts,
      threadIds,
      threadsById,
    };
  },

  formatLabelList(values, limit = 3) {
    const labels = [...new Set(this.stringList(values))];

    if (!labels.length) {
      return "";
    }

    if (labels.length <= limit) {
      return labels.join(", ");
    }

    return `${labels.slice(0, limit).join(", ")}, +${labels.length - limit} more`;
  },

  askAroundConstraintLabel(target) {
    const label = this.string(target?.label, "Unknown");
    const reason =
      this.askAroundTargetFinalState(target) === "approval_pending"
        ? "Approval pending"
        : this.askAroundTargetFinalState(target) === "review_required"
          ? "Review required"
          : this.askAroundTargetFinalState(target) === "blocked"
            ? "Blocked"
            : "Send failed";

    return `${label} (${reason})`;
  },

  askAroundOutcomeLines(thread) {
    if (!thread?.targets?.length) {
      return [];
    }

    return thread.targets.map((target) => {
      const label = this.string(target.label, "Unknown");
      const replyPreview = this.truncate(target.replyPreview, 120);

      switch (this.askAroundTargetFinalState(target)) {
        case "replied":
          return replyPreview
            ? `${label} replied: ${replyPreview}`
            : `${label} replied.`;
        case "no_grounded_answer":
          return replyPreview
            ? `${label} reported no grounded answer: ${replyPreview}`
            : `${label} reported no grounded answer.`;
        case "approval_pending":
          return `${label}: approval pending before this ask can go out.`;
        case "review_required":
          return `${label}: review required before this ask can go out.`;
        case "blocked":
          return `${label}: blocked by boundaries.`;
        case "failed":
          return `${label}: Mahilo could not route the ask.`;
        default:
          return `${label}: no reply yet.`;
      }
    });
  },

  askAroundReadinessLines(thread) {
    if (!thread?.targets?.length) {
      return [];
    }

    const readyTargets = thread.targets
      .filter((target) => target.readyAtAsk === true)
      .map((target) => target.label);
    const notReadyTargets = thread.targets
      .filter((target) => target.readyAtAsk === false)
      .map((target) => target.label);
    const constrainedTargets = thread.targets
      .filter((target) =>
        ["approval_pending", "review_required", "blocked"].includes(
          this.askAroundTargetFinalState(target),
        ),
      )
      .map((target) => this.askAroundConstraintLabel(target));
    const lines = [];

    if (readyTargets.length) {
      lines.push(
        `Ready when asked: ${this.formatLabelList(readyTargets, 4)}.`,
      );
    }

    if (notReadyTargets.length) {
      lines.push(
        `Not ready when asked: ${this.formatLabelList(notReadyTargets, 3)}.`,
      );
    }

    if (constrainedTargets.length) {
      lines.push(
        `Policy constrained: ${this.formatLabelList(constrainedTargets, 3)}.`,
      );
    }

    if (thread.unattributedReplies.length) {
      lines.push(
        `Unattributed replies: ${this.formatLabelList(
          thread.unattributedReplies.map((reply) => reply.sender),
          3,
        )}.`,
      );
    }

    return lines;
  },

  askAroundReplyContextLines(thread) {
    if (!thread?.targets?.length && !thread?.unattributedReplies?.length) {
      return [];
    }

    const lines = thread.targets
      .filter((target) => Boolean(target.replyOutcome))
      .sort((left, right) =>
        this.compareByTimestampAsc(
          { timestamp: left.replyTimestamp },
          { timestamp: right.replyTimestamp },
        ),
      )
      .map((target) => {
        const parts = [];

        if (target.replyContext) {
          parts.push(`context: ${target.replyContext}`);
        }

        if (target.replyInResponseTo) {
          parts.push(`reply to ${this.truncate(target.replyInResponseTo, 18)}`);
        }

        return parts.length
          ? `${target.label}: ${parts.join(" • ")}`
          : `${target.label}: direct reply recorded.`;
      });

    thread.unattributedReplies.forEach((reply) => {
      const parts = [];

      if (reply.context) {
        parts.push(`context: ${reply.context}`);
      }

      if (reply.inResponseTo) {
        parts.push(`reply to ${this.truncate(reply.inResponseTo, 18)}`);
      }

      lines.push(
        parts.length
          ? `${reply.sender}: ${parts.join(" • ")}`
          : `${reply.sender}: unattributed reply kept separate.`,
      );
    });

    return lines;
  },

  askAroundThreadSummaryLine(thread) {
    if (!thread) {
      return "Waiting on replies.";
    }

    const parts = [];

    if (thread.counts.replied) {
      parts.push(
        `${this.pluralize(thread.counts.replied, "reply")} attributed`,
      );
    }

    if (thread.counts.noGrounded) {
      parts.push(
        `${this.pluralize(thread.counts.noGrounded, "no-grounded answer", "no-grounded answers")}`,
      );
    }

    if (thread.counts.waiting) {
      parts.push(`${this.pluralize(thread.counts.waiting, "contact")} waiting`);
    }

    if (thread.counts.reviewRequired || thread.counts.approvalPending) {
      parts.push(
        `${thread.counts.reviewRequired + thread.counts.approvalPending} held for review`,
      );
    }

    if (thread.counts.blocked) {
      parts.push(`${this.pluralize(thread.counts.blocked, "contact")} blocked`);
    }

    if (thread.counts.failed) {
      parts.push(
        `${this.pluralize(thread.counts.failed, "contact")} not ready`,
      );
    }

    if (thread.counts.unattributedReplies) {
      parts.push(
        `${this.pluralize(thread.counts.unattributedReplies, "unattributed reply")}`,
      );
    }

    return parts.length ? parts.join(" • ") : "Waiting on replies.";
  },

  overviewActivityFeed(items = []) {
    const sortedItems = this.filterAuditLog(items);
    const threadSummary = this.askAroundThreadSummary(sortedItems);
    const seenThreadIds = new Set();
    const activities = [];

    sortedItems.forEach((item) => {
      const thread = this.askAroundThread(item, threadSummary);
      if (thread) {
        if (!seenThreadIds.has(thread.id)) {
          seenThreadIds.add(thread.id);
          activities.push({
            id: `ask:${thread.id}`,
            kind: "ask-around",
            thread,
            timestamp: thread.latestTimestamp,
          });
        }
        return;
      }

      activities.push({
        id: item.id,
        item,
        kind: "audit",
        timestamp: item.timestamp,
      });
    });

    return activities.sort((left, right) =>
      this.compareByTimestampDesc(left, right),
    );
  },

  auditCounts(items = []) {
    return (Array.isArray(items) ? items : []).reduce(
      (counts, item) => {
        if (item?.auditState === "delivered") {
          counts.delivered += 1;
        }

        if (item?.auditState === "review") {
          counts.review += 1;
          if (item?.status === "approval_pending") {
            counts.approvalPending += 1;
          } else {
            counts.reviewRequired += 1;
          }
        }

        if (item?.auditState === "blocked") {
          counts.blocked += 1;
        }

        return counts;
      },
      {
        delivered: 0,
        review: 0,
        reviewRequired: 0,
        approvalPending: 0,
        blocked: 0,
      },
    );
  },

  askAroundTag(item, threadSummary) {
    if (!item) {
      return null;
    }

    const thread = this.askAroundThread(item, threadSummary);
    if (!thread) {
      return null;
    }

    if (item.transportDirection === "received" && item.kind === "message") {
      const target = thread.targets.find(
        (candidate) => candidate.replyMessageId === (item.messageId || item.id),
      );
      if (target?.replyOutcome === "no_grounded_answer") {
        return "No grounded answer";
      }

      if (target?.replyOutcome === "direct_reply") {
        return "Attributed reply";
      }

      if (
        thread.unattributedReplies.some(
          (reply) => reply.messageId === (item.messageId || item.id),
        )
      ) {
        return "Unattributed reply";
      }
    }

    if (item.kind === "review") {
      return "Ask-around review";
    }

    if (item.kind === "blocked") {
      return "Ask blocked";
    }

    if (thread.kind === "group") {
      return thread.targetCount > 1
        ? `Ask-around group (${thread.targetCount})`
        : "Ask-around group";
    }

    return thread.targetCount > 1
      ? `Ask-around thread (${thread.targetCount})`
      : "Ask-around thread";
  },
};

const BOUNDARY_EFFECT_META = {
  allow: {
    badgeLabel: "Allow",
    label: "Allow sharing",
    description: "Mahilo can send matching content without stopping.",
    tone: "allow",
  },
  ask: {
    badgeLabel: "Ask",
    label: "Ask before sharing",
    description:
      "Mahilo should pause matching content for review before sending.",
    tone: "ask",
  },
  deny: {
    badgeLabel: "Deny",
    label: "Block sharing",
    description: "Mahilo should stop matching content from being sent.",
    tone: "deny",
  },
};

const BOUNDARY_EFFECT_ORDER = {
  deny: 0,
  ask: 1,
  allow: 2,
};

const BOUNDARY_SCOPE_ORDER = ["global", "user", "role", "group"];

const BOUNDARY_CATEGORY_ORDER = [
  "opinions",
  "availability",
  "location",
  "health",
  "financial",
  "contact",
  "generic",
  "advanced",
];

const BOUNDARY_SCOPE_META = {
  global: {
    filterLabel: "Global",
    scopeLabel: "Global",
    summary: "Applies across every conversation unless a narrower rule wins.",
    defaultDisplayLabel: "Anyone on Mahilo",
  },
  user: {
    filterLabel: "Contact",
    scopeLabel: "Contact",
    summary: "Applies only to one specific contact.",
    defaultDisplayLabel: "Specific contact",
  },
  role: {
    filterLabel: "Role",
    scopeLabel: "Role",
    summary: "Applies to contacts with a specific trust role.",
    defaultDisplayLabel: "Trust role",
  },
  group: {
    filterLabel: "Group",
    scopeLabel: "Group",
    summary: "Applies only when sending into a specific group.",
    defaultDisplayLabel: "Group conversation",
  },
};

const BOUNDARY_CATEGORY_META = {
  opinions: {
    description: "Recommendations, reviews, and other lived experience.",
    icon: "💬",
    label: "Opinions and recommendations",
    managementPath: "guided",
  },
  availability: {
    description: "Availability, event details, and schedule coordination.",
    icon: "🗓️",
    label: "Availability and schedule",
    managementPath: "guided",
  },
  location: {
    description: "Current location, whereabouts, and location history.",
    icon: "📍",
    label: "Location",
    managementPath: "guided",
  },
  health: {
    description: "Health summaries, wellness context, and medical details.",
    icon: "🩺",
    label: "Health details",
    managementPath: "guided",
  },
  financial: {
    description: "Balances, transactions, and other money-related details.",
    icon: "💳",
    label: "Financial details",
    managementPath: "guided",
  },
  contact: {
    description: "Email, phone, profile, and direct contact details.",
    icon: "📇",
    label: "Contact details",
    managementPath: "guided",
  },
  generic: {
    description:
      "General messages that do not map to a more specific boundary.",
    icon: "✉️",
    label: "Generic messages",
    managementPath: "guided",
  },
  advanced: {
    description:
      "Custom selector combinations stay visible here but use the advanced path.",
    icon: "🧩",
    label: "Advanced/custom boundary",
    managementPath: "advanced",
  },
};

const COMMON_BOUNDARY_PRESETS = {
  opinions: [
    {
      id: "opinions_recommend",
      label: "Recommendations and opinions",
      description:
        "Restaurant recs, product opinions, reviews, and lived experience.",
      resource: "message.general",
      action: "recommend",
    },
  ],
  availability: [
    {
      id: "availability_windows",
      label: "Availability windows",
      description:
        "Free/busy and availability signals without exposing full event details.",
      resource: "calendar.availability",
      action: "share",
    },
    {
      id: "availability_event_details",
      label: "Event details",
      description:
        "Specific calendar event titles, attendees, and schedule details.",
      resource: "calendar.event",
      action: "read_details",
    },
  ],
  location: [
    {
      id: "location_current",
      label: "Current location",
      description:
        "Current whereabouts, nearby context, or present location updates.",
      resource: "location.current",
      action: "share",
    },
    {
      id: "location_history",
      label: "Location history",
      description: "Recent places, travel history, and past location trails.",
      resource: "location.history",
      action: "share",
    },
  ],
  health: [
    {
      id: "health_summary",
      label: "Health summaries",
      description:
        "Wellness summaries, condition overviews, and medical context.",
      resource: "health.summary",
      action: "share",
    },
    {
      id: "health_metrics",
      label: "Health metrics",
      description:
        "Specific health readings such as heart rate, sleep, or vitals.",
      resource: "health.metric",
      action: "share",
    },
  ],
  financial: [
    {
      id: "financial_balance",
      label: "Balances",
      description: "Account balances, available funds, and money snapshots.",
      resource: "financial.balance",
      action: "share",
    },
    {
      id: "financial_transactions",
      label: "Transactions",
      description:
        "Payments, transactions, invoices, and money movement details.",
      resource: "financial.transaction",
      action: "share",
    },
  ],
  contact: [
    {
      id: "contact_profile",
      label: "Contact profile",
      description:
        "Basic profile details and general ways to identify or reach someone.",
      resource: "profile.basic",
      action: "share",
    },
    {
      id: "contact_email",
      label: "Email address",
      description: "Direct email details and related contact-sensitive data.",
      resource: "contact.email",
      action: "share",
    },
    {
      id: "contact_phone",
      label: "Phone number",
      description: "Phone numbers, SMS reachability, and direct call details.",
      resource: "contact.phone",
      action: "share",
    },
  ],
  generic: [
    {
      id: "generic_message",
      label: "Generic messages",
      description:
        "General outbound messages that do not map to a narrower category.",
      resource: "message.general",
      action: "share",
    },
  ],
};

const DEFAULT_BOUNDARY_CATEGORY = "generic";
const DEFAULT_BOUNDARY_EFFECT = "ask";
const PROMOTION_SUGGESTION_PRESET_ID = "__promotion_suggestion_selector__";

function listBoundaryPresetOptions(category) {
  const normalizedCategory = Helpers.string(
    category,
    DEFAULT_BOUNDARY_CATEGORY,
  ).toLowerCase();
  const options = COMMON_BOUNDARY_PRESETS[normalizedCategory];

  return Array.isArray(options) && options.length
    ? options
    : COMMON_BOUNDARY_PRESETS[DEFAULT_BOUNDARY_CATEGORY];
}

function findBoundaryPreset(category, presetId) {
  const options = listBoundaryPresetOptions(category);
  const normalizedPresetId = Helpers.string(presetId);

  return (
    options.find((option) => option.id === normalizedPresetId) ||
    options[0] ||
    null
  );
}

function buildPromotionSuggestionPreset(draft = {}) {
  const resource = Helpers.string(draft.resource, "message.general");
  const action = Helpers.nullableString(draft.action) || "share";
  const selectorLabel =
    Helpers.nullableString(draft.selectorLabel) ||
    Helpers.selectorSummary({
      direction: Helpers.string(draft.direction, "outbound"),
      resource,
      action,
    }) ||
    `${resource} / ${action}`;

  return {
    id: PROMOTION_SUGGESTION_PRESET_ID,
    label: selectorLabel,
    description: `Promote exactly ${resource}${action ? ` / ${action}` : ""} as a durable boundary.`,
    resource,
    action,
  };
}

function resolveBoundaryPresetFromSelectors(category, resource, action) {
  const normalizedCategory = Helpers.string(category).toLowerCase();
  const normalizedResource = normalizeBoundaryValue(resource);
  const normalizedAction = normalizeBoundaryValue(action) || "share";

  if (normalizedCategory === "opinions") {
    if (normalizedResource === "message.general") {
      return findBoundaryPreset("opinions", "opinions_recommend");
    }
    return null;
  }

  if (normalizedCategory === "availability") {
    if (
      normalizedResource === "calendar.event" ||
      normalizedAction === "read_details"
    ) {
      return findBoundaryPreset("availability", "availability_event_details");
    }

    if (
      normalizedResource === "calendar.availability" ||
      normalizedResource === "calendar" ||
      normalizedAction === "read_availability"
    ) {
      return findBoundaryPreset("availability", "availability_windows");
    }

    return null;
  }

  if (normalizedCategory === "location") {
    if (normalizedResource === "location.history") {
      return findBoundaryPreset("location", "location_history");
    }

    if (
      normalizedResource === "location.current" ||
      normalizedResource === "location"
    ) {
      return findBoundaryPreset("location", "location_current");
    }

    return null;
  }

  if (normalizedCategory === "health") {
    if (normalizedResource === "health.metric") {
      return findBoundaryPreset("health", "health_metrics");
    }

    if (
      normalizedResource === "health.summary" ||
      normalizedResource === "health"
    ) {
      return findBoundaryPreset("health", "health_summary");
    }

    return null;
  }

  if (normalizedCategory === "financial") {
    if (normalizedResource === "financial.transaction") {
      return findBoundaryPreset("financial", "financial_transactions");
    }

    if (
      normalizedResource === "financial.balance" ||
      normalizedResource === "financial"
    ) {
      return findBoundaryPreset("financial", "financial_balance");
    }

    return null;
  }

  if (normalizedCategory === "contact") {
    if (normalizedResource === "contact.email") {
      return findBoundaryPreset("contact", "contact_email");
    }

    if (normalizedResource === "contact.phone") {
      return findBoundaryPreset("contact", "contact_phone");
    }

    if (
      normalizedResource === "profile.basic" ||
      normalizedResource === "contact"
    ) {
      return findBoundaryPreset("contact", "contact_profile");
    }

    return null;
  }

  if (normalizedCategory === "generic") {
    if (normalizedResource === "message.general") {
      return findBoundaryPreset("generic", "generic_message");
    }
    return null;
  }

  return null;
}

function resolveBoundaryPresetFromPolicy(policy) {
  if (!policy) {
    return null;
  }

  const category =
    policy.boundary?.category ||
    inferBoundaryCategory(policy.resource, policy.action, policy.contentText);

  return resolveBoundaryPresetFromSelectors(
    category,
    policy.resource,
    policy.action,
  );
}

function canUseGuidedBoundaryEditor(policy) {
  return Boolean(
    policy?.boundary?.managementPath === "guided" &&
    resolveBoundaryPresetFromPolicy(policy),
  );
}

const BOUNDARY_OPINION_PATTERN =
  /\b(recommend|recommendation|opinion|opinions|review|reviews|advice|suggest|suggestion|taste|experience)\b/;
const BOUNDARY_AVAILABILITY_PATTERN =
  /\b(availability|available|free\/busy|free busy|calendar|schedule|meeting|event|appointment|time slot|busy)\b/;
const BOUNDARY_LOCATION_PATTERN =
  /\b(location|whereabouts|address|gps|coordinates?|latitude|longitude|home|nearby|city)\b/;
const BOUNDARY_HEALTH_PATTERN =
  /\b(health|medical|doctor|wellness|heart rate|blood pressure|sleep|bmi|symptom)\b/;
const BOUNDARY_FINANCIAL_PATTERN =
  /\b(financial|finance|money|balance|transaction|payment|invoice|charge|bank|credit|debit)\b/;
const BOUNDARY_CONTACT_PATTERN =
  /\b(contact|email|phone|sms|call|number|profile)\b/;

function normalizeBoundaryValue(value) {
  return Helpers.string(value).toLowerCase();
}

function formatBoundaryTargetLabel(scope, targetId) {
  const normalizedTargetId = Helpers.nullableString(targetId);
  if (!normalizedTargetId) {
    return null;
  }

  if (scope === "role") {
    return Helpers.titleizeToken(normalizedTargetId, normalizedTargetId);
  }

  if (Helpers.isInternalIdentifier(normalizedTargetId)) {
    return null;
  }

  if (scope === "group") {
    return Helpers.titleizeToken(normalizedTargetId, normalizedTargetId);
  }

  return normalizedTargetId;
}

function inferBoundaryCategoryFromContent(content) {
  const normalizedContent = normalizeBoundaryValue(content);

  if (BOUNDARY_OPINION_PATTERN.test(normalizedContent)) {
    return "opinions";
  }

  if (BOUNDARY_AVAILABILITY_PATTERN.test(normalizedContent)) {
    return "availability";
  }

  if (BOUNDARY_LOCATION_PATTERN.test(normalizedContent)) {
    return "location";
  }

  if (BOUNDARY_HEALTH_PATTERN.test(normalizedContent)) {
    return "health";
  }

  if (BOUNDARY_FINANCIAL_PATTERN.test(normalizedContent)) {
    return "financial";
  }

  if (BOUNDARY_CONTACT_PATTERN.test(normalizedContent)) {
    return "contact";
  }

  return null;
}

function inferBoundaryCategory(resource, action, contentText) {
  const normalizedResource = normalizeBoundaryValue(resource);
  const normalizedAction = normalizeBoundaryValue(action) || "share";

  if (
    normalizedResource === "calendar" ||
    normalizedResource.startsWith("calendar.")
  ) {
    return "availability";
  }

  if (
    normalizedResource === "location" ||
    normalizedResource.startsWith("location.")
  ) {
    return "location";
  }

  if (
    normalizedResource === "health" ||
    normalizedResource.startsWith("health.")
  ) {
    return "health";
  }

  if (
    normalizedResource === "financial" ||
    normalizedResource.startsWith("financial.")
  ) {
    return "financial";
  }

  if (
    normalizedResource === "contact" ||
    normalizedResource.startsWith("contact.") ||
    normalizedResource === "profile.basic"
  ) {
    return "contact";
  }

  if (
    normalizedResource === "message.general" &&
    BOUNDARY_OPINION_PATTERN.test(normalizedAction)
  ) {
    return "opinions";
  }

  if (normalizedResource === "message.general") {
    return inferBoundaryCategoryFromContent(contentText) || "generic";
  }

  return "advanced";
}

function boundaryDirectionLabel(direction) {
  const normalizedDirection = normalizeBoundaryValue(direction);

  switch (normalizedDirection) {
    case "outbound":
      return "Outbound";
    case "inbound":
      return "Inbound";
    case "request":
      return "Request";
    case "response":
      return "Response";
    case "notification":
      return "Notification";
    case "error":
      return "Error";
    default:
      return Helpers.titleizeToken(direction, "Outbound");
  }
}

function boundarySelectorLabel(category, resource, action) {
  const normalizedResource = normalizeBoundaryValue(resource);
  const normalizedAction = normalizeBoundaryValue(action) || "share";

  if (category === "opinions") {
    return normalizedAction === "recommend"
      ? "Recommendations"
      : "Opinion sharing";
  }

  if (category === "availability") {
    if (
      normalizedResource === "calendar.availability" ||
      normalizedAction === "read_availability"
    ) {
      return "Availability windows";
    }

    if (
      normalizedResource === "calendar.event" ||
      normalizedAction === "read_details"
    ) {
      return "Event details";
    }

    return "Schedule details";
  }

  if (category === "location") {
    return normalizedResource === "location.history"
      ? "Location history"
      : "Current location";
  }

  if (category === "health") {
    return normalizedResource === "health.summary"
      ? "Health summaries"
      : "Health metrics";
  }

  if (category === "financial") {
    return normalizedResource === "financial.transaction"
      ? "Transactions"
      : "Balances";
  }

  if (category === "contact") {
    if (normalizedResource === "contact.email") {
      return "Email address";
    }

    if (normalizedResource === "contact.phone") {
      return "Phone number";
    }

    return "Contact profile";
  }

  if (category === "generic") {
    return "General messages";
  }

  return Helpers.titleizeToken(
    normalizedResource.replace(/[._-]+/g, "_"),
    "Custom selector",
  );
}

function buildBoundaryAudience(scope, targetId) {
  const normalizedScope = Helpers.string(scope, "global");
  const scopeMeta =
    BOUNDARY_SCOPE_META[normalizedScope] || BOUNDARY_SCOPE_META.global;
  const targetLabel = formatBoundaryTargetLabel(normalizedScope, targetId);
  let displayLabel = scopeMeta.defaultDisplayLabel;
  let summary = scopeMeta.summary;

  if (normalizedScope === "role" && targetLabel) {
    displayLabel = `Role: ${targetLabel}`;
    summary = `Applies to contacts tagged ${targetLabel}.`;
  } else if (normalizedScope === "group" && targetLabel) {
    displayLabel = `Group: ${targetLabel}`;
    summary = `Applies only when sending into ${targetLabel}.`;
  } else if (normalizedScope === "user" && targetLabel) {
    displayLabel = `Contact: ${targetLabel}`;
    summary = `Applies only to ${targetLabel}.`;
  }

  return {
    key: `${normalizedScope}:${Helpers.nullableString(targetId) || "all"}`,
    scope: normalizedScope,
    filterLabel: scopeMeta.filterLabel,
    scopeLabel: scopeMeta.scopeLabel,
    targetId: Helpers.nullableString(targetId),
    targetLabel,
    displayLabel,
    summary,
  };
}

function buildBoundarySelector(category, direction, resource, action) {
  const normalizedAction = Helpers.nullableString(action) || "share";

  return {
    action: normalizedAction,
    direction: Helpers.string(direction, "outbound"),
    directionLabel: boundaryDirectionLabel(direction),
    label: boundarySelectorLabel(category, resource, normalizedAction),
    resource: Helpers.string(resource, "message.general"),
    summary: `${Helpers.string(resource, "message.general")}${normalizedAction ? ` / ${normalizedAction}` : ""}`,
  };
}

function buildBoundaryLifecycle(policy) {
  const effectiveFromTimestamp = Helpers.timestampValue(policy.effectiveFrom);
  const expiresAtTimestamp = Helpers.timestampValue(policy.expiresAt);
  const remainingUses =
    typeof policy.remainingUses === "number" &&
    Number.isFinite(policy.remainingUses)
      ? policy.remainingUses
      : null;
  const maxUses =
    typeof policy.maxUses === "number" && Number.isFinite(policy.maxUses)
      ? policy.maxUses
      : null;
  const now = Date.now();
  const detailItems = [];

  if (policy.effectiveFrom) {
    detailItems.push({
      label: "Effective from",
      value: Helpers.formatDateTime(policy.effectiveFrom),
    });
  }

  if (policy.expiresAt) {
    detailItems.push({
      label: "Expires at",
      value: Helpers.formatDateTime(policy.expiresAt),
    });
  }

  if (remainingUses !== null) {
    detailItems.push({
      label: "Remaining uses",
      value:
        maxUses !== null
          ? `${remainingUses} of ${maxUses}`
          : String(remainingUses),
    });
  }

  if (!policy.enabled) {
    return {
      badgeLabel: "Disabled",
      detailItems,
      isActive: false,
      maxUses,
      remainingUses,
      state: "disabled",
      summary: "Disabled manually and not currently enforced.",
      tone: "disabled",
    };
  }

  if (effectiveFromTimestamp && effectiveFromTimestamp > now) {
    return {
      badgeLabel: "Scheduled",
      detailItems,
      effectiveFromLabel: Helpers.formatDateTime(policy.effectiveFrom),
      isActive: false,
      maxUses,
      remainingUses,
      state: "scheduled",
      summary: `Starts ${Helpers.formatShortDate(policy.effectiveFrom)}.`,
      tone: "scheduled",
    };
  }

  if (expiresAtTimestamp && expiresAtTimestamp <= now) {
    return {
      badgeLabel: "Expired",
      detailItems,
      expiresAtLabel: Helpers.formatDateTime(policy.expiresAt),
      isActive: false,
      maxUses,
      remainingUses,
      state: "expired",
      summary: `Ended ${Helpers.formatShortDate(policy.expiresAt)}.`,
      tone: "expired",
    };
  }

  if (remainingUses !== null && remainingUses <= 0) {
    return {
      badgeLabel: "Used up",
      detailItems,
      isActive: false,
      maxUses,
      remainingUses,
      state: "spent",
      summary: "This temporary boundary has no uses remaining.",
      tone: "spent",
    };
  }

  const notes = [];
  if (policy.effectiveFrom) {
    notes.push(`Started ${Helpers.formatShortDate(policy.effectiveFrom)}.`);
  }
  if (policy.expiresAt) {
    notes.push(`Active until ${Helpers.formatShortDate(policy.expiresAt)}.`);
  }
  if (remainingUses !== null) {
    if (maxUses !== null) {
      notes.push(
        `${Helpers.pluralize(remainingUses, "use")} left out of ${maxUses}.`,
      );
    } else {
      notes.push(`${Helpers.pluralize(remainingUses, "use")} remaining.`);
    }
  }

  return {
    badgeLabel: "Active now",
    detailItems,
    effectiveFromLabel: policy.effectiveFrom
      ? Helpers.formatDateTime(policy.effectiveFrom)
      : null,
    expiresAtLabel: policy.expiresAt
      ? Helpers.formatDateTime(policy.expiresAt)
      : null,
    isActive: true,
    maxUses,
    remainingUses,
    state: "active",
    summary: notes.join(" ") || "Currently active and enforced.",
    tone: "active",
  };
}

function normalizeBoundaryOverrideKind(value) {
  const kind = Helpers.string(value).toLowerCase();

  if (kind === "one_time" || kind === "temporary" || kind === "persistent") {
    return kind;
  }

  return null;
}

function boundaryOverrideKindLabel(kind) {
  switch (normalizeBoundaryOverrideKind(kind)) {
    case "one_time":
      return "One-time override";
    case "temporary":
      return "Temporary override";
    case "persistent":
      return "Persistent override";
    default:
      return null;
  }
}

function inferBoundaryOverrideKind(policy) {
  const explicitKind = normalizeBoundaryOverrideKind(policy.override?.kind);
  if (explicitKind) {
    return explicitKind;
  }

  if (Helpers.string(policy.source).toLowerCase() !== "override") {
    return null;
  }

  if (
    typeof policy.maxUses === "number" &&
    Number.isFinite(policy.maxUses) &&
    policy.maxUses <= 1
  ) {
    return "one_time";
  }

  if (policy.expiresAt) {
    return "temporary";
  }

  return "persistent";
}

function buildBoundaryProvenance(policy) {
  const source = Helpers.string(policy.source).toLowerCase();
  const sourceLabel = Helpers.policySourceLabel(policy.source);
  const overrideKind = inferBoundaryOverrideKind(policy);
  const overrideKindLabel = boundaryOverrideKindLabel(overrideKind);
  const learningProvenance = Helpers.record(policy.learningProvenance);
  const promotedFromPolicyIds = Helpers.stringList(
    learningProvenance.promotedFromPolicyIds,
  );
  const sourceInteractionId = Helpers.nullableString(
    learningProvenance.sourceInteractionId,
  );
  const detailItems = [
    {
      label: "Source",
      value: sourceLabel,
    },
  ];

  if (overrideKindLabel) {
    detailItems.push({
      label: "Override type",
      value: overrideKindLabel,
    });
  }

  if (policy.derivedFromMessageId) {
    detailItems.push({
      label: "Derived from message",
      value: policy.derivedFromMessageId,
    });
  }

  if (sourceInteractionId) {
    detailItems.push({
      label: "Source interaction",
      value: sourceInteractionId,
    });
  }

  if (promotedFromPolicyIds.length) {
    detailItems.push({
      label: "Promoted from",
      value: Helpers.pluralize(
        promotedFromPolicyIds.length,
        "prior boundary",
        "prior boundaries",
      ),
    });
  }

  let summary = "Mahilo keeps this boundary's origin available for audit.";
  switch (source) {
    case "override":
      summary = overrideKindLabel
        ? `${overrideKindLabel} created for a situational sharing decision.`
        : "Situational override created from a review or approval decision.";
      break;
    case "learned":
      summary =
        "Learned from repeated interaction patterns and kept visible for review.";
      break;
    case "user_confirmed":
      summary = promotedFromPolicyIds.length
        ? "User confirmed this durable boundary after earlier override behavior."
        : "User confirmed this boundary after Mahilo surfaced a learned preference.";
      break;
    case "user_created":
      summary = "Created directly by the user as an explicit boundary.";
      break;
    case "default":
      summary =
        "Default Mahilo posture applied before a user-specific boundary replaced it.";
      break;
    case "legacy_migrated":
      summary = "Migrated forward from an older policy model.";
      break;
    default:
      break;
  }

  return {
    badgeLabel: overrideKindLabel || sourceLabel,
    detailItems,
    overrideKind,
    overrideKindLabel,
    source,
    sourceLabel,
    summary,
    tone:
      {
        default: "default",
        learned: "learned",
        legacy_migrated: "imported",
        override: "override",
        user_confirmed: "confirmed",
        user_created: "user-created",
      }[source] || "default",
  };
}

function boundarySelectorPhrase(label) {
  const text = Helpers.string(label, "matching content");
  return text
    ? `${text.charAt(0).toLowerCase()}${text.slice(1)}`
    : "matching content";
}

function buildBoundaryAudienceNarrative(policy, audienceLabel) {
  const scope = Helpers.string(policy.scope, "global");
  const label = Helpers.string(audienceLabel, "this audience");

  if (scope === "user") {
    return `with ${label.replace(/^Contact:\s*/i, "")}`;
  }

  if (scope === "role") {
    return `with contacts tagged ${label.replace(/^Role:\s*/i, "")}`;
  }

  if (scope === "group") {
    return `when sending into ${label.replace(/^Group:\s*/i, "")}`;
  }

  return `with ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

function buildBoundaryNarrative(policy, audienceLabel) {
  const boundary = policy.boundary || {};
  const effect = boundary.effect || {};
  const selector = boundary.selector || {};
  const selectorPhrase = boundarySelectorPhrase(selector.label);
  const audience = buildBoundaryAudienceNarrative(policy, audienceLabel);
  const effectValue = effect.value || policy.effect;

  switch (effectValue) {
    case "allow":
      return `Mahilo can share ${selectorPhrase} ${audience}.`;
    case "ask":
      return `Mahilo asks before sharing ${selectorPhrase} ${audience}.`;
    case "deny":
      return `Mahilo blocks ${selectorPhrase} ${audience}.`;
    default:
      return Helpers.string(
        boundary.categoryDescription,
        "Mahilo applies this boundary to matching content.",
      );
  }
}

function buildBoundaryAudienceSummary(policy, audienceLabel) {
  const scope = Helpers.string(policy.scope, "global");
  const label = Helpers.string(audienceLabel);

  if (!label) {
    return Helpers.string(
      policy.boundary?.audience?.summary,
      "This boundary applies to the selected audience.",
    );
  }

  if (scope === "user") {
    return `Applies only to ${label.replace(/^Contact:\s*/i, "")}.`;
  }

  if (scope === "role") {
    return `Applies to contacts tagged ${label.replace(/^Role:\s*/i, "")}.`;
  }

  if (scope === "group") {
    return `Applies only when sending into ${label.replace(/^Group:\s*/i, "")}.`;
  }

  return Helpers.string(
    policy.boundary?.audience?.summary,
    "Applies across every conversation unless a narrower boundary wins.",
  );
}

function doesPolicyMatchPromotionSuggestion(policy, suggestion) {
  if (!policy || !suggestion) {
    return false;
  }

  const lifecycle = policy.boundary?.lifecycle || buildBoundaryLifecycle(policy);
  if (!lifecycle.isActive) {
    return false;
  }

  if (Helpers.string(policy.source).toLowerCase() === "override") {
    return false;
  }

  return (
    Helpers.string(policy.scope, "global") ===
      Helpers.string(suggestion.scope, "global") &&
    (Helpers.nullableString(policy.targetId) || null) ===
      (Helpers.nullableString(suggestion.targetId) || null) &&
    Helpers.string(policy.direction, "outbound") ===
      Helpers.string(suggestion.direction, "outbound") &&
    Helpers.string(policy.resource, "message.general") ===
      Helpers.string(suggestion.resource, "message.general") &&
    (Helpers.nullableString(policy.action) || "share") ===
      (Helpers.nullableString(suggestion.action) || "share") &&
    Helpers.string(policy.effect, DEFAULT_BOUNDARY_EFFECT) ===
      Helpers.string(suggestion.effect, DEFAULT_BOUNDARY_EFFECT)
  );
}

function isPromotionSuggestionAlreadyEnforced(
  suggestion,
  policies = State.policies,
) {
  return (Array.isArray(policies) ? policies : []).some((policy) =>
    doesPolicyMatchPromotionSuggestion(policy, suggestion),
  );
}

function buildPromotionSuggestionSummary(suggestion) {
  const policy = suggestion?.suggestedPolicy || {};
  const selectorLabel =
    Helpers.string(
      suggestion?.boundary?.selector?.label,
      Helpers.selectorSummary(suggestion?.selectors) || "matching content",
    ) || "matching content";
  const audienceLabel = Helpers.string(
    suggestion?.audienceLabel,
    Helpers.policyAudienceDisplay(policy),
  );
  const effect = Helpers.string(suggestion?.effect, DEFAULT_BOUNDARY_EFFECT);
  const outcomeCopy =
    {
      allow: "are shared automatically",
      ask: "pause for review before sending",
      deny: "stay blocked",
    }[effect] || "follow the same outcome";

  return `Mahilo noticed ${Helpers.pluralize(
    suggestion?.repeatedOverridePattern?.count || 0,
    "temporary override",
  )} for ${boundarySelectorPhrase(selectorLabel)} ${buildBoundaryAudienceNarrative(
    policy,
    audienceLabel,
  )}. Save a durable boundary so future matches ${outcomeCopy}.`;
}

function buildPromotionSuggestionEvidence(suggestion) {
  const pattern = Helpers.record(suggestion?.repeatedOverridePattern);
  const firstSeenAt = Helpers.nullableString(pattern.firstSeenAt);
  const lastSeenAt = Helpers.nullableString(pattern.lastSeenAt);
  const reasons = Helpers.stringList(pattern.sampleReasons).slice(0, 2);
  const parts = [];

  if (firstSeenAt && lastSeenAt) {
    if (firstSeenAt === lastSeenAt) {
      parts.push(`Seen ${Helpers.formatShortDate(lastSeenAt)}.`);
    } else {
      parts.push(
        `Seen from ${Helpers.formatShortDate(firstSeenAt)} to ${Helpers.formatShortDate(lastSeenAt)}.`,
      );
    }
  } else if (lastSeenAt) {
    parts.push(`Last seen ${Helpers.formatShortDate(lastSeenAt)}.`);
  } else if (firstSeenAt) {
    parts.push(`First seen ${Helpers.formatShortDate(firstSeenAt)}.`);
  }

  if (reasons.length) {
    parts.push(`Recent reasons: ${reasons.join(" • ")}.`);
  }

  return parts.join(" ");
}

function compareBoundaryPolicies(left, right) {
  const leftLifecycle =
    left.boundary?.lifecycle || buildBoundaryLifecycle(left);
  const rightLifecycle =
    right.boundary?.lifecycle || buildBoundaryLifecycle(right);
  const activeDelta =
    Number(rightLifecycle.isActive) - Number(leftLifecycle.isActive);
  if (activeDelta !== 0) {
    return activeDelta;
  }

  const effectDelta =
    (BOUNDARY_EFFECT_ORDER[left.effect] ?? Number.MAX_SAFE_INTEGER) -
    (BOUNDARY_EFFECT_ORDER[right.effect] ?? Number.MAX_SAFE_INTEGER);
  if (effectDelta !== 0) {
    return effectDelta;
  }

  const priorityDelta = (right.priority || 0) - (left.priority || 0);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const selectorDelta = Helpers.string(
    left.boundary?.selector?.label,
  ).localeCompare(Helpers.string(right.boundary?.selector?.label));
  if (selectorDelta !== 0) {
    return selectorDelta;
  }

  return (
    Helpers.timestampValue(right.createdAt) -
    Helpers.timestampValue(left.createdAt)
  );
}

function buildBoundaryPresentation(policy) {
  const category = inferBoundaryCategory(
    policy.resource,
    policy.action,
    policy.contentText,
  );
  const categoryMeta =
    BOUNDARY_CATEGORY_META[category] || BOUNDARY_CATEGORY_META.advanced;
  const effectMeta =
    BOUNDARY_EFFECT_META[policy.effect] || BOUNDARY_EFFECT_META.deny;
  const selector = buildBoundarySelector(
    category,
    policy.direction,
    policy.resource,
    policy.action,
  );
  const audience = buildBoundaryAudience(policy.scope, policy.targetId);
  const lifecycle = buildBoundaryLifecycle(policy);
  const provenance = buildBoundaryProvenance(policy);
  const advancedSummary =
    categoryMeta.managementPath === "advanced"
      ? `Custom selector combination (${selector.summary}). Keep it visible here and use the advanced path for selector-specific edits.`
      : null;

  return {
    advancedSummary,
    audience,
    category,
    categoryDescription: categoryMeta.description,
    categoryLabel: categoryMeta.label,
    effect: {
      badgeLabel: effectMeta.badgeLabel,
      description: effectMeta.description,
      label: effectMeta.label,
      tone: effectMeta.tone,
      value: policy.effect,
    },
    icon: categoryMeta.icon,
    lifecycle,
    managementPath: categoryMeta.managementPath,
    provenance,
    selector,
  };
}

const Normalizers = {
  user(value) {
    const record = Helpers.record(value);
    const username = Helpers.nullableString(record.username);

    if (!username) {
      return null;
    }

    return {
      user_id: Helpers.string(record.user_id ?? record.id, username),
      username,
      display_name: Helpers.nullableString(
        record.display_name ?? record.displayName,
      ),
      created_at: Helpers.iso(record.created_at ?? record.createdAt),
      registration_source: Helpers.nullableString(
        record.registration_source ?? record.registrationSource,
      ),
      status: Helpers.nullableString(record.status),
      verified: Boolean(record.verified),
      verified_at: Helpers.iso(record.verified_at ?? record.verifiedAt),
      raw: value,
    };
  },

  agents(value) {
    return Helpers.collection(value, ["agents", "connections", "items"])
      .map((entry) => this.agent(entry))
      .filter(Boolean);
  },

  agentsModel(value) {
    return Helpers.collectionModel(this.agents(value), (agent) => agent.id);
  },

  agent(value) {
    const record = Helpers.record(value);
    const id = Helpers.nullableString(record.id ?? record.connection_id);

    if (!id) {
      return null;
    }

    const callbackUrl = Helpers.nullableString(
      record.callback_url ?? record.callbackUrl,
    );
    const status = Helpers.string(record.status, "unknown");
    const mode =
      Helpers.nullableString(record.mode) ||
      Helpers.connectionMode(callbackUrl);

    return {
      id,
      label: Helpers.string(record.label, id),
      framework: Helpers.string(record.framework, "unknown"),
      description: Helpers.nullableString(record.description),
      capabilities: Helpers.stringList(record.capabilities),
      routingPriority: Helpers.number(
        record.routing_priority ?? record.routingPriority,
        0,
      ),
      callbackUrl,
      publicKey: Helpers.nullableString(record.public_key ?? record.publicKey),
      publicKeyAlg: Helpers.nullableString(
        record.public_key_alg ?? record.publicKeyAlg,
      ),
      status,
      isActive: status === "active",
      mode,
      lastSeen: Helpers.iso(record.last_seen ?? record.lastSeen),
      createdAt: Helpers.iso(record.created_at ?? record.createdAt),
      raw: value,
    };
  },

  friends(value) {
    return Helpers.collection(value, ["friends", "items", "results", "data"])
      .map((entry) => this.friend(entry))
      .filter(Boolean);
  },

  friendsModel(value) {
    return Helpers.collectionModel(
      this.friends(value),
      (friend) => friend.friendshipId,
    );
  },

  friend(value) {
    const record = Helpers.record(value);
    const friendshipId = Helpers.nullableString(
      record.friendship_id ?? record.id,
    );

    if (!friendshipId) {
      return null;
    }

    const username =
      Helpers.nullableString(record.username) ||
      Helpers.nullableString(record.user_id) ||
      friendshipId;

    return {
      id: friendshipId,
      friendshipId,
      userId: Helpers.nullableString(record.user_id),
      username,
      displayName:
        Helpers.nullableString(record.display_name ?? record.displayName) ||
        username,
      status: Helpers.string(record.status, "pending"),
      direction: Helpers.string(record.direction, "received"),
      since: Helpers.iso(record.since ?? record.created_at ?? record.createdAt),
      roles: Helpers.stringList(record.roles),
      interactionCount: Helpers.number(
        record.interaction_count ?? record.interactionCount,
        0,
      ),
      raw: value,
    };
  },

  roles(value) {
    return Helpers.collection(value, ["roles", "items", "results", "data"])
      .map((entry) => this.role(entry))
      .filter(Boolean);
  },

  rolesModel(value) {
    return Helpers.collectionModel(this.roles(value), (role) => role.name);
  },

  role(value) {
    const record = Helpers.record(value);
    const name = Helpers.nullableString(record.name);

    if (!name) {
      return null;
    }

    return {
      id: name,
      name,
      description: Helpers.nullableString(record.description),
      isSystem: Boolean(record.is_system ?? record.isSystem),
      raw: value,
    };
  },

  groups(value) {
    return Helpers.collection(value, ["groups", "items", "results", "data"])
      .map((entry) => this.group(entry))
      .filter(Boolean);
  },

  groupsModel(value) {
    return Helpers.collectionModel(this.groups(value), (group) => group.id);
  },

  group(value) {
    const record = Helpers.record(value);
    const id = Helpers.nullableString(record.group_id ?? record.id);

    if (!id) {
      return null;
    }

    return {
      id,
      name: Helpers.string(record.name, id),
      description: Helpers.nullableString(record.description),
      inviteOnly: Boolean(record.invite_only ?? record.inviteOnly),
      role: Helpers.nullableString(record.role),
      status: Helpers.nullableString(record.status),
      memberCount: Helpers.number(record.member_count ?? record.memberCount, 0),
      createdAt: Helpers.iso(record.created_at ?? record.createdAt),
      raw: value,
    };
  },

  groupMembers(value) {
    return Helpers.collection(value, ["members", "items", "results", "data"])
      .map((entry) => this.groupMember(entry))
      .filter(Boolean);
  },

  groupMembersModel(value) {
    return Helpers.collectionModel(
      this.groupMembers(value),
      (member) => member.membershipId,
    );
  },

  groupMember(value) {
    const record = Helpers.record(value);
    const membershipId = Helpers.nullableString(
      record.membership_id ?? record.id,
    );

    if (!membershipId) {
      return null;
    }

    const username =
      Helpers.nullableString(record.username) ||
      Helpers.nullableString(record.user_id) ||
      membershipId;

    return {
      id: membershipId,
      membershipId,
      userId: Helpers.nullableString(record.user_id),
      username,
      displayName:
        Helpers.nullableString(record.display_name ?? record.displayName) ||
        username,
      role: Helpers.nullableString(record.role),
      status: Helpers.string(record.status, "active"),
      joinedAt: Helpers.iso(record.joined_at ?? record.joinedAt),
      raw: value,
    };
  },

  messages(value, options = {}) {
    return Helpers.collection(value, ["messages", "items", "results", "data"])
      .map((entry) => this.message(entry, options))
      .filter(Boolean)
      .sort((left, right) => Helpers.compareByTimestampDesc(left, right));
  },

  messagesModel(value, options = {}) {
    return Helpers.collectionModel(
      this.messages(value, options),
      (message) => message.id,
    );
  },

  message(value, options = {}) {
    const record = Helpers.record(value);
    const policyAudit = Helpers.jsonRecord(
      record.policies_evaluated ?? record.policiesEvaluated,
    );
    const rawPayload =
      record.message ??
      record.payload ??
      record.message_preview ??
      record.stored_payload_excerpt;
    const parsedPayload = Helpers.jsonValue(rawPayload);
    const parsedPayloadRecord = Helpers.record(parsedPayload);
    const timestamp =
      Helpers.iso(
        record.created_at ??
          record.timestamp ??
          record.delivered_at ??
          record.createdAt,
      ) || new Date().toISOString();
    const transportDirection = Helpers.normalizeTransportDirection(
      record,
      options.currentUsername,
    );
    const sender =
      Helpers.participantLabel(record.sender) ||
      (transportDirection === "sent" ? options.currentUsername : null) ||
      "Unknown sender";
    const recipientType =
      Helpers.nullableString(record.recipient_type) ||
      Helpers.participantType(record.recipient) ||
      "user";
    const recipient =
      Helpers.recipientLabel(record.recipient, recipientType) ||
      (recipientType === "group"
        ? "Group conversation"
        : options.currentUsername) ||
      "Unknown recipient";
    const id =
      Helpers.nullableString(record.id ?? record.message_id) ||
      `message_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const messageText = Helpers.contentText(
      Helpers.nullableString(parsedPayloadRecord.message) || rawPayload,
    );
    const counterpart = transportDirection === "sent" ? recipient : sender;
    const status = Helpers.string(
      record.status ?? record.delivery_status,
      "pending",
    );

    return {
      kind: "message",
      id,
      messageId: Helpers.string(record.message_id ?? record.id, id),
      senderId: Helpers.nullableString(
        record.sender_user_id ?? record.sender?.user_id ?? record.sender?.id,
      ),
      sender,
      recipientId: Helpers.nullableString(
        record.recipient_id ??
          record.recipient?.user_id ??
          record.recipient?.id,
      ),
      recipient,
      recipientType,
      transportDirection,
      isSent: transportDirection === "sent",
      counterpart,
      counterpartLabel:
        counterpart || (transportDirection === "sent" ? recipient : sender),
      status,
      deliveryStatus: Helpers.string(record.delivery_status, status),
      decision: Helpers.nullableString(record.decision ?? policyAudit.effect),
      deliveryMode: Helpers.nullableString(
        record.delivery_mode ?? policyAudit.delivery_mode,
      ),
      reasonCode: Helpers.nullableString(
        record.reason_code ?? policyAudit.reason_code,
      ),
      timestamp,
      createdAt: timestamp,
      deliveredAt: Helpers.iso(record.delivered_at ?? record.deliveredAt),
      messageText,
      previewText: Helpers.truncate(messageText, 120),
      context: Helpers.contentText(
        record.context ??
          record.context_preview ??
          parsedPayloadRecord.context,
      ),
      inResponseTo: Helpers.nullableString(
        record.in_response_to ?? record.inResponseTo,
      ),
      payloadType: Helpers.nullableString(
        record.payload_type ?? record.payloadType,
      ),
      outcome: Helpers.nullableString(record.outcome),
      outcomeDetails: record.outcome_details ?? record.outcomeDetails ?? null,
      parsedPayload,
      replyOutcome: Helpers.normalizeAskAroundReplyOutcome(
        parsedPayloadRecord.outcome ?? record.outcome,
      ),
      senderAgent: Helpers.nullableString(
        record.sender_agent ?? record.sender?.agent ?? record.sender?.label,
      ),
      senderConnectionId: Helpers.nullableString(
        record.sender_connection_id ??
          record.sender?.connection_id ??
          record.sender?.id,
      ),
      recipientConnectionId: Helpers.nullableString(
        record.recipient_connection_id ??
          record.recipient?.connection_id ??
          record.recipient?.id,
      ),
      correlationId: Helpers.nullableString(record.correlation_id),
      selectors: {
        direction: Helpers.nullableString(
          record.direction ??
            record.selectors?.direction ??
            record.classified_direction,
        ),
        resource: Helpers.nullableString(
          record.resource ??
            record.selectors?.resource ??
            record.classified_resource,
        ),
        action: Helpers.nullableString(
          record.action ?? record.selectors?.action ?? record.classified_action,
        ),
      },
      classifiedSelectors: {
        direction: Helpers.nullableString(record.classified_direction),
        resource: Helpers.nullableString(record.classified_resource),
        action: Helpers.nullableString(record.classified_action),
      },
      replyPolicies: Helpers.isObject(record.reply_policies)
        ? record.reply_policies
        : null,
      matchedPolicyIds: Helpers.stringList(policyAudit.matched_policy_ids),
      winningPolicyId: Helpers.nullableString(policyAudit.winning_policy_id),
      resolverLayer: Helpers.nullableString(policyAudit.resolver_layer),
      guardrailId: Helpers.nullableString(policyAudit.guardrail_id),
      policyAudit,
      raw: value,
    };
  },

  policyLearningProvenance(value) {
    const record = Helpers.record(value);
    const promotedFromPolicyIds = Helpers.stringList(
      record.promoted_from_policy_ids ?? record.promotedFromPolicyIds,
    );
    const sourceInteractionId = Helpers.nullableString(
      record.source_interaction_id ?? record.sourceInteractionId,
    );

    if (!sourceInteractionId && !promotedFromPolicyIds.length) {
      return null;
    }

    return {
      promotedFromPolicyIds,
      sourceInteractionId,
    };
  },

  policyOverride(value) {
    const content = Helpers.record(value);
    const override = Helpers.record(content._mahilo_override);
    const kind = normalizeBoundaryOverrideKind(override.kind);

    if (!kind && !Helpers.nullableString(override.reason)) {
      return null;
    }

    return {
      createdAt: Helpers.iso(override.created_at ?? override.createdAt),
      createdVia: Helpers.nullableString(
        override.created_via ?? override.createdVia,
      ),
      kind,
      reason: Helpers.nullableString(override.reason),
      senderConnectionId: Helpers.nullableString(
        override.sender_connection_id ?? override.senderConnectionId,
      ),
      sourceResolutionId: Helpers.nullableString(
        override.source_resolution_id ?? override.sourceResolutionId,
      ),
    };
  },

  policyAuditRecord(value) {
    const record = Helpers.record(value);
    const policyId = Helpers.nullableString(record.policy_id ?? record.id);

    if (!policyId) {
      return null;
    }

    return {
      policyId,
      scope: Helpers.string(record.scope, "global"),
      targetId: Helpers.nullableString(record.target_id),
      selectors: {
        action: Helpers.nullableString(
          record.selectors?.action ?? record.action,
        ),
        direction: Helpers.string(
          record.selectors?.direction ?? record.direction,
          "outbound",
        ),
        resource: Helpers.string(
          record.selectors?.resource ?? record.resource,
          "message.general",
        ),
      },
      effect: Helpers.string(record.effect, "deny"),
      evaluator: Helpers.string(record.evaluator, "structured"),
      source: Helpers.nullableString(record.source),
      derivedFromMessageId: Helpers.nullableString(
        record.derived_from_message_id ?? record.derivedFromMessageId,
      ),
      sourceInteractionId: Helpers.nullableString(
        record.source_interaction_id ?? record.sourceInteractionId,
      ),
      promotedFromPolicyIds: Helpers.stringList(
        record.promoted_from_policy_ids ?? record.promotedFromPolicyIds,
      ),
      createdAt: Helpers.iso(record.created_at ?? record.createdAt),
      raw: value,
    };
  },

  policyProvenanceAudit(value) {
    const record = Helpers.record(value);
    const policy = this.policyAuditRecord(record.policy);

    if (!policy) {
      return null;
    }

    const sourceMessageRecord = Helpers.record(record.source_message);
    const sourceMessageId = Helpers.nullableString(sourceMessageRecord.id);

    return {
      lineage: Helpers.collection(record.lineage)
        .map((entry) => this.policyAuditRecord(entry))
        .filter(Boolean),
      overrideToPromotedHistory: Helpers.collection(
        record.override_to_promoted_history,
      ).map((entry) => {
        const history = Helpers.record(entry);
        return {
          fromDerivedFromMessageId: Helpers.nullableString(
            history.from_derived_from_message_id,
          ),
          fromPolicyId: Helpers.nullableString(history.from_policy_id),
          fromSource: Helpers.nullableString(history.from_source),
          sourceInteractionId: Helpers.nullableString(
            history.source_interaction_id,
          ),
          toDerivedFromMessageId: Helpers.nullableString(
            history.to_derived_from_message_id,
          ),
          toPolicyId: Helpers.nullableString(history.to_policy_id),
          toSource: Helpers.nullableString(history.to_source),
        };
      }),
      policy,
      sourceMessage: sourceMessageId
        ? {
            createdAt: Helpers.iso(
              sourceMessageRecord.created_at ?? sourceMessageRecord.createdAt,
            ),
            id: sourceMessageId,
            recipientId: Helpers.nullableString(
              sourceMessageRecord.recipient_id ??
                sourceMessageRecord.recipientId,
            ),
            recipientType: Helpers.nullableString(
              sourceMessageRecord.recipient_type ??
                sourceMessageRecord.recipientType,
            ),
            selectors: {
              action: Helpers.nullableString(
                sourceMessageRecord.selectors?.action ??
                  sourceMessageRecord.action,
              ),
              direction: Helpers.string(
                sourceMessageRecord.selectors?.direction ??
                  sourceMessageRecord.direction,
                "outbound",
              ),
              resource: Helpers.string(
                sourceMessageRecord.selectors?.resource ??
                  sourceMessageRecord.resource,
                "message.general",
              ),
            },
            senderUserId: Helpers.nullableString(
              sourceMessageRecord.sender_user_id ??
                sourceMessageRecord.senderUserId,
            ),
          }
        : null,
      raw: value,
    };
  },

  policies(value) {
    return Helpers.collection(value, ["policies", "items", "results", "data"])
      .map((entry) => this.policy(entry))
      .filter(Boolean);
  },

  policiesModel(value) {
    return Helpers.collectionModel(this.policies(value), (policy) => policy.id);
  },

  policy(value) {
    const record = Helpers.record(value);
    const id = Helpers.nullableString(record.id ?? record.policy_id);

    if (!id) {
      return null;
    }

    const evaluator = Helpers.string(
      record.evaluator ?? record.policy_type,
      "llm",
    );

    const policy = {
      id,
      scope: Helpers.string(record.scope, "global"),
      targetId: Helpers.nullableString(record.target_id),
      direction: Helpers.string(record.direction, "outbound"),
      resource: Helpers.string(record.resource, "message.general"),
      action: Helpers.nullableString(record.action) || "share",
      effect: Helpers.string(record.effect, "deny"),
      evaluator,
      policyType: evaluator,
      content: record.policy_content,
      contentText: Helpers.contentText(record.policy_content),
      effectiveFrom: Helpers.iso(record.effective_from ?? record.effectiveFrom),
      expiresAt: Helpers.iso(record.expires_at ?? record.expiresAt),
      maxUses: record.max_uses ?? record.maxUses ?? null,
      remainingUses: record.remaining_uses ?? record.remainingUses ?? null,
      priority: Helpers.number(record.priority, 0),
      enabled: record.enabled !== false,
      source: Helpers.nullableString(record.source),
      derivedFromMessageId: Helpers.nullableString(
        record.derived_from_message_id ?? record.derivedFromMessageId,
      ),
      learningProvenance: this.policyLearningProvenance(
        record.learning_provenance ?? record.learningProvenance,
      ),
      override: this.policyOverride(record.policy_content),
      createdAt: Helpers.iso(record.created_at ?? record.createdAt),
      updatedAt: Helpers.iso(record.updated_at ?? record.updatedAt),
      raw: value,
    };

    return {
      ...policy,
      boundary: buildBoundaryPresentation(policy),
    };
  },

  preferences(value) {
    const record = Helpers.record(value);
    const quietHours = Helpers.record(record.quiet_hours ?? record.quietHours);

    return {
      preferredChannel: Helpers.nullableString(
        record.preferred_channel ?? record.preferredChannel,
      ),
      urgentBehavior: Helpers.string(
        record.urgent_behavior ?? record.urgentBehavior,
        "preferred_only",
      ),
      quietHours: {
        enabled: Boolean(quietHours.enabled),
        start: Helpers.string(quietHours.start, "22:00"),
        end: Helpers.string(quietHours.end, "07:00"),
        timezone: Helpers.string(quietHours.timezone, "UTC"),
      },
      defaultLlmProvider: Helpers.nullableString(
        record.default_llm_provider ?? record.defaultLlmProvider,
      ),
      defaultLlmModel: Helpers.nullableString(
        record.default_llm_model ?? record.defaultLlmModel,
      ),
      raw: value,
    };
  },

  reviews(value) {
    return Helpers.collection(value, ["reviews", "items", "results", "data"])
      .map((entry) => this.review(entry))
      .filter(Boolean);
  },

  reviewsModel(value) {
    return Helpers.collectionModel(this.reviews(value), (review) => review.id);
  },

  review(value) {
    const record = Helpers.record(value);
    const id = Helpers.nullableString(record.review_id ?? record.id);

    if (!id) {
      return null;
    }

    const queueDirection = Helpers.string(record.queue_direction, "outbound");
    const transportDirection =
      queueDirection === "inbound" ? "received" : "sent";

    return {
      kind: "review",
      id,
      reviewId: id,
      messageId: Helpers.nullableString(record.message_id) || id,
      queueDirection,
      transportDirection,
      status: Helpers.string(record.status, "approval_pending"),
      decision: Helpers.string(record.decision, "ask"),
      deliveryMode: Helpers.nullableString(record.delivery_mode),
      correlationId: Helpers.nullableString(record.correlation_id),
      inResponseTo: Helpers.nullableString(record.in_response_to),
      summary: Helpers.string(
        record.summary,
        "Message requires review before delivery.",
      ),
      reasonCode: Helpers.nullableString(record.reason_code),
      timestamp:
        Helpers.iso(record.created_at ?? record.timestamp) ||
        new Date().toISOString(),
      messagePreview: Helpers.contentText(record.message_preview),
      contextPreview: Helpers.contentText(record.context_preview),
      senderId: Helpers.nullableString(
        record.sender?.user_id ?? record.sender?.id,
      ),
      sender: Helpers.participantLabel(record.sender) || "Unknown sender",
      senderAgent: Helpers.nullableString(
        record.sender?.agent ?? record.sender_agent,
      ),
      senderConnectionId: Helpers.nullableString(
        record.sender?.connection_id ?? record.sender_connection_id,
      ),
      recipientId: Helpers.nullableString(
        record.recipient?.user_id ?? record.recipient?.id,
      ),
      recipient:
        Helpers.recipientLabel(
          record.recipient,
          Helpers.participantType(record.recipient) || "user",
        ) ||
        (Helpers.participantType(record.recipient) === "group"
          ? "Group conversation"
          : "Unknown recipient"),
      recipientType:
        Helpers.participantType(record.recipient) ||
        Helpers.nullableString(record.recipient_type) ||
        "user",
      recipientConnectionId: Helpers.nullableString(
        record.recipient?.connection_id ?? record.recipient_connection_id,
      ),
      payloadType: Helpers.nullableString(record.payload_type),
      selectors: Helpers.mergeSelectors(record.selectors, {
        direction: record.direction,
        resource: record.resource,
        action: record.action,
      }),
      appliedPolicy: Helpers.record(record.applied_policy),
      audit: Helpers.jsonRecord(record.audit),
      raw: value,
    };
  },

  blockedEvents(value) {
    return Helpers.collection(value, [
      "blocked_events",
      "items",
      "results",
      "data",
    ])
      .map((entry) => this.blockedEvent(entry))
      .filter(Boolean);
  },

  blockedEventsModel(value) {
    return Helpers.collectionModel(
      this.blockedEvents(value),
      (blockedEvent) => blockedEvent.id,
    );
  },

  blockedEventRetention(value) {
    const record = Helpers.record(Helpers.record(value).retention);

    return {
      blockedEventLog: Helpers.nullableString(record.blocked_event_log),
      payloadExcerptDefault: Helpers.nullableString(
        record.payload_excerpt_default,
      ),
      payloadExcerptIncluded: Boolean(record.payload_excerpt_included),
      payloadHashAlgorithm: Helpers.nullableString(
        record.payload_hash_algorithm,
      ),
      sourceMessagePayload: Helpers.nullableString(
        record.source_message_payload,
      ),
      raw: record,
    };
  },

  blockedEvent(value) {
    const record = Helpers.record(value);
    const id = Helpers.nullableString(record.id ?? record.blocked_event_id);

    if (!id) {
      return null;
    }

    const queueDirection = Helpers.string(record.queue_direction, "outbound");
    const transportDirection =
      queueDirection === "inbound" ? "received" : "sent";

    return {
      kind: "blocked",
      id,
      blockedEventId: id,
      messageId: Helpers.nullableString(record.message_id) || id,
      queueDirection,
      transportDirection,
      status: Helpers.string(record.status, "rejected"),
      reason: Helpers.string(record.reason, "Message blocked by policy."),
      reasonCode: Helpers.nullableString(record.reason_code),
      correlationId: Helpers.nullableString(record.correlation_id),
      inResponseTo: Helpers.nullableString(record.in_response_to),
      timestamp:
        Helpers.iso(record.timestamp ?? record.created_at) ||
        new Date().toISOString(),
      senderId: Helpers.nullableString(
        record.sender?.user_id ?? record.sender?.id,
      ),
      sender: Helpers.participantLabel(record.sender) || "Unknown sender",
      recipientId: Helpers.nullableString(
        record.recipient?.user_id ?? record.recipient?.id,
      ),
      recipient:
        Helpers.recipientLabel(
          record.recipient,
          Helpers.participantType(record.recipient) || "user",
        ) ||
        (Helpers.participantType(record.recipient) === "group"
          ? "Group conversation"
          : "Unknown recipient"),
      recipientType:
        Helpers.participantType(record.recipient) ||
        Helpers.nullableString(record.recipient_type) ||
        "user",
      storedPayloadExcerpt: Helpers.contentText(record.stored_payload_excerpt),
      payloadHash: Helpers.nullableString(record.payload_hash),
      selectors: Helpers.mergeSelectors(record.selectors, {
        direction: record.direction,
        resource: record.resource,
        action: record.action,
      }),
      audit: Helpers.jsonRecord(record.audit),
      raw: value,
    };
  },

  promotionSuggestionLearning(value) {
    const record = Helpers.record(Helpers.record(value).learning);

    return {
      minRepetitions: Helpers.number(
        record.min_repetitions ?? record.minRepetitions,
        0,
      ),
      lookbackDays: Helpers.number(
        record.lookback_days ?? record.lookbackDays,
        0,
      ),
      evaluatedOverrideCount: Helpers.number(
        record.evaluated_override_count ?? record.evaluatedOverrideCount,
        0,
      ),
      totalPatternCount: Helpers.number(
        record.total_pattern_count ?? record.totalPatternCount,
        0,
      ),
      raw: record,
    };
  },

  promotionSuggestions(value) {
    return Helpers.collection(value, [
      "promotion_suggestions",
      "items",
      "results",
      "data",
    ])
      .map((entry) => this.promotionSuggestion(entry))
      .filter(Boolean);
  },

  promotionSuggestionsModel(value) {
    return Helpers.collectionModel(
      this.promotionSuggestions(value),
      (suggestion) => suggestion.id,
    );
  },

  promotionSuggestion(value) {
    const record = Helpers.record(value);
    const id = Helpers.nullableString(record.suggestion_id ?? record.id);

    if (!id) {
      return null;
    }

    const suggestedPolicyRecord = Helpers.record(record.suggested_policy);
    const scope = Helpers.string(suggestedPolicyRecord.scope, "global");
    const targetId = Helpers.nullableString(
      suggestedPolicyRecord.target_id ?? suggestedPolicyRecord.targetId,
    );
    const direction = Helpers.string(suggestedPolicyRecord.direction, "outbound");
    const resource = Helpers.string(
      suggestedPolicyRecord.resource,
      Helpers.string(record.selectors?.resource, "message.general"),
    );
    const action =
      Helpers.nullableString(suggestedPolicyRecord.action) ||
      Helpers.nullableString(record.selectors?.action) ||
      "share";
    const effect = Helpers.string(
      suggestedPolicyRecord.effect,
      DEFAULT_BOUNDARY_EFFECT,
    );
    const learningProvenance = Helpers.record(
      suggestedPolicyRecord.learning_provenance,
    );
    const suggestedPolicy = this.policy({
      action,
      direction,
      effect,
      evaluator: Helpers.string(suggestedPolicyRecord.evaluator, "structured"),
      id,
      learning_provenance: learningProvenance,
      policy_content: {},
      resource,
      scope,
      source: "learned",
      target_id: targetId,
    });
    const boundary = suggestedPolicy?.boundary || null;
    const preset = suggestedPolicy
      ? resolveBoundaryPresetFromPolicy(suggestedPolicy)
      : null;
    const repeatedOverridePattern = Helpers.record(
      record.repeated_override_pattern,
    );

    return {
      kind: "promotion_suggestion",
      id,
      suggestionId: id,
      scope,
      targetId,
      direction,
      resource,
      action,
      effect,
      selectors: Helpers.mergeSelectors(record.selectors, {
        action,
        direction,
        resource,
      }),
      suggestedPolicy,
      boundary,
      category: boundary?.category || inferBoundaryCategory(resource, action, ""),
      audienceLabel: suggestedPolicy
        ? Helpers.policyAudienceDisplay(suggestedPolicy)
        : buildBoundaryAudience(scope, targetId).displayLabel,
      canUseGuidedEditor: Boolean(
        preset &&
          suggestedPolicy?.boundary?.managementPath === "guided",
      ),
      presetId: preset?.id || null,
      repeatedOverridePattern: {
        count: Helpers.number(repeatedOverridePattern.count, 0),
        firstSeenAt: Helpers.iso(
          repeatedOverridePattern.first_seen_at ??
            repeatedOverridePattern.firstSeenAt,
        ),
        lastSeenAt: Helpers.iso(
          repeatedOverridePattern.last_seen_at ??
            repeatedOverridePattern.lastSeenAt,
        ),
        overridePolicyIds: Helpers.stringList(
          repeatedOverridePattern.override_policy_ids ??
            repeatedOverridePattern.overridePolicyIds,
        ),
        kinds: Helpers.stringList(repeatedOverridePattern.kinds),
        sampleReasons: Helpers.stringList(
          repeatedOverridePattern.sample_reasons ??
            repeatedOverridePattern.sampleReasons,
        ),
        sourceResolutionIds: Helpers.stringList(
          repeatedOverridePattern.source_resolution_ids ??
            repeatedOverridePattern.sourceResolutionIds,
        ),
      },
      raw: value,
    };
  },

  reviewQueue(value) {
    const record = Helpers.record(Helpers.record(value).review_queue);

    return {
      count: Helpers.number(record.count, 0),
      direction: Helpers.nullableString(record.direction),
      statuses: Helpers.stringList(record.statuses),
      raw: record,
    };
  },
};

// ========================================
// WebSocket Manager
// ========================================
const WebSocketManager = {
  ws: null,
  pingInterval: null,
  reconnectAttempts: 0,
  maxReconnectAttempts: 5,

  connect() {
    if (!State.apiKey) return;

    try {
      const wsUrl = `${CONFIG.WS_URL}?api_key=${encodeURIComponent(State.apiKey)}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log("WebSocket connected");
        State.wsConnected = true;
        this.reconnectAttempts = 0;
        UI.updateWSStatus("connected");
        this.startPing();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (e) {
          console.error("Failed to parse WebSocket message:", e);
        }
      };

      this.ws.onclose = () => {
        console.log("WebSocket closed");
        State.wsConnected = false;
        UI.updateWSStatus("disconnected");
        this.stopPing();
        this.attemptReconnect();
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        UI.updateWSStatus("error");
      };
    } catch (error) {
      console.error("Failed to connect WebSocket:", error);
      UI.updateWSStatus("error");
    }
  },

  disconnect() {
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  },

  startPing() {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, CONFIG.PING_INTERVAL);
  },

  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  },

  attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      UI.updateWSStatus("connecting");
      setTimeout(() => this.connect(), 3000 * this.reconnectAttempts);
    }
  },

  handleMessage(data) {
    console.log("WebSocket message:", data);

    switch (data.type) {
      case "connection":
        UI.showToast("Connected to real-time notifications", "success");
        break;

      case "message_received":
        this.handleNewMessage(data.data);
        break;

      case "delivery_status":
        UI.showToast(`Message ${data.data.status}`, "info");
        break;

      case "friend_request":
        UI.showToast("New friend request received!", "info");
        DataLoader.loadFriends();
        break;

      case "group_invite":
        UI.showToast(`Invited to group!`, "info");
        DataLoader.loadGroups();
        break;

      case "pong":
        // Ping response, connection is alive
        break;

      default:
        console.log("Unknown event type:", data.type);
    }
  },

  handleNewMessage(data) {
    const message = Normalizers.message(data, {
      currentUsername: State.user?.username,
    });

    if (!message) {
      return;
    }

    Helpers.upsertMessage(message);

    // Show notification
    UI.showToast(`New message from ${message.counterpartLabel}`, "info");

    UI.renderOverviewMessages();
    UI.renderLogs();
    UI.renderConversations();
    UI.renderDevConversations();

    if (
      State.currentView === "messages" &&
      State.selectedChat === message.counterpart
    ) {
      UI.renderChat(message.counterpart);
    }

    if (
      State.currentView === "developer" &&
      State.selectedChat === message.counterpart
    ) {
      UI.renderDevChat(message.counterpart);
    }

    if (!State.selectedChat && message.counterpart) {
      if (State.currentView === "messages") {
        UI.selectChat(message.counterpart);
      }
      if (State.currentView === "developer") {
        UI.selectDevChat(message.counterpart);
      }
    }

    // Update notification dot
    UI.showNotificationDot();
  },
};

// ========================================
// Data Loader
// ========================================
const DataLoader = {
  async bootstrap(options = {}) {
    const user = Normalizers.user(
      await API.auth.me({
        authMode: options.authMode || "default",
      }),
    );

    if (!user) {
      throw new Error("Unable to load the current user");
    }

    State.user = user;
    State.save();
    UI.showDashboard();

    await this.loadAll();
  },

  async loadAll() {
    await Promise.all([
      this.loadAgents(),
      this.loadFriends(),
      this.loadRoles(),
      this.loadGroups(),
      this.loadLogFeed(),
      this.loadPolicies(),
      this.loadPromotionSuggestions(),
      this.loadPreferences(),
    ]);
  },

  async loadLogFeed() {
    await Promise.all([
      this.loadMessages(),
      this.loadReviewQueue(),
      this.loadBlockedEvents(),
    ]);
  },

  async loadAgents() {
    try {
      const agentsModel = Normalizers.agentsModel(await API.agents.list());
      const healthById = new Map();

      agentsModel.items.forEach((agent) => {
        const existingHealth = State.agentHealthById.get(agent.id);
        if (existingHealth) {
          healthById.set(agent.id, existingHealth);
        }
      });

      State.agentHealthById = healthById;
      Helpers.applyCollectionState("agents", "agentsById", agentsModel);
      if (
        State.selectedAgentId &&
        !State.agentsById.has(State.selectedAgentId)
      ) {
        State.selectedAgentId = null;
      }
      UI.updateAgentCount(State.agents.length);
      UI.renderAgents();
      UI.renderOverviewAgents();
      UI.renderDevDiagnostics();
      UI.renderDevMessagingSummary();
    } catch (error) {
      console.error("Failed to load agents:", error);
    }
  },

  async loadFriends() {
    try {
      const [accepted, pending, blocked] = await Promise.all([
        API.friends.list("accepted"),
        API.friends.list("pending"),
        API.friends.list("blocked"),
      ]);

      const acceptedFriendsModel = Normalizers.friendsModel(accepted);
      const pendingFriendsModel = Normalizers.friendsModel(pending);
      const blockedFriendsModel = Normalizers.friendsModel(blocked);
      const allFriendsModel = Helpers.mergeCollectionModels(
        [acceptedFriendsModel, pendingFriendsModel, blockedFriendsModel],
        (friend) => friend.friendshipId,
      );

      Helpers.applyCollectionState("friends", "friendsById", allFriendsModel);
      const activeFriendUsernames = new Set(
        allFriendsModel.items
          .map((friend) => Helpers.string(friend?.username).toLowerCase())
          .filter(Boolean),
      );

      State.contactConnectionsByUsername.forEach((_value, username) => {
        if (!activeFriendUsernames.has(username)) {
          State.contactConnectionsByUsername.delete(username);
        }
      });

      if (
        State.selectedNetworkFriendId &&
        !State.friendsById.has(State.selectedNetworkFriendId)
      ) {
        State.selectedNetworkFriendId = null;
      }

      UI.updateFriendCount(acceptedFriendsModel.items.length);
      UI.updateNetworkRelationshipCounts(allFriendsModel.items);
      UI.renderFriends();
      UI.renderOverviewFriends();
      UI.renderConversations();
      UI.renderDevConversations();
      UI.renderDevMessagingSummary();
      if (State.selectedChat) {
        UI.renderChat(State.selectedChat);
        const selectedDeveloperFriend = State.friends.find(
          (friend) =>
            friend.status === "accepted" &&
            friend.username === State.selectedChat,
        );
        if (selectedDeveloperFriend) {
          UI.renderDevChat(State.selectedChat);
        }
      }
      if (State.currentView === "developer") {
        UI.renderDeveloperConsole();
      }
      if (State.currentView === "boundaries") {
        UI.renderPolicies();
      }

      void this.loadAcceptedContactReadiness(allFriendsModel.items);
    } catch (error) {
      console.error("Failed to load friends:", error);
    }
  },

  async loadAcceptedContactReadiness(friends = State.friends) {
    const acceptedFriends = (Array.isArray(friends) ? friends : []).filter(
      (friend) => UI.networkBucket(friend) === "accepted",
    );

    await Promise.allSettled(
      acceptedFriends.map((friend) =>
        UI.ensureNetworkConnectionData(friend, {
          renderSelected: State.selectedNetworkFriendId === friend.friendshipId,
        }),
      ),
    );
  },

  async loadRoles() {
    State.availableRolesStatus = "loading";
    State.availableRolesError = null;

    try {
      const rolesModel = Normalizers.rolesModel(await API.roles.list());
      Helpers.applyCollectionState(
        "availableRoles",
        "availableRolesByName",
        rolesModel,
      );
      State.availableRolesStatus = "loaded";
      State.availableRolesError = null;
    } catch (error) {
      State.availableRoles = [];
      State.availableRolesByName = new Map();
      State.availableRolesStatus = "error";
      State.availableRolesError =
        error.message || "Failed to load available roles.";
      console.error("Failed to load roles:", error);
    }

    if (State.selectedNetworkFriendId) {
      UI.renderNetworkConnectionSpace(
        State.friendsById.get(State.selectedNetworkFriendId) || null,
      );
    }

    if (State.currentView === "boundaries") {
      UI.renderPolicies();
    }
  },

  async loadGroups() {
    try {
      const groupsModel = Normalizers.groupsModel(await API.groups.list());
      Helpers.applyCollectionState("groups", "groupsById", groupsModel);
      if (
        State.selectedGroupId &&
        !State.groupsById.has(State.selectedGroupId)
      ) {
        State.selectedGroupId = null;
      }

      State.groupDetailsById.forEach((_value, groupId) => {
        if (!State.groupsById.has(groupId)) {
          State.groupDetailsById.delete(groupId);
        }
      });

      State.groupMembersByGroupId.forEach((_value, groupId) => {
        if (!State.groupsById.has(groupId)) {
          State.groupMembersByGroupId.delete(groupId);
        }
      });

      UI.updateGroupCount(State.groups.length);
      UI.renderGroups();
      UI.renderOverviewGroups();
      if (State.currentView === "boundaries") {
        UI.renderPolicies();
      }
    } catch (error) {
      console.error("Failed to load groups:", error);
    }
  },

  async loadMessages() {
    try {
      const messagesModel = Normalizers.messagesModel(
        await API.messages.list({ limit: 50 }),
        {
          currentUsername: State.user?.username,
        },
      );
      Helpers.applyCollectionState("messages", "messagesById", messagesModel);
      Helpers.rebuildConversations();
      UI.renderConversations();
      UI.renderDevConversations();
      if (State.selectedChat) {
        UI.renderChat(State.selectedChat);
        UI.renderDevChat(State.selectedChat);
      }
      UI.renderOverviewMessages();
      UI.renderLogs();
    } catch (error) {
      console.error("Failed to load messages:", error);
    }
  },

  async loadPolicies() {
    try {
      const policiesModel = Normalizers.policiesModel(
        await API.policies.list(),
      );
      Helpers.applyCollectionState("policies", "policiesById", policiesModel);
      State.policyProvenanceById.forEach((_value, policyId) => {
        if (!State.policiesById.has(policyId)) {
          State.policyProvenanceById.delete(policyId);
        }
      });
      UI.renderPolicies(State.boundaryScopeFilter);
    } catch (error) {
      console.error("Failed to load policies:", error);
    }
  },

  async loadPromotionSuggestions() {
    State.promotionSuggestionsStatus = "loading";
    State.promotionSuggestionsError = null;
    UI.renderPolicies(State.boundaryScopeFilter);

    try {
      const payload = await API.plugin.promotionSuggestions({ limit: 20 });
      State.promotionSuggestionLearning =
        Normalizers.promotionSuggestionLearning(payload);
      const suggestionsModel = Normalizers.promotionSuggestionsModel(payload);
      Helpers.applyCollectionState(
        "promotionSuggestions",
        "promotionSuggestionsById",
        suggestionsModel,
      );
      State.promotionSuggestionsStatus = "loaded";
      State.promotionSuggestionsError = null;
      UI.renderPolicies(State.boundaryScopeFilter);
    } catch (error) {
      State.promotionSuggestionLearning = null;
      State.promotionSuggestions = [];
      State.promotionSuggestionsById = new Map();
      State.promotionSuggestionsStatus = "error";
      State.promotionSuggestionsError =
        error.message || "Failed to load promotion suggestions.";
      UI.renderPolicies(State.boundaryScopeFilter);
      console.error("Failed to load promotion suggestions:", error);
    }
  },

  async loadPreferences() {
    try {
      State.preferences = Normalizers.preferences(await API.preferences.get());
      UI.renderSettings();
    } catch (error) {
      State.preferences = null;
      console.error("Failed to load preferences:", error);
    }
  },

  async loadReviewQueue() {
    try {
      const payload = await API.plugin.reviews({ limit: 25 });
      State.reviewQueue = Normalizers.reviewQueue(payload);
      const reviewsModel = Normalizers.reviewsModel(payload);
      Helpers.applyCollectionState("reviews", "reviewsById", reviewsModel);
      UI.renderOverviewMessages();
      UI.renderLogs();
    } catch (error) {
      State.reviewQueue = null;
      State.reviews = [];
      State.reviewsById = new Map();
      Helpers.rebuildAuditLog();
      UI.renderOverviewMessages();
      UI.renderLogs();
      console.error("Failed to load review queue:", error);
    }
  },

  async loadBlockedEvents() {
    try {
      const payload = await API.plugin.blockedEvents({
        limit: 25,
        includePayloadExcerpt: true,
      });
      State.blockedEventRetention = Normalizers.blockedEventRetention(payload);
      const blockedEventsModel = Normalizers.blockedEventsModel(payload);
      Helpers.applyCollectionState(
        "blockedEvents",
        "blockedEventsById",
        blockedEventsModel,
      );
      UI.renderOverviewMessages();
      UI.renderLogs();
    } catch (error) {
      State.blockedEventRetention = null;
      State.blockedEvents = [];
      State.blockedEventsById = new Map();
      Helpers.rebuildAuditLog();
      UI.renderOverviewMessages();
      UI.renderLogs();
      console.error("Failed to load blocked events:", error);
    }
  },
};

// ========================================
// UI Manager
// ========================================
const UI = {
  browserLoginPollTimer: null,

  // Initialize UI
  init() {
    this.bindEvents();
    this.renderBrowserLogin();
    this.checkAuth();
  },

  // Check authentication status
  async checkAuth() {
    const storedSession = State.readStoredSession();

    try {
      State.apiKey = null;
      State.user = null;
      await DataLoader.bootstrap({ authMode: "omit" });
      WebSocketManager.connect();
      return;
    } catch (error) {
      const isAuthFailure = error?.status === 401 || error?.status === 403;
      if (!isAuthFailure) {
        console.error("Failed to resume browser session:", error);
      }
      State.apiKey = null;
      State.user = null;
    }

    if (storedSession.apiKey) {
      State.apiKey = storedSession.apiKey;
      State.user = storedSession.user;

      try {
        await DataLoader.bootstrap();
        WebSocketManager.connect();
      } catch (error) {
        console.error("Failed to resume dashboard session:", error);
        State.clear();
        this.showLanding();
        this.showToast(
          "Session expired. Sign in with your agent or use the advanced API-key fallback.",
          "error",
        );
      }
      return;
    }

    this.showLanding();
  },

  // Bind all event listeners
  bindEvents() {
    document
      .getElementById("agent-login-form")
      ?.addEventListener("submit", (e) => {
        e.preventDefault();
        this.handleAgentBrowserLogin();
      });

    document
      .getElementById("agent-login-reset")
      ?.addEventListener("click", () => {
        this.resetBrowserLogin({ preserveUsername: true });
      });

    document
      .getElementById("agent-login-retry")
      ?.addEventListener("click", () => {
        this.handleAgentBrowserLogin();
      });

    document
      .getElementById("agent-login-continue")
      ?.addEventListener("click", () => {
        this.redeemBrowserLoginAttempt();
      });

    // Advanced API-key fallback form
    document.getElementById("login-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.handleLogin();
    });

    // Toggle password
    document
      .querySelector(".toggle-password")
      ?.addEventListener("click", (e) => {
        const input = document.getElementById("login-api-key");
        input.type = input.type === "password" ? "text" : "password";
        e.target.textContent = input.type === "password" ? "👁️" : "🙈";
      });

    // Navigation
    document.querySelectorAll(".nav-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        const view = e.currentTarget.dataset.view;
        this.switchView(view);
      });
    });

    // User menu
    document.getElementById("user-menu-btn").addEventListener("click", () => {
      this.showModal("user-profile-modal");
      this.renderProfile();
    });

    // Modal close buttons
    document.querySelectorAll(".modal-close, [data-close]").forEach((btn) => {
      btn.addEventListener("click", () => this.hideModals());
    });

    document.getElementById("modal-overlay").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) this.hideModals();
    });

    // Add agent buttons
    document.getElementById("add-agent-btn")?.addEventListener("click", () => {
      this.openAgentEditor();
    });

    document
      .getElementById("add-agent-quick")
      ?.addEventListener("click", () => {
        this.openAgentEditor();
      });

    document
      .getElementById("add-first-agent")
      ?.addEventListener("click", () => {
        this.openAgentEditor();
      });

    // Save agent
    document.getElementById("save-agent-btn")?.addEventListener("click", () => {
      this.handleSaveAgent();
    });

    document.getElementById("agent-mode")?.addEventListener("change", () => {
      this.updateAgentModeFields();
    });

    document
      .getElementById("agent-advanced-toggle")
      ?.addEventListener("click", () => {
        this.toggleAgentAdvancedFields();
      });

    document
      .getElementById("agent-rotate-secret")
      ?.addEventListener("change", () => {
        this.syncAgentSecretControls();
      });

    document
      .getElementById("agent-public-key")
      ?.addEventListener("input", () => {
        this.syncAgentPublicKeyFields();
      });

    document
      .getElementById("agent-callback-secret")
      ?.addEventListener("input", () => {
        this.syncAgentSecretControls();
      });

    // Find friends
    document.getElementById("find-users-btn")?.addEventListener("click", () => {
      this.openAddFriendModal();
    });

    document
      .getElementById("find-friends-quick")
      ?.addEventListener("click", () => {
        this.switchView("network");
        this.openAddFriendModal();
      });

    document
      .getElementById("add-friend-form")
      ?.addEventListener("submit", (e) => {
        e.preventDefault();
        this.handleAddFriendRequest();
      });

    document
      .getElementById("send-friend-request-btn")
      ?.addEventListener("click", () => {
        this.handleAddFriendRequest();
      });

    document.getElementById("user-search")?.addEventListener("input", (e) => {
      State.networkSearch = e.currentTarget.value || "";
      this.renderFriends();
    });

    // Create group
    document
      .getElementById("create-group-btn")
      ?.addEventListener("click", () => {
        this.showModal("create-group-modal");
      });

    document.getElementById("save-group-btn")?.addEventListener("click", () => {
      this.handleCreateGroup();
    });

    document.getElementById("group-search")?.addEventListener("input", (e) => {
      State.groupSearch = e.currentTarget.value || "";
      this.renderGroups();
    });

    // Create boundary
    document
      .getElementById("create-policy-btn")
      ?.addEventListener("click", () => {
        this.openBoundaryEditor();
      });

    document
      .getElementById("create-first-policy")
      ?.addEventListener("click", () => {
        this.openBoundaryEditor();
      });

    document
      .getElementById("save-policy-btn")
      ?.addEventListener("click", () => {
        this.handleCreatePolicy();
      });

    document
      .getElementById("policy-category")
      ?.addEventListener("change", (e) => {
        this.populateBoundaryPresetOptions(e.target.value);
        this.renderBoundaryEditorPreview();
      });

    document.getElementById("policy-effect")?.addEventListener("change", () => {
      this.renderBoundaryEditorPreview();
    });

    document.getElementById("policy-preset")?.addEventListener("change", () => {
      this.updateBoundaryPresetHint();
      this.renderBoundaryEditorPreview();
    });

    document
      .getElementById("policy-target-id")
      ?.addEventListener("change", () => {
        this.renderBoundaryEditorPreview();
      });

    // Boundary audience change
    document.getElementById("policy-scope")?.addEventListener("change", (e) => {
      this.populatePolicyTargets(e.target.value);
      this.renderBoundaryEditorPreview();
    });

    // Friend filters
    document.querySelectorAll(".friends-filters .filter-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const filterButton = e.currentTarget;
        document
          .querySelectorAll(".friends-filters .filter-btn")
          .forEach((b) => b.classList.remove("active"));
        filterButton.classList.add("active");
        State.networkFilter = filterButton.dataset.filter || "all";
        this.renderFriends();
      });
    });

    // Policy filters
    document.querySelectorAll(".policy-filters .filter-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const filterButton = e.currentTarget;
        document
          .querySelectorAll(".policy-filters .filter-btn")
          .forEach((b) => b.classList.remove("active"));
        filterButton.classList.add("active");
        State.boundaryScopeFilter = filterButton.dataset.scope || "all";
        this.renderPolicies(State.boundaryScopeFilter);
      });
    });

    document
      .getElementById("boundary-category-filters")
      ?.addEventListener("click", (e) => {
        const button = e.target.closest(".boundary-category-filter");
        if (!button) {
          return;
        }

        State.boundaryCategoryFilter = button.dataset.category || "all";
        this.renderPolicies(State.boundaryScopeFilter);
      });

    // Refresh agents
    document.getElementById("refresh-agents")?.addEventListener("click", () => {
      DataLoader.loadAgents();
      this.showToast("Sender connections refreshed", "success");
    });

    // View all messages (logs)
    document
      .getElementById("view-all-messages")
      ?.addEventListener("click", () => {
        this.switchView("logs");
      });

    // Refresh logs
    document
      .getElementById("refresh-logs-btn")
      ?.addEventListener("click", () => {
        DataLoader.loadLogFeed();
        this.showToast("Delivery logs refreshed", "success");
      });

    // Logs filters
    document
      .querySelectorAll(".logs-filters [data-direction]")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          document
            .querySelectorAll(".logs-filters [data-direction]")
            .forEach((b) => b.classList.remove("active"));
          e.target.classList.add("active");
          State.logDirectionFilter = Helpers.normalizeLogDirectionFilter(
            e.target.dataset.direction,
          );
          this.renderLogs();
        });
      });
    document
      .querySelectorAll(".logs-state-filters [data-state]")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          document
            .querySelectorAll(".logs-state-filters [data-state]")
            .forEach((b) => b.classList.remove("active"));
          e.target.classList.add("active");
          State.logStateFilter = Helpers.normalizeLogStateFilter(
            e.target.dataset.state,
          );
          this.renderLogs();
        });
      });

    // Logout
    document.getElementById("logout-btn")?.addEventListener("click", () => {
      this.handleLogout();
    });

    // Save preferences
    document
      .getElementById("save-preferences-btn")
      ?.addEventListener("click", () => {
        this.handleSavePreferences();
      });

    document
      .getElementById("notifications-btn")
      ?.addEventListener("click", () => {
        this.switchView("logs");
        this.hideNotificationDot();
      });

    // Quiet hours toggle
    document
      .getElementById("pref-quiet-enabled")
      ?.addEventListener("change", (e) => {
        const row = document.getElementById("quiet-hours-row");
        row.classList.toggle("hidden", !e.target.checked);
      });

    // Rotate API key
    document
      .getElementById("rotate-api-key-btn")
      ?.addEventListener("click", () => {
        this.handleRotateKey();
      });

    // Copy buttons
    document.getElementById("copy-api-key")?.addEventListener("click", () => {
      this.copyToClipboard(document.getElementById("new-api-key").textContent);
    });

    document
      .getElementById("copy-callback-secret")
      ?.addEventListener("click", () => {
        this.copyToClipboard(
          document.getElementById("new-callback-secret").textContent,
        );
      });

    // Send test message (developer)
    document
      .getElementById("send-message-btn")
      ?.addEventListener("click", () => {
        this.handleSendMessage();
      });

    document.getElementById("chat-input")?.addEventListener("keypress", (e) => {
      if (e.key === "Enter") this.handleSendMessage();
    });

    document
      .getElementById("dev-send-message-btn")
      ?.addEventListener("click", () => {
        this.handleSendTestMessage();
      });

    document
      .getElementById("dev-chat-input")
      ?.addEventListener("keypress", (e) => {
        if (e.key === "Enter") this.handleSendTestMessage();
      });

    // Developer API key actions
    document
      .getElementById("dev-copy-api-key")
      ?.addEventListener("click", () => {
        this.copyToClipboard(State.apiKey);
      });

    document
      .getElementById("dev-toggle-api-key")
      ?.addEventListener("click", () => {
        this.toggleDevApiKeyVisibility();
      });

    document
      .getElementById("dev-rotate-api-key")
      ?.addEventListener("click", () => {
        this.handleRotateKey();
      });

    document
      .getElementById("dev-open-connections-btn")
      ?.addEventListener("click", () => {
        this.switchView("connections");
      });

    // Landing page: hamburger menu
    document
      .getElementById("landing-hamburger")
      ?.addEventListener("click", () => {
        document
          .getElementById("landing-mobile-menu")
          ?.classList.toggle("open");
      });

    // Landing page: close mobile menu on link click
    document.querySelectorAll(".landing-mobile-link").forEach((link) => {
      link.addEventListener("click", () => {
        document
          .getElementById("landing-mobile-menu")
          ?.classList.remove("open");
      });
    });

    // Landing page: waitlist form
    document
      .getElementById("waitlist-form")
      ?.addEventListener("submit", (e) => {
        e.preventDefault();
        this.handleWaitlistSubmit();
      });

    // Landing page: smooth scroll for nav links
    document
      .querySelectorAll(
        '.landing-nav a[href^="#"], .hero-cta-link[href^="#"], .browser-access-link[href^="#"]',
      )
      .forEach((link) => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          const target = document.querySelector(link.getAttribute("href"));
          if (target) target.scrollIntoView({ behavior: "smooth" });
          document
            .getElementById("landing-mobile-menu")
            ?.classList.remove("open");
        });
      });
  },

  normalizeBrowserLoginAttempt(value) {
    const record = Helpers.record(value);

    return {
      attemptId: Helpers.nullableString(record.attempt_id),
      browserToken: Helpers.nullableString(record.browser_token),
      approvalCode: Helpers.nullableString(record.approval_code),
      expiresAt: Helpers.iso(record.expires_at),
      approvedAt: Helpers.iso(record.approved_at),
      deniedAt: Helpers.iso(record.denied_at),
      redeemedAt: Helpers.iso(record.redeemed_at),
      status: Helpers.string(record.status, "pending"),
    };
  },

  clearBrowserLoginPolling() {
    if (this.browserLoginPollTimer) {
      clearTimeout(this.browserLoginPollTimer);
      this.browserLoginPollTimer = null;
    }
  },

  scheduleBrowserLoginPoll() {
    this.clearBrowserLoginPolling();

    const status = State.browserLogin?.status;
    if (
      !State.browserLogin?.attemptId ||
      !State.browserLogin?.browserToken ||
      !["pending", "approved"].includes(status)
    ) {
      return;
    }

    this.browserLoginPollTimer = setTimeout(() => {
      this.pollBrowserLoginAttempt();
    }, CONFIG.BROWSER_LOGIN_POLL_INTERVAL_MS);
  },

  resetBrowserLogin(options = {}) {
    this.clearBrowserLoginPolling();
    const usernameInput = document.getElementById("agent-login-username");
    const preservedUsername = options.preserveUsername
      ? Helpers.string(usernameInput?.value)
      : "";

    State.browserLogin = createEmptyBrowserLoginState();
    State.browserLogin.username = preservedUsername;

    if (usernameInput) {
      usernameInput.value = preservedUsername;
    }

    this.renderBrowserLogin();
  },

  getBrowserLoginExpiryLabel(browserLogin = State.browserLogin) {
    const expiresAt = Helpers.timestampValue(browserLogin?.expiresAt);
    if (!expiresAt) {
      return "Not issued yet";
    }

    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      return `Expired at ${Helpers.formatDateTime(browserLogin.expiresAt)}`;
    }

    const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
    const relativeLabel =
      remainingMinutes === 1
        ? "in about 1 minute"
        : `in about ${remainingMinutes} minutes`;

    return `${relativeLabel} (${Helpers.formatDateTime(browserLogin.expiresAt)})`;
  },

  getBrowserLoginPresentation(browserLogin = State.browserLogin) {
    const login = browserLogin || createEmptyBrowserLoginState();
    const username = Helpers.string(login.username || "your username");
    const approvalCode = Helpers.string(login.approvalCode || "------");

    const base = {
      badge: "Waiting",
      title: "Enter your Mahilo username to begin",
      copy: "Mahilo will prepare a short approval code for your configured agent to approve.",
      instructions: "Ask your agent to approve the short code shown here.",
      guidance:
        "Mahilo browser access is invite-backed. If your account does not exist yet, finish invite setup in your agent first.",
      showContinue: false,
      showRetry: false,
      showReset: false,
      disableForm: false,
      showPanel: login.status !== "idle",
      submitLabel: "Start browser sign-in",
      state: login.status,
    };

    switch (login.status) {
      case "submitting":
        return {
          ...base,
          badge: "Starting",
          title: `Preparing a code for @${username}`,
          copy: "Checking that this invite-backed Mahilo account exists and generating a short approval code for your agent.",
          instructions:
            "Stay on this page. Mahilo will show the approval code as soon as the attempt is ready.",
          guidance:
            "If this username has not been created by your invited agent yet, finish onboarding there first or use the advanced API-key fallback for an existing account.",
          disableForm: true,
          showPanel: true,
          showReset: true,
          submitLabel: "Preparing code...",
        };
      case "pending":
        return {
          ...base,
          badge: "Pending approval",
          title: `Ask your agent to approve ${approvalCode}`,
          copy: `Mahilo is waiting for browser approval on @${username}. This page checks automatically and does not need a manual refresh.`,
          instructions: `In your configured agent, approve browser sign-in for @${username} using code ${approvalCode}.`,
          guidance:
            "If no agent is configured for this account yet, finish invite setup first. If approval does not arrive before the code expires, start another code or use the advanced API-key fallback.",
          disableForm: true,
          showPanel: true,
          showReset: true,
          submitLabel: "Waiting for approval...",
        };
      case "approved":
        return {
          ...base,
          badge: "Approved",
          title: `Code ${approvalCode} is approved`,
          copy: `Your configured agent approved browser access for @${username}. Continue to redeem the short-lived browser session before the code expires.`,
          instructions:
            "Continue to the dashboard now. Mahilo will redeem the approved attempt into a browser session.",
          guidance:
            "If you wait too long and the code expires, just start another code. The browser will not store a long-lived API key for this path.",
          disableForm: true,
          showPanel: true,
          showContinue: true,
          showReset: true,
          submitLabel: "Waiting for approval...",
        };
      case "redeeming":
        return {
          ...base,
          badge: "Signing in",
          title: "Opening your dashboard",
          copy: `Redeeming the approved browser session for @${username}.`,
          instructions:
            "Mahilo is exchanging the approved code for a short-lived browser session now.",
          guidance:
            "If this stalls, start another code or use the advanced API-key fallback for the same account.",
          disableForm: true,
          showPanel: true,
          submitLabel: "Signing in...",
        };
      case "expired":
        return {
          ...base,
          badge: "Expired",
          title: "That approval code expired",
          copy: `The approval request for @${username} timed out before sign-in finished.`,
          instructions:
            "Start another code, then ask your agent to approve the new code while it is still active.",
          guidance:
            "If approval keeps timing out, confirm your agent is online and that it is approving the right username. The advanced API-key fallback still works for existing accounts.",
          showPanel: true,
          showRetry: true,
          showReset: true,
          state: "expired",
        };
      case "denied":
        return {
          ...base,
          badge: "Denied",
          title: "Your agent declined this sign-in",
          copy: `The approval request for @${username} was denied before the browser session was redeemed.`,
          instructions:
            "Ask your agent to approve a new browser sign-in code if you still want dashboard access here.",
          guidance:
            "This usually means the wrong account or code was requested. Start another code after confirming the username, or use the advanced API-key fallback if appropriate.",
          showPanel: true,
          showRetry: true,
          showReset: true,
          state: "denied",
        };
      case "retry": {
        const missingAccountCodes = ["USER_NOT_FOUND", "USER_NOT_ACTIVE"];
        const reusedAttempt = login.errorCode === "LOGIN_ATTEMPT_ALREADY_REDEEMED";
        const invalidAttemptCodes = [
          "INVALID_BROWSER_LOGIN_TOKEN",
          "LOGIN_ATTEMPT_NOT_FOUND",
          "BROWSER_LOGIN_TOKEN_REQUIRED",
        ];

        let title = "Browser sign-in needs another try";
        let copy =
          login.errorMessage ||
          "Mahilo could not finish this browser sign-in attempt.";
        let guidance =
          "Start another code from this page, or use the advanced API-key fallback if you already have direct access to the invite-backed account.";

        if (missingAccountCodes.includes(login.errorCode)) {
          title = `No active Mahilo account found for @${username}`;
          copy =
            "Mahilo could not find an active invite-backed account for that username.";
          guidance =
            "Finish invite setup and registration in your configured agent first. If the account already exists, check the exact username or use the advanced API-key fallback.";
        } else if (reusedAttempt) {
          title = "That browser code was already used";
          copy =
            "This approval code was redeemed elsewhere and cannot be reused in this browser.";
          guidance =
            "Start another code here if you still need access in this browser window.";
        } else if (invalidAttemptCodes.includes(login.errorCode)) {
          title = "This browser approval attempt is no longer valid";
          copy =
            login.errorMessage ||
            "The stored approval attempt could not be resumed.";
          guidance =
            "Start another code from this page. If that keeps failing, fall back to an API key for the existing account.";
        }

        return {
          ...base,
          badge: "Retry",
          title,
          copy,
          instructions:
            "Enter or confirm the Mahilo username above, then request a fresh approval code.",
          guidance,
          showPanel: true,
          showRetry: true,
          showReset: true,
          state: "retry",
        };
      }
      default:
        return base;
    }
  },

  renderBrowserLogin() {
    const browserLogin = State.browserLogin || createEmptyBrowserLoginState();
    const presentation = this.getBrowserLoginPresentation(browserLogin);
    const usernameInput = document.getElementById("agent-login-username");
    const submitButton = document.getElementById("agent-login-submit");
    const statusPanel = document.getElementById("agent-login-status");
    const statusBadge = document.getElementById("agent-login-status-badge");
    const statusTitle = document.getElementById("agent-login-status-title");
    const statusCopy = document.getElementById("agent-login-status-copy");
    const approvalCode = document.getElementById("agent-login-approval-code");
    const expiry = document.getElementById("agent-login-expiry");
    const instructions = document.getElementById("agent-login-instructions");
    const guidance = document.getElementById("agent-login-guidance");
    const continueButton = document.getElementById("agent-login-continue");
    const retryButton = document.getElementById("agent-login-retry");
    const resetButton = document.getElementById("agent-login-reset");

    if (usernameInput && browserLogin.username && !usernameInput.value) {
      usernameInput.value = browserLogin.username;
    }

    if (usernameInput) {
      usernameInput.disabled = presentation.disableForm;
    }

    if (submitButton) {
      submitButton.disabled = presentation.disableForm;
      submitButton.textContent = presentation.submitLabel;
    }

    if (statusPanel) {
      statusPanel.classList.toggle("hidden", !presentation.showPanel);
      statusPanel.dataset.state = presentation.state || "idle";
    }

    if (statusBadge) {
      statusBadge.textContent = presentation.badge;
    }

    if (statusTitle) {
      statusTitle.textContent = presentation.title;
    }

    if (statusCopy) {
      statusCopy.textContent = presentation.copy;
    }

    if (approvalCode) {
      approvalCode.textContent = browserLogin.approvalCode || "------";
    }

    if (expiry) {
      expiry.textContent = this.getBrowserLoginExpiryLabel(browserLogin);
    }

    if (instructions) {
      instructions.textContent = presentation.instructions;
    }

    if (guidance) {
      guidance.innerHTML = `<strong>Fallback guidance:</strong> ${Helpers.escapeHtml(
        presentation.guidance,
      )}`;
    }

    if (continueButton) {
      continueButton.classList.toggle("hidden", !presentation.showContinue);
      continueButton.disabled = browserLogin.status === "redeeming";
    }

    if (retryButton) {
      retryButton.classList.toggle("hidden", !presentation.showRetry);
      retryButton.disabled = browserLogin.status === "submitting";
    }

    if (resetButton) {
      resetButton.classList.toggle("hidden", !presentation.showReset);
      resetButton.disabled = browserLogin.status === "redeeming";
    }
  },

  async handleAgentBrowserLogin() {
    const usernameInput = document.getElementById("agent-login-username");
    if (!usernameInput) {
      this.showToast("Agent-backed browser sign-in is unavailable here.", "error");
      return;
    }

    const username = Helpers.string(usernameInput.value).trim().toLowerCase();
    if (!username) {
      this.showToast("Enter your Mahilo username to request an approval code.", "error");
      return;
    }

    this.clearBrowserLoginPolling();
    State.browserLogin = {
      ...createEmptyBrowserLoginState(),
      status: "submitting",
      username,
    };
    this.renderBrowserLogin();

    try {
      const started = this.normalizeBrowserLoginAttempt(
        await API.auth.browserLogin.start(username),
      );
      State.browserLogin = {
        ...createEmptyBrowserLoginState(),
        ...started,
        username,
      };
      this.renderBrowserLogin();
      this.scheduleBrowserLoginPoll();
    } catch (error) {
      this.applyBrowserLoginError(error, { username });
    }
  },

  applyBrowserLoginError(error, options = {}) {
    this.clearBrowserLoginPolling();

    const preservedState =
      options.preserveAttempt && State.browserLogin
        ? {
            attemptId: State.browserLogin.attemptId,
            browserToken: State.browserLogin.browserToken,
            approvalCode: State.browserLogin.approvalCode,
            expiresAt: State.browserLogin.expiresAt,
            approvedAt: State.browserLogin.approvedAt,
            deniedAt: State.browserLogin.deniedAt,
            redeemedAt: State.browserLogin.redeemedAt,
          }
        : {};

    const status =
      error?.code === "LOGIN_ATTEMPT_EXPIRED"
        ? "expired"
        : error?.code === "LOGIN_ATTEMPT_DENIED"
          ? "denied"
          : "retry";

    State.browserLogin = {
      ...createEmptyBrowserLoginState(),
      ...preservedState,
      status,
      username: options.username || State.browserLogin?.username || "",
      errorCode: error?.code || null,
      errorMessage: error?.message || "Mahilo could not finish browser sign-in.",
    };

    this.renderBrowserLogin();
  },

  async pollBrowserLoginAttempt() {
    const browserLogin = State.browserLogin;
    if (!browserLogin?.attemptId || !browserLogin?.browserToken) {
      return;
    }

    try {
      const update = this.normalizeBrowserLoginAttempt(
        await API.auth.browserLogin.status(
          browserLogin.attemptId,
          browserLogin.browserToken,
        ),
      );

      State.browserLogin = {
        ...State.browserLogin,
        ...update,
        attemptId: update.attemptId || State.browserLogin.attemptId,
        approvalCode: update.approvalCode || State.browserLogin.approvalCode,
        browserToken: update.browserToken || State.browserLogin.browserToken,
      };

      if (update.status === "redeemed") {
        State.browserLogin.status = "retry";
        State.browserLogin.errorCode = "LOGIN_ATTEMPT_ALREADY_REDEEMED";
        State.browserLogin.errorMessage =
          "This approval code has already been redeemed in another browser session.";
      }

      this.renderBrowserLogin();
      this.scheduleBrowserLoginPoll();
    } catch (error) {
      this.applyBrowserLoginError(error, {
        preserveAttempt: true,
      });
    }
  },

  async redeemBrowserLoginAttempt() {
    const browserLogin = State.browserLogin;
    if (!browserLogin?.attemptId || !browserLogin?.browserToken) {
      this.showToast("Start browser sign-in again to continue.", "error");
      return;
    }

    this.clearBrowserLoginPolling();
    State.browserLogin = {
      ...State.browserLogin,
      status: "redeeming",
      errorCode: null,
      errorMessage: null,
    };
    this.renderBrowserLogin();

    try {
      await API.auth.browserLogin.redeem(
        browserLogin.attemptId,
        browserLogin.browserToken,
      );

      State.apiKey = null;
      await DataLoader.bootstrap({ authMode: "omit" });
      WebSocketManager.connect();
      this.showToast("Signed in with agent approval", "success");
    } catch (error) {
      this.applyBrowserLoginError(error, {
        preserveAttempt: true,
        username: browserLogin.username,
      });
    }
  },

  // Handle login
  async handleLogin() {
    const apiKeyInput = document.getElementById("login-api-key");
    if (!apiKeyInput) {
      this.showToast(
        "Advanced API-key sign-in is unavailable on this page.",
        "error",
      );
      return;
    }

    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      this.showToast(
        "Enter your API key to use the advanced browser fallback.",
        "error",
      );
      return;
    }

    State.apiKey = apiKey;

    try {
      await DataLoader.bootstrap();
      WebSocketManager.connect();
      this.showToast("Welcome back!", "success");
    } catch (error) {
      State.apiKey = null;
      State.user = null;
      State.save();
      this.showToast(
        "Invalid API key. Browser signup is not self-serve; this fallback only works for existing invite-backed accounts.",
        "error",
      );
    }
  },

  // Handle save preferences
  async handleSavePreferences() {
    const prefs = {
      preferred_channel: document.getElementById("pref-channel").value || null,
      urgent_behavior: document.getElementById("pref-urgent").value,
      quiet_hours: {
        enabled: document.getElementById("pref-quiet-enabled").checked,
        start: document.getElementById("pref-quiet-start").value,
        end: document.getElementById("pref-quiet-end").value,
        timezone: document.getElementById("pref-quiet-timezone").value,
      },
      default_llm_provider:
        document.getElementById("pref-llm-provider").value || null,
      default_llm_model:
        document.getElementById("pref-llm-model").value || null,
    };

    try {
      await API.preferences.update(prefs);
      this.showToast("Settings saved successfully", "success");
    } catch (error) {
      this.showToast(error.message || "Failed to save settings", "error");
    }
  },

  // Handle logout
  async handleLogout() {
    WebSocketManager.disconnect();
    this.clearBrowserLoginPolling();
    let toastMessage = "Logged out successfully";
    let toastTone = "success";

    try {
      await API.auth.logout({ authMode: "omit" });
    } catch (error) {
      console.error("Failed to clear browser session during logout:", error);
      toastMessage =
        "Signed out locally, but Mahilo could not confirm that the browser session was cleared.";
      toastTone = "error";
    }

    State.clear();
    this.hideModals();
    this.showLanding();
    this.showToast(toastMessage, toastTone);
  },

  // Handle waitlist form submission
  async handleWaitlistSubmit() {
    const emailInput = document.getElementById("waitlist-email");
    const submitBtn = document.getElementById("waitlist-submit-btn");
    const btnText = submitBtn.querySelector(".waitlist-btn-text");
    const btnLoading = submitBtn.querySelector(".waitlist-btn-loading");
    const btnSuccess = submitBtn.querySelector(".waitlist-btn-success");
    const email = emailInput.value.trim();

    if (!email) return;

    // Show loading
    btnText.classList.add("hidden");
    btnLoading.classList.remove("hidden");
    submitBtn.disabled = true;

    try {
      await API.waitlist.join(email);

      // Show success
      btnLoading.classList.add("hidden");
      btnSuccess.classList.remove("hidden");

      // Hide form, show confirmation
      setTimeout(() => {
        document.getElementById("waitlist-form").classList.add("hidden");
        document
          .getElementById("waitlist-confirmation")
          .classList.remove("hidden");
      }, 800);
    } catch (error) {
      // Reset button
      btnLoading.classList.add("hidden");
      btnText.classList.remove("hidden");
      submitBtn.disabled = false;
      this.showToast(
        error.message || "Something went wrong. Try again.",
        "error",
      );
    }
  },

  // Handle rotate API key
  async handleRotateKey() {
    try {
      const result = await API.auth.rotateKey();
      State.apiKey = result.api_key;
      State.save();

      document.getElementById("new-api-key").textContent = result.api_key;
      this.renderDevApiKey();
      this.hideModals();
      this.showModal("api-key-modal");

      // Reconnect WebSocket with new key
      WebSocketManager.disconnect();
      WebSocketManager.connect();

      this.showToast("API key regenerated successfully", "success");
    } catch (error) {
      this.showToast("Failed to rotate API key", "error");
    }
  },

  setAgentAdvancedFieldsVisible(visible) {
    const advancedPanel = document.getElementById("agent-advanced-panel");
    const advancedToggle = document.getElementById("agent-advanced-toggle");

    if (advancedPanel) {
      advancedPanel.classList.toggle("hidden", !visible);
    }

    if (advancedToggle) {
      advancedToggle.textContent = visible
        ? "Hide Advanced Fields"
        : "Advanced Fields";
    }
  },

  updateAgentSaveLabel(overrideLabel = null) {
    const form = document.getElementById("add-agent-form");
    const saveLabel = document.getElementById("save-agent-label");
    const saveButton = document.getElementById("save-agent-btn");
    const isEdit = form?.dataset.mode === "edit";
    const defaultLabel = isEdit ? "Update Connection" : "Create Connection";

    if (saveLabel) {
      saveLabel.textContent = overrideLabel || defaultLabel;
    }

    if (saveButton) {
      saveButton.dataset.defaultLabel = defaultLabel;
    }
  },

  setAgentFormPending(pending) {
    const saveButton = document.getElementById("save-agent-btn");

    if (saveButton) {
      saveButton.disabled = pending;
    }

    this.updateAgentSaveLabel(
      pending
        ? document.getElementById("add-agent-form")?.dataset.mode === "edit"
          ? "Updating..."
          : "Creating..."
        : null,
    );
  },

  resetAgentEditor() {
    const form = document.getElementById("add-agent-form");
    const framework = document.getElementById("agent-framework");
    const label = document.getElementById("agent-label");
    const description = document.getElementById("agent-description");
    const mode = document.getElementById("agent-mode");
    const callback = document.getElementById("agent-callback");
    const routingPriority = document.getElementById("agent-routing-priority");
    const capabilities = document.getElementById("agent-capabilities");
    const callbackSecret = document.getElementById("agent-callback-secret");
    const rotateSecret = document.getElementById("agent-rotate-secret");
    const publicKey = document.getElementById("agent-public-key");
    const publicKeyAlg = document.getElementById("agent-public-key-alg");
    const title = document.getElementById("agent-modal-title");
    const copy = document.getElementById("agent-modal-copy");

    form?.reset?.();

    if (form) {
      form.dataset.mode = "create";
      form.dataset.connectionId = "";
    }

    if (framework) {
      framework.disabled = false;
      framework.value = "";
    }

    if (label) {
      label.disabled = false;
      label.value = "";
    }

    if (description) {
      description.value = "";
    }

    if (mode) {
      mode.value = "webhook";
    }

    if (callback) {
      callback.value = "";
    }

    if (routingPriority) {
      routingPriority.value = "0";
    }

    if (capabilities) {
      capabilities.value = "";
    }

    if (callbackSecret) {
      callbackSecret.value = "";
    }

    if (rotateSecret) {
      rotateSecret.checked = false;
    }

    if (publicKey) {
      publicKey.value = "";
    }

    if (publicKeyAlg) {
      publicKeyAlg.value = "ed25519";
    }

    if (title) {
      title.textContent = "🤖 Add Sender Connection";
    }

    if (copy) {
      copy.textContent =
        "Register a sender route that Mahilo can use on your behalf.";
    }

    this.setAgentAdvancedFieldsVisible(false);
    this.updateAgentModeFields();
    this.syncAgentPublicKeyFields();
    this.syncAgentSecretControls();
    this.setAgentFormPending(false);
  },

  openAgentEditor(agent = null) {
    const form = document.getElementById("add-agent-form");
    const framework = document.getElementById("agent-framework");
    const label = document.getElementById("agent-label");
    const description = document.getElementById("agent-description");
    const mode = document.getElementById("agent-mode");
    const callback = document.getElementById("agent-callback");
    const routingPriority = document.getElementById("agent-routing-priority");
    const capabilities = document.getElementById("agent-capabilities");
    const callbackSecret = document.getElementById("agent-callback-secret");
    const rotateSecret = document.getElementById("agent-rotate-secret");
    const publicKey = document.getElementById("agent-public-key");
    const publicKeyAlg = document.getElementById("agent-public-key-alg");
    const title = document.getElementById("agent-modal-title");
    const copy = document.getElementById("agent-modal-copy");

    if (
      !form ||
      !framework ||
      !label ||
      !description ||
      !mode ||
      !callback ||
      !routingPriority ||
      !capabilities ||
      !callbackSecret ||
      !rotateSecret ||
      !publicKey ||
      !publicKeyAlg
    ) {
      this.showToast("Sender connection editor is unavailable.", "error");
      return;
    }

    if (!agent) {
      this.resetAgentEditor();
      this.hideModals();
      this.showModal("add-agent-modal");
      return;
    }

    const connection =
      typeof agent === "string"
        ? this.getSenderConnectionWorkspaceItem(agent)
        : this.getSenderConnectionWorkspaceItem(agent.id);

    if (!connection) {
      this.showToast("Sender connection details are unavailable", "error");
      return;
    }

    form.dataset.mode = "edit";
    form.dataset.connectionId = connection.id;
    framework.disabled = true;
    framework.value = connection.framework;
    label.disabled = true;
    label.value = connection.label;
    description.value = connection.description || "";
    mode.value =
      connection.mode ||
      Helpers.connectionMode(connection.callbackUrl) ||
      "webhook";
    callback.value =
      mode.value === "polling" ? "" : Helpers.string(connection.callbackUrl);
    routingPriority.value = String(
      Helpers.number(connection.routingPriority, 0),
    );
    capabilities.value = Array.isArray(connection.capabilities)
      ? connection.capabilities.join(", ")
      : "";
    callbackSecret.value = "";
    rotateSecret.checked = false;
    publicKey.value = connection.publicKey || "";
    publicKeyAlg.value = connection.publicKeyAlg || "ed25519";

    if (title) {
      title.textContent = "✏️ Edit Sender Connection";
    }

    if (copy) {
      copy.textContent =
        "Framework and label identify the current connection. Use Add Connection if you need a new sender route.";
    }

    this.setAgentAdvancedFieldsVisible(
      Boolean(
        Helpers.number(connection.routingPriority, 0) ||
        (Array.isArray(connection.capabilities) &&
          connection.capabilities.length) ||
        connection.publicKey,
      ),
    );
    this.updateAgentModeFields();
    this.syncAgentPublicKeyFields();
    this.syncAgentSecretControls();
    this.setAgentFormPending(false);
    this.hideModals();
    this.showModal("add-agent-modal");
  },

  toggleAgentAdvancedFields() {
    const advancedPanel = document.getElementById("agent-advanced-panel");
    this.setAgentAdvancedFieldsVisible(
      Boolean(advancedPanel?.classList.contains("hidden")),
    );
  },

  updateAgentModeFields() {
    const mode = Helpers.string(
      document.getElementById("agent-mode")?.value,
      "webhook",
    );
    const callbackGroup = document.getElementById("agent-callback-group");
    const pollingNote = document.getElementById("agent-polling-note");
    const callbackInput = document.getElementById("agent-callback");
    const callbackSecretGroup = document.getElementById(
      "agent-callback-secret-group",
    );
    const rotateSecretGroup = document.getElementById(
      "agent-rotate-secret-group",
    );
    const rotateSecret = document.getElementById("agent-rotate-secret");

    const isPolling = mode === "polling";

    if (callbackGroup) {
      callbackGroup.classList.toggle("hidden", isPolling);
    }

    if (pollingNote) {
      pollingNote.classList.toggle("hidden", !isPolling);
    }

    if (callbackSecretGroup) {
      callbackSecretGroup.classList.toggle("hidden", isPolling);
    }

    if (rotateSecretGroup) {
      rotateSecretGroup.classList.toggle("hidden", isPolling);
    }

    if (callbackInput) {
      callbackInput.disabled = isPolling;
      callbackInput.required = !isPolling;
    }

    if (rotateSecret && isPolling) {
      rotateSecret.checked = false;
    }

    this.syncAgentSecretControls();
  },

  syncAgentPublicKeyFields() {
    const publicKey = document.getElementById("agent-public-key");
    const publicKeyAlg = document.getElementById("agent-public-key-alg");

    if (!publicKeyAlg) {
      return;
    }

    const hasPublicKey = Boolean(publicKey?.value?.trim());
    publicKeyAlg.disabled = !hasPublicKey;

    if (!hasPublicKey) {
      publicKeyAlg.value = "ed25519";
    }
  },

  syncAgentSecretControls() {
    const mode = Helpers.string(
      document.getElementById("agent-mode")?.value,
      "webhook",
    );
    const isPolling = mode === "polling";
    const callbackSecret = document.getElementById("agent-callback-secret");
    const callbackSecretHint = document.getElementById(
      "agent-callback-secret-hint",
    );
    const rotateSecret = document.getElementById("agent-rotate-secret");
    const hasManualSecret = Boolean(callbackSecret?.value?.trim());

    if (rotateSecret?.checked && hasManualSecret) {
      rotateSecret.checked = false;
    }

    if (callbackSecret) {
      callbackSecret.disabled = isPolling || Boolean(rotateSecret?.checked);
      if (rotateSecret?.checked) {
        callbackSecret.value = "";
      }
    }

    if (callbackSecretHint) {
      callbackSecretHint.textContent = isPolling
        ? "Polling connections do not use callback secrets."
        : rotateSecret?.checked
          ? "Mahilo will issue a fresh callback secret when you save this webhook connection."
          : "Leave blank to keep the current secret or let Mahilo generate one when needed.";
    }
  },

  // Handle save agent
  async handleSaveAgent() {
    const form = document.getElementById("add-agent-form");
    const mode = Helpers.string(
      document.getElementById("agent-mode")?.value,
      "webhook",
    );
    const framework = Helpers.string(
      document.getElementById("agent-framework")?.value,
    );
    const label = Helpers.string(document.getElementById("agent-label")?.value);
    const description = document
      .getElementById("agent-description")
      ?.value.trim();
    const callbackUrl = document.getElementById("agent-callback")?.value.trim();
    const routingPriorityRaw = document
      .getElementById("agent-routing-priority")
      ?.value.trim();
    const publicKey = document.getElementById("agent-public-key")?.value.trim();
    const publicKeyAlg = Helpers.string(
      document.getElementById("agent-public-key-alg")?.value,
      "ed25519",
    );
    const callbackSecret = document
      .getElementById("agent-callback-secret")
      ?.value.trim();
    const rotateSecret = Boolean(
      document.getElementById("agent-rotate-secret")?.checked,
    );
    const capabilitiesStr = document
      .getElementById("agent-capabilities")
      ?.value.trim();

    if (!framework || !label) {
      this.showToast("Framework and label are required", "error");
      return;
    }

    if (mode === "webhook" && !callbackUrl) {
      this.showToast(
        "Callback URL is required for webhook connections",
        "error",
      );
      return;
    }

    const routingPriority = Number(routingPriorityRaw || "0");
    if (
      !Number.isInteger(routingPriority) ||
      routingPriority < 0 ||
      routingPriority > 100
    ) {
      this.showToast(
        "Routing priority must be an integer between 0 and 100",
        "error",
      );
      return;
    }

    if (
      callbackSecret &&
      (callbackSecret.length < 16 || callbackSecret.length > 64)
    ) {
      this.showToast(
        "Callback secret must be between 16 and 64 characters",
        "error",
      );
      return;
    }

    const capabilities = capabilitiesStr
      ? capabilitiesStr
          .split(",")
          .map((capability) => capability.trim())
          .filter(Boolean)
      : [];

    this.setAgentFormPending(true);

    try {
      const result = await API.agents.register({
        framework,
        label,
        description: description || undefined,
        mode,
        callback_url: mode === "webhook" ? callbackUrl : undefined,
        callback_secret:
          mode === "webhook" && callbackSecret && !rotateSecret
            ? callbackSecret
            : undefined,
        public_key: publicKey || undefined,
        public_key_alg: publicKey ? publicKeyAlg : undefined,
        capabilities,
        rotate_secret: mode === "webhook" ? rotateSecret : undefined,
        routing_priority: routingPriority,
      });

      this.hideModals();

      if (result.callback_secret) {
        document.getElementById("new-callback-secret").textContent =
          result.callback_secret;
        this.showModal("callback-secret-modal");
      }

      this.resetAgentEditor();
      await DataLoader.loadAgents();

      this.showToast(
        result.updated
          ? "Connection updated successfully"
          : "Connection created successfully",
        "success",
      );
    } catch (error) {
      this.showToast(
        error.message || "Failed to save sender connection",
        "error",
      );
    } finally {
      if (form?.dataset.mode === "edit" || form?.dataset.mode === "create") {
        this.setAgentFormPending(false);
      }
    }
  },

  // Handle create group
  async handleCreateGroup() {
    const name = document.getElementById("group-name").value.trim();
    const description = document
      .getElementById("group-description")
      .value.trim();
    const inviteOnly = document.getElementById("group-invite-only").checked;

    if (!name) {
      this.showToast("Please enter a group name", "error");
      return;
    }

    try {
      const createdGroup = Normalizers.group(
        await API.groups.create({
          name,
          description,
          invite_only: inviteOnly,
        }),
      );

      if (createdGroup?.id) {
        State.selectedGroupId = createdGroup.id;
        State.groupDetailsById.delete(createdGroup.id);
        State.groupMembersByGroupId.delete(createdGroup.id);
      }

      await DataLoader.loadGroups();
      if (
        State.selectedGroupId &&
        State.groupsById.has(State.selectedGroupId)
      ) {
        await this.ensureGroupWorkspaceData(
          State.groupsById.get(State.selectedGroupId),
          { force: true },
        );
      }

      this.hideModals();
      document.getElementById("create-group-form").reset();
      this.showToast("Group created successfully", "success");
    } catch (error) {
      this.showToast(error.message || "Failed to create group", "error");
    }
  },

  defaultBoundaryEditorScope() {
    const scope = Helpers.string(State.boundaryScopeFilter, "global");
    return Object.prototype.hasOwnProperty.call(BOUNDARY_SCOPE_META, scope)
      ? scope
      : "global";
  },

  defaultBoundaryEditorCategory() {
    const category = Helpers.string(
      State.boundaryCategoryFilter,
      DEFAULT_BOUNDARY_CATEGORY,
    ).toLowerCase();
    return Object.prototype.hasOwnProperty.call(
      COMMON_BOUNDARY_PRESETS,
      category,
    )
      ? category
      : DEFAULT_BOUNDARY_CATEGORY;
  },

  getBoundaryEditorPolicy() {
    const form = document.getElementById("create-policy-form");
    const policyId = Helpers.nullableString(form?.dataset?.policyId);

    return policyId ? State.policiesById.get(policyId) || null : null;
  },

  getBoundaryEditorDraft() {
    const form = document.getElementById("create-policy-form");

    if (!form || Helpers.string(form.dataset.draftKind) !== "promotion") {
      return null;
    }

    return {
      action: Helpers.nullableString(form.dataset.draftAction) || "share",
      category: Helpers.string(
        form.dataset.draftCategory,
        DEFAULT_BOUNDARY_CATEGORY,
      ),
      categoryLabel: Helpers.nullableString(form.dataset.draftCategoryLabel),
      count: Helpers.number(form.dataset.draftCount, 0),
      direction: Helpers.string(form.dataset.draftDirection, "outbound"),
      effect: Helpers.string(form.dataset.draftEffect, DEFAULT_BOUNDARY_EFFECT),
      lookbackDays: Helpers.number(form.dataset.draftLookbackDays, 0),
      resource: Helpers.string(form.dataset.draftResource, "message.general"),
      scope: Helpers.string(form.dataset.draftScope, "global"),
      selectorLabel: Helpers.nullableString(form.dataset.draftSelectorLabel),
      selectorLocked: form.dataset.draftSelectorLocked === "true",
      suggestionId: Helpers.nullableString(form.dataset.draftSuggestionId),
      targetId: Helpers.nullableString(form.dataset.draftTargetId),
    };
  },

  setBoundaryEditorDraft(draft = null) {
    const form = document.getElementById("create-policy-form");
    const categoryInput = document.getElementById("policy-category");
    const presetInput = document.getElementById("policy-preset");

    if (!form) {
      return;
    }

    form.dataset.draftKind = draft ? "promotion" : "";
    form.dataset.draftSuggestionId = draft?.suggestionId || "";
    form.dataset.draftScope = draft?.scope || "";
    form.dataset.draftTargetId = draft?.targetId || "";
    form.dataset.draftDirection = draft?.direction || "";
    form.dataset.draftResource = draft?.resource || "";
    form.dataset.draftAction = draft?.action || "";
    form.dataset.draftEffect = draft?.effect || "";
    form.dataset.draftCount = String(
      typeof draft?.count === "number" && Number.isFinite(draft.count)
        ? draft.count
        : 0,
    );
    form.dataset.draftLookbackDays = String(
      typeof draft?.lookbackDays === "number" &&
        Number.isFinite(draft.lookbackDays)
        ? draft.lookbackDays
        : 0,
    );
    form.dataset.draftCategory = draft?.category || "";
    form.dataset.draftCategoryLabel = draft?.categoryLabel || "";
    form.dataset.draftSelectorLabel = draft?.selectorLabel || "";
    form.dataset.draftSelectorLocked = draft?.selectorLocked ? "true" : "";

    if (categoryInput) {
      categoryInput.disabled = false;
    }

    if (presetInput) {
      presetInput.disabled = false;
    }
  },

  boundaryAudienceEntityLabel(scope) {
    switch (Helpers.string(scope, "global")) {
      case "user":
        return "contact";
      case "role":
        return "role";
      case "group":
        return "group";
      default:
        return "audience";
    }
  },

  boundaryAudienceSelectionCopy(scope) {
    switch (Helpers.string(scope, "global")) {
      case "user":
        return "Choose the contact this boundary applies to.";
      case "role":
        return "Choose the trust role this boundary should cover.";
      case "group":
        return "Choose the group where this boundary should apply.";
      default:
        return "Global boundaries do not need a target.";
    }
  },

  boundaryAudienceEmptyState(scope) {
    switch (Helpers.string(scope, "global")) {
      case "user":
        return "Add an accepted contact in Network before creating a contact boundary.";
      case "role":
        if (State.availableRolesStatus === "loading") {
          return "Available roles are still loading.";
        }
        if (State.availableRolesStatus === "error") {
          return State.availableRolesError || "Failed to load available roles.";
        }
        return "Create or load a role before using a role boundary.";
      case "group":
        return "You need an active group where you are an owner or admin before using a group boundary.";
      default:
        return "Global boundaries do not need a target.";
    }
  },

  getBoundaryAudienceOptions(scope) {
    const normalizedScope = Helpers.string(scope, "global");

    if (normalizedScope === "user") {
      return State.friends
        .filter((friend) => {
          return this.networkBucket(friend) === "accepted" && friend.userId;
        })
        .slice()
        .sort((left, right) => {
          const leftLabel = Helpers.string(left.displayName || left.username);
          const rightLabel = Helpers.string(
            right.displayName || right.username,
          );
          return leftLabel.localeCompare(rightLabel);
        })
        .map((friend) => ({
          value: friend.userId,
          label: friend.displayName || friend.username,
        }));
    }

    if (normalizedScope === "role") {
      return State.availableRoles
        .slice()
        .sort((left, right) =>
          Helpers.string(left.name).localeCompare(Helpers.string(right.name)),
        )
        .map((role) => ({
          value: role.name,
          label: Helpers.titleizeToken(role.name, role.name),
        }));
    }

    if (normalizedScope === "group") {
      return State.groups
        .filter((group) => {
          const role = Helpers.string(group.role).toLowerCase();
          const status = Helpers.string(group.status, "active").toLowerCase();
          return status === "active" && (role === "owner" || role === "admin");
        })
        .slice()
        .sort((left, right) =>
          Helpers.string(left.name).localeCompare(Helpers.string(right.name)),
        )
        .map((group) => ({
          value: group.id,
          label: group.name,
        }));
    }

    return [];
  },

  populateBoundaryPresetOptions(category, selectedPresetId = null) {
    const select = document.getElementById("policy-preset");
    const categoryHint = document.getElementById("policy-category-hint");
    if (!select) {
      return;
    }

    const normalizedCategory = Helpers.string(
      category,
      DEFAULT_BOUNDARY_CATEGORY,
    ).toLowerCase();
    const draft = this.getBoundaryEditorDraft();

    if (normalizedCategory === "advanced") {
      const customPreset = draft?.selectorLocked
        ? buildPromotionSuggestionPreset(draft)
        : null;

      if (customPreset) {
        select.innerHTML = `<option value="${Helpers.escapeHtml(customPreset.id)}">${Helpers.escapeHtml(customPreset.label)}</option>`;
        select.value = customPreset.id;
        select.disabled = true;

        if (categoryHint) {
          categoryHint.textContent =
            "This suggestion uses a selector that stays on the advanced/custom path.";
        }

        this.updateBoundaryPresetHint();
        return;
      }

      select.innerHTML =
        '<option value="">No guided selector available</option>';
      select.value = "";
      select.disabled = true;

      if (categoryHint) {
        categoryHint.textContent =
          "Advanced/custom selectors stay visible here, but only suggestion-driven promotion can prefill them.";
      }

      this.updateBoundaryPresetHint();
      return;
    }

    const categoryMeta =
      BOUNDARY_CATEGORY_META[normalizedCategory] ||
      BOUNDARY_CATEGORY_META[DEFAULT_BOUNDARY_CATEGORY];
    const presets = listBoundaryPresetOptions(normalizedCategory);
    const selectedPreset = findBoundaryPreset(
      normalizedCategory,
      selectedPresetId,
    );

    select.innerHTML = presets
      .map((option) => {
        return `<option value="${Helpers.escapeHtml(option.id)}">${Helpers.escapeHtml(option.label)}</option>`;
      })
      .join("");
    select.value = selectedPreset?.id || "";

    if (categoryHint) {
      categoryHint.textContent = Helpers.string(
        categoryMeta?.description,
        "Pick the category this boundary should manage.",
      );
    }

    select.disabled = false;
    this.updateBoundaryPresetHint();
  },

  updateBoundaryPresetHint() {
    const hint = document.getElementById("policy-preset-hint");
    if (!hint) {
      return;
    }

    const category = document.getElementById("policy-category")?.value;
    const presetId = document.getElementById("policy-preset")?.value;
    const draft = this.getBoundaryEditorDraft();

    if (Helpers.string(category).toLowerCase() === "advanced") {
      const customPreset = draft?.selectorLocked
        ? buildPromotionSuggestionPreset(draft)
        : null;

      hint.textContent = Helpers.string(
        customPreset?.description,
        "Guided preset editing is unavailable for this selector.",
      );
      return;
    }

    const preset = findBoundaryPreset(category, presetId);

    hint.textContent = Helpers.string(
      preset?.description,
      "Choose the specific selector this boundary should cover.",
    );
  },

  updateBoundaryEditorDirectionCopy(policy = null) {
    const note = document.getElementById("policy-direction-note");
    if (!note) {
      return;
    }

    const draft = this.getBoundaryEditorDraft();

    if (!policy) {
      if (draft) {
        const directionLabel = boundaryDirectionLabel(draft.direction);
        note.textContent =
          Helpers.string(draft.direction, "outbound") === "outbound"
            ? "This promotion keeps the boundary on outbound sharing."
            : `This promotion keeps the boundary on ${directionLabel.toLowerCase()} traffic.`;
        return;
      }

      note.textContent =
        "New common boundaries apply to outbound sharing by default.";
      return;
    }

    const directionLabel = boundaryDirectionLabel(policy.direction);
    note.textContent =
      Helpers.string(policy.direction, "outbound") === "outbound"
        ? "This edit keeps the boundary on outbound sharing."
        : `This edit keeps the boundary on ${directionLabel.toLowerCase()} traffic.`;
  },

  openBoundaryEditor(policy = null, options = {}) {
    const draft = !policy ? options?.draft || null : null;

    if (policy && !canUseGuidedBoundaryEditor(policy)) {
      this.showToast(
        "This boundary uses the advanced/custom path and cannot be edited here.",
        "info",
      );
      return;
    }

    const form = document.getElementById("create-policy-form");
    const title = document.getElementById("policy-modal-title");
    const copy = document.getElementById("policy-modal-copy");
    const saveLabel = document.getElementById("save-policy-label");
    const scopeInput = document.getElementById("policy-scope");
    const effectInput = document.getElementById("policy-effect");
    const categoryInput = document.getElementById("policy-category");

    if (!form || !scopeInput || !effectInput || !categoryInput) {
      this.showToast("Boundary editor is unavailable.", "error");
      return;
    }

    form.reset?.();
    this.setBoundaryEditorDraft(null);
    form.dataset.mode = policy ? "edit" : "create";
    form.dataset.policyId = policy?.id || "";
    this.setBoundaryEditorDraft(draft);

    const scope =
      policy?.scope || draft?.scope || this.defaultBoundaryEditorScope();
    const category = policy
      ? policy?.boundary?.category &&
        Object.prototype.hasOwnProperty.call(
          COMMON_BOUNDARY_PRESETS,
          policy.boundary.category,
        )
          ? policy.boundary.category
          : this.defaultBoundaryEditorCategory()
      : draft?.selectorLocked
        ? "advanced"
        : Object.prototype.hasOwnProperty.call(
              COMMON_BOUNDARY_PRESETS,
              Helpers.string(draft?.category).toLowerCase(),
            )
          ? Helpers.string(draft?.category).toLowerCase()
          : this.defaultBoundaryEditorCategory();
    const preset = policy
      ? resolveBoundaryPresetFromPolicy(policy)
      : draft?.selectorLocked
        ? buildPromotionSuggestionPreset(draft)
        : draft?.category && draft?.resource
          ? findBoundaryPreset(category, draft.presetId)
          : null;

    if (title) {
      title.textContent = policy
        ? "✏️ Edit Boundary"
        : draft
          ? "🛡️ Promote Boundary Suggestion"
          : "🛡️ Create Boundary";
    }
    if (copy) {
      copy.textContent = policy
        ? "Update the common category and effect without editing raw policy JSON."
        : draft
          ? `Mahilo spotted ${Helpers.pluralize(
              draft.count,
              "temporary override",
            )} for ${Helpers.string(
              draft.selectorLabel,
              `${draft.resource}${draft.action ? ` / ${draft.action}` : ""}`,
            )}. Review the prefilled boundary and save it to enforce future matches.`
          : "Set a common boundary by audience and category without editing raw policy JSON.";
    }
    if (saveLabel) {
      saveLabel.textContent = policy
        ? "Save Changes"
        : draft
          ? "Promote Boundary"
          : "Save Boundary";
    }

    scopeInput.value = scope;
    scopeInput.disabled = Boolean(policy);
    effectInput.value = Helpers.string(
      policy?.effect,
      draft?.effect || DEFAULT_BOUNDARY_EFFECT,
    );
    categoryInput.value = category;
    categoryInput.disabled = Boolean(policy) || Boolean(draft?.selectorLocked);

    this.populatePolicyTargets(scope, policy?.targetId || draft?.targetId || null, {
      locked: Boolean(policy),
    });
    this.populateBoundaryPresetOptions(category, preset?.id || null);
    this.updateBoundaryEditorDirectionCopy(policy);
    this.renderBoundaryEditorPreview();
    this.showModal("create-policy-modal");
  },

  // Populate boundary audiences
  populatePolicyTargets(scope, selectedTargetId = null, config = {}) {
    const targetGroup = document.getElementById("policy-target-group");
    const select = document.getElementById("policy-target-id");
    const hint = document.getElementById("policy-target-hint");
    const normalizedScope = Helpers.string(scope, "global");
    const locked = Boolean(config.locked);

    if (!targetGroup || !select) {
      return;
    }

    if (normalizedScope === "global") {
      targetGroup.classList.add("hidden");
      select.innerHTML = '<option value="">No target needed</option>';
      select.value = "";
      select.disabled = true;
      if (hint) {
        hint.textContent =
          "Global boundaries apply across every conversation unless a narrower rule wins.";
      }
      return;
    }

    targetGroup.classList.remove("hidden");

    const choices = this.getBoundaryAudienceOptions(normalizedScope);
    const normalizedTargetId = Helpers.nullableString(selectedTargetId);

    if (
      normalizedTargetId &&
      !choices.some((choice) => choice.value === normalizedTargetId)
    ) {
      const fallbackLabel =
        Helpers.resolvePolicyTargetLabel({
          scope: normalizedScope,
          targetId: normalizedTargetId,
        }) ||
        formatBoundaryTargetLabel(normalizedScope, normalizedTargetId) ||
        normalizedTargetId;
      choices.unshift({
        value: normalizedTargetId,
        label: fallbackLabel,
      });
    }

    select.innerHTML = choices.length
      ? choices
          .map((choice) => {
            return `<option value="${Helpers.escapeHtml(choice.value)}">${Helpers.escapeHtml(choice.label)}</option>`;
          })
          .join("")
      : '<option value="">No audiences available</option>';

    const nextValue =
      normalizedTargetId || (choices.length === 1 ? choices[0].value : "");
    select.value = nextValue;
    select.disabled = locked || choices.length === 0;

    if (hint) {
      if (locked) {
        hint.textContent =
          "Audience is fixed for an existing boundary. Create a new boundary to change who it applies to.";
      } else if (!choices.length) {
        hint.textContent = this.boundaryAudienceEmptyState(normalizedScope);
      } else {
        hint.textContent = this.boundaryAudienceSelectionCopy(normalizedScope);
      }
    }
  },

  renderBoundaryEditorPreview() {
    const preview = document.getElementById("policy-preview-card");
    const draft = this.getBoundaryEditorDraft();
    const scope = Helpers.string(
      document.getElementById("policy-scope")?.value,
      this.defaultBoundaryEditorScope(),
    );
    const targetId = Helpers.nullableString(
      document.getElementById("policy-target-id")?.value,
    );
    const category = Helpers.string(
      document.getElementById("policy-category")?.value,
      DEFAULT_BOUNDARY_CATEGORY,
    ).toLowerCase();
    const effect = Helpers.string(
      document.getElementById("policy-effect")?.value,
      DEFAULT_BOUNDARY_EFFECT,
    );
    const preset =
      draft?.selectorLocked && category === "advanced"
        ? buildPromotionSuggestionPreset(draft)
        : findBoundaryPreset(
            category,
            document.getElementById("policy-preset")?.value,
          );

    if (!preview) {
      return;
    }

    if (scope !== "global" && !targetId) {
      preview.classList.add("empty");
      preview.innerHTML = `<p>${Helpers.escapeHtml(
        `Choose the ${this.boundaryAudienceEntityLabel(scope)} this boundary should cover.`,
      )}</p>`;
      return;
    }

    if (!preset && !draft?.selectorLocked) {
      preview.classList.add("empty");
      preview.innerHTML =
        "<p>Choose a boundary category to preview the selector and outcome.</p>";
      return;
    }

    const currentPolicy = this.getBoundaryEditorPolicy();
    const previewPolicy = {
      id: currentPolicy?.id || "draft_boundary",
      scope,
      targetId: scope === "global" ? null : targetId,
      direction: Helpers.string(
        currentPolicy?.direction,
        draft?.direction || "outbound",
      ),
      resource: Helpers.string(
        preset?.resource,
        draft?.resource || "message.general",
      ),
      action:
        Helpers.nullableString(preset?.action) ||
        Helpers.nullableString(draft?.action) ||
        "share",
      effect,
      evaluator: "structured",
      content: {},
      contentText: "",
      effectiveFrom: currentPolicy?.effectiveFrom || null,
      expiresAt: currentPolicy?.expiresAt || null,
      maxUses: currentPolicy?.maxUses ?? null,
      remainingUses: currentPolicy?.remainingUses ?? null,
      priority: currentPolicy?.priority || 0,
      enabled: currentPolicy ? currentPolicy.enabled !== false : true,
      source: currentPolicy?.source || "user_created",
      derivedFromMessageId: currentPolicy?.derivedFromMessageId || null,
      createdAt: currentPolicy?.createdAt || null,
      updatedAt: currentPolicy?.updatedAt || null,
    };

    previewPolicy.boundary = buildBoundaryPresentation(previewPolicy);
    const boundary = previewPolicy.boundary || {};
    const boundaryEffect = boundary.effect || {};
    const selector = boundary.selector || {};
    const audienceLabel = Helpers.policyAudienceDisplay(previewPolicy);

    preview.classList.remove("empty");
    preview.innerHTML = `
      <div class="boundary-editor-preview-header">
        <div class="boundary-editor-preview-copy">
          <span class="boundary-summary-label">Preview</span>
          <span class="boundary-editor-preview-title">${Helpers.escapeHtml(selector.label || "Common boundary")}</span>
        </div>
        <span class="policy-badge effect-${Helpers.escapeHtml(boundaryEffect.tone || effect)}">${Helpers.escapeHtml(boundaryEffect.badgeLabel || Helpers.titleizeToken(effect, effect))}</span>
      </div>
      <p class="boundary-editor-preview-summary">${Helpers.escapeHtml(buildBoundaryNarrative(previewPolicy, audienceLabel))}</p>
      <div class="boundary-meta-list">
        <span class="boundary-meta-chip">
          <span class="boundary-meta-label">Audience</span>
          ${Helpers.escapeHtml(audienceLabel)}
        </span>
        <span class="boundary-meta-chip">
          <span class="boundary-meta-label">Selector</span>
          ${Helpers.escapeHtml(
            selector.summary ||
              `${Helpers.string(
                preset?.resource,
                draft?.resource || "message.general",
              )} / ${
                Helpers.nullableString(preset?.action) ||
                Helpers.nullableString(draft?.action) ||
                "share"
              }`,
          )}
        </span>
        <span class="boundary-meta-chip">
          <span class="boundary-meta-label">Direction</span>
          ${Helpers.escapeHtml(selector.directionLabel || boundaryDirectionLabel(previewPolicy.direction))}
        </span>
      </div>
      <p class="boundary-row-footnote">${Helpers.escapeHtml(boundary.categoryDescription || "Mahilo will use this selector and effect for matching content.")}</p>
    `;
  },

  // Handle create/update boundary
  async handleCreatePolicy() {
    const draft = this.getBoundaryEditorDraft();
    const scope = Helpers.string(
      document.getElementById("policy-scope")?.value,
      "global",
    );
    const targetId = Helpers.nullableString(
      document.getElementById("policy-target-id")?.value,
    );
    const category = Helpers.string(
      document.getElementById("policy-category")?.value,
      DEFAULT_BOUNDARY_CATEGORY,
    ).toLowerCase();
    const effect = Helpers.string(
      document.getElementById("policy-effect")?.value,
      DEFAULT_BOUNDARY_EFFECT,
    );
    const preset =
      draft?.selectorLocked && category === "advanced"
        ? buildPromotionSuggestionPreset(draft)
        : findBoundaryPreset(
            category,
            document.getElementById("policy-preset")?.value,
          );
    const currentPolicy = this.getBoundaryEditorPolicy();

    if (scope !== "global" && !targetId) {
      this.showToast(
        `Choose the ${this.boundaryAudienceEntityLabel(scope)} this boundary should apply to.`,
        "error",
      );
      return;
    }

    if (!preset) {
      this.showToast("Choose a boundary type before saving.", "error");
      return;
    }

    try {
      const payload = {
        direction: Helpers.string(
          currentPolicy?.direction,
          draft?.direction || "outbound",
        ),
        resource: Helpers.string(
          preset?.resource,
          draft?.resource || "message.general",
        ),
        action:
          Helpers.nullableString(preset?.action) ||
          Helpers.nullableString(draft?.action) ||
          "share",
        effect,
        evaluator: "structured",
        policy_type: "structured",
        policy_content: {},
      };

      if (currentPolicy) {
        await API.policies.update(currentPolicy.id, payload);
      } else {
        await API.policies.create({
          scope,
          target_id: scope === "global" ? undefined : targetId,
          ...payload,
        });
      }

      this.hideModals();
      await DataLoader.loadPolicies();
      this.showToast(
        currentPolicy
          ? "Boundary updated successfully"
          : "Boundary created successfully",
        "success",
      );
    } catch (error) {
      this.showToast(
        error.message ||
          `Failed to ${currentPolicy ? "update" : "create"} boundary`,
        "error",
      );
    }
  },

  handleEditPolicy(id) {
    const policy = State.policiesById.get(id) || null;

    if (!policy) {
      this.showToast("Boundary not found", "error");
      return;
    }

    this.openBoundaryEditor(policy);
  },

  buildPromotionSuggestionDraft(suggestion) {
    if (!suggestion) {
      return null;
    }

    return {
      action: Helpers.nullableString(suggestion.action) || "share",
      category: Helpers.string(
        suggestion.category,
        DEFAULT_BOUNDARY_CATEGORY,
      ).toLowerCase(),
      categoryLabel: Helpers.nullableString(suggestion.boundary?.categoryLabel),
      count: Helpers.number(suggestion.repeatedOverridePattern?.count, 0),
      direction: Helpers.string(suggestion.direction, "outbound"),
      effect: Helpers.string(suggestion.effect, DEFAULT_BOUNDARY_EFFECT),
      lookbackDays: Helpers.number(
        State.promotionSuggestionLearning?.lookbackDays,
        0,
      ),
      presetId: Helpers.nullableString(suggestion.presetId),
      resource: Helpers.string(suggestion.resource, "message.general"),
      scope: Helpers.string(suggestion.scope, "global"),
      selectorLabel: Helpers.string(
        suggestion.boundary?.selector?.label,
        Helpers.selectorSummary(suggestion.selectors) || "Suggested selector",
      ),
      selectorLocked: !suggestion.canUseGuidedEditor,
      suggestionId: suggestion.id,
      targetId: Helpers.nullableString(suggestion.targetId),
    };
  },

  handlePromoteSuggestion(id) {
    const suggestion = State.promotionSuggestionsById.get(id) || null;

    if (!suggestion) {
      this.showToast("Promotion suggestion not found.", "error");
      return;
    }

    this.openBoundaryEditor(null, {
      draft: this.buildPromotionSuggestionDraft(suggestion),
    });
  },

  renderPolicyProvenanceModal(policy, auditState = {}) {
    const title = document.getElementById("policy-provenance-title");
    const copy = document.getElementById("policy-provenance-copy");
    const content = document.getElementById("policy-provenance-content");

    if (!title || !copy || !content || !policy) {
      return;
    }

    const boundary = policy.boundary || buildBoundaryPresentation(policy);
    const effect = boundary.effect || {};
    const selector = boundary.selector || {};
    const lifecycle = boundary.lifecycle || buildBoundaryLifecycle(policy);
    const provenance = boundary.provenance || buildBoundaryProvenance(policy);
    const audienceLabel = Helpers.policyAudienceDisplay(policy);
    const status = Helpers.string(auditState.status, "loading");

    const renderDetailRows = (items = []) => {
      return items
        .filter((item) => Helpers.nullableString(item?.value))
        .map(
          (item) => `
            <div class="detail-row">
              <span class="detail-label">${Helpers.escapeHtml(item.label)}</span>
              <span class="detail-value">${Helpers.escapeHtml(item.value)}</span>
            </div>
          `,
        )
        .join("");
    };

    const renderAuditRecord = (record) => {
      const selectors = Helpers.selectorSummary(record?.selectors);
      const sourceLabel = Helpers.policySourceLabel(record?.source);
      const scopeLabel = Helpers.titleizeToken(record?.scope, record?.scope);
      const provenanceTone =
        {
          default: "default",
          learned: "learned",
          legacy_migrated: "imported",
          override: "override",
          user_confirmed: "confirmed",
          user_created: "user-created",
        }[Helpers.string(record?.source).toLowerCase()] || "default";
      const detailRows = [
        {
          label: "Source",
          value: sourceLabel,
        },
        {
          label: "Effect",
          value: Helpers.titleizeToken(record?.effect, record?.effect),
        },
        {
          label: "Scope",
          value: record?.targetId
            ? `${scopeLabel} · ${record.targetId}`
            : scopeLabel,
        },
        {
          label: "Selectors",
          value: selectors,
        },
        record?.derivedFromMessageId
          ? {
              label: "Derived from message",
              value: record.derivedFromMessageId,
            }
          : null,
        record?.sourceInteractionId
          ? {
              label: "Source interaction",
              value: record.sourceInteractionId,
            }
          : null,
        record?.createdAt
          ? {
              label: "Created at",
              value: Helpers.formatDateTime(record.createdAt),
            }
          : null,
      ];

      return `
        <article class="boundary-provenance-record">
          <div class="boundary-provenance-record-header">
            <div>
              <h5>${Helpers.escapeHtml(record?.policyId || "Unknown boundary")}</h5>
              <p>${Helpers.escapeHtml(`${sourceLabel} · ${selectors || "message.general / share"}`)}</p>
            </div>
            <span class="policy-badge provenance-${Helpers.escapeHtml(
              provenanceTone,
            )}">${Helpers.escapeHtml(sourceLabel)}</span>
          </div>
          ${renderDetailRows(detailRows)}
        </article>
      `;
    };

    title.textContent = selector.label || "Boundary inspector";
    copy.textContent = `Canonical selectors, raw content, and provenance for ${audienceLabel}.`;

    const overviewDetails = [
      {
        label: "Audience",
        value: audienceLabel,
      },
      {
        label: "Outcome",
        value:
          effect.badgeLabel ||
          Helpers.titleizeToken(policy.effect, policy.effect),
      },
      {
        label: "Source",
        value: provenance.sourceLabel,
      },
      {
        label: "Status",
        value: lifecycle.badgeLabel || "Inactive",
      },
      ...provenance.detailItems.filter((item) => item.label !== "Source"),
      ...lifecycle.detailItems,
    ];
    const canonicalSelectorDetails = [
      {
        label: "Direction",
        value: Helpers.string(policy.direction, "outbound"),
      },
      {
        label: "Resource",
        value: Helpers.string(policy.resource, "message.general"),
      },
      {
        label: "Action",
        value: Helpers.string(policy.action, "share"),
      },
    ];
    const canonicalPolicyDetails = [
      {
        label: "Policy ID",
        value: policy.id,
      },
      {
        label: "Scope",
        value: Helpers.string(policy.scope, "global"),
      },
      policy.targetId
        ? {
            label: "Target ID",
            value: policy.targetId,
          }
        : null,
      {
        label: "Evaluator",
        value: Helpers.string(policy.evaluator, "llm"),
      },
      {
        label: "Priority",
        value: String(Helpers.number(policy.priority, 0)),
      },
      {
        label: "Enabled",
        value: policy.enabled ? "true" : "false",
      },
      policy.createdAt
        ? {
            label: "Created at",
            value: Helpers.formatDateTime(policy.createdAt),
          }
        : null,
      policy.updatedAt
        ? {
            label: "Updated at",
            value: Helpers.formatDateTime(policy.updatedAt),
          }
        : null,
    ];
    const rawPolicyContent = Helpers.contentText(policy.content);
    const advancedInspectorNote =
      boundary.managementPath === "advanced"
        ? `
          <div class="policy-advanced-note">
            This boundary stays on the advanced/custom path because its selector does not map to a guided product category. Inspect the canonical fields and raw content below when debugging it.
          </div>
        `
        : "";

    let auditHtml = `
      <div class="boundary-provenance-callout loading">
        <p>Loading lineage and source-message audit for this boundary.</p>
      </div>
    `;

    if (status === "error") {
      auditHtml = `
        <div class="boundary-provenance-callout error">
          <p>${Helpers.escapeHtml(
            auditState.error || "Failed to load boundary audit details.",
          )}</p>
        </div>
      `;
    } else if (status === "loaded") {
      const audit = auditState.data;
      const sourceMessage = Helpers.record(audit?.sourceMessage);
      const lineage = Array.isArray(audit?.lineage) ? audit.lineage : [];
      const promotionHistory = Array.isArray(audit?.overrideToPromotedHistory)
        ? audit.overrideToPromotedHistory
        : [];
      const sourceMessageHtml = sourceMessage.id
        ? `
            <div class="detail-section">
              <h4>Source message</h4>
              ${renderDetailRows([
                {
                  label: "Message",
                  value: sourceMessage.id,
                },
                {
                  label: "Selectors",
                  value: Helpers.selectorSummary(sourceMessage.selectors),
                },
                sourceMessage.senderUserId
                  ? {
                      label: "Sender user",
                      value: sourceMessage.senderUserId,
                    }
                  : null,
                sourceMessage.recipientId
                  ? {
                      label: "Recipient",
                      value: sourceMessage.recipientId,
                    }
                  : null,
                sourceMessage.recipientType
                  ? {
                      label: "Recipient type",
                      value: Helpers.titleizeToken(
                        sourceMessage.recipientType,
                        sourceMessage.recipientType,
                      ),
                    }
                  : null,
                sourceMessage.createdAt
                  ? {
                      label: "Created at",
                      value: Helpers.formatDateTime(sourceMessage.createdAt),
                    }
                  : null,
              ])}
            </div>
          `
        : `
            <div class="detail-section">
              <h4>Source message</h4>
              <p class="boundary-provenance-empty">
                No linked source message is available for this boundary.
              </p>
            </div>
          `;

      const lineageHtml = lineage.length
        ? lineage.map((entry) => renderAuditRecord(entry)).join("")
        : `
            <p class="boundary-provenance-empty">
              No earlier promoted boundaries are linked to this rule.
            </p>
          `;

      const promotionHistoryHtml = promotionHistory.length
        ? promotionHistory
            .map((entry) => {
              return `
                <article class="boundary-provenance-history-item">
                  <h5>${Helpers.escapeHtml(
                    `${Helpers.policySourceLabel(entry.fromSource)} → ${Helpers.policySourceLabel(entry.toSource)}`,
                  )}</h5>
                  <p>${Helpers.escapeHtml(
                    `${entry.fromPolicyId || "Unknown boundary"} promoted into ${entry.toPolicyId || "Unknown boundary"}.`,
                  )}</p>
                  <div class="boundary-meta-list compact">
                    ${
                      entry.sourceInteractionId
                        ? `
                          <span class="boundary-meta-chip">
                            <span class="boundary-meta-label">Interaction</span>
                            ${Helpers.escapeHtml(entry.sourceInteractionId)}
                          </span>
                        `
                        : ""
                    }
                    ${
                      entry.fromDerivedFromMessageId
                        ? `
                          <span class="boundary-meta-chip">
                            <span class="boundary-meta-label">From message</span>
                            ${Helpers.escapeHtml(entry.fromDerivedFromMessageId)}
                          </span>
                        `
                        : ""
                    }
                    ${
                      entry.toDerivedFromMessageId
                        ? `
                          <span class="boundary-meta-chip">
                            <span class="boundary-meta-label">To message</span>
                            ${Helpers.escapeHtml(entry.toDerivedFromMessageId)}
                          </span>
                        `
                        : ""
                    }
                  </div>
                </article>
              `;
            })
            .join("")
        : `
            <p class="boundary-provenance-empty">
              No override-to-promotion history is attached to this boundary.
            </p>
          `;

      auditHtml = `
        <div class="boundary-provenance-sections">
          ${sourceMessageHtml}
          <div class="detail-section">
            <h4>Lineage</h4>
            <div class="boundary-provenance-record-list">
              ${lineageHtml}
            </div>
          </div>
          <div class="detail-section">
            <h4>Override promotion history</h4>
            <div class="boundary-provenance-history-list">
              ${promotionHistoryHtml}
            </div>
          </div>
        </div>
      `;
    }

    content.innerHTML = `
      <div class="boundary-provenance-overview">
        <div class="boundary-provenance-hero">
          <div>
            <span class="boundary-summary-label">Summary</span>
            <h4>${Helpers.escapeHtml(selector.label || "Boundary provenance")}</h4>
          </div>
          <div class="boundary-row-badges">
            <span class="policy-badge effect-${Helpers.escapeHtml(
              effect.tone || policy.effect,
            )}">${Helpers.escapeHtml(
              effect.badgeLabel ||
                Helpers.titleizeToken(policy.effect, policy.effect),
            )}</span>
            <span class="boundary-activity-badge ${Helpers.escapeHtml(
              lifecycle.tone || "disabled",
            )}">${Helpers.escapeHtml(lifecycle.badgeLabel || "Inactive")}</span>
            <span class="policy-badge provenance-${Helpers.escapeHtml(
              provenance.tone || "default",
            )}">${Helpers.escapeHtml(provenance.badgeLabel)}</span>
          </div>
        </div>
        <p class="boundary-row-summary">${Helpers.escapeHtml(
          buildBoundaryNarrative(policy, audienceLabel),
        )}</p>
        <p class="boundary-provenance-note">${Helpers.escapeHtml(
          provenance.summary,
        )}</p>
        <p class="boundary-row-footnote">${Helpers.escapeHtml(
          lifecycle.summary || "Currently active and enforced.",
        )}</p>
        ${advancedInspectorNote}
        <div class="policy-inspector-grid">
          <div class="detail-section">
            <h4>Boundary details</h4>
            ${renderDetailRows(overviewDetails)}
          </div>
          <div class="detail-section">
            <h4>Canonical selectors</h4>
            ${renderDetailRows(canonicalSelectorDetails)}
          </div>
          <div class="detail-section">
            <h4>Canonical policy</h4>
            ${renderDetailRows(canonicalPolicyDetails)}
          </div>
        </div>
        <div class="agent-detail-sections compact">
          <div class="detail-section">
            <h4>Raw policy content</h4>
            ${
              Helpers.nullableString(rawPolicyContent)
                ? `
                  <pre class="policy-inspector-raw">${Helpers.escapeHtml(rawPolicyContent)}</pre>
                `
                : `
                  <p class="boundary-provenance-empty">
                    No raw policy content is stored for this boundary.
                  </p>
                `
            }
          </div>
        </div>
      </div>
      ${auditHtml}
    `;
  },

  async handleInspectPolicy(id) {
    const policy = State.policiesById.get(id) || null;

    if (!policy) {
      this.showToast("Boundary not found", "error");
      return;
    }

    this.renderPolicyProvenanceModal(policy, { status: "loading" });
    this.showModal("policy-provenance-modal");

    if (State.policyProvenanceById.has(id)) {
      this.renderPolicyProvenanceModal(policy, {
        data: State.policyProvenanceById.get(id),
        status: "loaded",
      });
      return;
    }

    try {
      const audit = Normalizers.policyProvenanceAudit(
        await API.policies.provenance(id),
      );
      if (!audit) {
        throw new Error("Boundary inspector payload was empty.");
      }

      State.policyProvenanceById.set(id, audit);
      this.renderPolicyProvenanceModal(policy, {
        data: audit,
        status: "loaded",
      });
    } catch (error) {
      this.renderPolicyProvenanceModal(policy, {
        error:
          error.message ||
          "Failed to load boundary inspector audit details.",
        status: "error",
      });
    }
  },

  openAddFriendModal() {
    document.getElementById("add-friend-form")?.reset();
    this.showModal("search-users-modal");
  },

  async handleAddFriendRequest() {
    const usernameInput = document.getElementById("add-friend-username");
    const submitButton = document.getElementById("send-friend-request-btn");

    if (!usernameInput) {
      this.showToast("The add-by-username form is unavailable.", "error");
      return;
    }

    const username = usernameInput.value.trim().replace(/^@+/, "");

    if (!username || username.length < 3) {
      this.showToast(
        "Enter the exact Mahilo username you want to add.",
        "error",
      );
      return;
    }

    if (State.user?.username?.toLowerCase() === username.toLowerCase()) {
      this.showToast(
        "You cannot send a request to your own username.",
        "error",
      );
      return;
    }

    if (submitButton) {
      submitButton.disabled = true;
    }

    try {
      await this.handleSendFriendRequest(username);
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
      }
    }
  },

  // Handle send friend request
  async handleSendFriendRequest(username) {
    const normalizedUsername = username.trim().replace(/^@+/, "");

    try {
      const result = await API.friends.request(normalizedUsername);
      this.hideModals();
      document.getElementById("add-friend-form")?.reset();
      await DataLoader.loadFriends();
      this.showToast(
        result.status === "accepted"
          ? result.message ||
              `${normalizedUsername} is now part of your network`
          : `Friend request sent to ${normalizedUsername}`,
        "success",
      );
    } catch (error) {
      this.showToast(error.message || "Failed to send friend request", "error");
    }
  },

  // Handle friend actions
  async handleAcceptFriend(id) {
    try {
      await API.friends.accept(id);
      await DataLoader.loadFriends();
      this.showToast("Friend request accepted", "success");
    } catch (error) {
      this.showToast("Failed to accept friend request", "error");
    }
  },

  async handleRejectFriend(id) {
    try {
      await API.friends.reject(id);
      await DataLoader.loadFriends();
      this.showToast("Friend request rejected", "success");
    } catch (error) {
      this.showToast("Failed to reject friend request", "error");
    }
  },

  async handleBlockFriend(id) {
    try {
      await API.friends.block(id);
      await DataLoader.loadFriends();
      this.showToast("User blocked", "success");
    } catch (error) {
      this.showToast("Failed to block user", "error");
    }
  },

  async handleUnfriend(id) {
    try {
      await API.friends.unfriend(id);
      await DataLoader.loadFriends();
      this.showToast("Friend removed", "success");
    } catch (error) {
      this.showToast("Failed to remove friend", "error");
    }
  },

  async refreshAvailableRoles() {
    try {
      await DataLoader.loadRoles();
      if (State.availableRolesStatus === "loaded") {
        this.showToast("Available roles refreshed", "success");
      }
    } catch (error) {
      this.showToast(error.message || "Failed to refresh roles", "error");
    }
  },

  async handleAddFriendRole(friendshipId, roleName) {
    const friend = State.friendsById.get(friendshipId);
    const normalizedRole = Helpers.string(roleName).trim();

    if (!friend || !normalizedRole) {
      this.showToast("Select a valid contact role to assign.", "error");
      return;
    }

    if (this.networkBucket(friend) !== "accepted") {
      this.showToast(
        "Accept this relationship before assigning roles.",
        "error",
      );
      return;
    }

    try {
      await API.friends.addRole(friendshipId, normalizedRole);
      await DataLoader.loadFriends();
      this.showToast(
        `${Helpers.titleizeToken(normalizedRole, "Role")} added to ${friend.displayName || friend.username}`,
        "success",
      );
    } catch (error) {
      this.showToast(error.message || "Failed to add role", "error");
    }
  },

  async handleRemoveFriendRole(friendshipId, roleName) {
    const friend = State.friendsById.get(friendshipId);
    const normalizedRole = Helpers.string(roleName).trim();

    if (!friend || !normalizedRole) {
      this.showToast("Select a valid contact role to remove.", "error");
      return;
    }

    if (this.networkBucket(friend) !== "accepted") {
      this.showToast(
        "Accept this relationship before removing roles.",
        "error",
      );
      return;
    }

    try {
      await API.friends.removeRole(friendshipId, normalizedRole);
      await DataLoader.loadFriends();
      this.showToast(
        `${Helpers.titleizeToken(normalizedRole, "Role")} removed from ${friend.displayName || friend.username}`,
        "success",
      );
    } catch (error) {
      this.showToast(error.message || "Failed to remove role", "error");
    }
  },

  // Handle send message (user-facing chat)
  async handleSendMessage() {
    const input = document.getElementById("chat-input");
    const message = input.value.trim();

    if (!message || !State.selectedChat) return;

    const thread = State.conversations.get(State.selectedChat) || [];
    const latestMessage = thread[thread.length - 1] || null;
    const latestRecord = latestMessage
      ? State.messagesById.get(latestMessage.id)
      : null;
    const isGroupThread = latestMessage?.recipientType === "group";

    if (isGroupThread && !latestRecord?.recipientId) {
      this.showToast(
        "Group replies are unavailable until the server includes a stable group identifier.",
        "info",
      );
      return;
    }

    const payload = {
      recipient: isGroupThread ? latestRecord.recipientId : State.selectedChat,
      recipient_type: isGroupThread ? "group" : "user",
      message,
      context: "Sent from the Mahilo dashboard",
    };

    try {
      const result = await API.messages.send(payload);

      input.value = "";
      await DataLoader.loadLogFeed();
      this.showToast(`Message queued: ${result.status}`, "success");
    } catch (error) {
      this.showToast(error.message || "Failed to send message", "error");
    }
  },

  // Handle send test message (developer view)
  async handleSendTestMessage() {
    const input = document.getElementById("dev-chat-input");
    const message = input.value.trim();
    const sender = this.getDefaultSenderCandidate();

    if (!message || !State.selectedChat) return;
    if (!sender) {
      this.showToast(
        "Add or activate a sender connection before running a developer test message.",
        "error",
      );
      return;
    }

    try {
      const result = await API.messages.send({
        recipient: State.selectedChat,
        message,
        context: "Developer console test message",
      });

      input.value = "";
      await DataLoader.loadLogFeed();
      this.showToast(`Test message queued: ${result.status}`, "success");
    } catch (error) {
      this.showToast(error.message || "Failed to send test message", "error");
    }
  },

  // Handle delete agent
  async handleDeleteAgent(id) {
    if (!confirm("Are you sure you want to delete this sender connection?"))
      return;

    try {
      await API.agents.delete(id);
      await DataLoader.loadAgents();
      this.hideModals();
      this.showToast("Connection deleted successfully", "success");
    } catch (error) {
      this.showToast("Failed to delete sender connection", "error");
    }
  },

  // Show agent details
  showAgentDetails(agent) {
    const agentId =
      typeof agent === "string" ? agent : Helpers.nullableString(agent?.id);
    const connection = agentId
      ? this.getSenderConnectionWorkspaceItem(agentId)
      : null;

    if (!connection) {
      this.showToast("Sender connection details are unavailable", "error");
      return;
    }

    State.selectedAgentId = connection.id;

    document.getElementById("detail-agent-icon").textContent = "🤖";
    document.getElementById("detail-agent-name").textContent =
      `${connection.label} (${Helpers.titleizeToken(connection.framework, "Unknown framework")})`;
    document.getElementById("detail-agent-framework").textContent =
      `${Helpers.titleizeToken(connection.framework, "Unknown framework")} • ${connection.modeLabel}`;
    document.getElementById("detail-agent-status").textContent =
      Helpers.titleizeToken(connection.status, "Unknown");
    document.getElementById("detail-agent-status").className =
      `status-badge ${connection.status}`;
    document.getElementById("detail-agent-id").textContent = connection.id;
    document.getElementById("detail-agent-label").textContent =
      connection.label;
    document.getElementById("detail-agent-callback").textContent =
      connection.callbackUrl || "None";
    document.getElementById("detail-agent-public-key").textContent =
      connection.publicKey
        ? `${connection.publicKey.substring(0, 50)}...`
        : "None";
    document.getElementById("detail-agent-alg").textContent =
      connection.publicKeyAlg || "None";
    document.getElementById("detail-agent-priority").textContent = String(
      Helpers.number(connection.routingPriority, 0),
    );
    document.getElementById("detail-agent-mode").textContent =
      connection.modeLabel;
    document.getElementById("detail-agent-last-seen").textContent =
      connection.lastSeenLabel;
    document.getElementById("detail-agent-default").textContent =
      connection.isDefaultSenderCandidate
        ? "Current default sender"
        : connection.routing.badge;
    document.getElementById("detail-agent-route-note").textContent =
      connection.routing.detail;

    const healthBadge = document.getElementById("detail-agent-health-badge");
    healthBadge.textContent = connection.health.label;
    healthBadge.className = `status-badge ${connection.health.tone}`;
    document.getElementById("detail-agent-health-copy").textContent =
      connection.health.detail;

    const capsContainer = document.getElementById("detail-agent-capabilities");
    capsContainer.innerHTML = "";
    if (connection.capabilities?.length) {
      connection.capabilities.forEach((cap) => {
        const tag = document.createElement("span");
        tag.className = "capability-tag";
        tag.textContent = cap;
        capsContainer.appendChild(tag);
      });
    } else {
      capsContainer.innerHTML = '<span class="capability-tag">None</span>';
    }

    // Bind delete button
    const editBtn = document.getElementById("edit-agent-btn");
    editBtn.onclick = () => this.openAgentEditor(connection.id);

    const deleteBtn = document.getElementById("delete-agent-btn");
    deleteBtn.onclick = () => this.handleDeleteAgent(connection.id);

    this.showModal("agent-details-modal");
  },

  // Switch view
  switchView(view) {
    const resolvedView = VIEW_ALIASES[view] || view || "overview";
    State.currentView = resolvedView;

    // Update nav
    document.querySelectorAll(".nav-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.view === resolvedView);
    });

    // Update page title
    const { title, subtitle } = VIEW_META[resolvedView] || VIEW_META.overview;
    document.getElementById("page-title").textContent = title;
    document.getElementById("page-subtitle").textContent = subtitle;

    // Show view
    document
      .querySelectorAll(".view")
      .forEach((v) => v.classList.remove("active"));
    const nextView = document.getElementById(`${resolvedView}-view`);
    if (!nextView) {
      console.warn(`View not found: ${resolvedView}`);
      State.currentView = "overview";
      document.getElementById("page-title").textContent =
        VIEW_META.overview.title;
      document.getElementById("page-subtitle").textContent =
        VIEW_META.overview.subtitle;
      document.getElementById("overview-view")?.classList.add("active");
      return;
    }
    nextView.classList.add("active");

    // Load data if needed
    if (resolvedView === "messages") {
      this.renderConversations();
      if (State.selectedChat) {
        this.renderChat(State.selectedChat);
      }
    } else if (resolvedView === "logs") {
      this.hideNotificationDot();
      this.renderLogs();
    } else if (resolvedView === "boundaries") {
      this.renderPolicies(State.boundaryScopeFilter);
    } else if (resolvedView === "settings") {
      DataLoader.loadPreferences();
    } else if (resolvedView === "developer") {
      this.renderDeveloperConsole();
    }
  },

  renderDeveloperConsole() {
    this.renderDevApiKey();
    this.renderDevDiagnostics();
    this.renderDevMessagingSummary();
    this.renderDevConversations();

    const selectedFriend = State.friends.find(
      (friend) =>
        friend.status === "accepted" && friend.username === State.selectedChat,
    );
    const placeholder = document.getElementById("dev-chat-placeholder");
    const container = document.getElementById("dev-chat-container");

    if (!placeholder || !container) {
      return;
    }

    if (selectedFriend) {
      this.selectDevChat(selectedFriend.username);
      return;
    }

    placeholder.classList.remove("hidden");
    container.classList.add("hidden");
  },

  // Show landing page
  showLanding() {
    document.getElementById("landing-page").classList.remove("hidden");
    document.getElementById("dashboard-screen").classList.add("hidden");
    document.getElementById("ws-status").style.display = "none";
    this.renderBrowserLogin();
    this.initLandingAnimations();
  },

  // Initialize landing page animations
  initLandingAnimations() {
    // Scroll reveal observer
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("revealed");
          }
        });
      },
      { threshold: 0.1 },
    );

    document
      .querySelectorAll(".reveal-on-scroll")
      .forEach((el) => observer.observe(el));

    // Nav scroll effect
    const handleScroll = () => {
      const nav = document.querySelector(".landing-nav");
      if (nav) nav.classList.toggle("scrolled", window.scrollY > 50);
    };
    window.addEventListener("scroll", handleScroll);
    handleScroll();

    // Typewriter effect for solution demo
    const demoText =
      '"Hey, ask my contacts if anyone knows a good dentist in SF."';
    const demoEl = document.getElementById("demo-prompt-text");
    const demoSection = document.getElementById("solution-section");

    if (demoEl && demoSection) {
      let typed = false;
      const typeObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting && !typed) {
              typed = true;
              let i = 0;
              demoEl.textContent = "";
              const cursor = demoEl.previousElementSibling;
              const interval = setInterval(() => {
                demoEl.textContent += demoText[i];
                i++;
                if (i >= demoText.length) {
                  clearInterval(interval);
                  if (cursor) cursor.style.display = "none";
                  // Show response cards after typing finishes
                  setTimeout(() => {
                    document
                      .querySelectorAll(".demo-response")
                      .forEach((card, idx) => {
                        setTimeout(() => {
                          card.style.opacity = "1";
                          card.style.transform = "translateY(0)";
                        }, idx * 400);
                      });
                  }, 300);
                }
              }, 35);
            }
          });
        },
        { threshold: 0.3 },
      );
      typeObserver.observe(demoSection);
    }
  },

  // Show dashboard
  showDashboard() {
    document.getElementById("landing-page").classList.add("hidden");
    document.getElementById("dashboard-screen").classList.remove("hidden");
    document.getElementById("ws-status").style.display = "flex";

    // Update sidebar
    document.getElementById("sidebar-username").textContent =
      State.user?.username || "User";
    document.getElementById("user-avatar-initial").textContent = (
      State.user?.display_name?.[0] ||
      State.user?.username?.[0] ||
      "U"
    ).toUpperCase();
    document.getElementById("welcome-name").textContent =
      State.user?.display_name || State.user?.username || "Friend";
  },

  // Show modal
  showModal(id) {
    document.getElementById("modal-overlay").classList.remove("hidden");
    document.getElementById(id).classList.remove("hidden");
  },

  // Hide all modals
  hideModals() {
    document.getElementById("modal-overlay").classList.add("hidden");
    document
      .querySelectorAll(".modal")
      .forEach((m) => m.classList.add("hidden"));
    State.selectedAgentId = null;
  },

  // Update counts
  updateAgentCount(count) {
    document.getElementById("agent-count").textContent = count;
    document
      .getElementById("agent-count")
      .classList.toggle("hidden", count === 0);
    const overviewAgentCount = document.getElementById("overview-agent-count");
    if (overviewAgentCount) {
      overviewAgentCount.textContent = count;
    }
  },

  updateFriendCount(count) {
    document.getElementById("friend-count").textContent = count;
    document
      .getElementById("friend-count")
      .classList.toggle("hidden", count === 0);
    const overviewFriendCount =
      document.getElementById("overview-friend-count");
    if (overviewFriendCount) {
      overviewFriendCount.textContent = count;
    }
    document.getElementById("profile-friend-count").textContent = count;
  },

  updateNetworkRelationshipCounts(friends = State.friends) {
    const counts = this.getNetworkRelationshipCounts(friends);
    const badges = {
      "all-network-count": counts.all,
      "accepted-count": counts.accepted,
      "incoming-count": counts.incoming,
      "outgoing-count": counts.outgoing,
      "blocked-count": counts.blocked,
    };

    Object.entries(badges).forEach(([id, count]) => {
      const badge = document.getElementById(id);
      if (!badge) {
        return;
      }

      badge.textContent = String(count);
      badge.classList.toggle("hidden", count === 0);
    });
  },

  updateGroupCount(count) {
    document.getElementById("group-count").textContent = count;
    document
      .getElementById("group-count")
      .classList.toggle("hidden", count === 0);
    const overviewGroupCount = document.getElementById("overview-group-count");
    if (overviewGroupCount) {
      overviewGroupCount.textContent = count;
    }
    document.getElementById("profile-group-count").textContent = count;
  },

  groupMembershipTone(group) {
    if (group?.status === "active") {
      return "active";
    }

    if (group?.status === "invited") {
      return "invited";
    }

    return "pending";
  },

  groupMembershipStatusLabel(group) {
    switch (group?.status) {
      case "active":
        return "Active member";
      case "invited":
        return "Invite pending";
      default:
        return Helpers.titleizeToken(group?.status, "Membership pending");
    }
  },

  groupRoleLabel(group) {
    return Helpers.titleizeToken(
      Helpers.nullableString(group?.role) || "member",
      "Member",
    );
  },

  groupVisibilityLabel(group) {
    return group?.inviteOnly ? "Invite only group" : "Public group";
  },

  groupSummaryCopy(group) {
    if (!group) {
      return "Group membership details appear here once you select a group.";
    }

    if (group.status === "invited") {
      return "Invite pending. Accept it before this group can participate in targeted ask-around or group-scoped boundaries.";
    }

    if (group.role === "owner" || group.role === "admin") {
      return "Manage invites, membership, and group-scoped boundaries for this trusted circle.";
    }

    return "Active membership ready for targeted ask-around and group-scoped boundaries.";
  },

  groupMatchesSearch(
    group,
    searchTerm = Helpers.string(State.groupSearch).trim(),
  ) {
    const query = Helpers.string(searchTerm).trim().toLowerCase();

    if (!query) {
      return true;
    }

    const haystack = [
      group?.name,
      group?.description,
      this.groupVisibilityLabel(group),
      this.groupMembershipStatusLabel(group),
      this.groupRoleLabel(group),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  },

  getVisibleGroups() {
    const statusOrder = {
      active: 0,
      invited: 1,
    };

    return State.groups
      .filter((group) => this.groupMatchesSearch(group))
      .slice()
      .sort((left, right) => {
        const statusDelta =
          (statusOrder[left?.status] ?? 99) -
          (statusOrder[right?.status] ?? 99);

        if (statusDelta !== 0) {
          return statusDelta;
        }

        const memberDelta =
          (right?.memberCount || 0) - (left?.memberCount || 0);

        if (memberDelta !== 0) {
          return memberDelta;
        }

        const createdDelta =
          Helpers.timestampValue(right?.createdAt) -
          Helpers.timestampValue(left?.createdAt);

        if (createdDelta !== 0) {
          return createdDelta;
        }

        return Helpers.string(left?.name).localeCompare(
          Helpers.string(right?.name),
        );
      });
  },

  getGroupCounts(groups = State.groups) {
    return groups.reduce(
      (counts, group) => {
        counts.all += 1;
        counts.totalMembers += Number.isFinite(group?.memberCount)
          ? group.memberCount
          : 0;

        if (group?.status === "active") {
          counts.activeMemberships += 1;
        }

        if (group?.status === "invited") {
          counts.invitedMemberships += 1;
        }

        if (group?.inviteOnly) {
          counts.inviteOnly += 1;
        }

        return counts;
      },
      {
        all: 0,
        activeMemberships: 0,
        invitedMemberships: 0,
        totalMembers: 0,
        inviteOnly: 0,
      },
    );
  },

  groupListMeta(visibleCount = 0) {
    const searchTerm = Helpers.string(State.groupSearch).trim();
    const matchesLabel = Helpers.pluralize(visibleCount, "match");

    return {
      title: "Working groups",
      description:
        "Use real group memberships to target ask-around circles, manage invites, and understand whether a group is actually useful yet.",
      total: searchTerm
        ? matchesLabel
        : Helpers.pluralize(visibleCount, "group"),
    };
  },

  renderGroupHeader(visibleGroups, counts = this.getGroupCounts()) {
    const summaryTitle = document.getElementById("group-list-title");
    const summaryDescription = document.getElementById(
      "group-list-description",
    );
    const totalChip = document.getElementById("group-list-total");
    const summaryStrip = document.getElementById("groups-summary-strip");
    const meta = this.groupListMeta(visibleGroups.length);

    if (summaryTitle) {
      summaryTitle.textContent = meta.title;
    }

    if (summaryDescription) {
      summaryDescription.textContent = meta.description;
    }

    if (totalChip) {
      totalChip.textContent = meta.total;
    }

    if (summaryStrip) {
      const summaryCards = [
        {
          label: "Active memberships",
          value: counts.activeMemberships,
          copy: "Ready right now",
        },
        {
          label: "Pending invites",
          value: counts.invitedMemberships,
          copy: "Waiting on you",
        },
        {
          label: "Active members",
          value: counts.totalMembers,
          copy: "Across your groups",
        },
        {
          label: "Invite only",
          value: counts.inviteOnly,
          copy: "Boundary-friendly circles",
        },
      ];

      summaryStrip.innerHTML = summaryCards
        .map(
          (card) => `
            <div class="network-summary-card">
              <span class="network-summary-label">${card.label}</span>
              <span class="network-summary-value">${card.value}</span>
              <span class="network-summary-copy">${card.copy}</span>
            </div>
          `,
        )
        .join("");
    }
  },

  renderGroupsEmptyState() {
    const searchTerm = Helpers.string(State.groupSearch).trim();

    if (searchTerm) {
      return `
        <div class="empty-state">
          <div class="empty-icon-large">🔎</div>
          <h3>No group matches for "${Helpers.escapeHtml(searchTerm)}"</h3>
          <p>Try a group name, description word, or a status like invite.</p>
        </div>
      `;
    }

    return `
      <div class="empty-state">
        <div class="empty-icon-large">🏘️</div>
        <h3>No groups yet</h3>
        <p>Create a trusted circle you can actually target for ask-around and group-scoped boundaries.</p>
        <button class="squishy-btn btn-primary" onclick="UI.showModal('create-group-modal')">
          <span>🏘️</span> Create Your First Group
        </button>
      </div>
    `;
  },

  preferredGroup(groups = []) {
    return (
      groups.find((group) => group?.status === "active") || groups[0] || null
    );
  },

  syncSelectedGroup(visibleGroups = this.getVisibleGroups()) {
    const currentGroup = State.selectedGroupId
      ? State.groupsById.get(State.selectedGroupId)
      : null;

    if (
      currentGroup &&
      visibleGroups.some((group) => group.id === currentGroup.id)
    ) {
      return currentGroup;
    }

    const nextGroup = this.preferredGroup(visibleGroups);
    State.selectedGroupId = nextGroup?.id || null;
    return nextGroup;
  },

  getGroupDetailState(groupOrId) {
    const groupId = Helpers.string(
      typeof groupOrId === "string" ? groupOrId : groupOrId?.id,
    );

    if (!groupId) {
      return {
        status: "idle",
        item: null,
        error: null,
        loadedAt: null,
      };
    }

    return (
      State.groupDetailsById.get(groupId) || {
        status: "idle",
        item: null,
        error: null,
        loadedAt: null,
      }
    );
  },

  getGroupMembersState(groupOrId) {
    const groupId = Helpers.string(
      typeof groupOrId === "string" ? groupOrId : groupOrId?.id,
    );

    if (!groupId) {
      return {
        status: "idle",
        items: [],
        error: null,
        loadedAt: null,
      };
    }

    return (
      State.groupMembersByGroupId.get(groupId) || {
        status: "idle",
        items: [],
        error: null,
        loadedAt: null,
      }
    );
  },

  compareGroupMembers(left, right) {
    const statusOrder = {
      active: 0,
      invited: 1,
    };
    const roleOrder = {
      owner: 0,
      admin: 1,
      member: 2,
    };

    const selfDelta =
      Number(right?.userId === State.user?.user_id) -
      Number(left?.userId === State.user?.user_id);

    if (selfDelta !== 0) {
      return selfDelta;
    }

    const statusDelta =
      (statusOrder[left?.status] ?? 99) - (statusOrder[right?.status] ?? 99);

    if (statusDelta !== 0) {
      return statusDelta;
    }

    const roleDelta =
      (roleOrder[left?.role] ?? 99) - (roleOrder[right?.role] ?? 99);

    if (roleDelta !== 0) {
      return roleDelta;
    }

    const joinedDelta =
      Helpers.timestampValue(left?.joinedAt) -
      Helpers.timestampValue(right?.joinedAt);

    if (joinedDelta !== 0) {
      return joinedDelta;
    }

    return Helpers.string(left?.displayName || left?.username).localeCompare(
      Helpers.string(right?.displayName || right?.username),
    );
  },

  groupMembersByStatus(members = []) {
    const active = [];
    const invited = [];

    members.forEach((member) => {
      if (member?.status === "invited") {
        invited.push(member);
      } else {
        active.push(member);
      }
    });

    active.sort((left, right) => this.compareGroupMembers(left, right));
    invited.sort((left, right) => this.compareGroupMembers(left, right));

    return {
      active,
      invited,
    };
  },

  async selectGroup(groupId) {
    if (!groupId || !State.groupsById.has(groupId)) {
      return;
    }

    State.selectedGroupId = groupId;
    this.renderGroups();
  },

  async refreshSelectedGroupWorkspace() {
    const group = State.selectedGroupId
      ? State.groupsById.get(State.selectedGroupId)
      : null;

    if (!group) {
      return;
    }

    await this.ensureGroupWorkspaceData(group, { force: true });
  },

  async ensureGroupWorkspaceData(group, options = {}) {
    if (!group) {
      return;
    }

    await Promise.all([
      this.ensureGroupDetailData(group, options),
      this.ensureGroupMembersData(group, options),
    ]);
  },

  async ensureGroupDetailData(groupOrId, options = {}) {
    const groupId = Helpers.string(
      typeof groupOrId === "string" ? groupOrId : groupOrId?.id,
    );

    if (!groupId) {
      return;
    }

    const existingState = this.getGroupDetailState(groupId);

    if (
      !options.force &&
      ["loading", "loaded"].includes(existingState.status)
    ) {
      return;
    }

    State.groupDetailsById.set(groupId, {
      status: "loading",
      item: existingState.item || State.groupsById.get(groupId) || null,
      error: null,
      loadedAt: existingState.loadedAt || null,
    });

    if (State.selectedGroupId === groupId) {
      this.renderGroupDetailPanel(State.groupsById.get(groupId) || null);
    }

    try {
      const detail = Normalizers.group(await API.groups.get(groupId));
      const mergedGroup = {
        ...(State.groupsById.get(groupId) || {}),
        ...(detail || {}),
      };

      if (detail) {
        State.groupsById.set(groupId, mergedGroup);
        State.groups = State.groups.map((group) =>
          group.id === groupId ? mergedGroup : group,
        );
      }

      State.groupDetailsById.set(groupId, {
        status: "loaded",
        item: detail,
        error: null,
        loadedAt: new Date().toISOString(),
      });
    } catch (error) {
      State.groupDetailsById.set(groupId, {
        status: "error",
        item: existingState.item || State.groupsById.get(groupId) || null,
        error: error.message || "Failed to load live group detail.",
        loadedAt: null,
      });
    }

    if (State.selectedGroupId === groupId) {
      this.renderGroups();
    }
  },

  async ensureGroupMembersData(groupOrId, options = {}) {
    const groupId = Helpers.string(
      typeof groupOrId === "string" ? groupOrId : groupOrId?.id,
    );

    if (!groupId) {
      return;
    }

    const existingState = this.getGroupMembersState(groupId);

    if (
      !options.force &&
      ["loading", "loaded"].includes(existingState.status)
    ) {
      return;
    }

    State.groupMembersByGroupId.set(groupId, {
      status: "loading",
      items: Array.isArray(existingState.items) ? existingState.items : [],
      error: null,
      loadedAt: existingState.loadedAt || null,
    });

    if (State.selectedGroupId === groupId) {
      this.renderGroupDetailPanel(State.groupsById.get(groupId) || null);
    }

    try {
      const membersModel = Normalizers.groupMembersModel(
        await API.groups.members(groupId),
      );
      const members = membersModel.items
        .slice()
        .sort((left, right) => this.compareGroupMembers(left, right));

      State.groupMembersByGroupId.set(groupId, {
        status: "loaded",
        items: members,
        error: null,
        loadedAt: new Date().toISOString(),
      });
    } catch (error) {
      State.groupMembersByGroupId.set(groupId, {
        status: "error",
        items: [],
        error: error.message || "Failed to load group members.",
        loadedAt: null,
      });
    }

    if (State.selectedGroupId === groupId) {
      this.renderGroupDetailPanel(State.groupsById.get(groupId) || null);
    }
  },

  normalizeNetworkFilter(filter = State.networkFilter) {
    const aliases = {
      pending: "incoming",
      sent: "outgoing",
    };
    const normalized = aliases[filter] || filter || "all";
    return ["all", "accepted", "incoming", "outgoing", "blocked"].includes(
      normalized,
    )
      ? normalized
      : "all";
  },

  networkBucket(friend) {
    if (friend?.status === "blocked") {
      return "blocked";
    }

    if (friend?.status === "accepted") {
      return "accepted";
    }

    if (friend?.status === "pending" && friend?.direction === "received") {
      return "incoming";
    }

    return "outgoing";
  },

  getNetworkRelationshipCounts(friends = State.friends) {
    return friends.reduce(
      (counts, friend) => {
        const bucket = this.networkBucket(friend);
        counts.all += 1;
        counts[bucket] += 1;
        return counts;
      },
      {
        all: 0,
        accepted: 0,
        incoming: 0,
        outgoing: 0,
        blocked: 0,
      },
    );
  },

  networkFilterMeta(filter = State.networkFilter, visibleCount = 0) {
    const searchTerm = Helpers.string(State.networkSearch).trim();
    const matchesLabel = Helpers.pluralize(visibleCount, "match");

    switch (filter) {
      case "accepted":
        return {
          title: "Accepted contacts",
          description:
            "These people are already in your trusted Mahilo circle and ready for direct asks, messages, and role-based boundaries.",
          total: searchTerm
            ? matchesLabel
            : Helpers.pluralize(visibleCount, "accepted contact"),
        };
      case "incoming":
        return {
          title: "Incoming requests",
          description:
            "These people are waiting on you to accept, reject, or block their request before they can join your useful circle.",
          total: searchTerm
            ? matchesLabel
            : Helpers.pluralize(visibleCount, "incoming request"),
        };
      case "outgoing":
        return {
          title: "Outgoing requests",
          description:
            "These requests are waiting on the other person before their agent can participate in your network.",
          total: searchTerm
            ? matchesLabel
            : Helpers.pluralize(visibleCount, "outgoing request"),
        };
      case "blocked":
        return {
          title: "Blocked relationships",
          description:
            "Blocked contacts stay out of ask-around, direct delivery, and future trust-circle decisions until you remove the record.",
          total: searchTerm
            ? matchesLabel
            : Helpers.pluralize(visibleCount, "blocked relationship"),
        };
      default:
        return {
          title: "All relationships",
          description:
            "Accepted contacts, pending requests, and blocked relationships powered by the real Mahilo friendship model.",
          total: searchTerm
            ? matchesLabel
            : Helpers.pluralize(visibleCount, "relationship"),
        };
    }
  },

  networkStatusLabel(friend) {
    const bucket = this.networkBucket(friend);

    switch (bucket) {
      case "accepted":
        return "Accepted";
      case "incoming":
        return "Pending incoming";
      case "outgoing":
        return "Pending outgoing";
      case "blocked":
        return "Blocked";
      default:
        return "Relationship";
    }
  },

  networkRequestDirectionLabel(friend) {
    return friend?.direction === "sent" ? "You initiated" : "They initiated";
  },

  networkRolesLabel(friend) {
    if (!Array.isArray(friend?.roles) || friend.roles.length === 0) {
      return "No roles yet";
    }

    return friend.roles
      .map((role) => Helpers.titleizeToken(role, ""))
      .join(", ");
  },

  networkRoleDescription(role) {
    const description = Helpers.nullableString(role?.description);

    if (description) {
      return description;
    }

    return role?.isSystem
      ? "System role available across every Mahilo account."
      : "Custom role available only in your account.";
  },

  networkAgeLabel(friend) {
    const labelByBucket = {
      accepted: "Connected",
      incoming: "Requested",
      outgoing: "Requested",
      blocked: "Recorded",
    };
    const bucket = this.networkBucket(friend);
    return `${labelByBucket[bucket] || "Started"} ${Helpers.formatShortDate(friend?.since, "date pending")}`;
  },

  networkSummaryCopy(friend) {
    const bucket = this.networkBucket(friend);

    switch (bucket) {
      case "accepted":
        return "Ready for direct asks, conversation history, and role-based sharing boundaries.";
      case "incoming":
        return "Review this request before the person can join your ask-around circle.";
      case "outgoing":
        return "Waiting on the other person before their agent can participate in your network.";
      case "blocked":
        return "Blocked contacts stay outside your trust circle until you remove the relationship.";
      default:
        return "Relationship details from the current Mahilo friendship model.";
    }
  },

  networkMatchesSearch(
    friend,
    searchTerm = Helpers.string(State.networkSearch).trim(),
  ) {
    const query = Helpers.string(searchTerm).trim().toLowerCase();
    if (!query) {
      return true;
    }

    const haystack = [
      friend?.displayName,
      friend?.username,
      this.networkStatusLabel(friend),
      this.networkRequestDirectionLabel(friend),
      ...(Array.isArray(friend?.roles) ? friend.roles : []),
      ...(Array.isArray(friend?.roles)
        ? friend.roles.map((role) => Helpers.titleizeToken(role, ""))
        : []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  },

  getVisibleNetworkFriends(filter = State.networkFilter) {
    const normalizedFilter = this.normalizeNetworkFilter(filter);
    const sortOrder = {
      accepted: 0,
      incoming: 1,
      outgoing: 2,
      blocked: 3,
    };

    return State.friends
      .filter((friend) => {
        const bucket = this.networkBucket(friend);
        return normalizedFilter === "all" || bucket === normalizedFilter;
      })
      .filter((friend) => this.networkMatchesSearch(friend))
      .slice()
      .sort((left, right) => {
        const bucketDelta =
          (sortOrder[this.networkBucket(left)] ?? 99) -
          (sortOrder[this.networkBucket(right)] ?? 99);

        if (bucketDelta !== 0) {
          return bucketDelta;
        }

        const interactionDelta =
          (right?.interactionCount || 0) - (left?.interactionCount || 0);
        if (interactionDelta !== 0) {
          return interactionDelta;
        }

        const sinceDelta =
          Helpers.timestampValue(right?.since) -
          Helpers.timestampValue(left?.since);
        if (sinceDelta !== 0) {
          return sinceDelta;
        }

        return Helpers.string(
          left?.displayName || left?.username,
        ).localeCompare(Helpers.string(right?.displayName || right?.username));
      });
  },

  renderNetworkHeader(
    filter,
    visibleFriends,
    counts = this.getNetworkRelationshipCounts(),
  ) {
    const summaryTitle = document.getElementById("network-list-title");
    const summaryDescription = document.getElementById(
      "network-list-description",
    );
    const totalChip = document.getElementById("network-list-total");
    const summaryStrip = document.getElementById("network-summary-strip");
    const meta = this.networkFilterMeta(filter, visibleFriends.length);
    const totalInteractions = State.friends.reduce(
      (sum, friend) =>
        sum +
        (Number.isFinite(friend?.interactionCount)
          ? friend.interactionCount
          : 0),
      0,
    );

    if (summaryTitle) {
      summaryTitle.textContent = meta.title;
    }

    if (summaryDescription) {
      summaryDescription.textContent = meta.description;
    }

    if (totalChip) {
      totalChip.textContent = meta.total;
    }

    if (summaryStrip) {
      const summaryCards = [
        {
          label: "Accepted",
          value: counts.accepted,
          copy: "Ready now",
        },
        {
          label: "Incoming",
          value: counts.incoming,
          copy: "Waiting on you",
        },
        {
          label: "Outgoing",
          value: counts.outgoing,
          copy: "Waiting on them",
        },
        {
          label: "Blocked",
          value: counts.blocked,
          copy: "Held outside",
        },
        {
          label: "Interactions",
          value: totalInteractions,
          copy: "Across your network",
        },
      ];

      summaryStrip.innerHTML = summaryCards
        .map(
          (card) => `
            <div class="network-summary-card">
              <span class="network-summary-label">${card.label}</span>
              <span class="network-summary-value">${card.value}</span>
              <span class="network-summary-copy">${card.copy}</span>
            </div>
          `,
        )
        .join("");
    }
  },

  renderNetworkEmptyState(filter = State.networkFilter) {
    const searchTerm = Helpers.string(State.networkSearch).trim();

    if (searchTerm) {
      return `
        <div class="empty-state">
          <div class="empty-icon-large">🔎</div>
          <h3>No matches for "${Helpers.escapeHtml(searchTerm)}"</h3>
          <p>Try a display name, exact username, or a role tag like close_friends.</p>
        </div>
      `;
    }

    const emptyStates = {
      all: {
        icon: "🤝",
        title: "Your trust circle starts with a few real people",
        copy: "Add the people whose agents you actually want to ask for recommendations, availability, and lived experience.",
        action: true,
      },
      accepted: {
        icon: "✅",
        title: "No accepted contacts yet",
        copy: "Accepted relationships are what turn a request list into a useful Mahilo circle.",
        action: true,
      },
      incoming: {
        icon: "📥",
        title: "No incoming requests right now",
        copy: "When someone asks to join your network, the request will show up here for review.",
      },
      outgoing: {
        icon: "📤",
        title: "No outgoing requests yet",
        copy: "Reach out to a few trusted people by username so your ask-around circle can start taking shape.",
        action: true,
      },
      blocked: {
        icon: "🚫",
        title: "No blocked relationships",
        copy: "Use blocking when someone should stay out of your trust circle entirely. Those records will stay visible here.",
      },
    };
    const state = emptyStates[filter] || emptyStates.all;

    return `
      <div class="empty-state">
        <div class="empty-icon-large">${state.icon}</div>
        <h3>${state.title}</h3>
        <p>${state.copy}</p>
        ${
          state.action
            ? `
              <button class="squishy-btn btn-primary" onclick="UI.openAddFriendModal()">
                <span>@</span> Add by Username
              </button>
            `
            : ""
        }
      </div>
    `;
  },

  renderNetworkActions(friend, options = {}) {
    const friendshipId = Helpers.string(friend?.friendshipId);
    const bucket = this.networkBucket(friend);
    const actionPrefix = options.stopPropagation
      ? "event.stopPropagation(); "
      : "";

    if (bucket === "incoming") {
      return `
        <button class="squishy-btn btn-primary btn-small" onclick="${actionPrefix}UI.handleAcceptFriend('${friendshipId}')">Accept</button>
        <button class="squishy-btn btn-secondary btn-small" onclick="${actionPrefix}UI.handleRejectFriend('${friendshipId}')">Reject</button>
      `;
    }

    if (bucket === "accepted") {
      return `
        <button class="squishy-btn btn-secondary btn-small" onclick="${actionPrefix}UI.handleBlockFriend('${friendshipId}')">Block</button>
        <button class="squishy-btn btn-danger btn-small" onclick="${actionPrefix}UI.handleUnfriend('${friendshipId}')">Unfriend</button>
      `;
    }

    if (bucket === "blocked") {
      return `
        <button class="squishy-btn btn-secondary btn-small" onclick="${actionPrefix}UI.handleUnfriend('${friendshipId}')">Remove</button>
      `;
    }

    return `
      <button class="squishy-btn btn-secondary btn-small" onclick="${actionPrefix}UI.handleUnfriend('${friendshipId}')">Cancel Request</button>
    `;
  },

  renderNetworkRoleAssignments(friend, editable) {
    const roles = Array.isArray(friend?.roles) ? friend.roles : [];

    if (!roles.length) {
      return `
        <div class="network-detail-empty">
          <div class="empty-icon">🏷️</div>
          <p>No trust roles assigned to this contact yet.</p>
          <p class="hint">
            ${
              editable
                ? "Add a role from the catalog below to make role-scoped boundaries usable."
                : "Accept this relationship before you start assigning trust roles."
            }
          </p>
        </div>
      `;
    }

    return `
      <div class="network-role-chip-list">
        ${roles
          .map(
            (roleName) => `
              <div class="network-role-chip">
                <div class="network-role-chip-copy">
                  <strong>${Helpers.escapeHtml(Helpers.titleizeToken(roleName, roleName))}</strong>
                  <span class="network-role-token">${Helpers.escapeHtml(roleName)}</span>
                </div>
                ${
                  editable
                    ? `
                      <button
                        type="button"
                        class="network-role-chip-action"
                        onclick="UI.handleRemoveFriendRole('${Helpers.string(friend?.friendshipId)}', '${roleName}')"
                      >
                        Remove
                      </button>
                    `
                    : ""
                }
              </div>
            `,
          )
          .join("")}
      </div>
    `;
  },

  renderNetworkRoleCatalog(friend, editable) {
    if (!editable) {
      return `
        <div class="network-detail-empty">
          <div class="empty-icon">🪢</div>
          <p>Roles become editable once this relationship is accepted.</p>
        </div>
      `;
    }

    if (State.availableRolesStatus === "error") {
      return `
        <div class="network-detail-empty">
          <div class="empty-icon">⚠️</div>
          <p>${Helpers.escapeHtml(State.availableRolesError || "Failed to load available roles.")}</p>
          <button class="squishy-btn btn-secondary btn-small network-inline-action" onclick="UI.refreshAvailableRoles()">
            Retry
          </button>
        </div>
      `;
    }

    if (State.availableRolesStatus !== "loaded") {
      return `
        <div class="network-loading-row">
          <span class="network-loading-dot"></span>
          <p>Loading the available role catalog for this account...</p>
        </div>
      `;
    }

    if (!State.availableRoles.length) {
      return `
        <div class="network-detail-empty">
          <div class="empty-icon">📚</div>
          <p>No roles are available for this account yet.</p>
        </div>
      `;
    }

    const assignedRoles = new Set(
      Array.isArray(friend?.roles) ? friend.roles : [],
    );

    return `
      <div class="network-role-library">
        ${State.availableRoles
          .map((role) => {
            const roleName = Helpers.string(role?.name);
            const isAssigned = assignedRoles.has(roleName);
            return `
              <article class="network-role-option ${isAssigned ? "assigned" : ""}">
                <div class="network-role-option-copy">
                  <div class="network-role-option-title-row">
                    <h5>${Helpers.escapeHtml(Helpers.titleizeToken(roleName, roleName))}</h5>
                    <span class="network-role-type">${role?.isSystem ? "System" : "Custom"}</span>
                  </div>
                  <p>${Helpers.escapeHtml(this.networkRoleDescription(role))}</p>
                  <span class="network-role-token">${Helpers.escapeHtml(roleName)}</span>
                </div>
                ${
                  isAssigned
                    ? '<span class="network-role-assigned-badge">Assigned</span>'
                    : `
                      <button
                        class="squishy-btn btn-secondary btn-small"
                        onclick="UI.handleAddFriendRole('${Helpers.string(friend?.friendshipId)}', '${roleName}')"
                      >
                        Add
                      </button>
                    `
                }
              </article>
            `;
          })
          .join("")}
      </div>
    `;
  },

  renderNetworkRoleSection(friend) {
    const editable = this.networkBucket(friend) === "accepted";

    return `
      <div class="network-role-stack">
        <div>
          <span class="network-role-subheading">Current roles</span>
          ${this.renderNetworkRoleAssignments(friend, editable)}
        </div>
        <div>
          <span class="network-role-subheading">Available roles</span>
          ${this.renderNetworkRoleCatalog(friend, editable)}
        </div>
      </div>
    `;
  },

  renderFriendCard(friend) {
    const bucket = this.networkBucket(friend);
    const friendshipId = Helpers.string(friend?.friendshipId);
    const isSelected = State.selectedNetworkFriendId === friendshipId;
    const displayName = Helpers.escapeHtml(
      friend?.displayName || friend?.username || "Unknown",
    );
    const username = Helpers.escapeHtml(friend?.username || "unknown");
    const summary = Helpers.escapeHtml(this.networkSummaryCopy(friend));
    const metaChips = [
      `Request: ${this.networkRequestDirectionLabel(friend)}`,
      `Roles: ${this.networkRolesLabel(friend)}`,
      `Interactions: ${Helpers.pluralize(friend?.interactionCount || 0, "interaction")}`,
      this.networkAgeLabel(friend),
    ]
      .map(
        (chip) => `
          <span class="friend-meta-chip">${Helpers.escapeHtml(chip)}</span>
        `,
      )
      .join("");

    return `
      <div
        class="friend-item ${bucket} ${isSelected ? "selected" : ""}"
        role="button"
        tabindex="0"
        aria-pressed="${isSelected ? "true" : "false"}"
        onclick="UI.selectNetworkFriend('${friendshipId}')"
        onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); UI.selectNetworkFriend('${friendshipId}'); }"
      >
        <div class="friend-primary">
          <div class="friend-avatar">
            ${(friend?.displayName?.[0] || friend?.username?.[0] || "?").toUpperCase()}
          </div>
          <div class="friend-main">
            <div class="friend-header">
              <div class="friend-heading">
                <div class="friend-name-row">
                  <div class="friend-name">${displayName}</div>
                  <div class="friend-username">@${username}</div>
                </div>
                <div class="friend-summary">${summary}</div>
              </div>
              <span class="friend-status ${bucket}">${this.networkStatusLabel(friend)}</span>
            </div>
            <div class="friend-meta-list">${metaChips}</div>
          </div>
        </div>
        <div class="friend-actions">
          ${this.renderNetworkActions(friend, { stopPropagation: true })}
        </div>
      </div>
    `;
  },

  networkConnectionCacheKey(username) {
    return Helpers.string(username).toLowerCase();
  },

  getNetworkConnectionState(friendOrUsername) {
    const username =
      typeof friendOrUsername === "string"
        ? friendOrUsername
        : friendOrUsername?.username;
    const key = this.networkConnectionCacheKey(username);

    if (!key) {
      return {
        status: "idle",
        items: [],
        error: null,
        loadedAt: null,
      };
    }

    return (
      State.contactConnectionsByUsername.get(key) || {
        status: "idle",
        items: [],
        error: null,
        loadedAt: null,
      }
    );
  },

  preferredNetworkFriend(friends = []) {
    return (
      friends.find((friend) => this.networkBucket(friend) === "accepted") ||
      friends[0] ||
      null
    );
  },

  syncSelectedNetworkFriend(
    visibleFriends = this.getVisibleNetworkFriends(State.networkFilter),
  ) {
    const currentFriend = State.selectedNetworkFriendId
      ? State.friendsById.get(State.selectedNetworkFriendId)
      : null;

    if (
      currentFriend &&
      visibleFriends.some(
        (friend) => friend.friendshipId === currentFriend.friendshipId,
      )
    ) {
      return currentFriend;
    }

    const nextFriend = this.preferredNetworkFriend(visibleFriends);
    State.selectedNetworkFriendId = nextFriend?.friendshipId || null;
    return nextFriend;
  },

  async selectNetworkFriend(friendshipId) {
    if (!friendshipId || !State.friendsById.has(friendshipId)) {
      return;
    }

    State.selectedNetworkFriendId = friendshipId;
    this.renderFriends();
  },

  async refreshSelectedNetworkConnections() {
    const friend = State.selectedNetworkFriendId
      ? State.friendsById.get(State.selectedNetworkFriendId)
      : null;

    if (!friend) {
      return;
    }

    await this.ensureNetworkConnectionData(friend, { force: true });
  },

  async ensureNetworkConnectionData(friend, options = {}) {
    if (!friend || this.networkBucket(friend) !== "accepted") {
      return;
    }

    const key = this.networkConnectionCacheKey(friend.username);

    if (!key) {
      return;
    }

    const existingState = this.getNetworkConnectionState(friend);

    if (
      !options.force &&
      ["loading", "loaded"].includes(existingState.status)
    ) {
      return;
    }

    const shouldRenderOverview = options.renderOverview !== false;
    const shouldRenderSelected =
      options.renderSelected !== false &&
      State.selectedNetworkFriendId === friend.friendshipId;

    State.contactConnectionsByUsername.set(key, {
      status: "loading",
      items: Array.isArray(existingState.items) ? existingState.items : [],
      error: null,
      loadedAt: existingState.loadedAt || null,
    });

    if (shouldRenderSelected) {
      this.renderNetworkConnectionSpace(friend);
    }
    if (shouldRenderOverview) {
      this.renderOverviewFriends();
    }

    try {
      const connectionsModel = Normalizers.agentsModel(
        await API.contacts.connections(friend.username),
      );

      State.contactConnectionsByUsername.set(key, {
        status: "loaded",
        items: connectionsModel.items,
        error: null,
        loadedAt: new Date().toISOString(),
      });
    } catch (error) {
      State.contactConnectionsByUsername.set(key, {
        status: "error",
        items: [],
        error: error.message || "Failed to load active contact connections.",
        loadedAt: null,
      });
    }

    if (shouldRenderSelected) {
      this.renderNetworkConnectionSpace(friend);
    }
    if (shouldRenderOverview) {
      this.renderOverviewFriends();
    }
  },

  networkReadinessState(
    friend,
    connectionState = this.getNetworkConnectionState(friend),
  ) {
    if (!friend) {
      return null;
    }

    const bucket = this.networkBucket(friend);
    const connections = Array.isArray(connectionState?.items)
      ? connectionState.items
      : [];
    const status = connectionState?.status || "idle";

    if (bucket !== "accepted") {
      const pendingMeta = {
        incoming: {
          title: "Waiting on your decision",
          summary:
            "Accept this request before Mahilo can inspect the contact connection space or include this person in ask-around.",
          direct: "Direct send is blocked until you accept the relationship.",
          askAround:
            "Pending contacts do not participate in ask-around until the relationship is accepted.",
        },
        outgoing: {
          title: "Waiting on their acceptance",
          summary:
            "Connection readiness becomes available after the other person accepts your request.",
          direct:
            "Mahilo will not attempt direct delivery until the relationship is accepted.",
          askAround:
            "Outgoing requests stay outside ask-around participation until acceptance completes.",
        },
        blocked: {
          title: "Blocked from Mahilo participation",
          summary:
            "Blocked contacts stay outside direct delivery and ask-around until the relationship record is removed.",
          direct:
            "Blocked relationships are not eligible for direct send routing.",
          askAround:
            "Blocked relationships are excluded from ask-around participation.",
        },
      };
      const meta = pendingMeta[bucket] || pendingMeta.outgoing;

      return {
        tone: "not-ready",
        summaryTitle: meta.title,
        summaryCopy: meta.summary,
        directSend: {
          label: "Not ready",
          tone: "not-ready",
          copy: meta.direct,
        },
        askAround: {
          label: "Not ready",
          tone: "not-ready",
          copy: meta.askAround,
        },
      };
    }

    if (status === "error") {
      return {
        tone: "warning",
        summaryTitle: "Unable to verify connection readiness",
        summaryCopy:
          "Mahilo could not load this contact’s active connections just now. Retry to confirm direct-send and ask-around readiness.",
        directSend: {
          label: "Check failed",
          tone: "warning",
          copy: "Mahilo could not confirm an active direct-delivery route from the contact connections API.",
        },
        askAround: {
          label: "Check failed",
          tone: "warning",
          copy: "Retry the contact connection lookup to confirm whether this person can participate in ask-around.",
        },
      };
    }

    if (status !== "loaded") {
      return {
        tone: "pending",
        summaryTitle: "Checking active Mahilo connections",
        summaryCopy:
          "Mahilo is loading this contact’s live connection space to determine direct-send and ask-around readiness.",
        directSend: {
          label: "Checking",
          tone: "pending",
          copy: "Loading active contact connections for direct delivery readiness.",
        },
        askAround: {
          label: "Checking",
          tone: "pending",
          copy: "Loading active contact connections for ask-around readiness.",
        },
      };
    }

    if (!connections.length) {
      return {
        tone: "not-ready",
        summaryTitle: "No active Mahilo connections right now",
        summaryCopy:
          "This accepted contact is in your network, but they are not ready for direct send or ask-around until an active connection comes online.",
        directSend: {
          label: "Not ready",
          tone: "not-ready",
          copy: "Direct send would fail right now because Mahilo has no active recipient connection to route to.",
        },
        askAround: {
          label: "Not ready",
          tone: "not-ready",
          copy: "Without an active connection, this contact cannot participate in ask-around results.",
        },
      };
    }

    const frameworks = Array.from(
      new Set(
        connections
          .map((connection) =>
            Helpers.titleizeToken(connection.framework, "Unknown"),
          )
          .filter(Boolean),
      ),
    );

    return {
      tone: "ready",
      summaryTitle: "Ready for direct send and ask-around",
      summaryCopy: `${Helpers.pluralize(connections.length, "active connection")} live${
        frameworks.length ? ` across ${frameworks.join(", ")}` : ""
      }.`,
      directSend: {
        label: "Ready",
        tone: "ready",
        copy: "Mahilo can route a direct send to one of this contact’s active connections.",
      },
      askAround: {
        label: "Ready",
        tone: "ready",
        copy: "This contact can participate when your agent asks the network for answers.",
      },
    };
  },

  renderNetworkReadinessCard(title, readiness) {
    return `
      <div class="network-readiness-card">
        <div class="network-readiness-card-header">
          <span class="network-readiness-label">${Helpers.escapeHtml(title)}</span>
          <span class="network-readiness-status ${Helpers.escapeHtml(readiness?.tone || "pending")}">
            ${Helpers.escapeHtml(readiness?.label || "Checking")}
          </span>
        </div>
        <p>${Helpers.escapeHtml(readiness?.copy || "")}</p>
      </div>
    `;
  },

  renderContactConnectionCard(connection) {
    const framework = Helpers.titleizeToken(
      connection?.framework,
      "Unknown framework",
    );
    const label = Helpers.string(
      connection?.label,
      connection?.id || "Unnamed connection",
    );
    const description = Helpers.nullableString(connection?.description);
    const metaChips = [
      `Framework: ${framework}`,
      `Label: ${label}`,
      `Status: ${Helpers.titleizeToken(connection?.status, "Unknown")}`,
      `Priority: ${Helpers.number(connection?.routingPriority, 0)}`,
    ]
      .map(
        (chip) => `
          <span class="friend-meta-chip">${Helpers.escapeHtml(chip)}</span>
        `,
      )
      .join("");
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities
      : [];

    return `
      <article class="contact-connection-card">
        <div class="contact-connection-header">
          <div class="contact-connection-copy">
            <h5>${Helpers.escapeHtml(label)}</h5>
            <p>${Helpers.escapeHtml(framework)}</p>
          </div>
          <span class="status-badge ${Helpers.escapeHtml(connection?.status || "active")}">
            ${Helpers.escapeHtml(Helpers.titleizeToken(connection?.status, "Active"))}
          </span>
        </div>
        ${
          description
            ? `<p class="contact-connection-description">${Helpers.escapeHtml(description)}</p>`
            : ""
        }
        <div class="contact-connection-meta">${metaChips}</div>
        <div class="contact-connection-capabilities">
          ${
            capabilities.length
              ? capabilities
                  .map(
                    (capability) => `
                      <span class="capability-tag">${Helpers.escapeHtml(capability)}</span>
                    `,
                  )
                  .join("")
              : '<span class="capability-tag">No capabilities declared</span>'
          }
        </div>
      </article>
    `;
  },

  renderNetworkConnectionSection(friend, connectionState) {
    if (!friend) {
      return `
        <div class="network-detail-empty">
          <div class="empty-icon">🤝</div>
          <p>Select a contact to open their connection space.</p>
        </div>
      `;
    }

    const bucket = this.networkBucket(friend);

    if (bucket !== "accepted") {
      return `
        <div class="network-detail-empty">
          <div class="empty-icon">🪢</div>
          <p>Connection details become available after this relationship is accepted.</p>
        </div>
      `;
    }

    if (connectionState.status === "error") {
      return `
        <div class="network-detail-empty">
          <div class="empty-icon">⚠️</div>
          <p>${Helpers.escapeHtml(connectionState.error || "Failed to load active contact connections.")}</p>
          <button class="squishy-btn btn-secondary btn-small network-inline-action" onclick="UI.refreshSelectedNetworkConnections()">
            Retry
          </button>
        </div>
      `;
    }

    if (connectionState.status !== "loaded") {
      return `
        <div class="network-loading-row">
          <span class="network-loading-dot"></span>
          <p>Checking active Mahilo connections for direct-send and ask-around readiness...</p>
        </div>
      `;
    }

    if (!connectionState.items.length) {
      return `
        <div class="network-detail-empty">
          <div class="empty-icon">📭</div>
          <p>No active Mahilo connections are live for this contact.</p>
          <p class="hint">They are not ready for ask-around or direct send until one of their connections becomes active.</p>
        </div>
      `;
    }

    return `
      <div class="contact-connection-list">
        ${connectionState.items
          .map((connection) => this.renderContactConnectionCard(connection))
          .join("")}
      </div>
    `;
  },

  renderNetworkConnectionSpace(friend = null) {
    const panel = document.getElementById("network-detail-panel");

    if (!panel) {
      return;
    }

    if (!friend) {
      panel.innerHTML = `
        <div class="network-detail-panel">
          <div class="network-detail-placeholder">
            <div class="empty-icon-large">🧭</div>
            <h3>Open a connection space</h3>
            <p>Select someone from your network to see whether they have active Mahilo connections and whether they are ready for direct send or ask-around.</p>
          </div>
        </div>
      `;
      return;
    }

    const connectionState = this.getNetworkConnectionState(friend);
    const readiness = this.networkReadinessState(friend, connectionState);
    const bucket = this.networkBucket(friend);
    const displayName = Helpers.escapeHtml(
      friend.displayName || friend.username || "Unknown",
    );
    const username = Helpers.escapeHtml(friend.username || "unknown");
    const relationshipMeta = [
      `Relationship: ${this.networkStatusLabel(friend)}`,
      `Request: ${this.networkRequestDirectionLabel(friend)}`,
      `Roles: ${this.networkRolesLabel(friend)}`,
      `Interactions: ${Helpers.pluralize(friend?.interactionCount || 0, "interaction")}`,
      this.networkAgeLabel(friend),
    ]
      .map(
        (chip) => `
          <span class="friend-meta-chip">${Helpers.escapeHtml(chip)}</span>
        `,
      )
      .join("");
    const canRefreshConnections = bucket === "accepted";

    panel.innerHTML = `
      <div class="network-detail-panel">
        <div class="network-detail-header">
          <div class="network-detail-avatar">
            ${(friend?.displayName?.[0] || friend?.username?.[0] || "?").toUpperCase()}
          </div>
          <div class="network-detail-copy">
            <p class="network-detail-eyebrow">Connection space</p>
            <h3>${displayName}</h3>
            <p class="network-detail-username">@${username}</p>
            <div class="network-detail-status-row">
              <span class="friend-status ${bucket}">${this.networkStatusLabel(friend)}</span>
            </div>
          </div>
          ${
            canRefreshConnections
              ? `
                <button
                  class="squishy-btn btn-secondary btn-small"
                  onclick="UI.refreshSelectedNetworkConnections()"
                  ${connectionState.status === "loading" ? "disabled" : ""}
                >
                  ${connectionState.status === "loading" ? "Refreshing..." : "Refresh"}
                </button>
              `
              : ""
          }
        </div>

        <div class="network-readiness-banner ${Helpers.escapeHtml(readiness?.tone || "pending")}">
          <span class="network-readiness-label">Mahilo readiness</span>
          <strong>${Helpers.escapeHtml(readiness?.summaryTitle || "Checking")}</strong>
          <p>${Helpers.escapeHtml(readiness?.summaryCopy || "")}</p>
        </div>

        <div class="network-readiness-grid">
          ${this.renderNetworkReadinessCard("Direct send", readiness?.directSend)}
          ${this.renderNetworkReadinessCard("Ask-around", readiness?.askAround)}
        </div>

        <div class="network-detail-section">
          <div class="network-detail-section-header">
            <div>
              <h4>Relationship actions</h4>
              <p class="network-detail-section-copy">
                Use the current Mahilo friendship flow to accept, reject, block, or remove this relationship without leaving the dashboard.
              </p>
            </div>
          </div>
          <div class="network-detail-actions">
            ${this.renderNetworkActions(friend)}
          </div>
        </div>

        <div class="network-detail-section">
          <div class="network-detail-section-header">
            <div>
              <h4>Active contact connections</h4>
              <p class="network-detail-section-copy">
                Framework, label, capabilities, and live status from the current contacts API.
              </p>
            </div>
            ${
              bucket === "accepted" && connectionState.status === "loaded"
                ? `
                  <div class="friends-total-chip">
                    ${Helpers.pluralize(connectionState.items.length, "active connection")}
                  </div>
                `
                : ""
            }
          </div>
          ${this.renderNetworkConnectionSection(friend, connectionState)}
        </div>

        <div class="network-detail-section">
          <div class="network-detail-section-header">
            <div>
              <h4>Trust roles</h4>
              <p class="network-detail-section-copy">
                Role-scoped boundaries use these trust tags to decide what Mahilo can share with this contact.
              </p>
            </div>
          </div>
          ${this.renderNetworkRoleSection(friend)}
        </div>

        <div class="network-detail-section">
          <div class="network-detail-section-header">
            <div>
              <h4>Relationship context</h4>
              <p class="network-detail-section-copy">
                Network state from the friendship model that gates Mahilo participation.
              </p>
            </div>
          </div>
          <div class="network-detail-meta">
            ${relationshipMeta}
          </div>
        </div>
      </div>
    `;
  },

  // Render functions
  compareSenderConnections(left, right) {
    const leftActive = Helpers.string(left?.status).toLowerCase() === "active";
    const rightActive =
      Helpers.string(right?.status).toLowerCase() === "active";

    if (leftActive !== rightActive) {
      return Number(rightActive) - Number(leftActive);
    }

    const priorityDiff =
      Helpers.number(right?.routingPriority, 0) -
      Helpers.number(left?.routingPriority, 0);
    if (priorityDiff) {
      return priorityDiff;
    }

    const createdDiff =
      Helpers.timestampValue(right?.createdAt) -
      Helpers.timestampValue(left?.createdAt);
    if (createdDiff) {
      return createdDiff;
    }

    return Helpers.string(left?.label).localeCompare(
      Helpers.string(right?.label),
    );
  },

  getSortedSenderConnections(connections = State.agents) {
    return (Array.isArray(connections) ? [...connections] : []).sort(
      (left, right) => this.compareSenderConnections(left, right),
    );
  },

  getDefaultSenderCandidate(connections = State.agents) {
    return (
      this.getSortedSenderConnections(connections).find(
        (connection) =>
          Helpers.string(connection?.status).toLowerCase() === "active",
      ) || null
    );
  },

  describeSenderConnectionHealth(agent) {
    const pingState = State.agentHealthById.get(agent.id) || null;
    const mode = agent.mode || Helpers.connectionMode(agent.callbackUrl);
    const isActive = Helpers.string(agent?.status).toLowerCase() === "active";

    if (!isActive) {
      return {
        tone: "inactive",
        label: "Inactive",
        detail:
          "Inactive connections stay visible here, but Mahilo skips them when it auto-selects a sender.",
      };
    }

    if (pingState) {
      if (pingState.success) {
        if (mode === "polling") {
          return {
            tone: "healthy",
            label: "Polling inbox",
            detail:
              pingState.message ||
              "Polling connections deliver through Mahilo's inbox route instead of an HTTP callback.",
          };
        }

        const pingSummary = [
          `Last ping ${Helpers.formatDateTime(pingState.checkedAt)}`,
          pingState.statusCode ? `HTTP ${pingState.statusCode}` : null,
          Number.isFinite(pingState.latencyMs)
            ? `${pingState.latencyMs}ms`
            : null,
        ]
          .filter(Boolean)
          .join(" • ");

        return {
          tone: "healthy",
          label: "Healthy",
          detail:
            pingSummary || "Webhook callback responded to the latest ping.",
        };
      }

      return {
        tone: "warning",
        label: "Ping failed",
        detail: [
          `Last check ${Helpers.formatDateTime(pingState.checkedAt)}`,
          pingState.error || "Mahilo could not reach this connection.",
        ]
          .filter(Boolean)
          .join(" • "),
      };
    }

    if (mode === "polling") {
      return {
        tone: "healthy",
        label: "Polling inbox",
        detail:
          "Polling connections do not expose a callback URL. Mahilo delivers to their inbox route when selected.",
      };
    }

    if (agent.lastSeen) {
      return {
        tone: "observed",
        label: "Seen on callback",
        detail: `Last callback activity ${Helpers.formatDateTime(agent.lastSeen)}.`,
      };
    }

    return {
      tone: "unknown",
      label: "Not checked",
      detail: "Run ping to verify webhook reachability from the dashboard.",
    };
  },

  describeSenderRouting(agent, defaultCandidate) {
    const isActive = Helpers.string(agent?.status).toLowerCase() === "active";

    if (!isActive) {
      return {
        tone: "inactive",
        badge: "Inactive route",
        detail:
          "Mahilo ignores inactive connections when it picks a sender automatically.",
      };
    }

    if (!defaultCandidate) {
      return {
        tone: "standby",
        badge: "Awaiting sender",
        detail:
          "Mahilo needs an active connection before it can auto-select a sender.",
      };
    }

    if (agent.id === defaultCandidate.id) {
      return {
        tone: "default",
        badge: "Default sender",
        detail:
          "Mahilo will auto-select this connection first because it has the highest active routing priority. Newer registrations win ties.",
      };
    }

    if (
      Helpers.number(agent.routingPriority, 0) <
      Helpers.number(defaultCandidate.routingPriority, 0)
    ) {
      return {
        tone: "standby",
        badge: "Standby route",
        detail: `${defaultCandidate.label} wins automatic sender selection with a higher routing priority.`,
      };
    }

    return {
      tone: "standby",
      badge: "Standby route",
      detail: `${defaultCandidate.label} wins the tie because it was registered more recently.`,
    };
  },

  getSenderConnectionWorkspaceItems(connections = State.agents) {
    const sortedConnections = this.getSortedSenderConnections(connections);
    const defaultCandidate = this.getDefaultSenderCandidate(sortedConnections);

    return sortedConnections.map((agent) => {
      const mode = agent.mode || Helpers.connectionMode(agent.callbackUrl);
      const health = this.describeSenderConnectionHealth(agent);
      const routing = this.describeSenderRouting(agent, defaultCandidate);

      return {
        ...agent,
        health,
        isDefaultSenderCandidate: defaultCandidate?.id === agent.id,
        lastSeenLabel: Helpers.formatDateTime(
          agent.lastSeen,
          "No callback activity yet",
        ),
        modeLabel: Helpers.connectionModeLabel(mode),
        routing,
      };
    });
  },

  getSenderConnectionWorkspaceItem(agentId) {
    return this.getSenderConnectionWorkspaceItems().find(
      (connection) => connection.id === agentId,
    );
  },

  renderSenderConnectionCard(agent) {
    const description = Helpers.nullableString(agent.description);
    const capabilities = Array.isArray(agent.capabilities)
      ? agent.capabilities
      : [];

    return `
      <article class="agent-card ${Helpers.escapeHtml(agent.routing.tone)}" onclick="UI.showAgentDetails('${Helpers.escapeHtml(agent.id)}')">
        <div class="agent-card-header">
          <div class="agent-avatar">🤖</div>
          <div class="agent-info">
            <div class="agent-name">${Helpers.escapeHtml(agent.label)}</div>
            <div class="agent-framework">${Helpers.escapeHtml(Helpers.titleizeToken(agent.framework, "Unknown framework"))}</div>
          </div>
          <div class="agent-card-badges">
            <span class="agent-status ${Helpers.escapeHtml(agent.status)}">
              <span class="status-dot"></span>
              ${Helpers.escapeHtml(Helpers.titleizeToken(agent.status, "Unknown"))}
            </span>
            ${
              agent.mode
                ? `
                  <span class="status-badge ${Helpers.escapeHtml(agent.mode)}">
                    ${Helpers.escapeHtml(agent.modeLabel)}
                  </span>
                `
                : ""
            }
          </div>
        </div>
        <div class="agent-card-body">
          <div class="agent-routing-callout ${Helpers.escapeHtml(agent.routing.tone)}">
            <span class="agent-routing-badge">${Helpers.escapeHtml(agent.routing.badge)}</span>
            <p>${Helpers.escapeHtml(agent.routing.detail)}</p>
          </div>
          <div class="agent-meta-grid">
            <div class="agent-meta-item">
              <span class="agent-meta-label">Routing priority</span>
              <strong class="agent-meta-value">${Helpers.escapeHtml(String(Helpers.number(agent.routingPriority, 0)))}</strong>
              <span class="agent-meta-note">Used for auto-selection</span>
            </div>
            <div class="agent-meta-item">
              <span class="agent-meta-label">Last seen</span>
              <strong class="agent-meta-value">${Helpers.escapeHtml(agent.lastSeenLabel)}</strong>
              <span class="agent-meta-note">Last callback or registration activity</span>
            </div>
            <div class="agent-meta-item">
              <span class="agent-meta-label">Connection mode</span>
              <strong class="agent-meta-value">${Helpers.escapeHtml(agent.modeLabel)}</strong>
              <span class="agent-meta-note">${
                agent.mode === "polling"
                  ? "Inbox delivery route"
                  : "HTTP callback route"
              }</span>
            </div>
            <div class="agent-meta-item">
              <span class="agent-meta-label">Callback health</span>
              <strong class="agent-meta-value">${Helpers.escapeHtml(agent.health.label)}</strong>
              <span class="agent-meta-note">${Helpers.escapeHtml(agent.health.detail)}</span>
            </div>
          </div>
          ${
            description
              ? `<div class="agent-description">${Helpers.escapeHtml(description)}</div>`
              : ""
          }
          <div class="agent-capabilities">
            ${
              capabilities.length
                ? capabilities
                    .map(
                      (capability) => `
                        <span class="capability-tag">${Helpers.escapeHtml(capability)}</span>
                      `,
                    )
                    .join("")
                : '<span class="capability-tag">No capabilities declared</span>'
            }
          </div>
        </div>
        <div class="agent-card-footer">
          <button class="squishy-btn btn-secondary btn-small" onclick="event.stopPropagation(); UI.showAgentDetails('${Helpers.escapeHtml(agent.id)}')">
            Details
          </button>
          <button class="squishy-btn btn-primary btn-small" onclick="event.stopPropagation(); UI.handlePingAgent('${Helpers.escapeHtml(agent.id)}')">
            Check Health
          </button>
        </div>
      </article>
    `;
  },

  renderAgents() {
    const grid = document.getElementById("agents-grid");
    const connections = this.getSenderConnectionWorkspaceItems();

    if (!connections.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon-large">🤖</div>
          <h3>No sender connections yet</h3>
          <p>Add a sender connection so Mahilo can deliver messages and ask around for you</p>
          <button class="squishy-btn btn-primary" id="add-first-agent">
            <span>🚀</span> Add Your First Connection
          </button>
        </div>
      `;
      document
        .getElementById("add-first-agent")
        ?.addEventListener("click", () => {
          this.openAgentEditor();
        });
      return;
    }

    grid.innerHTML = connections
      .map((agent) => this.renderSenderConnectionCard(agent))
      .join("");
  },

  async handlePingAgent(id) {
    try {
      const agent = State.agentsById.get(id);
      const result = await API.agents.ping(id);
      const checkedAt = new Date().toISOString();

      State.agentHealthById.set(id, {
        checkedAt,
        error: Helpers.nullableString(result.error),
        latencyMs: Helpers.number(result.latency_ms, 0),
        message: Helpers.nullableString(result.message),
        mode:
          Helpers.nullableString(result.mode) ||
          agent?.mode ||
          Helpers.connectionMode(agent?.callbackUrl),
        statusCode:
          typeof result.status_code === "number" ? result.status_code : null,
        success: Boolean(result.success),
      });

      if (agent && result.last_seen) {
        agent.lastSeen = Helpers.iso(result.last_seen);
      }

      this.renderAgents();
      this.renderOverviewAgents();
      this.renderDevDiagnostics();
      this.renderDevMessagingSummary();

      if (State.selectedAgentId === id) {
        this.showAgentDetails(id);
      }

      if (result.success) {
        if (result.mode === "polling") {
          this.showToast(
            result.message ||
              "Polling route confirmed. Mahilo will deliver through the inbox route.",
            "success",
          );
        } else {
          this.showToast(
            `Connection responded in ${result.latency_ms}ms`,
            "success",
          );
        }
      } else {
        this.showToast(
          `Connection ping failed: ${result.error || "Health check failed"}`,
          "error",
        );
      }
    } catch (error) {
      this.showToast("Failed to ping sender connection", "error");
    }
  },

  renderFriends(filter = State.networkFilter) {
    const list = document.getElementById("friends-list");
    if (!list) {
      return;
    }

    State.networkFilter = this.normalizeNetworkFilter(filter);

    const searchInput = document.getElementById("user-search");
    if (searchInput && searchInput.value !== State.networkSearch) {
      searchInput.value = State.networkSearch;
    }

    document
      .querySelectorAll(".friends-filters .filter-btn")
      .forEach((button) => {
        button.classList.toggle(
          "active",
          button.dataset.filter === State.networkFilter,
        );
      });

    const counts = this.getNetworkRelationshipCounts();
    const friends = this.getVisibleNetworkFriends(State.networkFilter);
    const selectedFriend = this.syncSelectedNetworkFriend(friends);
    this.renderNetworkHeader(State.networkFilter, friends, counts);

    if (!friends.length) {
      list.innerHTML = this.renderNetworkEmptyState(State.networkFilter);
      this.renderNetworkConnectionSpace(null);
      return;
    }

    list.innerHTML = friends
      .map((friend) => this.renderFriendCard(friend))
      .join("");
    this.renderNetworkConnectionSpace(selectedFriend);
    void this.ensureNetworkConnectionData(selectedFriend);
  },

  groupReadinessState(
    group,
    detailState = this.getGroupDetailState(group),
    membersState = this.getGroupMembersState(group),
  ) {
    if (!group) {
      return null;
    }

    if (detailState.status === "error" || membersState.status === "error") {
      return {
        tone: "warning",
        summaryTitle: "Unable to verify live group readiness",
        summaryCopy:
          "Mahilo could not load the latest group detail and member roster just now. Retry before relying on this group for targeting decisions.",
        askAround: {
          label: "Retry needed",
          tone: "warning",
          copy: "Refresh the group detail and members to confirm whether active members can answer ask-around requests.",
        },
        boundaries: {
          label: "Retry needed",
          tone: "warning",
          copy: "Refresh this workspace before trusting group-scoped boundary readiness.",
        },
      };
    }

    if (detailState.status !== "loaded" || membersState.status !== "loaded") {
      return {
        tone: "pending",
        summaryTitle: "Checking group detail and members",
        summaryCopy:
          "Loading live membership, invite, and roster data from the current groups API.",
        askAround: {
          label: "Checking",
          tone: "pending",
          copy: "Loading active versus invited members for targeted ask-around readiness.",
        },
        boundaries: {
          label: "Checking",
          tone: "pending",
          copy: "Loading group detail before boundary-targeting guidance appears.",
        },
      };
    }

    const detail = detailState.item || group;
    const members = Array.isArray(membersState.items) ? membersState.items : [];
    const { active, invited } = this.groupMembersByStatus(members);
    const activePeers = active.filter(
      (member) => member.userId !== State.user?.user_id,
    );

    if (detail?.status === "invited") {
      return {
        tone: "pending",
        summaryTitle: "Invite pending",
        summaryCopy:
          "Accept this invite before the group can participate in targeted ask-around or group-scoped boundaries.",
        askAround: {
          label: "Invite pending",
          tone: "pending",
          copy: "Ask-around only becomes useful after you accept the invite and at least one active peer remains in the group.",
        },
        boundaries: {
          label: "Invite pending",
          tone: "pending",
          copy: "Group-scoped boundaries stay dormant for you until your membership becomes active.",
        },
      };
    }

    if (activePeers.length > 0) {
      return {
        tone: "ready",
        summaryTitle: "Useful for targeted ask-around",
        summaryCopy: `${Helpers.pluralize(activePeers.length, "other active member")} can contribute when you target this group.${
          invited.length
            ? ` ${Helpers.pluralize(invited.length, "invite")} is still pending.`
            : ""
        }`,
        askAround: {
          label: "Ready",
          tone: "ready",
          copy: "This group has active members besides you, so targeted ask-around can produce real answers.",
        },
        boundaries: {
          label: "Ready",
          tone: "ready",
          copy: "Group-scoped boundaries can target this circle with a live active roster.",
        },
      };
    }

    if (invited.length > 0) {
      return {
        tone: "pending",
        summaryTitle: "Waiting on more active members",
        summaryCopy:
          "You are active here, but nobody else is active yet. This group becomes useful once one of the pending invites turns into an active member.",
        askAround: {
          label: "Waiting",
          tone: "pending",
          copy: "Ask-around stays thin until at least one invited member becomes active.",
        },
        boundaries: {
          label: "Limited",
          tone: "warning",
          copy: "You can target the group, but the circle is still too small to be a strong boundary overlay.",
        },
      };
    }

    return {
      tone: "not-ready",
      summaryTitle: "Too thin for ask-around",
      summaryCopy:
        "You are the only active member in this group right now. It can exist as a label, but it is not yet a useful ask-around circle.",
      askAround: {
        label: "Not ready",
        tone: "not-ready",
        copy: "Ask-around needs at least one other active member in the group to be useful.",
      },
      boundaries: {
        label: "Limited",
        tone: "warning",
        copy: "Group-scoped boundaries can target this group, but they currently apply only to you.",
      },
    };
  },

  renderGroupCard(group) {
    const tone = this.groupMembershipTone(group);
    const isSelected = State.selectedGroupId === group?.id;
    const name = Helpers.escapeHtml(group?.name || "Untitled group");
    const summary = Helpers.escapeHtml(
      group?.description || this.groupSummaryCopy(group),
    );
    const visibility = Helpers.escapeHtml(this.groupVisibilityLabel(group));
    const metaChips = [
      `Active members: ${Helpers.number(group?.memberCount, 0)}`,
      `Role: ${this.groupRoleLabel(group)}`,
      `Membership: ${this.groupMembershipStatusLabel(group)}`,
      `Created ${Helpers.formatShortDate(group?.createdAt, "date pending")}`,
    ]
      .map(
        (chip) => `
          <span class="friend-meta-chip">${Helpers.escapeHtml(chip)}</span>
        `,
      )
      .join("");

    return `
      <div
        class="friend-item ${tone} ${isSelected ? "selected" : ""}"
        role="button"
        tabindex="0"
        aria-pressed="${isSelected ? "true" : "false"}"
        onclick="UI.selectGroup('${Helpers.string(group?.id)}')"
        onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); UI.selectGroup('${Helpers.string(group?.id)}'); }"
      >
        <div class="friend-primary">
          <div class="friend-avatar">🏘️</div>
          <div class="friend-main">
            <div class="friend-header">
              <div class="friend-heading">
                <div class="friend-name-row">
                  <div class="friend-name">${name}</div>
                  <div class="friend-username">${visibility}</div>
                </div>
                <div class="friend-summary">${summary}</div>
              </div>
              <span class="friend-status ${tone}">
                ${Helpers.escapeHtml(this.groupMembershipStatusLabel(group))}
              </span>
            </div>
            <div class="friend-meta-list">${metaChips}</div>
          </div>
        </div>
      </div>
    `;
  },

  renderGroupMemberCard(member) {
    const isSelf = member?.userId === State.user?.user_id;
    const tone = member?.status === "invited" ? "invited" : "active";
    const displayName = Helpers.escapeHtml(
      member?.displayName || member?.username || "Unknown",
    );
    const username = Helpers.escapeHtml(member?.username || "unknown");
    const joinedLabel =
      member?.status === "invited"
        ? `Invited ${Helpers.formatShortDate(member?.joinedAt, "recently")}`
        : `Joined ${Helpers.formatShortDate(member?.joinedAt, "recently")}`;

    return `
      <article class="group-member-row">
        <div class="group-member-copy">
          <div class="group-member-name-row">
            <strong>${displayName}</strong>
            <span class="group-member-username">@${username}</span>
            ${isSelf ? '<span class="group-member-self-badge">You</span>' : ""}
          </div>
          <div class="group-member-meta">
            <span class="friend-meta-chip">${Helpers.escapeHtml(
              `Role: ${Helpers.titleizeToken(member?.role, "Member")}`,
            )}</span>
            <span class="friend-meta-chip">${Helpers.escapeHtml(joinedLabel)}</span>
          </div>
        </div>
        <div class="group-member-badges">
          <span class="friend-status ${tone}">
            ${Helpers.escapeHtml(
              member?.status === "invited" ? "Invited" : "Active",
            )}
          </span>
          <span class="group-member-role-badge">
            ${Helpers.escapeHtml(Helpers.titleizeToken(member?.role, "Member"))}
          </span>
        </div>
      </article>
    `;
  },

  renderGroupMemberCollection(members, emptyState) {
    if (!members.length) {
      return `
        <div class="network-detail-empty">
          <div class="empty-icon">${emptyState.icon}</div>
          <p>${Helpers.escapeHtml(emptyState.copy)}</p>
          ${
            emptyState.hint
              ? `<p class="hint">${Helpers.escapeHtml(emptyState.hint)}</p>`
              : ""
          }
        </div>
      `;
    }

    return `
      <div class="group-member-list">
        ${members.map((member) => this.renderGroupMemberCard(member)).join("")}
      </div>
    `;
  },

  renderGroupMembersSection(group, membersState) {
    if (membersState.status === "error") {
      return `
        <div class="network-detail-empty">
          <div class="empty-icon">⚠️</div>
          <p>${Helpers.escapeHtml(
            membersState.error || "Failed to load group members.",
          )}</p>
          <button class="squishy-btn btn-secondary btn-small network-inline-action" onclick="UI.refreshSelectedGroupWorkspace()">
            Retry
          </button>
        </div>
      `;
    }

    if (membersState.status !== "loaded") {
      return `
        <div class="network-loading-row">
          <span class="network-loading-dot"></span>
          <p>Loading active members and pending invites from the live groups API...</p>
        </div>
      `;
    }

    const { active, invited } = this.groupMembersByStatus(membersState.items);

    return `
      <div class="group-member-stack">
        <div>
          <span class="network-role-subheading">Active members</span>
          ${this.renderGroupMemberCollection(active, {
            icon: "👥",
            copy: "No active members are visible in this group yet.",
            hint: "Ask-around stays unusable until someone is active here.",
          })}
        </div>
        <div>
          <span class="network-role-subheading">Pending invites</span>
          ${this.renderGroupMemberCollection(invited, {
            icon: "✉️",
            copy: "No pending invites right now.",
            hint:
              group?.status === "invited"
                ? "You can accept or decline the invite from the actions section above."
                : "Invite more people from the actions section if you want a larger circle.",
          })}
        </div>
      </div>
    `;
  },

  renderGroupActionSection(group, detailState, membersState) {
    if (detailState.status === "error") {
      return `
        <div class="network-detail-empty">
          <div class="empty-icon">⚠️</div>
          <p>${Helpers.escapeHtml(
            detailState.error || "Failed to load live group detail.",
          )}</p>
          <button class="squishy-btn btn-secondary btn-small network-inline-action" onclick="UI.refreshSelectedGroupWorkspace()">
            Retry
          </button>
        </div>
      `;
    }

    if (detailState.status !== "loaded") {
      return `
        <div class="network-loading-row">
          <span class="network-loading-dot"></span>
          <p>Loading live group status so invite and leave actions stay aligned with the backend.</p>
        </div>
      `;
    }

    const detail = detailState.item || group;
    const membersLoaded = membersState.status === "loaded";
    const { active } = membersLoaded
      ? this.groupMembersByStatus(membersState.items)
      : { active: [] };
    const activePeerCount = membersLoaded
      ? active.filter((member) => member.userId !== State.user?.user_id).length
      : Math.max((detail?.memberCount || 1) - 1, 0);
    const canInvite =
      detail?.status === "active" &&
      ["owner", "admin"].includes(Helpers.string(detail?.role));
    let actionButtons = "";
    let note = "";

    if (detail?.status === "invited") {
      actionButtons = `
        <button class="squishy-btn btn-primary btn-small" onclick="UI.handleJoinGroup('${Helpers.string(detail?.id)}')">
          Accept invite
        </button>
        <button class="squishy-btn btn-secondary btn-small" onclick="UI.handleLeaveGroup('${Helpers.string(detail?.id)}')">
          Decline invite
        </button>
      `;
      note =
        "These actions use the live join and leave endpoints for your current membership record.";
    } else if (detail?.status === "active" && detail?.role !== "owner") {
      actionButtons = `
        <button class="squishy-btn btn-secondary btn-small" onclick="UI.handleLeaveGroup('${Helpers.string(detail?.id)}')">
          Leave group
        </button>
      `;
      note =
        "Leaving removes this group from your targeted ask-around circles and future group-specific boundary targeting.";
    } else if (detail?.status === "active" && detail?.role === "owner") {
      if (activePeerCount === 0) {
        actionButtons = `
          <button class="squishy-btn btn-danger btn-small" onclick="UI.handleLeaveGroup('${Helpers.string(detail?.id)}')">
            Delete empty group
          </button>
        `;
        note =
          "Because you are the last active member, the leave endpoint will delete this group.";
      } else {
        note =
          "Owners can invite people here, but leaving is blocked until ownership is transferred or you are the last active member.";
      }
    }

    return `
      <div class="network-detail-actions">
        ${actionButtons || '<span class="friend-meta-chip">No membership action required right now.</span>'}
      </div>
      ${
        note
          ? `<p class="group-action-note">${Helpers.escapeHtml(note)}</p>`
          : ""
      }
      ${
        canInvite
          ? `
            <div class="group-invite-form">
              <div class="group-invite-row">
                <input
                  type="text"
                  id="group-invite-username"
                  class="squishy-input"
                  placeholder="@username"
                />
                <button
                  class="squishy-btn btn-primary btn-small"
                  id="group-invite-submit"
                  onclick="UI.handleInviteToGroup('${Helpers.string(detail?.id)}')"
                >
                  Invite member
                </button>
              </div>
              <p class="group-action-note">
                Invite by exact Mahilo username. Pending invites stay visible in the member roster below until they accept.
              </p>
            </div>
          `
          : ""
      }
    `;
  },

  renderGroupDetailPanel(group = null) {
    const panel = document.getElementById("group-detail-panel");

    if (!panel) {
      return;
    }

    if (!group) {
      panel.innerHTML = `
        <div class="network-detail-panel">
          <div class="network-detail-placeholder">
            <div class="empty-icon-large">🧭</div>
            <h3>Open a group workspace</h3>
            <p>Select a group to load its live detail, member roster, invite state, and ask-around readiness.</p>
          </div>
        </div>
      `;
      return;
    }

    const detailState = this.getGroupDetailState(group);
    const membersState = this.getGroupMembersState(group);
    const detail = detailState.item || group;
    const readiness = this.groupReadinessState(
      group,
      detailState,
      membersState,
    );
    const isRefreshing =
      detailState.status === "loading" || membersState.status === "loading";
    const memberBuckets =
      membersState.status === "loaded"
        ? this.groupMembersByStatus(membersState.items)
        : { active: [], invited: [] };
    const metaChips = [
      `Membership: ${this.groupMembershipStatusLabel(detail)}`,
      `Your role: ${this.groupRoleLabel(detail)}`,
      `Visibility: ${this.groupVisibilityLabel(detail)}`,
      `Active members: ${
        membersState.status === "loaded"
          ? memberBuckets.active.length
          : Helpers.number(detail?.memberCount, 0)
      }`,
      membersState.status === "loaded"
        ? `Pending invites: ${memberBuckets.invited.length}`
        : "Pending invites: checking",
      `Created ${Helpers.formatShortDate(detail?.createdAt, "date pending")}`,
    ]
      .map(
        (chip) => `
          <span class="friend-meta-chip">${Helpers.escapeHtml(chip)}</span>
        `,
      )
      .join("");

    panel.innerHTML = `
      <div class="network-detail-panel">
        <div class="network-detail-header">
          <div class="network-detail-avatar">🏘️</div>
          <div class="network-detail-copy">
            <p class="network-detail-eyebrow">Group detail</p>
            <h3>${Helpers.escapeHtml(detail?.name || "Untitled group")}</h3>
            <p class="network-detail-username">${Helpers.escapeHtml(
              detail?.description || "No description provided yet.",
            )}</p>
            <div class="network-detail-status-row">
              <span class="friend-status ${Helpers.escapeHtml(this.groupMembershipTone(detail))}">
                ${Helpers.escapeHtml(this.groupMembershipStatusLabel(detail))}
              </span>
            </div>
          </div>
          <button
            class="squishy-btn btn-secondary btn-small"
            onclick="UI.refreshSelectedGroupWorkspace()"
            ${isRefreshing ? "disabled" : ""}
          >
            ${isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        <div class="network-readiness-banner ${Helpers.escapeHtml(readiness?.tone || "pending")}">
          <span class="network-readiness-label">Group readiness</span>
          <strong>${Helpers.escapeHtml(
            readiness?.summaryTitle || "Checking",
          )}</strong>
          <p>${Helpers.escapeHtml(readiness?.summaryCopy || "")}</p>
        </div>

        <div class="network-readiness-grid">
          ${this.renderNetworkReadinessCard(
            "Targeted ask-around",
            readiness?.askAround,
          )}
          ${this.renderNetworkReadinessCard(
            "Group boundaries",
            readiness?.boundaries,
          )}
        </div>

        <div class="network-detail-section">
          <div class="network-detail-section-header">
            <div>
              <h4>Membership snapshot</h4>
              <p class="network-detail-section-copy">
                Live group detail from the current groups API, including your role, status, and whether this circle is ready to use.
              </p>
            </div>
          </div>
          <div class="network-detail-meta">
            ${metaChips}
          </div>
        </div>

        <div class="network-detail-section">
          <div class="network-detail-section-header">
            <div>
              <h4>Invite and membership actions</h4>
              <p class="network-detail-section-copy">
                Use the current invite, join, and leave flows without leaving the dashboard.
              </p>
            </div>
          </div>
          ${this.renderGroupActionSection(group, detailState, membersState)}
        </div>

        <div class="network-detail-section">
          <div class="network-detail-section-header">
            <div>
              <h4>Members and invite state</h4>
              <p class="network-detail-section-copy">
                Active members and pending invites from <code>/api/v1/groups/:id/members</code>.
              </p>
            </div>
            ${
              membersState.status === "loaded"
                ? `
                  <div class="friends-total-chip">
                    ${Helpers.pluralize(membersState.items.length, "membership")}
                  </div>
                `
                : ""
            }
          </div>
          ${this.renderGroupMembersSection(group, membersState)}
        </div>
      </div>
    `;
  },

  renderGroups() {
    const list = document.getElementById("groups-grid");

    if (!list) {
      return;
    }

    const searchInput = document.getElementById("group-search");
    if (searchInput && searchInput.value !== State.groupSearch) {
      searchInput.value = State.groupSearch;
    }

    const counts = this.getGroupCounts();
    const groups = this.getVisibleGroups();
    const selectedGroup = this.syncSelectedGroup(groups);
    this.renderGroupHeader(groups, counts);

    if (!groups.length) {
      list.innerHTML = this.renderGroupsEmptyState();
      this.renderGroupDetailPanel(null);
      return;
    }

    list.innerHTML = groups
      .map((group) => this.renderGroupCard(group))
      .join("");
    this.renderGroupDetailPanel(selectedGroup);
    void this.ensureGroupWorkspaceData(selectedGroup);
  },

  async handleInviteToGroup(groupId = State.selectedGroupId) {
    const resolvedGroupId = Helpers.string(groupId);
    const group =
      State.groupsById.get(resolvedGroupId) ||
      this.getGroupDetailState(resolvedGroupId).item;
    const usernameInput = document.getElementById("group-invite-username");
    const inviteButton = document.getElementById("group-invite-submit");

    if (!resolvedGroupId || !group) {
      this.showToast("Group not found", "error");
      return;
    }

    if (!usernameInput) {
      this.showToast("The invite form is unavailable right now.", "error");
      return;
    }

    const username = Helpers.string(usernameInput.value)
      .trim()
      .replace(/^@+/, "");

    if (!username || username.length < 3) {
      this.showToast(
        "Enter the exact Mahilo username you want to invite.",
        "error",
      );
      return;
    }

    if (State.user?.username?.toLowerCase() === username.toLowerCase()) {
      this.showToast("You cannot invite your own username.", "error");
      return;
    }

    if (inviteButton) {
      inviteButton.disabled = true;
    }

    try {
      await API.groups.invite(resolvedGroupId, username);
      usernameInput.value = "";
      State.groupDetailsById.delete(resolvedGroupId);
      State.groupMembersByGroupId.delete(resolvedGroupId);
      await DataLoader.loadGroups();
      this.showToast(`Invited ${username} to ${group.name}`, "success");
    } catch (error) {
      this.showToast(error.message || "Failed to invite group member", "error");
    } finally {
      if (inviteButton) {
        inviteButton.disabled = false;
      }
    }
  },

  async handleJoinGroup(groupId) {
    const resolvedGroupId = Helpers.string(groupId || State.selectedGroupId);
    const group =
      State.groupsById.get(resolvedGroupId) ||
      this.getGroupDetailState(resolvedGroupId).item;

    if (!group) {
      this.showToast("Group not found", "error");
      return;
    }

    if (group.status === "invited") {
      try {
        await API.groups.join(resolvedGroupId);
        State.groupDetailsById.delete(resolvedGroupId);
        State.groupMembersByGroupId.delete(resolvedGroupId);
        await DataLoader.loadGroups();
        this.showToast(`Joined ${group.name}`, "success");
      } catch (error) {
        this.showToast(error.message || "Failed to join group", "error");
      }
      return;
    }

    this.showToast("Only invited groups can be joined from this view.", "info");
  },

  async handleLeaveGroup(groupId) {
    const resolvedGroupId = Helpers.string(groupId || State.selectedGroupId);
    const group =
      State.groupsById.get(resolvedGroupId) ||
      this.getGroupDetailState(resolvedGroupId).item;

    if (!group) {
      this.showToast("Group not found", "error");
      return;
    }

    const confirmCopy =
      group.status === "invited"
        ? `Decline the invite to ${group.name}?`
        : group.role === "owner" && Helpers.number(group.memberCount, 0) <= 1
          ? `Delete ${group.name}?`
          : `Leave ${group.name}?`;

    if (!confirm(confirmCopy)) {
      return;
    }

    try {
      await API.groups.leave(resolvedGroupId);
      State.groupDetailsById.delete(resolvedGroupId);
      State.groupMembersByGroupId.delete(resolvedGroupId);
      await DataLoader.loadGroups();
      this.showToast(
        group.status === "invited"
          ? `Declined invite to ${group.name}`
          : group.role === "owner" && Helpers.number(group.memberCount, 0) <= 1
            ? `${group.name} removed`
            : `Left ${group.name}`,
        "success",
      );
    } catch (error) {
      this.showToast(error.message || "Failed to leave group", "error");
    }
  },

  updateBoundaryScopeCounts(policies = State.policies) {
    const counts = {
      all: policies.length,
      global: 0,
      user: 0,
      role: 0,
      group: 0,
    };

    policies.forEach((policy) => {
      if (Object.prototype.hasOwnProperty.call(counts, policy.scope)) {
        counts[policy.scope] += 1;
      }
    });

    Object.entries(counts).forEach(([scope, count]) => {
      const badge = document.getElementById(`boundary-count-${scope}`);
      if (!badge) {
        return;
      }

      badge.textContent = String(count);
      badge.classList.toggle("hidden", count === 0);
    });
  },

  renderBoundaryCategoryFilters(policies = State.policies) {
    const container = document.getElementById("boundary-category-filters");
    if (!container) {
      return;
    }

    const categoryCounts = new Map();
    policies.forEach((policy) => {
      const categoryKey = policy.boundary?.category || "advanced";
      categoryCounts.set(
        categoryKey,
        (categoryCounts.get(categoryKey) || 0) + 1,
      );
    });

    if (
      State.boundaryCategoryFilter !== "all" &&
      !categoryCounts.has(State.boundaryCategoryFilter)
    ) {
      State.boundaryCategoryFilter = "all";
    }

    const buttons = [
      {
        count: policies.length,
        icon: "🧭",
        key: "all",
        label: "All categories",
      },
      ...BOUNDARY_CATEGORY_ORDER.filter((key) => categoryCounts.has(key)).map(
        (key) => ({
          count: categoryCounts.get(key) || 0,
          icon: BOUNDARY_CATEGORY_META[key]?.icon || "🛡️",
          key,
          label:
            BOUNDARY_CATEGORY_META[key]?.label ||
            Helpers.titleizeToken(key, key),
        }),
      ),
    ];

    container.innerHTML = buttons
      .map((button) => {
        const isActive = button.key === (State.boundaryCategoryFilter || "all");
        return `
          <button class="filter-btn boundary-category-filter ${isActive ? "active" : ""}" data-category="${Helpers.escapeHtml(button.key)}">
            <span class="boundary-category-filter-label">${Helpers.escapeHtml(`${button.icon} ${button.label}`)}</span>
            <span class="filter-badge ${button.count ? "" : "hidden"}">${button.count}</span>
          </button>
        `;
      })
      .join("");
  },

  renderBoundarySummary(visiblePolicies = [], allPolicies = State.policies) {
    const summary = document.getElementById("boundaries-summary-grid");
    if (!summary) {
      return;
    }

    if (!allPolicies.length) {
      summary.innerHTML = "";
      return;
    }

    const activePolicies = visiblePolicies.filter(
      (policy) => policy.boundary?.lifecycle?.isActive,
    );
    const allowCount = activePolicies.filter(
      (policy) => policy.effect === "allow",
    ).length;
    const askCount = activePolicies.filter(
      (policy) => policy.effect === "ask",
    ).length;
    const denyCount = activePolicies.filter(
      (policy) => policy.effect === "deny",
    ).length;
    const inactiveCount = visiblePolicies.length - activePolicies.length;

    const cards = [
      {
        copy: !visiblePolicies.length
          ? "No boundaries match the current audience/category filters."
          : inactiveCount > 0
            ? `${Helpers.pluralize(inactiveCount, "boundary", "boundaries")} in this view are not active right now.`
            : "Every visible boundary is currently active.",
        label: "Active now",
        tone: "neutral",
        value: activePolicies.length,
      },
      {
        copy: "Matching content can move without stopping.",
        label: "Share automatically",
        tone: "allow",
        value: allowCount,
      },
      {
        copy: "Matching content pauses for review before send.",
        label: "Hold for review",
        tone: "ask",
        value: askCount,
      },
      {
        copy: "Matching content is blocked outright.",
        label: "Block outright",
        tone: "deny",
        value: denyCount,
      },
    ];

    summary.innerHTML = cards
      .map(
        (card) => `
          <div class="boundary-summary-card ${Helpers.escapeHtml(card.tone)}">
            <span class="boundary-summary-label">${Helpers.escapeHtml(card.label)}</span>
            <span class="boundary-summary-value">${card.value}</span>
            <p>${Helpers.escapeHtml(card.copy)}</p>
          </div>
        `,
      )
      .join("");
  },

  renderBoundarySuggestions(filters = {}) {
    const panel = document.getElementById("boundary-suggestions-panel");
    const title = document.getElementById("boundary-suggestions-title");
    const description = document.getElementById(
      "boundary-suggestions-description",
    );
    const total = document.getElementById("boundary-suggestions-total");
    const list = document.getElementById("boundary-suggestions-list");

    if (!panel || !description || !total || !list) {
      return;
    }

    const activeScope = Helpers.string(
      filters.scope,
      State.boundaryScopeFilter || "all",
    );
    const activeCategory = Helpers.string(
      filters.category,
      State.boundaryCategoryFilter || "all",
    );
    const status = Helpers.string(
      State.promotionSuggestionsStatus,
      State.promotionSuggestions.length ? "loaded" : "idle",
    );
    const pendingSuggestions = State.promotionSuggestions.filter(
      (suggestion) => !isPromotionSuggestionAlreadyEnforced(suggestion),
    );
    let visibleSuggestions = pendingSuggestions;

    if (activeScope !== "all") {
      visibleSuggestions = visibleSuggestions.filter(
        (suggestion) => suggestion.scope === activeScope,
      );
    }

    if (activeCategory !== "all") {
      visibleSuggestions = visibleSuggestions.filter(
        (suggestion) => suggestion.category === activeCategory,
      );
    }

    const learning = State.promotionSuggestionLearning;
    const thresholdCopy =
      learning?.minRepetitions && learning?.lookbackDays
        ? `Based on ${learning.minRepetitions}+ repeated overrides in the last ${learning.lookbackDays} days.`
        : "Based on repeated temporary overrides.";

    if (title) {
      title.textContent =
        "Promote repeated overrides into durable boundaries";
    }

    if (status === "loading") {
      panel.classList.remove("hidden");
      total.textContent = "Checking patterns";
      description.textContent =
        "Mahilo is checking temporary overrides for repeated boundary patterns.";
      list.innerHTML = `
        <div class="network-loading-row">
          <span class="network-loading-dot"></span>
          <p>Loading promotion suggestions from repeated temporary decisions...</p>
        </div>
      `;
      return;
    }

    if (status === "error") {
      panel.classList.remove("hidden");
      total.textContent = "Unavailable";
      description.textContent =
        "Boundary-learning suggestions are temporarily unavailable.";
      list.innerHTML = `
        <div class="empty-state small">
          <div class="empty-icon">⚠️</div>
          <p>${Helpers.escapeHtml(
            State.promotionSuggestionsError ||
              "Failed to load promotion suggestions.",
          )}</p>
        </div>
      `;
      return;
    }

    if (!pendingSuggestions.length) {
      panel.classList.add("hidden");
      total.textContent = "0 suggestions";
      list.innerHTML = "";
      return;
    }

    panel.classList.remove("hidden");
    total.textContent =
      visibleSuggestions.length === pendingSuggestions.length
        ? Helpers.pluralize(visibleSuggestions.length, "suggestion")
        : `${Helpers.pluralize(visibleSuggestions.length, "suggestion")} of ${pendingSuggestions.length}`;
    description.textContent = visibleSuggestions.length
      ? `These patterns are suggestions only until you save a boundary. ${thresholdCopy}`
      : `No learning suggestions match the current audience/category filters. ${thresholdCopy}`;

    if (!visibleSuggestions.length) {
      list.innerHTML = `
        <div class="empty-state small">
          <div class="empty-icon">🧭</div>
          <p>No learning suggestions match this view right now.</p>
        </div>
      `;
      return;
    }

    list.innerHTML = visibleSuggestions
      .slice()
      .sort((left, right) => {
        const countDelta =
          (right.repeatedOverridePattern?.count || 0) -
          (left.repeatedOverridePattern?.count || 0);
        if (countDelta !== 0) {
          return countDelta;
        }

        return (
          Helpers.timestampValue(right.repeatedOverridePattern?.lastSeenAt) -
          Helpers.timestampValue(left.repeatedOverridePattern?.lastSeenAt)
        );
      })
      .map((suggestion) => {
        const boundary = suggestion.boundary || {};
        const effect = boundary.effect || {};
        const selector = boundary.selector || {};
        const audienceLabel = Helpers.string(
          suggestion.audienceLabel,
          Helpers.policyAudienceDisplay(suggestion.suggestedPolicy),
        );
        const pattern = suggestion.repeatedOverridePattern || {};
        const evidence = buildPromotionSuggestionEvidence(suggestion);
        const overrideKinds = Helpers.stringList(pattern.kinds)
          .map(
            (kind) =>
              boundaryOverrideKindLabel(kind) ||
              Helpers.titleizeToken(kind, kind),
          )
          .join(", ");

        return `
          <article class="boundary-suggestion-card ${Helpers.escapeHtml(effect.tone || suggestion.effect)}">
            <div class="boundary-suggestion-header">
              <div class="boundary-suggestion-copy">
                <span class="boundary-summary-label">Suggestion only</span>
                <h4 class="boundary-suggestion-title">${Helpers.escapeHtml(selector.label || "Boundary suggestion")}</h4>
                <p class="boundary-row-summary">${Helpers.escapeHtml(buildPromotionSuggestionSummary(suggestion))}</p>
              </div>
              <div class="boundary-row-badges">
                <span class="policy-badge effect-${Helpers.escapeHtml(effect.tone || suggestion.effect)}">${Helpers.escapeHtml(effect.badgeLabel || Helpers.titleizeToken(suggestion.effect, suggestion.effect))}</span>
                ${
                  suggestion.canUseGuidedEditor
                    ? ""
                    : '<span class="policy-badge advanced">Advanced path</span>'
                }
                <span class="policy-badge suggestion-pending">Not enforced yet</span>
              </div>
            </div>
            <div class="boundary-meta-list">
              <span class="boundary-meta-chip">
                <span class="boundary-meta-label">Audience</span>
                ${Helpers.escapeHtml(audienceLabel)}
              </span>
              <span class="boundary-meta-chip">
                <span class="boundary-meta-label">Selector</span>
                ${Helpers.escapeHtml(
                  selector.summary ||
                    `${suggestion.resource}${suggestion.action ? ` / ${suggestion.action}` : ""}`,
                )}
              </span>
              <span class="boundary-meta-chip">
                <span class="boundary-meta-label">Pattern</span>
                ${Helpers.escapeHtml(
                  Helpers.pluralize(pattern.count || 0, "override"),
                )}
              </span>
              ${
                overrideKinds
                  ? `
                    <span class="boundary-meta-chip">
                      <span class="boundary-meta-label">Override types</span>
                      ${Helpers.escapeHtml(overrideKinds)}
                    </span>
                  `
                  : ""
              }
            </div>
            ${
              evidence
                ? `<p class="boundary-row-footnote">${Helpers.escapeHtml(evidence)}</p>`
                : ""
            }
            <div class="boundary-suggestion-actions">
              <button class="squishy-btn btn-primary btn-small" onclick="UI.handlePromoteSuggestion('${suggestion.id}')">
                Promote to boundary
              </button>
            </div>
          </article>
        `;
      })
      .join("");
  },

  renderPolicies(scope = State.boundaryScopeFilter || "all") {
    const list =
      document.getElementById("boundaries-groups") ||
      document.getElementById("policies-list");
    const legacyList =
      list?.id === "policies-list"
        ? null
        : document.getElementById("policies-list");
    const browserTitle = document.getElementById("boundaries-browser-title");
    const browserDescription = document.getElementById(
      "boundaries-browser-description",
    );
    const browserTotal = document.getElementById("boundaries-browser-total");
    if (!list) {
      return;
    }

    const setListHtml = (html) => {
      list.innerHTML = html;
      if (legacyList && legacyList !== list) {
        legacyList.innerHTML = html;
      }
    };

    const activeScope = scope || "all";
    State.boundaryScopeFilter = activeScope;

    this.updateBoundaryScopeCounts(State.policies);

    document
      .querySelectorAll(".policy-filters .filter-btn")
      .forEach((button) => {
        button.classList.toggle("active", button.dataset.scope === activeScope);
      });

    const scopeFilteredPolicies =
      activeScope === "all"
        ? State.policies
        : State.policies.filter((policy) => policy.scope === activeScope);

    this.renderBoundaryCategoryFilters(scopeFilteredPolicies);

    const activeCategory = State.boundaryCategoryFilter || "all";
    let policies = scopeFilteredPolicies;
    if (activeCategory !== "all") {
      policies = policies.filter(
        (policy) =>
          (policy.boundary?.category || "advanced") === activeCategory,
      );
    }

    this.renderBoundarySummary(policies, State.policies);
    this.renderBoundarySuggestions({
      category: activeCategory,
      scope: activeScope,
    });

    const scopeMeta =
      activeScope === "all" ? null : BOUNDARY_SCOPE_META[activeScope] || null;
    const categoryMeta =
      activeCategory === "all"
        ? null
        : BOUNDARY_CATEGORY_META[activeCategory] || null;

    if (browserTitle) {
      if (scopeMeta && categoryMeta) {
        browserTitle.textContent = `${scopeMeta.filterLabel} · ${categoryMeta.label}`;
      } else if (scopeMeta) {
        browserTitle.textContent = `${scopeMeta.filterLabel} boundaries`;
      } else if (categoryMeta) {
        browserTitle.textContent = categoryMeta.label;
      } else {
        browserTitle.textContent = "All boundaries";
      }
    }

    if (browserDescription) {
      const descriptionParts = [];
      if (scopeMeta) {
        descriptionParts.push(scopeMeta.summary);
      } else {
        descriptionParts.push("All audiences are included.");
      }

      if (categoryMeta) {
        descriptionParts.push(
          `Focused on ${categoryMeta.label.toLowerCase()}.`,
        );
      } else {
        descriptionParts.push(
          "Grouped by category, then audience, so your current sharing posture stays legible.",
        );
      }

      browserDescription.textContent = descriptionParts.join(" ");
    }

    if (browserTotal) {
      const audienceCount = new Set(
        policies.map((policy) => `${policy.scope}:${policy.targetId || "all"}`),
      ).size;
      browserTotal.textContent = policies.length
        ? `${Helpers.pluralize(policies.length, "boundary", "boundaries")} across ${Helpers.pluralize(audienceCount, "audience")}`
        : "0 boundaries";
    }

    if (!State.policies.length) {
      setListHtml(`
        <div class="empty-state">
          <div class="empty-icon-large">🛡️</div>
          <h3>No boundaries yet</h3>
          <p>Create boundaries to control what Mahilo can share or hold for review</p>
          <button class="squishy-btn btn-primary" id="create-first-policy">
            <span>🛡️</span> Create Your First Boundary
          </button>
        </div>
      `);
      document
        .getElementById("create-first-policy")
        ?.addEventListener("click", () => {
          this.openBoundaryEditor();
        });
      return;
    }

    if (!policies.length) {
      setListHtml(`
        <div class="empty-state">
          <div class="empty-icon-large">🧭</div>
          <h3>No boundaries match this view</h3>
          <p>Try a different audience or category filter to browse the rest of your current posture.</p>
          <button class="squishy-btn btn-secondary" id="reset-boundary-filters">
            <span>↺</span> Clear Filters
          </button>
        </div>
      `);
      document
        .getElementById("reset-boundary-filters")
        ?.addEventListener("click", () => {
          State.boundaryScopeFilter = "all";
          State.boundaryCategoryFilter = "all";
          this.renderPolicies("all");
        });
      return;
    }

    const groupedPolicies = new Map();
    policies
      .slice()
      .sort(compareBoundaryPolicies)
      .forEach((policy) => {
        const categoryKey = policy.boundary?.category || "advanced";
        if (!groupedPolicies.has(categoryKey)) {
          groupedPolicies.set(categoryKey, {
            audiences: new Map(),
            key: categoryKey,
            policies: [],
          });
        }

        const categoryGroup = groupedPolicies.get(categoryKey);
        categoryGroup.policies.push(policy);

        const audienceKey = `${policy.scope}:${policy.targetId || "all"}`;
        if (!categoryGroup.audiences.has(audienceKey)) {
          const audienceLabel = Helpers.policyAudienceDisplay(policy);
          categoryGroup.audiences.set(audienceKey, {
            key: audienceKey,
            label: audienceLabel,
            policies: [],
            scope: policy.scope,
            summary: buildBoundaryAudienceSummary(policy, audienceLabel),
          });
        }

        categoryGroup.audiences.get(audienceKey).policies.push(policy);
      });

    setListHtml(
      Array.from(groupedPolicies.values())
        .sort((left, right) => {
          const leftIndex = BOUNDARY_CATEGORY_ORDER.indexOf(left.key);
          const rightIndex = BOUNDARY_CATEGORY_ORDER.indexOf(right.key);
          return (
            (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
            (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
          );
        })
        .map((categoryGroup) => {
          const categoryKey = categoryGroup.key;
          const categoryPresentation =
            BOUNDARY_CATEGORY_META[categoryKey] ||
            BOUNDARY_CATEGORY_META.advanced;
          const activeCount = categoryGroup.policies.filter(
            (policy) => policy.boundary?.lifecycle?.isActive,
          ).length;
          const askCount = categoryGroup.policies.filter(
            (policy) =>
              policy.effect === "ask" && policy.boundary?.lifecycle?.isActive,
          ).length;
          const denyCount = categoryGroup.policies.filter(
            (policy) =>
              policy.effect === "deny" && policy.boundary?.lifecycle?.isActive,
          ).length;

          const audienceCards = Array.from(categoryGroup.audiences.values())
            .sort((left, right) => {
              const scopeDelta =
                (BOUNDARY_SCOPE_ORDER.indexOf(left.scope) === -1
                  ? Number.MAX_SAFE_INTEGER
                  : BOUNDARY_SCOPE_ORDER.indexOf(left.scope)) -
                (BOUNDARY_SCOPE_ORDER.indexOf(right.scope) === -1
                  ? Number.MAX_SAFE_INTEGER
                  : BOUNDARY_SCOPE_ORDER.indexOf(right.scope));
              if (scopeDelta !== 0) {
                return scopeDelta;
              }

              return Helpers.string(left.label).localeCompare(
                Helpers.string(right.label),
              );
            })
            .map((audienceGroup) => {
              const scopeLabel =
                BOUNDARY_SCOPE_META[audienceGroup.scope]?.scopeLabel ||
                Helpers.titleizeToken(audienceGroup.scope, audienceGroup.scope);

              const rows = audienceGroup.policies
                .slice()
                .sort(compareBoundaryPolicies)
                .map((policy) => {
                  const boundary = policy.boundary || {};
                  const audienceLabel = Helpers.policyAudienceDisplay(policy);
                  const effect = boundary.effect || {};
                  const selector = boundary.selector || {};
                  const lifecycle = boundary.lifecycle || {};
                  const provenance = boundary.provenance || {};
                  const sourceLabel = Helpers.policySourceLabel(policy.source);
                  const canEdit = canUseGuidedBoundaryEditor(policy);
                  const lifecycleMetaChips = Array.isArray(
                    lifecycle.detailItems,
                  )
                    ? lifecycle.detailItems
                        .map(
                          (item) => `
                          <span class="boundary-meta-chip">
                            <span class="boundary-meta-label">${Helpers.escapeHtml(item.label)}</span>
                            ${Helpers.escapeHtml(item.value)}
                          </span>
                        `,
                        )
                        .join("")
                    : "";
                  const provenanceMetaChips = Array.isArray(
                    provenance.detailItems,
                  )
                    ? provenance.detailItems
                        .filter((item) => item.label !== "Source")
                        .map(
                          (item) => `
                          <span class="boundary-meta-chip">
                            <span class="boundary-meta-label">${Helpers.escapeHtml(item.label)}</span>
                            ${Helpers.escapeHtml(item.value)}
                          </span>
                        `,
                        )
                        .join("")
                    : "";
                  const advancedNote =
                    boundary.managementPath === "advanced"
                      ? `
                      <div class="policy-advanced-note">
                        ${Helpers.escapeHtml(boundary.advancedSummary || "This boundary uses a custom selector and stays on the advanced path.")}
                      </div>
                    `
                      : "";

                  return `
                  <article class="boundary-row ${Helpers.escapeHtml(effect.tone || policy.effect)} ${lifecycle.isActive ? "is-active" : "is-inactive"}">
                    <div class="boundary-row-main">
                      <div class="boundary-row-top">
                        <div class="boundary-row-copy">
                          <div class="boundary-row-title-row">
                            <span class="boundary-row-title">${Helpers.escapeHtml(selector.label || "Custom selector")}</span>
                            ${boundary.managementPath === "advanced" ? '<span class="policy-badge advanced">Advanced path</span>' : ""}
                          </div>
                          <p class="boundary-row-summary">${Helpers.escapeHtml(buildBoundaryNarrative(policy, audienceLabel))}</p>
                        </div>
                        <div class="boundary-row-badges">
                          <span class="policy-badge effect-${Helpers.escapeHtml(effect.tone || policy.effect)}">${Helpers.escapeHtml(effect.badgeLabel || policy.effect)}</span>
                          <span class="boundary-activity-badge ${Helpers.escapeHtml(lifecycle.tone || "disabled")}">${Helpers.escapeHtml(lifecycle.badgeLabel || "Inactive")}</span>
                          <span class="policy-badge provenance-${Helpers.escapeHtml(provenance.tone || "default")}">${Helpers.escapeHtml(provenance.badgeLabel || sourceLabel)}</span>
                        </div>
                      </div>
                      <div class="boundary-meta-list">
                        <span class="boundary-meta-chip">
                          <span class="boundary-meta-label">Audience</span>
                          ${Helpers.escapeHtml(audienceLabel)}
                        </span>
                        <span class="boundary-meta-chip">
                          <span class="boundary-meta-label">Source</span>
                          ${Helpers.escapeHtml(sourceLabel)}
                        </span>
                        <span class="boundary-meta-chip">
                          <span class="boundary-meta-label">Selector</span>
                          ${Helpers.escapeHtml(selector.summary || `${policy.resource}${policy.action ? ` / ${policy.action}` : ""}`)}
                        </span>
                        <span class="boundary-meta-chip">
                          <span class="boundary-meta-label">Direction</span>
                          ${Helpers.escapeHtml(selector.directionLabel || Helpers.titleizeToken(policy.direction, policy.direction))}
                        </span>
                        ${provenanceMetaChips}
                        ${lifecycleMetaChips}
                      </div>
                      <div class="boundary-row-notes">
                        <p class="boundary-row-footnote">${Helpers.escapeHtml(lifecycle.summary || "Currently active and enforced.")}</p>
                        <p class="boundary-provenance-note">${Helpers.escapeHtml(provenance.summary || "Mahilo keeps this boundary's origin available for audit.")}</p>
                      </div>
                      ${advancedNote}
                    </div>
                    <div class="boundary-row-actions">
                      <button class="squishy-btn btn-secondary btn-small" onclick="UI.handleInspectPolicy('${policy.id}')">
                        Inspect
                      </button>
                      ${
                        canEdit
                          ? `
                            <button class="squishy-btn btn-secondary btn-small" onclick="UI.handleEditPolicy('${policy.id}')">
                              Edit
                            </button>
                          `
                          : ""
                      }
                      <button class="squishy-btn btn-secondary btn-small" onclick="UI.handleTogglePolicy('${policy.id}', ${!policy.enabled})">
                        ${policy.enabled ? "Disable" : "Enable"}
                      </button>
                      <button class="squishy-btn btn-danger btn-small" onclick="UI.handleDeletePolicy('${policy.id}')">
                        Delete
                      </button>
                    </div>
                  </article>
                `;
                })
                .join("");

              return `
              <article class="boundary-audience-card">
                <div class="boundary-audience-header">
                  <div class="boundary-audience-copy">
                    <span class="boundary-audience-title">${Helpers.escapeHtml(audienceGroup.label)}</span>
                    <p class="boundary-audience-description">${Helpers.escapeHtml(audienceGroup.summary)}</p>
                  </div>
                  <div class="boundary-audience-meta">
                    <span class="policy-badge ${Helpers.escapeHtml(audienceGroup.scope)}">${Helpers.escapeHtml(scopeLabel)}</span>
                    <span class="boundary-audience-count">${Helpers.escapeHtml(Helpers.pluralize(audienceGroup.policies.length, "boundary", "boundaries"))}</span>
                  </div>
                </div>
                <div class="boundary-row-list">
                  ${rows}
                </div>
              </article>
            `;
            })
            .join("");

          return `
          <section class="boundary-category-section">
            <div class="boundary-category-header">
              <div class="boundary-category-copy">
                <span class="boundary-category-title">${Helpers.escapeHtml(`${categoryPresentation.icon || "🛡️"} ${categoryPresentation.label || "Boundary"}`)}</span>
                <p class="boundary-category-description">${Helpers.escapeHtml(categoryPresentation.description || "Boundaries for this category.")}</p>
              </div>
              <div class="boundary-category-stats">
                <span class="boundary-category-stat">${Helpers.escapeHtml(Helpers.pluralize(categoryGroup.policies.length, "boundary", "boundaries"))}</span>
                <span class="boundary-category-stat ${activeCount ? "active" : ""}">${Helpers.escapeHtml(`${activeCount} active`)}</span>
                ${askCount ? `<span class="boundary-category-stat ask">${Helpers.escapeHtml(`${askCount} ask`)}</span>` : ""}
                ${denyCount ? `<span class="boundary-category-stat deny">${Helpers.escapeHtml(`${denyCount} deny`)}</span>` : ""}
              </div>
            </div>
            <div class="boundary-audience-grid">
              ${audienceCards}
            </div>
          </section>
        `;
        })
        .join(""),
    );
  },

  async handleTogglePolicy(id, enabled) {
    try {
      await API.policies.update(id, { enabled });
      await DataLoader.loadPolicies();
      this.showToast(`Boundary ${enabled ? "enabled" : "disabled"}`, "success");
    } catch (error) {
      this.showToast("Failed to update boundary", "error");
    }
  },

  async handleDeletePolicy(id) {
    if (!confirm("Are you sure you want to delete this boundary?")) return;

    try {
      await API.policies.delete(id);
      await DataLoader.loadPolicies();
      this.showToast("Boundary deleted", "success");
    } catch (error) {
      this.showToast("Failed to delete boundary", "error");
    }
  },

  renderSettings() {
    const prefs = State.preferences;
    if (!prefs) return;

    // Notification preferences
    if (prefs.preferredChannel !== undefined) {
      document.getElementById("pref-channel").value =
        prefs.preferredChannel || "";
    }
    if (prefs.urgentBehavior) {
      document.getElementById("pref-urgent").value = prefs.urgentBehavior;
    }

    // Quiet hours
    if (prefs.quietHours) {
      document.getElementById("pref-quiet-enabled").checked =
        prefs.quietHours.enabled;
      document.getElementById("pref-quiet-start").value =
        prefs.quietHours.start || "22:00";
      document.getElementById("pref-quiet-end").value =
        prefs.quietHours.end || "07:00";
      document.getElementById("pref-quiet-timezone").value =
        prefs.quietHours.timezone || "UTC";

      // Show/hide quiet hours row
      const row = document.getElementById("quiet-hours-row");
      row.classList.toggle("hidden", !prefs.quietHours.enabled);
    }

    // LLM defaults
    if (prefs.defaultLlmProvider !== undefined) {
      document.getElementById("pref-llm-provider").value =
        prefs.defaultLlmProvider || "";
    }
    if (prefs.defaultLlmModel !== undefined) {
      document.getElementById("pref-llm-model").value =
        prefs.defaultLlmModel || "";
    }
  },

  renderConversations() {
    const list = document.getElementById("conversations-list");
    if (!list) {
      return;
    }

    // Build conversations from loaded messages first so non-friend threads still show up.
    const conversations = new Map();

    State.conversations.forEach((messages, counterpart) => {
      const friend = State.friends.find(
        (entry) => entry.username === counterpart,
      );
      const name =
        friend?.displayName ||
        messages[messages.length - 1]?.counterpartLabel ||
        counterpart;

      conversations.set(counterpart, {
        name,
        username: counterpart,
        messages,
      });
    });

    State.friends
      .filter((f) => f.status === "accepted")
      .forEach((friend) => {
        if (conversations.has(friend.username)) {
          return;
        }

        conversations.set(friend.username, {
          name: friend.displayName || friend.username,
          username: friend.username,
          messages: [],
        });
      });

    if (!conversations.size) {
      list.innerHTML = `
        <div class="empty-state small" style="padding: 40px 20px;">
          <div class="empty-icon" style="font-size: 3rem; margin-bottom: 16px;">💬</div>
          <p style="font-weight: 700; color: var(--color-text); margin-bottom: 8px;">No conversations yet</p>
          <p class="hint" style="font-size: 0.9rem;">Add friends to start messaging!</p>
        </div>
      `;
      return;
    }

    list.innerHTML = Array.from(conversations.entries())
      .sort(([, left], [, right]) => {
        const leftLast = left.messages[left.messages.length - 1];
        const rightLast = right.messages[right.messages.length - 1];
        return (
          (Date.parse(rightLast?.timestamp || "") || 0) -
          (Date.parse(leftLast?.timestamp || "") || 0)
        );
      })
      .map(([username, conv]) => {
        const lastMessage = conv.messages[conv.messages.length - 1];
        return `
          <div class="conversation-item ${State.selectedChat === username ? "active" : ""}" onclick="UI.selectChat('${username}')">
            <div class="conversation-avatar">${conv.name[0].toUpperCase()}</div>
            <div class="conversation-info">
              <div class="conversation-name">${conv.name}</div>
              <div class="conversation-preview">${lastMessage?.previewText || lastMessage?.message || "No messages yet"}</div>
            </div>
            <div class="conversation-meta">
              <div class="conversation-time">${lastMessage ? new Date(lastMessage.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</div>
            </div>
          </div>
        `;
      })
      .join("");
  },

  selectChat(username) {
    State.selectedChat = username;

    const friend = State.friends.find((f) => f.username === username);
    const messages = State.conversations.get(username) || [];
    const name =
      friend?.displayName ||
      messages[messages.length - 1]?.counterpartLabel ||
      username;
    const isGroupThread = messages.some(
      (entry) => entry.recipientType === "group",
    );
    const latestMessage = messages[messages.length - 1] || null;
    const latestRecord = latestMessage
      ? State.messagesById.get(latestMessage.id)
      : null;
    const canSend = !isGroupThread || Boolean(latestRecord?.recipientId);

    const placeholder = document.getElementById("chat-placeholder");
    const chatContainer = document.getElementById("chat-container");
    const chatInput = document.getElementById("chat-input");
    const sendButton = document.getElementById("send-message-btn");
    if (!placeholder || !chatContainer) {
      return;
    }

    placeholder.classList.add("hidden");
    chatContainer.classList.remove("hidden");

    document.getElementById("chat-recipient-avatar").textContent =
      name[0].toUpperCase();
    document.getElementById("chat-recipient-name").textContent = name;
    document.getElementById("chat-recipient-status").textContent = isGroupThread
      ? "Group thread"
      : friend
        ? "Online"
        : "Conversation";

    if (chatInput) {
      chatInput.disabled = !canSend;
      chatInput.placeholder = canSend
        ? "Type a message..."
        : "Group replies need a stable group ID from the server";
    }

    if (sendButton) {
      sendButton.disabled = !canSend;
    }

    this.renderConversations();
    this.renderChat(username);
  },

  renderChat(username) {
    const container = document.getElementById("chat-messages");
    if (!container) {
      return;
    }
    const messages = State.conversations.get(username) || [];

    container.innerHTML = messages
      .map(
        (msg) => `
      <div class="message ${msg.sent ? "sent" : "received"}">
        <div class="message-content">${msg.message}</div>
        <div class="message-time">
          ${new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          ${msg.status && msg.status !== "delivered" ? ` • ${msg.status}` : ""}
        </div>
      </div>
    `,
      )
      .join("");

    container.scrollTop = container.scrollHeight;
  },

  buildLogContextEntries(item) {
    const senderLabel = Helpers.auditSenderLabel(item);
    const recipientLabel = Helpers.auditRecipientLabel(item);

    return [
      {
        label: "Sender",
        value: senderLabel,
      },
      {
        label: "Recipient",
        value:
          item.recipientType === "group"
            ? `${recipientLabel} (group)`
            : recipientLabel,
      },
      item.senderAgent
        ? {
            label: "Via",
            value: item.senderAgent,
          }
        : null,
      {
        label: "Selector",
        value: Helpers.selectorSummary(item.selectors),
      },
    ].filter(Boolean);
  },

  buildLogExcerpts(item, threadSummary = null) {
    const excerpts = [];
    const thread = Helpers.askAroundThread(item, threadSummary);

    if (item.kind === "review") {
      if (item.messagePreview) {
        excerpts.push({
          label: "Draft preview",
          value: item.messagePreview,
        });
      }

      if (item.contextPreview) {
        excerpts.push({
          label: "Context",
          value: item.contextPreview,
        });
      }

      if (!excerpts.length && item.auditExplanation) {
        excerpts.push({
          label: "Audit note",
          value: item.auditExplanation,
        });
      }
    } else if (item.kind === "blocked") {
      excerpts.push({
        label: "Audit note",
        value:
          item.auditExplanation ||
          item.reason ||
          item.summary ||
          "Mahilo blocked this delivery before it left the audit boundary.",
      });
      excerpts.push({
        label: "Stored excerpt",
        value:
          item.storedPayloadExcerpt ||
          "Payload excerpt omitted by current retention settings.",
      });
    } else if (item.context) {
      excerpts.push({
        label: "Context",
        value: item.context,
      });
    }

    if (thread) {
      if (item.transportDirection === "received" && thread.questionPreview) {
        excerpts.unshift({
          label: "Ask-around question",
          maxLength: 280,
          value: thread.questionPreview,
        });
      }

      const outcomeLines = Helpers.askAroundOutcomeLines(thread);
      if (outcomeLines.length) {
        excerpts.push({
          label: "Ask-around outcome",
          maxLength: 420,
          value: outcomeLines.join("\n"),
        });
      }

      const readinessLines = Helpers.askAroundReadinessLines(thread);
      if (readinessLines.length) {
        excerpts.push({
          label: "Ask-around readiness",
          maxLength: 360,
          value: readinessLines.join("\n"),
        });
      }

      const replyContextLines = Helpers.askAroundReplyContextLines(thread);
      if (replyContextLines.length) {
        excerpts.push({
          label: "Reply context",
          maxLength: 360,
          value: replyContextLines.join("\n"),
        });
      }
    }

    return excerpts;
  },

  renderLogContextGrid(item) {
    return `
      <div class="log-context-grid">
        ${this.buildLogContextEntries(item)
          .map(
            (entry) => `
          <div class="log-context-card">
            <span class="log-context-label">${Helpers.escapeHtml(entry.label)}</span>
            <span class="log-context-value">${Helpers.escapeHtml(entry.value)}</span>
          </div>
        `,
          )
          .join("")}
      </div>
    `;
  },

  renderLogExcerptGrid(item, threadSummary = null) {
    const excerpts = this.buildLogExcerpts(item, threadSummary);

    if (!excerpts.length) {
      return "";
    }

    return `
      <div class="log-excerpt-grid">
        ${excerpts
          .map(
            (excerpt) => `
          <div class="log-excerpt-card">
            <span class="log-excerpt-label">${Helpers.escapeHtml(excerpt.label)}</span>
            <p class="log-excerpt-copy">${Helpers.escapeHtml(
              Helpers.truncate(excerpt.value, excerpt.maxLength || 180),
            )}</p>
          </div>
        `,
          )
          .join("")}
      </div>
    `;
  },

  renderLogDetails(item, threadSummary = null, askAroundTag = null) {
    const details = [];
    const thread = Helpers.askAroundThread(item, threadSummary);

    if (item.kind === "review") {
      details.push({ label: "Review queue", highlight: true });
      details.push({
        label: `State: ${Helpers.logStatusLabel(item.status, "Review required")}`,
      });
      details.push({
        label: `Decision: ${Helpers.titleizeToken(item.decision, "Ask")}`,
      });
      details.push({
        label: `Mode: ${Helpers.logStatusLabel(item.deliveryMode, "Review required")}`,
      });
    } else if (item.kind === "blocked") {
      details.push({ label: "Blocked", highlight: true });
    } else {
      details.push({
        label:
          item.transportDirection === "sent"
            ? "Outbound delivery"
            : "Inbound delivery",
        highlight: true,
      });
    }

    if (item.reasonCode) {
      details.push({ label: `Reason code: ${item.reasonCode}` });
    }

    if (item.resolverLayer) {
      details.push({
        label: `Layer: ${Helpers.titleizeToken(item.resolverLayer, item.resolverLayer)}`,
      });
    }

    if (item.correlationId) {
      details.push({
        label: `Thread: ${Helpers.truncate(item.correlationId, 16)}`,
      });
    }

    if (item.payloadHash && item.kind === "blocked") {
      details.push({
        label: `Payload hash: ${Helpers.truncate(item.payloadHash, 22)}`,
      });
    }

    if (item.recipientType === "group") {
      details.push({ label: "Group delivery" });
    }

    if (askAroundTag) {
      details.push({ label: askAroundTag, highlight: true });
    }

    if (thread) {
      if (thread.counts.ready) {
        details.push({ label: `Ready ${thread.counts.ready}` });
      }

      if (thread.counts.replied) {
        details.push({ label: `Replies ${thread.counts.replied}` });
      }

      if (thread.counts.noGrounded) {
        details.push({
          label: `No grounded ${thread.counts.noGrounded}`,
        });
      }

      if (thread.counts.waiting) {
        details.push({ label: `No reply yet ${thread.counts.waiting}` });
      }
    }

    return `
      <div class="log-details">
        ${details
          .map(
            (detail) => `
          <span class="log-detail${detail.highlight ? " log-detail-highlight" : ""}">${Helpers.escapeHtml(detail.label)}</span>
        `,
          )
          .join("")}
      </div>
    `;
  },

  renderLogItem(item, threadSummary) {
    const askAroundTag =
      item.askAroundTag || Helpers.askAroundTag(item, threadSummary);
    const askAroundThread = Helpers.askAroundThread(item, threadSummary);
    const askAroundReply = askAroundThread
      ? Helpers.readAskAroundReplyPayload(item)
      : null;
    const recipientLabel = Helpers.auditRecipientLabel(item);
    const senderLabel = Helpers.auditSenderLabel(item);
    const statusLabel =
      item.kind === "blocked"
        ? "Blocked"
        : Helpers.logStatusLabel(
            item.status,
            item.kind === "review" ? "Review required" : "Pending",
          );
    const directionLabel =
      item.transportDirection === "sent" ? "Outbound" : "Inbound";
    const heading =
      askAroundThread &&
      item.kind === "message" &&
      item.transportDirection === "sent"
        ? item.recipientType === "group"
          ? `Ask-around to group ${recipientLabel}`
          : `Ask-around to ${recipientLabel}`
        : askAroundThread &&
            item.kind === "message" &&
            item.transportDirection === "received"
          ? `Ask-around reply from ${senderLabel}`
          : item.kind === "review"
        ? `Review queue • ${
            item.transportDirection === "sent"
              ? `To: ${recipientLabel}`
              : `From: ${senderLabel}`
          }`
        : item.kind === "blocked"
          ? `Blocked event • ${
              item.transportDirection === "sent"
                ? `To: ${recipientLabel}`
                : `From: ${senderLabel}`
            }`
          : item.transportDirection === "sent"
            ? `Delivery to ${recipientLabel}`
            : `Delivery from ${senderLabel}`;
    const icon =
      askAroundThread && item.kind === "message"
        ? item.transportDirection === "sent"
          ? "🗣️"
          : "💬"
        : item.kind === "review"
        ? item.transportDirection === "sent"
          ? "⏸️"
          : "🧾"
        : item.kind === "blocked"
          ? "🚫"
          : item.transportDirection === "sent"
            ? "📤"
            : "📥";
    const contentLabel =
      askAroundThread &&
      item.kind === "message" &&
      item.transportDirection === "sent"
        ? "Question"
        : askAroundThread &&
            item.kind === "message" &&
            item.transportDirection === "received"
          ? "Reply"
          : item.kind === "review"
        ? "Queue summary"
        : item.kind === "blocked"
          ? "Block summary"
          : "Message";
    const contentText =
      item.kind === "review"
        ? item.summary ||
          item.messagePreview ||
          item.previewText ||
          "Message requires review before delivery."
        : item.kind === "blocked"
          ? item.reason || item.summary || "Message blocked by policy."
          : askAroundReply
            ? askAroundReply.text
          : item.messageText || item.previewText || "(no content)";

    return `
      <div class="log-item ${item.auditState}${askAroundThread ? " ask-around" : ""}">
        <div class="log-header">
          <div class="log-direction">
            <div class="log-direction-icon ${item.transportDirection}">
              ${icon}
            </div>
            <div>
              <div class="log-participants">${Helpers.escapeHtml(heading)}</div>
              <div class="log-meta">
                <span>${Helpers.escapeHtml(new Date(item.timestamp).toLocaleString())}</span>
                <span>${Helpers.escapeHtml(directionLabel)}</span>
              </div>
            </div>
          </div>
          <span class="log-status ${item.status}">${Helpers.escapeHtml(statusLabel)}</span>
        </div>
        <div class="log-content">
          <span class="log-content-title">${Helpers.escapeHtml(contentLabel)}</span>
          <div class="log-content-body">${Helpers.escapeHtml(Helpers.truncate(contentText, item.kind === "message" ? 220 : 180))}</div>
        </div>
        ${this.renderLogContextGrid(item)}
        ${this.renderLogExcerptGrid(item, threadSummary)}
        ${this.renderLogDetails(item, threadSummary, askAroundTag)}
      </div>
    `;
  },

  renderLogSummary(items, threadSummary) {
    const container = document.getElementById("logs-summary");
    if (!container) {
      return;
    }

    const counts = Helpers.auditCounts(items);
    const representedThreadIds = new Set(
      items
        .map((item) => Helpers.askAroundThread(item, threadSummary)?.id || null)
        .filter(Boolean),
    );
    const askAroundCounts = {
      noGrounded: 0,
      replies: 0,
      unattributedReplies: 0,
      waiting: 0,
    };
    representedThreadIds.forEach((threadId) => {
      const thread = threadSummary?.threadsById?.get(threadId);
      if (!thread?.counts) {
        return;
      }

      askAroundCounts.replies += thread.counts.replied || 0;
      askAroundCounts.noGrounded += thread.counts.noGrounded || 0;
      askAroundCounts.waiting += thread.counts.waiting || 0;
      askAroundCounts.unattributedReplies +=
        thread.counts.unattributedReplies || 0;
    });

    container.innerHTML = `
      <div class="log-summary-card">
        <span class="log-summary-label">Deliveries</span>
        <span class="log-summary-value">${counts.delivered}</span>
        <p>Completed sends or receives in the current audit view.</p>
      </div>
      <div class="log-summary-card">
        <span class="log-summary-label">Review Queue</span>
        <span class="log-summary-value">${counts.review}</span>
        <div class="log-summary-breakdown">
          <span class="log-summary-chip">Review required ${counts.reviewRequired}</span>
          <span class="log-summary-chip">Approval pending ${counts.approvalPending}</span>
        </div>
      </div>
      <div class="log-summary-card">
        <span class="log-summary-label">Blocked Events</span>
        <span class="log-summary-value">${counts.blocked}</span>
        <p>Boundary and policy denials captured for audit.</p>
      </div>
      <div class="log-summary-card">
        <span class="log-summary-label">Ask-around Threads</span>
        <span class="log-summary-value">${representedThreadIds.size}</span>
        <div class="log-summary-breakdown">
          <span class="log-summary-chip">Replies ${askAroundCounts.replies}</span>
          <span class="log-summary-chip">No reply yet ${askAroundCounts.waiting}</span>
          <span class="log-summary-chip">No grounded ${askAroundCounts.noGrounded}</span>
        </div>
        ${
          askAroundCounts.unattributedReplies
            ? `<p>${Helpers.pluralize(askAroundCounts.unattributedReplies, "unattributed reply")} kept separate from trusted attribution.</p>`
            : "<p>Detected fan-out or group delivery threads in this view.</p>"
        }
      </div>
    `;
  },

  renderLogs(filters = null) {
    if (typeof filters === "string") {
      State.logDirectionFilter = Helpers.normalizeLogDirectionFilter(filters);
    } else if (Helpers.isObject(filters)) {
      if (Object.hasOwn(filters, "direction")) {
        State.logDirectionFilter = Helpers.normalizeLogDirectionFilter(
          filters.direction,
        );
      }

      if (Object.hasOwn(filters, "state")) {
        State.logStateFilter = Helpers.normalizeLogStateFilter(filters.state);
      }
    }

    const list = document.getElementById("logs-list");
    if (!list) {
      return;
    }

    const items = Helpers.filterAuditLog(State.auditLog, {
      direction: State.logDirectionFilter,
      state: State.logStateFilter,
    });
    const threadSummary = Helpers.askAroundThreadSummary(State.auditLog);

    this.renderLogSummary(items, threadSummary);

    if (!items.length) {
      const emptyCopy =
        State.logDirectionFilter === "all" && State.logStateFilter === "all"
          ? "Deliveries, reviews, blocked events, and ask-around threads will appear here for audit"
          : "No delivery-log items match the current direction and state filters.";
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon-large">📋</div>
          <h3>No delivery logs yet</h3>
          <p>${Helpers.escapeHtml(emptyCopy)}</p>
        </div>
      `;
      return;
    }

    list.innerHTML = items
      .map((item) => this.renderLogItem(item, threadSummary))
      .join("");
  },

  renderDevConversations() {
    const list = document.getElementById("dev-conversations-list");
    if (!list) {
      return;
    }

    const acceptedFriends = State.friends.filter(
      (f) => f.status === "accepted",
    );

    if (!acceptedFriends.length) {
      list.innerHTML = `
        <div class="empty-state small" style="padding: 40px 20px;">
          <div class="empty-icon" style="font-size: 3rem; margin-bottom: 16px;">👥</div>
          <p style="font-weight: 700; color: var(--color-text); margin-bottom: 8px;">No network contacts available</p>
          <p class="hint" style="font-size: 0.9rem;">Build your network first to test messaging</p>
        </div>
      `;
      return;
    }

    list.innerHTML = acceptedFriends
      .map((friend) => {
        const name = friend.displayName || friend.username;
        const messages = State.conversations.get(friend.username) || [];
        const lastMessage = messages[messages.length - 1];

        return `
        <div class="conversation-item ${State.selectedChat === friend.username ? "active" : ""}" 
             onclick="UI.selectDevChat('${friend.username}')">
          <div class="conversation-avatar">${name[0].toUpperCase()}</div>
          <div class="conversation-info">
            <div class="conversation-name">${name}</div>
            <div class="conversation-preview">${lastMessage?.previewText || "Click to test messaging"}</div>
          </div>
        </div>
      `;
      })
      .join("");
  },

  selectDevChat(username) {
    State.selectedChat = username;

    const friend = State.friends.find((f) => f.username === username);
    const name = friend?.displayName || username;

    document.getElementById("dev-chat-placeholder").classList.add("hidden");
    document.getElementById("dev-chat-container").classList.remove("hidden");

    document.getElementById("dev-chat-recipient-avatar").textContent =
      name[0].toUpperCase();
    document.getElementById("dev-chat-recipient-name").textContent = name;
    document.getElementById("dev-chat-recipient-status").textContent =
      "Accepted network contact";

    this.renderDevMessagingSummary();
    this.renderDevConversations();
    this.renderDevChat(username);
  },

  renderDevChat(username) {
    const container = document.getElementById("dev-chat-messages");
    if (!container) {
      return;
    }
    const messages = State.conversations.get(username) || [];

    container.innerHTML = messages
      .map(
        (msg) => `
      <div class="message ${msg.sent ? "sent" : "received"}">
        <div class="message-content">${msg.message}</div>
        <div class="message-time">
          ${new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          ${msg.status ? ` • ${msg.status}` : ""}
        </div>
      </div>
    `,
      )
      .join("");

    container.scrollTop = container.scrollHeight;
  },

  renderDevApiKey() {
    const display = document.getElementById("dev-api-key-display");
    const context = document.getElementById("dev-api-key-context");
    const footnote = document.getElementById("dev-api-key-footnote");
    const toggle = document.getElementById("dev-toggle-api-key");

    if (!display || !context || !footnote || !toggle) {
      return;
    }

    const key = Helpers.nullableString(State.apiKey);
    if (!key) {
      display.textContent = "No API key loaded";
      context.textContent =
        "Use the advanced API-key fallback to load an existing invite-backed account.";
      footnote.textContent =
        "API keys are an advanced access path for existing accounts. Mahilo only returns a fresh key when you regenerate it.";
      toggle.disabled = true;
      toggle.innerHTML = "<span>👁️</span> Reveal";
      return;
    }

    display.textContent = State.developerApiKeyVisible
      ? key
      : Helpers.maskSecret(key);
    context.textContent = State.developerApiKeyVisible
      ? "Visible because you intentionally revealed it in this dashboard session."
      : "Loaded from this dashboard session for an existing invite-backed account. Copy works without revealing it on screen.";
    footnote.textContent =
      "Mahilo can regenerate this advanced credential, but it cannot recover an older lost key.";
    toggle.disabled = false;
    toggle.innerHTML = State.developerApiKeyVisible
      ? "<span>🙈</span> Hide"
      : "<span>👁️</span> Reveal";
  },

  toggleDevApiKeyVisibility() {
    if (!State.apiKey) {
      this.showToast("No API key is loaded in this dashboard session.", "error");
      return;
    }

    State.developerApiKeyVisible = !State.developerApiKeyVisible;
    this.renderDevApiKey();
  },

  renderDevDiagnostics() {
    const summary = document.getElementById("dev-diagnostics-summary");
    const list = document.getElementById("dev-diagnostics-list");

    if (!summary || !list) {
      return;
    }

    const connections = this.getSenderConnectionWorkspaceItems();
    const activeConnections = connections.filter(
      (connection) =>
        Helpers.string(connection?.status).toLowerCase() === "active",
    );
    const healthyConnections = connections.filter(
      (connection) => connection.health?.tone === "healthy",
    );
    const defaultSender =
      connections.find((connection) => connection.isDefaultSenderCandidate) ||
      null;

    summary.innerHTML = [
      {
        label: "Default sender",
        tone: defaultSender ? "default" : "warning",
        value: defaultSender ? defaultSender.label : "No active sender",
        detail: defaultSender
          ? `${defaultSender.modeLabel} route selected first`
          : "Add or activate a connection",
      },
      {
        label: "Connections",
        tone: connections.length ? "success" : "warning",
        value: `${connections.length} total`,
        detail: `${activeConnections.length} active for auto-selection`,
      },
      {
        label: "Healthy checks",
        tone: healthyConnections.length ? "success" : "warning",
        value: healthyConnections.length
          ? `${healthyConnections.length} reporting healthy`
          : "No successful checks yet",
        detail: healthyConnections.length
          ? "Latest ping or polling inbox signal is healthy"
          : "Run a connection check from Developer",
      },
    ]
      .map(
        (item) => `
          <article class="developer-summary-chip ${Helpers.escapeHtml(item.tone)}">
            <span class="developer-summary-label">${Helpers.escapeHtml(item.label)}</span>
            <strong class="developer-summary-value">${Helpers.escapeHtml(item.value)}</strong>
            <p>${Helpers.escapeHtml(item.detail)}</p>
          </article>
        `,
      )
      .join("");

    if (!connections.length) {
      list.innerHTML = `
        <div class="empty-state small" style="padding: 32px 20px;">
          <div class="empty-icon" style="font-size: 2.5rem; margin-bottom: 12px;">🤖</div>
          <p style="font-weight: 700; color: var(--color-text); margin-bottom: 8px;">No sender connections yet</p>
          <p class="hint" style="font-size: 0.9rem;">Add a sender connection before running diagnostics.</p>
        </div>
      `;
      return;
    }

    list.innerHTML = connections
      .map(
        (connection) => `
          <article class="developer-diagnostic-card ${Helpers.escapeHtml(connection.health.tone)}">
            <div class="developer-diagnostic-header">
              <div>
                <div class="developer-diagnostic-title">${Helpers.escapeHtml(connection.label)}</div>
                <p class="developer-diagnostic-copy">${Helpers.escapeHtml(Helpers.titleizeToken(connection.framework, "Unknown framework"))} • ${Helpers.escapeHtml(connection.modeLabel)}</p>
                <div class="developer-diagnostic-badges">
                  <span class="status-badge ${Helpers.escapeHtml(connection.status)}">${Helpers.escapeHtml(Helpers.titleizeToken(connection.status, "Unknown"))}</span>
                  <span class="status-badge ${Helpers.escapeHtml(connection.mode)}">${Helpers.escapeHtml(connection.modeLabel)}</span>
                  ${
                    connection.isDefaultSenderCandidate
                      ? '<span class="status-badge default">Default sender</span>'
                      : ""
                  }
                </div>
              </div>
              <button class="squishy-btn btn-secondary btn-small" onclick="UI.handlePingAgent('${Helpers.escapeHtml(connection.id)}')">
                <span>🔎</span> ${connection.mode === "polling" ? "Check Inbox" : "Check Health"}
              </button>
            </div>
            <div class="developer-diagnostic-meta">
              <div class="developer-diagnostic-meta-item">
                <span>Routing</span>
                <strong>${Helpers.escapeHtml(connection.routing.badge)}</strong>
                <p>${Helpers.escapeHtml(connection.routing.detail)}</p>
              </div>
              <div class="developer-diagnostic-meta-item">
                <span>Health</span>
                <strong>${Helpers.escapeHtml(connection.health.label)}</strong>
                <p>${Helpers.escapeHtml(connection.health.detail)}</p>
              </div>
              <div class="developer-diagnostic-meta-item">
                <span>Last seen</span>
                <strong>${Helpers.escapeHtml(connection.lastSeenLabel)}</strong>
                <p>Last callback or registration activity.</p>
              </div>
            </div>
          </article>
        `,
      )
      .join("");
  },

  renderDevMessagingSummary() {
    const summary = document.getElementById("dev-test-messaging-summary");
    if (!summary) {
      return;
    }

    const acceptedFriends = State.friends.filter(
      (friend) => friend.status === "accepted",
    );
    const selectedFriend = acceptedFriends.find(
      (friend) => friend.username === State.selectedChat,
    );
    const sender = this.getDefaultSenderCandidate();

    summary.innerHTML = [
      {
        label: "Selected sender",
        tone: sender ? "default" : "warning",
        value: sender ? sender.label : "No active sender",
        detail: sender
          ? `${Helpers.connectionModeLabel(sender.mode || Helpers.connectionMode(sender.callbackUrl))} route used for dashboard debug sends`
          : "Add or activate a sender connection first",
      },
      {
        label: "Test target",
        tone: selectedFriend ? "success" : "warning",
        value: selectedFriend
          ? selectedFriend.displayName || selectedFriend.username
          : "No contact selected",
        detail: selectedFriend
          ? "Accepted network contact selected for a direct send check"
          : "Choose an accepted contact from the left column",
      },
      {
        label: "Eligible contacts",
        tone: acceptedFriends.length ? "success" : "warning",
        value: Helpers.pluralize(acceptedFriends.length, "contact"),
        detail: acceptedFriends.length
          ? "Developer test sends stay limited to accepted network contacts"
          : "Build your network before using test messaging",
      },
    ]
      .map(
        (item) => `
          <article class="developer-summary-chip ${Helpers.escapeHtml(item.tone)}">
            <span class="developer-summary-label">${Helpers.escapeHtml(item.label)}</span>
            <strong class="developer-summary-value">${Helpers.escapeHtml(item.value)}</strong>
            <p>${Helpers.escapeHtml(item.detail)}</p>
          </article>
        `,
      )
      .join("");
  },

  getOverviewNetworkReadiness() {
    const counts = this.getNetworkRelationshipCounts();
    const acceptedFriends = State.friends
      .filter((friend) => this.networkBucket(friend) === "accepted")
      .slice()
      .sort((left, right) => {
        const interactionDelta =
          (right?.interactionCount || 0) - (left?.interactionCount || 0);
        if (interactionDelta !== 0) {
          return interactionDelta;
        }

        return Helpers.string(
          left?.displayName || left?.username,
        ).localeCompare(Helpers.string(right?.displayName || right?.username));
      });

    const readyContacts = [];
    const notReadyContacts = [];
    const checkingContacts = [];
    const errorContacts = [];

    acceptedFriends.forEach((friend) => {
      const connectionState = this.getNetworkConnectionState(friend);

      if (connectionState.status === "loaded") {
        if (
          Array.isArray(connectionState.items) &&
          connectionState.items.length > 0
        ) {
          readyContacts.push({
            connectionCount: connectionState.items.length,
            connectionState,
            friend,
          });
        } else {
          notReadyContacts.push({
            connectionState,
            friend,
          });
        }
        return;
      }

      if (connectionState.status === "error") {
        errorContacts.push({
          connectionState,
          friend,
        });
        return;
      }

      checkingContacts.push({
        connectionState,
        friend,
      });
    });

    return {
      acceptedCount: counts.accepted,
      acceptedFriends,
      checkingContacts,
      checkingCount: checkingContacts.length,
      counts,
      errorContacts,
      errorCount: errorContacts.length,
      notReadyContacts,
      notReadyCount: notReadyContacts.length,
      readyContacts,
      readyCount: readyContacts.length,
    };
  },

  getOverviewSenderReadiness() {
    const connections = this.getSenderConnectionWorkspaceItems();
    const activeConnections = connections.filter(
      (connection) =>
        Helpers.string(connection?.status).toLowerCase() === "active",
    );
    const defaultSender =
      connections.find((connection) => connection.isDefaultSenderCandidate) ||
      null;

    if (!connections.length) {
      return {
        activeCount: 0,
        canSend: false,
        connections,
        copy:
          "Mahilo cannot send or ask around until you add a sender connection.",
        defaultSender: null,
        nextStep:
          "Add a sender connection from the Sender Connections workspace.",
        statusLabel: "Setup needed",
        title: "No sender connections yet",
        tone: "warning",
      };
    }

    if (!activeConnections.length || !defaultSender) {
      return {
        activeCount: 0,
        canSend: false,
        connections,
        copy:
          "Connections are saved, but none are active for automatic routing right now.",
        defaultSender,
        nextStep:
          "Activate one sender connection so Mahilo can route messages.",
        statusLabel: "Action needed",
        title: "No active sender route",
        tone: "warning",
      };
    }

    if (defaultSender.health?.tone === "warning") {
      return {
        activeCount: activeConnections.length,
        canSend: true,
        connections,
        copy: `${defaultSender.label} is still the default ${defaultSender.modeLabel.toLowerCase()} sender, but the latest health check failed.`,
        defaultSender,
        nextStep: `Run a health check or fix ${defaultSender.label} before depending on it.`,
        statusLabel: "Attention needed",
        title: `${defaultSender.label} is ready but needs attention`,
        tone: "warning",
      };
    }

    if (defaultSender.health?.tone === "unknown") {
      return {
        activeCount: activeConnections.length,
        canSend: true,
        connections,
        copy: `${Helpers.pluralize(activeConnections.length, "active sender connection")} available. ${defaultSender.modeLabel} routing is selected first.`,
        defaultSender,
        nextStep: `Run a health check on ${defaultSender.label} to verify reachability.`,
        statusLabel: "Check recommended",
        title: `Ready via ${defaultSender.label}`,
        tone: "pending",
      };
    }

    return {
      activeCount: activeConnections.length,
      canSend: true,
      connections,
      copy: `${Helpers.pluralize(activeConnections.length, "active sender connection")} available. ${defaultSender.modeLabel} routing is selected first.`,
      defaultSender,
      nextStep: "No obvious sender blocker.",
      statusLabel: "Ready",
      title: `Ready via ${defaultSender.label}`,
      tone: "ready",
    };
  },

  getOverviewActivitySnapshot() {
    const auditCounts = Helpers.auditCounts(State.auditLog);
    const threadSummary = Helpers.askAroundThreadSummary(State.auditLog);
    const parts = [];

    if (threadSummary.threadIds.size) {
      parts.push(
        Helpers.pluralize(threadSummary.threadIds.size, "ask-around thread"),
      );
    }

    if (threadSummary.counts.replied) {
      parts.push(Helpers.pluralize(threadSummary.counts.replied, "reply"));
    }

    if (threadSummary.counts.waiting) {
      parts.push(
        `${Helpers.pluralize(threadSummary.counts.waiting, "contact")} waiting`,
      );
    }

    if (threadSummary.counts.noGrounded) {
      parts.push(
        Helpers.pluralize(
          threadSummary.counts.noGrounded,
          "no-grounded answer",
          "no-grounded answers",
        ),
      );
    }

    if (!parts.length && auditCounts.delivered) {
      parts.push(
        Helpers.pluralize(auditCounts.delivered, "delivery", "deliveries"),
      );
    }

    if (auditCounts.review) {
      parts.push(Helpers.pluralize(auditCounts.review, "review item"));
    }

    if (auditCounts.blocked) {
      parts.push(Helpers.pluralize(auditCounts.blocked, "blocked event"));
    }

    return {
      copy: parts.length
        ? parts.join(" • ")
        : "No recent ask-around or delivery activity yet.",
    };
  },

  getOverviewReadinessSummary() {
    const sender = this.getOverviewSenderReadiness();
    const network = this.getOverviewNetworkReadiness();
    const auditCounts = Helpers.auditCounts(State.auditLog);
    const reviewQueueCount =
      auditCounts.reviewRequired + auditCounts.approvalPending;
    const activity = this.getOverviewActivitySnapshot();
    let tone = "pending";
    let statusLabel = "Checking";
    let title = "Loading Mahilo readiness";
    let copy =
      "Mahilo is loading your sender routes, network, and recent activity.";
    let nextStep = "Loading the latest readiness signals.";

    if (!sender.connections.length) {
      tone = "warning";
      statusLabel = "Setup needed";
      title = "Add a sender connection";
      copy =
        "Mahilo cannot send or ask around until you register a sender connection.";
      nextStep = sender.nextStep;
    } else if (!sender.canSend) {
      tone = "warning";
      statusLabel = "Action needed";
      title = "Activate a sender route";
      copy =
        "You have sender connections saved, but none are active for automatic routing.";
      nextStep = sender.nextStep;
    } else if (!network.acceptedCount) {
      tone = "warning";
      statusLabel = "Build your circle";
      title = "Add trusted contacts";
      copy =
        "You have a sender route, but nobody is in your accepted Mahilo circle yet.";
      nextStep = "Add someone by username so Mahilo has a real circle to reach.";
    } else if (!network.readyCount && network.checkingCount) {
      tone = "pending";
      statusLabel = "Checking";
      title = "Checking network readiness";
      copy = `Mahilo is confirming which of your ${network.acceptedCount} accepted contacts have active connections.`;
      nextStep =
        "Give Mahilo a moment to finish checking each contact connection space.";
    } else if (!network.readyCount) {
      tone = "warning";
      statusLabel = "Waiting on contacts";
      title = "Accepted contacts need active connections";
      copy =
        "Your circle exists, but none of the accepted contacts currently have an active Mahilo connection.";
      nextStep =
        "Ask a contact to bring one of their Mahilo connections online.";
    } else {
      tone = sender.tone === "warning" ? "warning" : "ready";
      statusLabel = sender.tone === "warning" ? "Attention needed" : "Ready";
      title = "Ready to ask around";
      copy = `Mahilo can route through ${sender.defaultSender?.label || "your default sender"} and reach ${Helpers.pluralize(network.readyCount, "contact")} with active connections right now.`;

      if (sender.tone !== "ready") {
        nextStep = sender.nextStep;
      } else if (reviewQueueCount) {
        nextStep = `Review ${Helpers.pluralize(reviewQueueCount, "held item")} waiting in the queue.`;
      } else if (network.counts.incoming) {
        nextStep = `Accept ${Helpers.pluralize(network.counts.incoming, "incoming request")} to widen your circle.`;
      } else {
        nextStep =
          "No obvious blocker. You can ask around or send directly now.";
      }
    }

    return {
      activity,
      auditCounts,
      blockedCount: auditCounts.blocked,
      copy,
      network,
      nextStep,
      reviewQueueCount,
      sender,
      statusLabel,
      title,
      tone,
    };
  },

  renderOverviewReadiness() {
    const container = document.getElementById("overview-readiness-summary");
    if (!container) {
      return;
    }

    const summary = this.getOverviewReadinessSummary();
    const reviewCopyParts = [];
    if (summary.auditCounts.reviewRequired) {
      reviewCopyParts.push(
        `${summary.auditCounts.reviewRequired} review required`,
      );
    }
    if (summary.auditCounts.approvalPending) {
      reviewCopyParts.push(
        `${summary.auditCounts.approvalPending} approval pending`,
      );
    }

    const statCards = [
      {
        copy: "In your trusted circle",
        label: "Accepted contacts",
        value: summary.network.counts.accepted,
      },
      {
        copy: summary.network.checkingCount
          ? `${summary.network.checkingCount} checking`
          : "Active contact connections",
        label: "Ready contacts",
        value: summary.network.readyCount,
      },
      {
        copy: "Waiting on you",
        label: "Incoming requests",
        value: summary.network.counts.incoming,
      },
      {
        copy: "Waiting on them",
        label: "Outgoing requests",
        value: summary.network.counts.outgoing,
      },
      {
        copy: reviewCopyParts.length
          ? reviewCopyParts.join(" • ")
          : "Held deliveries",
        label: "Review queue",
        value: summary.reviewQueueCount,
      },
      {
        copy: "Boundary and policy denials",
        label: "Blocked events",
        value: summary.blockedCount,
      },
    ];

    container.innerHTML = `
      <div class="overview-readiness-hero">
        <div class="overview-readiness-copy">
          <span class="overview-readiness-status ${Helpers.escapeHtml(summary.tone)}">${Helpers.escapeHtml(summary.statusLabel)}</span>
          <h3>${Helpers.escapeHtml(summary.title)}</h3>
          <p>${Helpers.escapeHtml(summary.copy)}</p>
        </div>
        <div class="overview-readiness-next-step">
          <span class="overview-readiness-next-label">Next step</span>
          <p>${Helpers.escapeHtml(summary.nextStep)}</p>
        </div>
      </div>
      <div class="overview-summary-strip">
        ${statCards
          .map(
            (card) => `
              <div class="network-summary-card">
                <span class="network-summary-label">${Helpers.escapeHtml(card.label)}</span>
                <span class="network-summary-value">${Helpers.escapeHtml(String(card.value))}</span>
                <span class="network-summary-copy">${Helpers.escapeHtml(card.copy)}</span>
              </div>
            `,
          )
          .join("")}
      </div>
      <div class="overview-activity-note">
        <span class="overview-activity-note-label">Recent activity</span>
        <p>${Helpers.escapeHtml(summary.activity.copy)}</p>
      </div>
    `;
  },

  renderOverviewNetworkRow(options = {}) {
    const friend = options.friend || null;
    const displayName =
      options.title ||
      friend?.displayName ||
      friend?.username ||
      "Unknown contact";
    const avatarLabel =
      options.avatarLabel ||
      (friend?.displayName?.[0] || friend?.username?.[0] || "?").toUpperCase();
    const tone = Helpers.string(options.tone, "ready");
    const badgeTone = Helpers.string(options.badgeTone, tone);
    const avatarTone = Helpers.string(options.avatarTone, tone);

    return `
      <div class="friend-preview-item ${Helpers.escapeHtml(tone)}">
        <div class="friend-preview-avatar ${Helpers.escapeHtml(avatarTone)}">${Helpers.escapeHtml(avatarLabel)}</div>
        <div class="friend-preview-main">
          <span class="friend-preview-name">${Helpers.escapeHtml(displayName)}</span>
          <span class="friend-preview-copy">${Helpers.escapeHtml(options.copy || "")}</span>
        </div>
        <span class="friend-preview-badge ${Helpers.escapeHtml(badgeTone)}">${Helpers.escapeHtml(options.badge || "")}</span>
      </div>
    `;
  },

  renderOverviewAgents() {
    const list = document.getElementById("overview-agent-list");
    const summaryContainer = document.getElementById("overview-sender-summary");
    const sender = this.getOverviewSenderReadiness();
    const connections = sender.connections;

    this.renderOverviewReadiness();

    if (summaryContainer) {
      summaryContainer.innerHTML = `
        <div class="overview-card-callout ${Helpers.escapeHtml(sender.tone)}">
          <div class="overview-card-callout-copy">
            <span class="overview-card-callout-label">Current sender</span>
            <strong>${Helpers.escapeHtml(sender.title)}</strong>
            <p>${Helpers.escapeHtml(sender.copy)}</p>
          </div>
          <div class="overview-card-callout-next">
            <span>Next step</span>
            <p>${Helpers.escapeHtml(sender.nextStep)}</p>
          </div>
        </div>
      `;
    }

    if (!connections.length) {
      list.innerHTML = `
        <div class="empty-state small" style="padding: 30px 20px;">
          <div class="empty-icon" style="font-size: 2.5rem; margin-bottom: 12px;">🤖</div>
          <p style="font-weight: 700; color: var(--color-text); font-size: 0.95rem;">No sender connections yet</p>
        </div>
      `;
      return;
    }

    list.innerHTML = connections
      .slice(0, 3)
      .map(
        (agent) => `
      <div class="agent-status-item ${agent.isDefaultSenderCandidate ? "default" : ""}">
        <span class="status-indicator ${Helpers.escapeHtml(agent.status)}"></span>
        <div class="agent-status-main">
          <span class="agent-status-name">${Helpers.escapeHtml(agent.label)}</span>
          <span class="agent-status-copy">${Helpers.escapeHtml(`${agent.modeLabel} • ${agent.health.label}`)}</span>
        </div>
        <div class="agent-status-meta">
          <span class="agent-status-framework">${Helpers.escapeHtml(
            agent.isDefaultSenderCandidate
              ? "Default sender"
              : agent.routing.badge,
          )}</span>
          ${
            agent.isDefaultSenderCandidate
              ? '<span class="agent-status-default">Default</span>'
              : ""
          }
        </div>
      </div>
    `,
      )
      .join("");
  },

  renderOverviewFriends() {
    const list = document.getElementById("overview-friend-list");
    const cues = document.getElementById("overview-network-cues");
    const network = this.getOverviewNetworkReadiness();

    this.renderOverviewReadiness();

    if (cues) {
      const cueCards = [
        {
          copy: "In your circle",
          label: "Accepted",
          value: network.counts.accepted,
        },
        {
          copy: network.checkingCount
            ? `${network.checkingCount} checking`
            : "Live connection space",
          label: "Ready now",
          value: network.readyCount,
        },
        {
          copy: "Waiting on you",
          label: "Incoming",
          value: network.counts.incoming,
        },
        {
          copy: "Waiting on them",
          label: "Outgoing",
          value: network.counts.outgoing,
        },
      ];

      cues.innerHTML = cueCards
        .map(
          (card) => `
            <div class="network-summary-card">
              <span class="network-summary-label">${Helpers.escapeHtml(card.label)}</span>
              <span class="network-summary-value">${Helpers.escapeHtml(String(card.value))}</span>
              <span class="network-summary-copy">${Helpers.escapeHtml(card.copy)}</span>
            </div>
          `,
        )
        .join("");
    }

    if (!State.friends.length) {
      list.innerHTML = `
        <div class="empty-state small" style="padding: 30px 20px;">
          <div class="empty-icon" style="font-size: 2.5rem; margin-bottom: 12px;">👋</div>
          <p style="font-weight: 700; color: var(--color-text); font-size: 0.95rem;">No network yet</p>
        </div>
      `;
      return;
    }

    const rows = [];

    network.readyContacts.slice(0, 3).forEach(({ connectionCount, friend }) => {
      const interactionCopy = Number.isFinite(friend?.interactionCount)
        ? ` • ${Helpers.pluralize(friend.interactionCount, "interaction")}`
        : "";

      rows.push(
        this.renderOverviewNetworkRow({
          badge: "Ready",
          copy: `${Helpers.pluralize(connectionCount, "active connection")} live${interactionCopy}`,
          friend,
          tone: "ready",
        }),
      );
    });

    if (!network.readyCount && network.checkingCount) {
      rows.push(
        this.renderOverviewNetworkRow({
          avatarLabel: "...",
          avatarTone: "pending",
          badge: "Checking",
          badgeTone: "pending",
          copy: `Looking up active connections for ${Helpers.pluralize(network.checkingCount, "accepted contact")}.`,
          title: "Checking contact readiness",
          tone: "pending",
        }),
      );
    }

    network.notReadyContacts
      .slice(0, rows.length ? 1 : 2)
      .forEach(({ friend }) => {
        rows.push(
          this.renderOverviewNetworkRow({
            badge: "Not ready",
            copy: "Accepted, but no active Mahilo connection is live right now.",
            friend,
            tone: "not-ready",
          }),
        );
      });

    if (network.errorCount && rows.length < 5) {
      rows.push(
        this.renderOverviewNetworkRow({
          avatarLabel: "!",
          avatarTone: "warning",
          badge: "Retry",
          badgeTone: "warning",
          copy: `${Helpers.pluralize(network.errorCount, "contact")} need a readiness refresh from the Network view.`,
          title: "Connection checks need attention",
          tone: "warning",
        }),
      );
    }

    if (network.counts.incoming) {
      rows.push(
        this.renderOverviewNetworkRow({
          avatarLabel: "↓",
          avatarTone: "pending",
          badge: String(network.counts.incoming),
          badgeTone: "pending",
          copy: `${Helpers.pluralize(network.counts.incoming, "request")} waiting on you.`,
          title: "Incoming requests",
          tone: "pending",
        }),
      );
    }

    if (network.counts.outgoing) {
      rows.push(
        this.renderOverviewNetworkRow({
          avatarLabel: "↑",
          avatarTone: "pending",
          badge: String(network.counts.outgoing),
          badgeTone: "pending",
          copy: `${Helpers.pluralize(network.counts.outgoing, "request")} waiting on them.`,
          title: "Outgoing requests",
          tone: "pending",
        }),
      );
    }

    if (!rows.length) {
      rows.push(
        this.renderOverviewNetworkRow({
          avatarLabel: "•",
          avatarTone: "pending",
          badge: "Start",
          badgeTone: "pending",
          copy:
            "Add or accept a contact to start building a usable Mahilo circle.",
          title: "No accepted or pending contacts yet",
          tone: "pending",
        }),
      );
    }

    list.innerHTML = rows.slice(0, 5).join("");
  },

  renderOverviewGroups() {
    // Already handled by updateGroupCount
  },

  renderOverviewAuditItem(item) {
    const recipientLabel = Helpers.auditRecipientLabel(item);
    const senderLabel = Helpers.auditSenderLabel(item);

    return `
      <div class="message-preview-item ${item.auditState}">
        <div class="message-preview-main">
          <div class="message-preview-heading">
            <span class="message-preview-status ${item.kind === "blocked" ? "blocked" : item.status}">${Helpers.escapeHtml(
              item.kind === "blocked"
                ? "Blocked"
                : Helpers.logStatusLabel(
                    item.status,
                    item.kind === "review" ? "Review required" : "Delivered",
                  ),
            )}</span>
            <span class="message-preview-sender">${Helpers.escapeHtml(
              item.transportDirection === "sent"
                ? `To ${recipientLabel}`
                : `From ${senderLabel}`,
            )}</span>
          </div>
          <span class="message-preview-text">${Helpers.escapeHtml(
            Helpers.truncate(
              item.kind === "review"
                ? item.summary ||
                    item.messagePreview ||
                    item.previewText ||
                    "Message requires review before delivery."
                : item.kind === "blocked"
                  ? item.reason || item.summary || "Message blocked by policy."
                  : item.previewText || item.messageText || "(no content)",
              120,
            ),
          )}</span>
          <div class="message-preview-meta">
            <span class="message-preview-selector">${Helpers.escapeHtml(
              Helpers.selectorSummary(item.selectors),
            )}</span>
            ${
              item.senderAgent
                ? `<span class="message-preview-meta-chip">Via ${Helpers.escapeHtml(item.senderAgent)}</span>`
                : ""
            }
          </div>
        </div>
        <span class="message-preview-time">${Helpers.escapeHtml(new Date(item.timestamp).toLocaleDateString())}</span>
      </div>
    `;
  },

  renderOverviewAskAroundItem(thread) {
    const repliedLabels = thread.targets
      .filter((target) => Helpers.askAroundTargetFinalState(target) === "replied")
      .map((target) => target.label);
    const noGroundedLabels = thread.targets
      .filter(
        (target) =>
          Helpers.askAroundTargetFinalState(target) === "no_grounded_answer",
      )
      .map((target) => target.label);
    const waitingLabels = thread.targets
      .filter((target) => Helpers.askAroundTargetFinalState(target) === "no_reply")
      .map((target) => target.label);
    const readyLabels = thread.targets
      .filter((target) => target.readyAtAsk === true)
      .map((target) => target.label);
    const notReadyLabels = thread.targets
      .filter((target) => target.readyAtAsk === false)
      .map((target) => target.label);
    const constrainedLabels = thread.targets
      .filter((target) =>
        ["approval_pending", "review_required", "blocked"].includes(
          Helpers.askAroundTargetFinalState(target),
        ),
      )
      .map((target) => Helpers.askAroundConstraintLabel(target));
    const metaChips = [
      readyLabels.length
        ? `Ready: ${Helpers.formatLabelList(readyLabels, 2)}`
        : null,
      notReadyLabels.length
        ? `Not ready: ${Helpers.formatLabelList(notReadyLabels, 2)}`
        : null,
      repliedLabels.length
        ? `Replies: ${Helpers.formatLabelList(repliedLabels, 2)}`
        : null,
      noGroundedLabels.length
        ? `No grounded: ${Helpers.formatLabelList(noGroundedLabels, 2)}`
        : null,
      waitingLabels.length
        ? `No reply: ${Helpers.formatLabelList(waitingLabels, 2)}`
        : null,
      constrainedLabels.length
        ? `Held: ${Helpers.formatLabelList(constrainedLabels, 2)}`
        : null,
      thread.unattributedReplies.length
        ? `Unattributed: ${Helpers.formatLabelList(
            thread.unattributedReplies.map((reply) => reply.sender),
            2,
          )}`
        : null,
    ]
      .filter(Boolean);
    const targetLabel =
      thread.kind === "group" && thread.groupLabel
        ? `Group ${thread.groupLabel}`
        : `Asked ${Helpers.pluralize(thread.targetCount || 0, "contact")}`;

    return `
      <div class="message-preview-item ask-around">
        <div class="message-preview-main">
          <div class="message-preview-heading">
            <span class="message-preview-status ask_around">Ask-around</span>
            <span class="message-preview-sender">${Helpers.escapeHtml(targetLabel)}</span>
          </div>
          <span class="message-preview-text">${Helpers.escapeHtml(
            Helpers.truncate(
              thread.questionPreview || "Mahilo ask-around activity",
              120,
            ),
          )}</span>
          <p class="message-preview-thread-copy">${Helpers.escapeHtml(
            Helpers.askAroundThreadSummaryLine(thread),
          )}</p>
          <div class="message-preview-meta">
            ${metaChips
              .map(
                (chip) => `
                  <span class="message-preview-meta-chip">${Helpers.escapeHtml(chip)}</span>
                `,
              )
              .join("")}
          </div>
        </div>
        <span class="message-preview-time">${Helpers.escapeHtml(new Date(thread.latestTimestamp).toLocaleDateString())}</span>
      </div>
    `;
  },

  renderOverviewAuditCues(items = State.auditLog) {
    const container = document.getElementById("overview-audit-cues");
    if (!container) {
      return;
    }

    const counts = Helpers.auditCounts(items);
    const threadSummary = Helpers.askAroundThreadSummary(items);
    const askAroundCounts = threadSummary.counts || {
      noGrounded: 0,
      waiting: 0,
    };

    container.innerHTML = `
      <div class="overview-audit-pill review_required">
        <span class="overview-audit-value">${counts.reviewRequired}</span>
        <span class="overview-audit-label">Review required</span>
      </div>
      <div class="overview-audit-pill approval_pending">
        <span class="overview-audit-value">${counts.approvalPending}</span>
        <span class="overview-audit-label">Approval pending</span>
      </div>
      <div class="overview-audit-pill blocked">
        <span class="overview-audit-value">${counts.blocked}</span>
        <span class="overview-audit-label">Blocked</span>
      </div>
      <div class="overview-audit-pill ask_around">
        <span class="overview-audit-value">${threadSummary.threadIds.size}</span>
        <span class="overview-audit-label">Ask-around</span>
      </div>
      <div class="overview-audit-pill waiting">
        <span class="overview-audit-value">${askAroundCounts.waiting}</span>
        <span class="overview-audit-label">No reply yet</span>
      </div>
      <div class="overview-audit-pill no_grounded">
        <span class="overview-audit-value">${askAroundCounts.noGrounded}</span>
        <span class="overview-audit-label">No grounded</span>
      </div>
    `;
  },

  renderOverviewMessages() {
    const list = document.getElementById("overview-message-list");
    if (!list) {
      return;
    }

    this.renderOverviewReadiness();
    this.renderOverviewAuditCues(State.auditLog);
    const activities = Helpers.overviewActivityFeed(State.auditLog).slice(0, 5);

    if (!activities.length) {
      list.innerHTML = `
        <div class="empty-state small" style="padding: 40px 20px;">
          <div class="empty-icon" style="font-size: 3rem; margin-bottom: 16px;">📨</div>
          <p style="font-weight: 700; color: var(--color-text); margin-bottom: 8px;">No delivery activity yet</p>
          <p class="hint" style="font-size: 0.9rem;">Send a message or ask around to start your audit trail.</p>
        </div>
      `;
      return;
    }

    list.innerHTML = activities
      .map((activity) =>
        activity.kind === "ask-around"
          ? this.renderOverviewAskAroundItem(activity.thread)
          : this.renderOverviewAuditItem(activity.item),
      )
      .join("");
  },

  renderProfile() {
    const user = State.user;
    if (!user) return;

    document.getElementById("profile-avatar").textContent = (
      user.display_name?.[0] ||
      user.username?.[0] ||
      "U"
    ).toUpperCase();
    document.getElementById("profile-username").textContent = user.username;
    document.getElementById("profile-display-name").textContent =
      user.display_name || user.username;
    document.getElementById("profile-agent-count").textContent =
      State.agents.length;
  },

  // Toast notifications
  showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;

    const icons = {
      success: "✅",
      error: "❌",
      warning: "⚠️",
      info: "ℹ️",
    };

    toast.innerHTML = `
      <span class="toast-icon">${icons[type]}</span>
      <div class="toast-content">
        <div class="toast-title">${type.charAt(0).toUpperCase() + type.slice(1)}</div>
        <div class="toast-message">${message}</div>
      </div>
      <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
    `;

    container.appendChild(toast);

    // Auto remove
    setTimeout(() => {
      toast.classList.add("hiding");
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  },

  // Update WebSocket status
  updateWSStatus(status) {
    const dot = document.getElementById("ws-dot");
    const text = document.getElementById("ws-text");

    dot.className = "ws-dot";

    switch (status) {
      case "connected":
        dot.classList.add("connected");
        text.textContent = "Live";
        break;
      case "connecting":
        dot.classList.add("connecting");
        text.textContent = "Connecting...";
        break;
      case "error":
      case "disconnected":
        dot.classList.add("error");
        text.textContent = "Offline";
        break;
    }
  },

  // Show notification dot
  showNotificationDot() {
    document.getElementById("notification-dot").classList.remove("hidden");
  },

  hideNotificationDot() {
    document.getElementById("notification-dot").classList.add("hidden");
  },

  // Copy to clipboard
  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      this.showToast("Copied to clipboard!", "success");
    } catch (err) {
      // Fallback
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      this.showToast("Copied to clipboard!", "success");
    }
  },
};

// ========================================
// Initialize App
// ========================================
document.addEventListener("DOMContentLoaded", () => {
  UI.init();
});

// Expose UI for onclick handlers
if (
  typeof globalThis !== "undefined" &&
  globalThis.__MAHILO_DASHBOARD_TEST_HOOKS__
) {
  globalThis.__MAHILO_DASHBOARD__ = {
    Helpers,
    Normalizers,
    State,
    UI,
  };
}

window.UI = UI;
