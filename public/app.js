/**
 * Mahilo Dashboard - Main Application
 * Soft, squishy 3D game UI for agent management
 */

// ========================================
// Configuration
// ========================================
const APP_ORIGIN =
  typeof window !== 'undefined' &&
  window.location.origin &&
  window.location.origin !== 'null'
    ? window.location.origin
    : 'https://mahilo.io';
const WS_ORIGIN = APP_ORIGIN.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');

const CONFIG = {
  API_URL: `${APP_ORIGIN}/api/v1`,
  WS_URL: `${WS_ORIGIN}/api/v1/notifications/ws`,

  STORAGE_KEY: 'mahilo_session',
  PING_INTERVAL: 30000,
};

// ========================================
// State Management
// ========================================
const State = {
  user: null,
  apiKey: null,
  ws: null,
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
  reviewQueue: null,
  blockedEvents: [],
  blockedEventsById: new Map(),
  blockedEventRetention: null,
  preferences: null,
  conversations: new Map(),
  currentView: 'overview',
  selectedChat: null,
  wsConnected: false,
  notifications: [],

  // Initialize state from localStorage
  init() {
    const session = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (session) {
      try {
        const data = JSON.parse(session);
        this.apiKey = typeof data.apiKey === 'string' ? data.apiKey : null;
        this.user = Normalizers.user(data.user);
        return Boolean(this.apiKey && this.user);
      } catch (e) {
        console.error('Failed to parse session:', e);
      }
    }
    return false;
  },

  // Save state to localStorage
  save() {
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

    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({
      apiKey: this.apiKey,
      user,
    }));
  },

  // Clear state
  clear() {
    this.user = null;
    this.apiKey = null;
    this.agents = [];
    this.agentsById = new Map();
    this.friends = [];
    this.friendsById = new Map();
    this.groups = [];
    this.groupsById = new Map();
    this.messages = [];
    this.messagesById = new Map();
    this.policies = [];
    this.policiesById = new Map();
    this.reviews = [];
    this.reviewsById = new Map();
    this.reviewQueue = null;
    this.blockedEvents = [];
    this.blockedEventsById = new Map();
    this.blockedEventRetention = null;
    this.preferences = null;
    this.conversations = new Map();
    this.currentView = 'overview';
    this.selectedChat = null;
    this.wsConnected = false;
    localStorage.removeItem(CONFIG.STORAGE_KEY);
  },
};

// ========================================
// API Client
// ========================================
const API = {
  // Make authenticated API request
  async request(endpoint, options = {}) {
    const url = `${CONFIG.API_URL}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (State.apiKey) {
      headers['Authorization'] = `Bearer ${State.apiKey}`;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || data?.message || `HTTP ${response.status}`);
      }

      return data;
    } catch (error) {
      console.error('API Error:', error);
      throw error;
    }
  },

  // Auth endpoints
  auth: {
    async register(username, displayName) {
      return API.request('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, display_name: displayName }),
      });
    },

    async me() {
      return API.request('/auth/me');
    },

    async rotateKey() {
      return API.request('/auth/rotate-key', { method: 'POST' });
    },
  },

  // Waitlist endpoint
  waitlist: {
    async join(email) {
      return API.request('/waitlist', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
    },
  },

  // Agent endpoints
  agents: {
    async list() {
      return API.request('/agents');
    },

    async register(agent) {
      return API.request('/agents', {
        method: 'POST',
        body: JSON.stringify(agent),
      });
    },

    async delete(id) {
      return API.request(`/agents/${id}`, { method: 'DELETE' });
    },

    async ping(id) {
      return API.request(`/agents/${id}/ping`, { method: 'POST' });
    },
  },

  // Friend endpoints
  friends: {
    async list(status = 'accepted') {
      return API.request(`/friends?status=${status}`);
    },

    async request(username) {
      return API.request('/friends/request', {
        method: 'POST',
        body: JSON.stringify({ username }),
      });
    },

    async accept(id) {
      return API.request(`/friends/${id}/accept`, { method: 'POST' });
    },

    async reject(id) {
      return API.request(`/friends/${id}/reject`, { method: 'POST' });
    },

    async block(id) {
      return API.request(`/friends/${id}/block`, { method: 'POST' });
    },

    async unfriend(id) {
      return API.request(`/friends/${id}`, { method: 'DELETE' });
    },
  },

  // Group endpoints
  groups: {
    async list() {
      return API.request('/groups');
    },

    async create(group) {
      return API.request('/groups', {
        method: 'POST',
        body: JSON.stringify(group),
      });
    },

    async get(id) {
      return API.request(`/groups/${id}`);
    },

    async invite(id, username) {
      return API.request(`/groups/${id}/invite`, {
        method: 'POST',
        body: JSON.stringify({ username }),
      });
    },

    async join(id) {
      return API.request(`/groups/${id}/join`, { method: 'POST' });
    },

    async leave(id) {
      return API.request(`/groups/${id}/leave`, { method: 'DELETE' });
    },

    async members(id) {
      return API.request(`/groups/${id}/members`);
    },
  },

  // Message endpoints
  messages: {
    async list(options = {}) {
      const params = new URLSearchParams();
      if (options.limit) params.append('limit', options.limit);
      if (options.direction) params.append('direction', options.direction);
      if (options.since) params.append('since', options.since);
      return API.request(`/messages?${params}`);
    },

    async send(message) {
      return API.request('/messages/send', {
        method: 'POST',
        body: JSON.stringify(message),
      });
    },
  },

  // Policy endpoints
  policies: {
    async list(scope) {
      const url = scope ? `/policies?scope=${scope}` : '/policies';
      return API.request(url);
    },

    async create(policy) {
      return API.request('/policies', {
        method: 'POST',
        body: JSON.stringify(policy),
      });
    },

    async update(id, updates) {
      return API.request(`/policies/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
    },

    async delete(id) {
      return API.request(`/policies/${id}`, { method: 'DELETE' });
    },
  },

  // Preferences endpoints
  preferences: {
    async get() {
      return API.request('/preferences');
    },

    async update(prefs) {
      return API.request('/preferences', {
        method: 'PATCH',
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
      if (options.status) params.append('status', options.status);
      if (options.direction) params.append('direction', options.direction);
      if (options.limit) params.append('limit', options.limit);
      const query = params.toString();
      return API.request(`/plugin/reviews${query ? `?${query}` : ''}`);
    },

    async blockedEvents(options = {}) {
      const params = new URLSearchParams();
      if (options.direction) params.append('direction', options.direction);
      if (options.limit) params.append('limit', options.limit);
      if (options.includePayloadExcerpt) {
        params.append('include_payload_excerpt', 'true');
      }
      const query = params.toString();
      return API.request(`/plugin/events/blocked${query ? `?${query}` : ''}`);
    },
  },
};

// ========================================
// Data Normalization
// ========================================
const Helpers = {
  isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

  nullableString(value) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length ? trimmed : null;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
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
            value.connection_id
        ) || null
      );
    }

    return this.nullableString(value);
  },

  participantType(value) {
    return this.isObject(value) ? this.nullableString(value.type) : null;
  },

  recipientLabel(value, recipientType = 'user') {
    if (recipientType === 'group') {
      if (typeof value === 'string') {
        return this.nullableString(value);
      }

      if (this.isObject(value)) {
        return this.nullableString(value.name ?? value.label);
      }

      return null;
    }

    return this.participantLabel(value);
  },

  string(value, fallback = '') {
    return this.nullableString(value) ?? fallback;
  },

  number(value, fallback = 0) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return fallback;
  },

  stringList(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.nullableString(item))
      .filter(Boolean);
  },

  iso(value) {
    const raw =
      value instanceof Date
        ? value.toISOString()
        : typeof value === 'string'
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
      return '';
    }

    if (typeof value === 'string') {
      return value;
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  },

  truncate(value, limit = 120) {
    const text = this.string(value);
    return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
  },

  timestampValue(value) {
    if (!value) {
      return 0;
    }

    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  },

  compareByTimestampDesc(left, right) {
    return this.timestampValue(right.timestamp || right.createdAt) - this.timestampValue(left.timestamp || left.createdAt);
  },

  compareByTimestampAsc(left, right) {
    return this.timestampValue(left.timestamp || left.createdAt) - this.timestampValue(right.timestamp || right.createdAt);
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
      items: ids
        .map((id) => byId.get(id))
        .filter(Boolean),
    };
  },

  mergeCollectionModels(models, getId = (item) => item?.id) {
    return this.collectionModel(
      models.flatMap((model) => (Array.isArray(model?.items) ? model.items : [])),
      getId
    );
  },

  applyCollectionState(stateKey, indexKey, model) {
    State[stateKey] = Array.isArray(model?.items) ? model.items : [];
    State[indexKey] = model?.byId instanceof Map ? model.byId : new Map();
  },

  normalizeTransportDirection(record, currentUsername) {
    const sender = this.participantLabel(record.sender);
    const recipient = this.participantLabel(record.recipient);
    const queueDirection = this.nullableString(record.queue_direction);
    const normalizedCurrentUser = currentUsername?.toLowerCase() || null;

    if (queueDirection === 'outbound') {
      return 'sent';
    }

    if (queueDirection === 'inbound') {
      return 'received';
    }

    if (normalizedCurrentUser && sender?.toLowerCase() === normalizedCurrentUser) {
      return 'sent';
    }

    if (normalizedCurrentUser && recipient?.toLowerCase() === normalizedCurrentUser) {
      return 'received';
    }

    if (sender && !recipient) {
      return 'received';
    }

    if (recipient && !sender) {
      return 'sent';
    }

    return 'sent';
  },

  buildConversations(messages) {
    const threads = new Map();

    messages
      .filter((message) => message.kind === 'message' && message.counterpart)
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
        : message
    );

    State.messages = Array.from(State.messagesById.values()).sort((left, right) =>
      this.compareByTimestampDesc(left, right)
    );
    this.rebuildConversations();
  },

  logFeed(messages, reviews, blockedEvents, direction = 'all') {
    return [...messages, ...reviews, ...blockedEvents]
      .filter((item) => {
        if (direction === 'all') {
          return true;
        }
        return item.transportDirection === direction;
      })
      .sort((left, right) => this.compareByTimestampDesc(left, right));
  },
};

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
      display_name: Helpers.nullableString(record.display_name ?? record.displayName),
      created_at: Helpers.iso(record.created_at ?? record.createdAt),
      registration_source: Helpers.nullableString(record.registration_source ?? record.registrationSource),
      status: Helpers.nullableString(record.status),
      verified: Boolean(record.verified),
      verified_at: Helpers.iso(record.verified_at ?? record.verifiedAt),
      raw: value,
    };
  },

  agents(value) {
    return Helpers.collection(value, ['agents', 'connections', 'items'])
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

    return {
      id,
      label: Helpers.string(record.label, id),
      framework: Helpers.string(record.framework, 'unknown'),
      description: Helpers.nullableString(record.description),
      capabilities: Helpers.stringList(record.capabilities),
      routingPriority: Helpers.number(record.routing_priority ?? record.routingPriority, 0),
      callbackUrl: Helpers.nullableString(record.callback_url ?? record.callbackUrl),
      publicKey: Helpers.nullableString(record.public_key ?? record.publicKey),
      publicKeyAlg: Helpers.nullableString(record.public_key_alg ?? record.publicKeyAlg),
      status: Helpers.string(record.status, 'unknown'),
      lastSeen: Helpers.iso(record.last_seen ?? record.lastSeen),
      createdAt: Helpers.iso(record.created_at ?? record.createdAt),
      raw: value,
    };
  },

  friends(value) {
    return Helpers.collection(value, ['friends', 'items', 'results', 'data'])
      .map((entry) => this.friend(entry))
      .filter(Boolean);
  },

  friendsModel(value) {
    return Helpers.collectionModel(this.friends(value), (friend) => friend.friendshipId);
  },

  friend(value) {
    const record = Helpers.record(value);
    const friendshipId = Helpers.nullableString(record.friendship_id ?? record.id);

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
      status: Helpers.string(record.status, 'pending'),
      direction: Helpers.string(record.direction, 'received'),
      since: Helpers.iso(record.since ?? record.created_at ?? record.createdAt),
      roles: Helpers.stringList(record.roles),
      interactionCount: Helpers.number(record.interaction_count ?? record.interactionCount, 0),
      raw: value,
    };
  },

  groups(value) {
    return Helpers.collection(value, ['groups', 'items', 'results', 'data'])
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

  messages(value, options = {}) {
    return Helpers.collection(value, ['messages', 'items', 'results', 'data'])
      .map((entry) => this.message(entry, options))
      .filter(Boolean)
      .sort((left, right) => Helpers.compareByTimestampDesc(left, right));
  },

  messagesModel(value, options = {}) {
    return Helpers.collectionModel(this.messages(value, options), (message) => message.id);
  },

  message(value, options = {}) {
    const record = Helpers.record(value);
    const timestamp =
      Helpers.iso(record.created_at ?? record.timestamp ?? record.delivered_at ?? record.createdAt) ||
      new Date().toISOString();
    const transportDirection = Helpers.normalizeTransportDirection(record, options.currentUsername);
    const sender =
      Helpers.participantLabel(record.sender) ||
      (transportDirection === 'sent' ? options.currentUsername : null) ||
      'Unknown sender';
    const recipientType =
      Helpers.nullableString(record.recipient_type) ||
      Helpers.participantType(record.recipient) ||
      'user';
    const recipient =
      Helpers.recipientLabel(record.recipient, recipientType) ||
      (recipientType === 'group' ? 'Group conversation' : options.currentUsername) ||
      'Unknown recipient';
    const id =
      Helpers.nullableString(record.id ?? record.message_id) ||
      `message_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const messageText = Helpers.contentText(
      record.message ?? record.payload ?? record.message_preview ?? record.stored_payload_excerpt
    );
    const counterpart = transportDirection === 'sent' ? recipient : sender;
    const status = Helpers.string(record.status ?? record.delivery_status, 'pending');

    return {
      kind: 'message',
      id,
      messageId: Helpers.string(record.message_id ?? record.id, id),
      senderId: Helpers.nullableString(
        record.sender_user_id ?? record.sender?.user_id ?? record.sender?.id
      ),
      sender,
      recipientId: Helpers.nullableString(
        record.recipient_id ?? record.recipient?.user_id ?? record.recipient?.id
      ),
      recipient,
      recipientType,
      transportDirection,
      isSent: transportDirection === 'sent',
      counterpart,
      counterpartLabel: counterpart || (transportDirection === 'sent' ? recipient : sender),
      status,
      deliveryStatus: Helpers.string(record.delivery_status, status),
      timestamp,
      createdAt: timestamp,
      deliveredAt: Helpers.iso(record.delivered_at ?? record.deliveredAt),
      messageText,
      previewText: Helpers.truncate(messageText, 120),
      context: Helpers.contentText(record.context ?? record.context_preview),
      senderAgent: Helpers.nullableString(
        record.sender_agent ?? record.sender?.agent ?? record.sender?.label
      ),
      senderConnectionId: Helpers.nullableString(
        record.sender_connection_id ?? record.sender?.connection_id ?? record.sender?.id
      ),
      recipientConnectionId: Helpers.nullableString(
        record.recipient_connection_id ?? record.recipient?.connection_id ?? record.recipient?.id
      ),
      correlationId: Helpers.nullableString(record.correlation_id),
      selectors: {
        direction: Helpers.nullableString(
          record.direction ?? record.selectors?.direction ?? record.classified_direction
        ),
        resource: Helpers.nullableString(
          record.resource ?? record.selectors?.resource ?? record.classified_resource
        ),
        action: Helpers.nullableString(
          record.action ?? record.selectors?.action ?? record.classified_action
        ),
      },
      replyPolicies: Helpers.isObject(record.reply_policies) ? record.reply_policies : null,
      raw: value,
    };
  },

  policies(value) {
    return Helpers.collection(value, ['policies', 'items', 'results', 'data'])
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

    const evaluator = Helpers.string(record.evaluator ?? record.policy_type, 'llm');

    return {
      id,
      scope: Helpers.string(record.scope, 'global'),
      targetId: Helpers.nullableString(record.target_id),
      direction: Helpers.string(record.direction, 'outbound'),
      resource: Helpers.string(record.resource, 'message.general'),
      action: Helpers.nullableString(record.action) || 'share',
      effect: Helpers.string(record.effect, 'deny'),
      evaluator,
      policyType: evaluator,
      content: record.policy_content,
      contentText: Helpers.contentText(record.policy_content),
      priority: Helpers.number(record.priority, 0),
      enabled: record.enabled !== false,
      source: Helpers.nullableString(record.source),
      createdAt: Helpers.iso(record.created_at ?? record.createdAt),
      raw: value,
    };
  },

  preferences(value) {
    const record = Helpers.record(value);
    const quietHours = Helpers.record(record.quiet_hours ?? record.quietHours);

    return {
      preferredChannel: Helpers.nullableString(
        record.preferred_channel ?? record.preferredChannel
      ),
      urgentBehavior: Helpers.string(
        record.urgent_behavior ?? record.urgentBehavior,
        'preferred_only'
      ),
      quietHours: {
        enabled: Boolean(quietHours.enabled),
        start: Helpers.string(quietHours.start, '22:00'),
        end: Helpers.string(quietHours.end, '07:00'),
        timezone: Helpers.string(quietHours.timezone, 'UTC'),
      },
      defaultLlmProvider: Helpers.nullableString(
        record.default_llm_provider ?? record.defaultLlmProvider
      ),
      defaultLlmModel: Helpers.nullableString(
        record.default_llm_model ?? record.defaultLlmModel
      ),
      raw: value,
    };
  },

  reviews(value) {
    return Helpers.collection(value, ['reviews', 'items', 'results', 'data'])
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

    const queueDirection = Helpers.string(record.queue_direction, 'outbound');
    const transportDirection = queueDirection === 'inbound' ? 'received' : 'sent';

    return {
      kind: 'review',
      id,
      reviewId: id,
      messageId: Helpers.nullableString(record.message_id) || id,
      queueDirection,
      transportDirection,
      status: Helpers.string(record.status, 'approval_pending'),
      decision: Helpers.string(record.decision, 'ask'),
      deliveryMode: Helpers.nullableString(record.delivery_mode),
      summary: Helpers.string(record.summary, 'Message requires review before delivery.'),
      reasonCode: Helpers.nullableString(record.reason_code),
      timestamp: Helpers.iso(record.created_at ?? record.timestamp) || new Date().toISOString(),
      messagePreview: Helpers.contentText(record.message_preview),
      contextPreview: Helpers.contentText(record.context_preview),
      sender: Helpers.participantLabel(record.sender) || 'Unknown sender',
      recipient:
        Helpers.recipientLabel(
          record.recipient,
          Helpers.participantType(record.recipient) || 'user'
        ) ||
        (Helpers.participantType(record.recipient) === 'group'
          ? 'Group conversation'
          : 'Unknown recipient'),
      selectors: {
        direction: Helpers.nullableString(record.selectors?.direction),
        resource: Helpers.nullableString(record.selectors?.resource),
        action: Helpers.nullableString(record.selectors?.action),
      },
      raw: value,
    };
  },

  blockedEvents(value) {
    return Helpers.collection(value, ['blocked_events', 'items', 'results', 'data'])
      .map((entry) => this.blockedEvent(entry))
      .filter(Boolean);
  },

  blockedEventsModel(value) {
    return Helpers.collectionModel(this.blockedEvents(value), (blockedEvent) => blockedEvent.id);
  },

  blockedEventRetention(value) {
    const record = Helpers.record(Helpers.record(value).retention);

    return {
      blockedEventLog: Helpers.nullableString(record.blocked_event_log),
      payloadExcerptDefault: Helpers.nullableString(record.payload_excerpt_default),
      payloadExcerptIncluded: Boolean(record.payload_excerpt_included),
      payloadHashAlgorithm: Helpers.nullableString(record.payload_hash_algorithm),
      sourceMessagePayload: Helpers.nullableString(record.source_message_payload),
      raw: record,
    };
  },

  blockedEvent(value) {
    const record = Helpers.record(value);
    const id = Helpers.nullableString(record.id ?? record.blocked_event_id);

    if (!id) {
      return null;
    }

    const queueDirection = Helpers.string(record.queue_direction, 'outbound');
    const transportDirection = queueDirection === 'inbound' ? 'received' : 'sent';

    return {
      kind: 'blocked',
      id,
      blockedEventId: id,
      messageId: Helpers.nullableString(record.message_id) || id,
      queueDirection,
      transportDirection,
      status: Helpers.string(record.status, 'rejected'),
      reason: Helpers.string(record.reason, 'Message blocked by policy.'),
      reasonCode: Helpers.nullableString(record.reason_code),
      timestamp: Helpers.iso(record.timestamp ?? record.created_at) || new Date().toISOString(),
      sender: Helpers.participantLabel(record.sender) || 'Unknown sender',
      recipient:
        Helpers.recipientLabel(
          record.recipient,
          Helpers.participantType(record.recipient) || 'user'
        ) ||
        (Helpers.participantType(record.recipient) === 'group'
          ? 'Group conversation'
          : 'Unknown recipient'),
      storedPayloadExcerpt: Helpers.contentText(record.stored_payload_excerpt),
      payloadHash: Helpers.nullableString(record.payload_hash),
      selectors: {
        direction: Helpers.nullableString(record.direction),
        resource: Helpers.nullableString(record.resource),
        action: Helpers.nullableString(record.action),
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
        console.log('WebSocket connected');
        State.wsConnected = true;
        this.reconnectAttempts = 0;
        UI.updateWSStatus('connected');
        this.startPing();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };

      this.ws.onclose = () => {
        console.log('WebSocket closed');
        State.wsConnected = false;
        UI.updateWSStatus('disconnected');
        this.stopPing();
        this.attemptReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        UI.updateWSStatus('error');
      };
    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      UI.updateWSStatus('error');
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
        this.ws.send(JSON.stringify({ type: 'ping' }));
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
      UI.updateWSStatus('connecting');
      setTimeout(() => this.connect(), 3000 * this.reconnectAttempts);
    }
  },

  handleMessage(data) {
    console.log('WebSocket message:', data);

    switch (data.type) {
      case 'connection':
        UI.showToast('Connected to real-time notifications', 'success');
        break;

      case 'message_received':
        this.handleNewMessage(data.data);
        break;

      case 'delivery_status':
        UI.showToast(`Message ${data.data.status}`, 'info');
        break;

      case 'friend_request':
        UI.showToast('New friend request received!', 'info');
        DataLoader.loadFriends();
        break;

      case 'group_invite':
        UI.showToast(`Invited to group!`, 'info');
        DataLoader.loadGroups();
        break;

      case 'pong':
        // Ping response, connection is alive
        break;

      default:
        console.log('Unknown event type:', data.type);
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
    UI.showToast(`New message from ${message.counterpartLabel}`, 'info');

    UI.renderOverviewMessages();
    UI.renderLogs();
    UI.renderConversations();
    UI.renderDevConversations();

    if (State.currentView === 'messages' && State.selectedChat === message.counterpart) {
      UI.renderChat(message.counterpart);
    }

    if (State.currentView === 'developer' && State.selectedChat === message.counterpart) {
      UI.renderDevChat(message.counterpart);
    }

    if (!State.selectedChat && message.counterpart) {
      if (State.currentView === 'messages') {
        UI.selectChat(message.counterpart);
      }
      if (State.currentView === 'developer') {
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
  async bootstrap() {
    const user = Normalizers.user(await API.auth.me());

    if (!user) {
      throw new Error('Unable to load the current user');
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
      this.loadGroups(),
      this.loadLogFeed(),
      this.loadPolicies(),
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
      Helpers.applyCollectionState('agents', 'agentsById', agentsModel);
      UI.updateAgentCount(State.agents.length);
      UI.renderAgents();
      UI.renderOverviewAgents();
    } catch (error) {
      console.error('Failed to load agents:', error);
    }
  },

  async loadFriends() {
    try {
      const [accepted, pending, blocked] = await Promise.all([
        API.friends.list('accepted'),
        API.friends.list('pending'),
        API.friends.list('blocked'),
      ]);

      const acceptedFriendsModel = Normalizers.friendsModel(accepted);
      const pendingFriendsModel = Normalizers.friendsModel(pending);
      const blockedFriendsModel = Normalizers.friendsModel(blocked);

      Helpers.applyCollectionState(
        'friends',
        'friendsById',
        Helpers.mergeCollectionModels(
          [acceptedFriendsModel, pendingFriendsModel, blockedFriendsModel],
          (friend) => friend.friendshipId
        )
      );
      UI.updateFriendCount(acceptedFriendsModel.items.length);
      UI.updatePendingCount(
        pendingFriendsModel.items.filter((friend) => friend.direction === 'received').length
      );
      UI.renderFriends();
      UI.renderOverviewFriends();
      UI.renderConversations();
      UI.renderDevConversations();
      if (State.selectedChat) {
        UI.renderChat(State.selectedChat);
        UI.renderDevChat(State.selectedChat);
      }
    } catch (error) {
      console.error('Failed to load friends:', error);
    }
  },

  async loadGroups() {
    try {
      const groupsModel = Normalizers.groupsModel(await API.groups.list());
      Helpers.applyCollectionState('groups', 'groupsById', groupsModel);
      UI.updateGroupCount(State.groups.length);
      UI.renderGroups();
      UI.renderOverviewGroups();
    } catch (error) {
      console.error('Failed to load groups:', error);
    }
  },

  async loadMessages() {
    try {
      const messagesModel = Normalizers.messagesModel(
        await API.messages.list({ limit: 50 }),
        {
          currentUsername: State.user?.username,
        }
      );
      Helpers.applyCollectionState('messages', 'messagesById', messagesModel);
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
      console.error('Failed to load messages:', error);
    }
  },

  async loadPolicies() {
    try {
      const policiesModel = Normalizers.policiesModel(await API.policies.list());
      Helpers.applyCollectionState('policies', 'policiesById', policiesModel);
      UI.renderPolicies();
    } catch (error) {
      console.error('Failed to load policies:', error);
    }
  },

  async loadPreferences() {
    try {
      State.preferences = Normalizers.preferences(await API.preferences.get());
      UI.renderSettings();
    } catch (error) {
      State.preferences = null;
      console.error('Failed to load preferences:', error);
    }
  },

  async loadReviewQueue() {
    try {
      const payload = await API.plugin.reviews({ limit: 25 });
      State.reviewQueue = Normalizers.reviewQueue(payload);
      const reviewsModel = Normalizers.reviewsModel(payload);
      Helpers.applyCollectionState('reviews', 'reviewsById', reviewsModel);
      UI.renderLogs();
    } catch (error) {
      State.reviewQueue = null;
      State.reviews = [];
      State.reviewsById = new Map();
      console.error('Failed to load review queue:', error);
    }
  },

  async loadBlockedEvents() {
    try {
      const payload = await API.plugin.blockedEvents({ limit: 25 });
      State.blockedEventRetention = Normalizers.blockedEventRetention(payload);
      const blockedEventsModel = Normalizers.blockedEventsModel(payload);
      Helpers.applyCollectionState(
        'blockedEvents',
        'blockedEventsById',
        blockedEventsModel
      );
      UI.renderLogs();
    } catch (error) {
      State.blockedEventRetention = null;
      State.blockedEvents = [];
      State.blockedEventsById = new Map();
      console.error('Failed to load blocked events:', error);
    }
  },
};

// ========================================
// UI Manager
// ========================================
const UI = {
  // Initialize UI
  init() {
    this.bindEvents();
    this.checkAuth();
  },

  // Check authentication status
  async checkAuth() {
    if (State.init()) {
      try {
        await DataLoader.bootstrap();
        WebSocketManager.connect();
      } catch (error) {
        console.error('Failed to resume dashboard session:', error);
        State.clear();
        this.showLanding();
        this.showToast('Session expired. Please authenticate again.', 'error');
      }
    } else {
      this.showLanding();
    }
  },

  // Bind all event listeners
  bindEvents() {
    // Login form (may not exist if landing page replaced auth screen)
    document.getElementById('login-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleLogin();
    });

    // Register form (may not exist if landing page replaced auth screen)
    document.getElementById('register-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleRegister();
    });

    // Toggle password
    document.querySelector('.toggle-password')?.addEventListener('click', (e) => {
      const input = document.getElementById('login-api-key');
      input.type = input.type === 'password' ? 'text' : 'password';
      e.target.textContent = input.type === 'password' ? '👁️' : '🙈';
    });

    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const view = e.currentTarget.dataset.view;
        this.switchView(view);
      });
    });

    // User menu
    document.getElementById('user-menu-btn').addEventListener('click', () => {
      this.showModal('user-profile-modal');
      this.renderProfile();
    });

    // Modal close buttons
    document.querySelectorAll('.modal-close, [data-close]').forEach(btn => {
      btn.addEventListener('click', () => this.hideModals());
    });

    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hideModals();
    });

    // Add agent buttons
    document.getElementById('add-agent-btn')?.addEventListener('click', () => {
      this.showModal('add-agent-modal');
    });

    document.getElementById('add-agent-quick')?.addEventListener('click', () => {
      this.showModal('add-agent-modal');
    });

    document.getElementById('add-first-agent')?.addEventListener('click', () => {
      this.showModal('add-agent-modal');
    });

    // Save agent
    document.getElementById('save-agent-btn')?.addEventListener('click', () => {
      this.handleSaveAgent();
    });

    // Find friends
    document.getElementById('find-users-btn')?.addEventListener('click', () => {
      this.openAddFriendModal();
    });

    document.getElementById('find-friends-quick')?.addEventListener('click', () => {
      this.switchView('friends');
      this.openAddFriendModal();
    });

    document.getElementById('add-friend-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleAddFriendRequest();
    });

    document.getElementById('send-friend-request-btn')?.addEventListener('click', () => {
      this.handleAddFriendRequest();
    });

    // Create group
    document.getElementById('create-group-btn')?.addEventListener('click', () => {
      this.showModal('create-group-modal');
    });

    document.getElementById('create-first-group')?.addEventListener('click', () => {
      this.showModal('create-group-modal');
    });

    document.getElementById('save-group-btn')?.addEventListener('click', () => {
      this.handleCreateGroup();
    });

    // Create policy
    document.getElementById('create-policy-btn')?.addEventListener('click', () => {
      this.showModal('create-policy-modal');
    });

    document.getElementById('create-first-policy')?.addEventListener('click', () => {
      this.showModal('create-policy-modal');
    });

    document.getElementById('save-policy-btn')?.addEventListener('click', () => {
      this.handleCreatePolicy();
    });

    // Policy scope change
    document.getElementById('policy-scope')?.addEventListener('change', (e) => {
      const targetGroup = document.getElementById('policy-target-group');
      if (e.target.value === 'global') {
        targetGroup.classList.add('hidden');
      } else {
        targetGroup.classList.remove('hidden');
        this.populatePolicyTargets(e.target.value);
      }
    });

    // Friend filters
    document.querySelectorAll('.friends-filters .filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.friends-filters .filter-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        this.renderFriends(e.target.dataset.filter);
      });
    });

    // Policy filters
    document.querySelectorAll('.policy-filters .filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.policy-filters .filter-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        this.renderPolicies(e.target.dataset.scope);
      });
    });

    // Refresh agents
    document.getElementById('refresh-agents')?.addEventListener('click', () => {
      DataLoader.loadAgents();
      this.showToast('Agents refreshed', 'success');
    });

    // View all messages (logs)
    document.getElementById('view-all-messages')?.addEventListener('click', () => {
      this.switchView('logs');
    });

    // Refresh logs
    document.getElementById('refresh-logs-btn')?.addEventListener('click', () => {
      DataLoader.loadLogFeed();
      this.showToast('Logs refreshed', 'success');
    });

    // Logs filters
    document.querySelectorAll('.logs-filters .filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.logs-filters .filter-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        this.renderLogs(e.target.dataset.direction);
      });
    });

    // Logout
    document.getElementById('logout-btn')?.addEventListener('click', () => {
      this.handleLogout();
    });

    // Save preferences
    document.getElementById('save-preferences-btn')?.addEventListener('click', () => {
      this.handleSavePreferences();
    });

    document.getElementById('notifications-btn')?.addEventListener('click', () => {
      this.switchView('logs');
      this.hideNotificationDot();
    });

    // Quiet hours toggle
    document.getElementById('pref-quiet-enabled')?.addEventListener('change', (e) => {
      const row = document.getElementById('quiet-hours-row');
      row.classList.toggle('hidden', !e.target.checked);
    });

    // Rotate API key
    document.getElementById('rotate-api-key-btn')?.addEventListener('click', () => {
      this.handleRotateKey();
    });

    // Copy buttons
    document.getElementById('copy-api-key')?.addEventListener('click', () => {
      this.copyToClipboard(document.getElementById('new-api-key').textContent);
    });

    document.getElementById('copy-callback-secret')?.addEventListener('click', () => {
      this.copyToClipboard(document.getElementById('new-callback-secret').textContent);
    });

    // Send test message (developer)
    document.getElementById('send-message-btn')?.addEventListener('click', () => {
      this.handleSendMessage();
    });

    document.getElementById('chat-input')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.handleSendMessage();
    });

    document.getElementById('dev-send-message-btn')?.addEventListener('click', () => {
      this.handleSendTestMessage();
    });

    document.getElementById('dev-chat-input')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.handleSendTestMessage();
    });

    // Developer API key actions
    document.getElementById('dev-copy-api-key')?.addEventListener('click', () => {
      this.copyToClipboard(State.apiKey);
    });

    document.getElementById('dev-rotate-api-key')?.addEventListener('click', () => {
      this.handleRotateKey();
    });

    // Landing page: hamburger menu
    document.getElementById('landing-hamburger')?.addEventListener('click', () => {
      document.getElementById('landing-mobile-menu')?.classList.toggle('open');
    });

    // Landing page: close mobile menu on link click
    document.querySelectorAll('.landing-mobile-link').forEach(link => {
      link.addEventListener('click', () => {
        document.getElementById('landing-mobile-menu')?.classList.remove('open');
      });
    });

    // Landing page: waitlist form
    document.getElementById('waitlist-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleWaitlistSubmit();
    });

    // Landing page: smooth scroll for nav links
    document.querySelectorAll('.landing-nav a[href^="#"], .hero-cta[href^="#"]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const target = document.querySelector(link.getAttribute('href'));
        if (target) target.scrollIntoView({ behavior: 'smooth' });
        document.getElementById('landing-mobile-menu')?.classList.remove('open');
      });
    });
  },

  // Handle login
  async handleLogin() {
    const apiKeyInput = document.getElementById('login-api-key');
    if (!apiKeyInput) {
      this.showToast('Dashboard login inputs are not available on this page.', 'error');
      return;
    }

    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      this.showToast('Please enter your API key', 'error');
      return;
    }

    State.apiKey = apiKey;
    
    try {
      const user = await API.auth.me();
      State.user = Normalizers.user(user);
      if (!State.user) {
        throw new Error('Failed to load current user');
      }
      State.save();
      
      this.showDashboard();
      await DataLoader.loadAll();
      WebSocketManager.connect();
      this.showToast('Welcome back!', 'success');
    } catch (error) {
      State.apiKey = null;
      State.user = null;
      this.showToast('Invalid API key', 'error');
    }
  },

  async handleRegister() {
    this.showToast(
      'Browser signup is not part of the active dashboard flow. Register through your agent with an invite token, then come back here.',
      'info'
    );
  },

  // Handle save preferences
  async handleSavePreferences() {
    const prefs = {
      preferred_channel: document.getElementById('pref-channel').value || null,
      urgent_behavior: document.getElementById('pref-urgent').value,
      quiet_hours: {
        enabled: document.getElementById('pref-quiet-enabled').checked,
        start: document.getElementById('pref-quiet-start').value,
        end: document.getElementById('pref-quiet-end').value,
        timezone: document.getElementById('pref-quiet-timezone').value,
      },
      default_llm_provider: document.getElementById('pref-llm-provider').value || null,
      default_llm_model: document.getElementById('pref-llm-model').value || null,
    };

    try {
      await API.preferences.update(prefs);
      this.showToast('Settings saved successfully', 'success');
    } catch (error) {
      this.showToast(error.message || 'Failed to save settings', 'error');
    }
  },

  // Handle logout
  handleLogout() {
    WebSocketManager.disconnect();
    State.clear();
    this.hideModals();
    this.showLanding();
    this.showToast('Logged out successfully', 'success');
  },

  // Handle waitlist form submission
  async handleWaitlistSubmit() {
    const emailInput = document.getElementById('waitlist-email');
    const submitBtn = document.getElementById('waitlist-submit-btn');
    const btnText = submitBtn.querySelector('.waitlist-btn-text');
    const btnLoading = submitBtn.querySelector('.waitlist-btn-loading');
    const btnSuccess = submitBtn.querySelector('.waitlist-btn-success');
    const email = emailInput.value.trim();

    if (!email) return;

    // Show loading
    btnText.classList.add('hidden');
    btnLoading.classList.remove('hidden');
    submitBtn.disabled = true;

    try {
      await API.waitlist.join(email);

      // Show success
      btnLoading.classList.add('hidden');
      btnSuccess.classList.remove('hidden');

      // Hide form, show confirmation
      setTimeout(() => {
        document.getElementById('waitlist-form').classList.add('hidden');
        document.getElementById('waitlist-confirmation').classList.remove('hidden');
      }, 800);
    } catch (error) {
      // Reset button
      btnLoading.classList.add('hidden');
      btnText.classList.remove('hidden');
      submitBtn.disabled = false;
      this.showToast(error.message || 'Something went wrong. Try again.', 'error');
    }
  },

  // Handle rotate API key
  async handleRotateKey() {
    try {
      const result = await API.auth.rotateKey();
      State.apiKey = result.api_key;
      State.save();
      
      document.getElementById('new-api-key').textContent = result.api_key;
      this.hideModals();
      this.showModal('api-key-modal');
      
      // Reconnect WebSocket with new key
      WebSocketManager.disconnect();
      WebSocketManager.connect();
      
      this.showToast('API key rotated successfully', 'success');
    } catch (error) {
      this.showToast('Failed to rotate API key', 'error');
    }
  },

  // Handle save agent
  async handleSaveAgent() {
    const framework = document.getElementById('agent-framework').value;
    const label = document.getElementById('agent-label').value.trim();
    const description = document.getElementById('agent-description').value.trim();
    const callbackUrl = document.getElementById('agent-callback').value.trim();
    const publicKey = document.getElementById('agent-public-key').value.trim();
    const capabilitiesStr = document.getElementById('agent-capabilities').value.trim();

    if (!framework || !label || !callbackUrl) {
      this.showToast('Please fill in all required fields', 'error');
      return;
    }

    const capabilities = capabilitiesStr
      ? capabilitiesStr.split(',').map(c => c.trim()).filter(Boolean)
      : [];

    try {
      const result = await API.agents.register({
        framework,
        label,
        description,
        callback_url: callbackUrl,
        public_key: publicKey || undefined,
        public_key_alg: publicKey ? 'ed25519' : undefined,
        capabilities,
      });

      this.hideModals();
      
      // Show callback secret if new
      if (result.callback_secret) {
        document.getElementById('new-callback-secret').textContent = result.callback_secret;
        this.showModal('callback-secret-modal');
      }

      // Reset form
      document.getElementById('add-agent-form').reset();
      
      // Reload agents
      await DataLoader.loadAgents();
      
      this.showToast(
        result.updated ? 'Agent updated successfully' : 'Agent registered successfully',
        'success'
      );
    } catch (error) {
      this.showToast(error.message || 'Failed to save agent', 'error');
    }
  },

  // Handle create group
  async handleCreateGroup() {
    const name = document.getElementById('group-name').value.trim();
    const description = document.getElementById('group-description').value.trim();
    const inviteOnly = document.getElementById('group-invite-only').checked;

    if (!name) {
      this.showToast('Please enter a group name', 'error');
      return;
    }

    try {
      await API.groups.create({
        name,
        description,
        invite_only: inviteOnly,
      });

      this.hideModals();
      document.getElementById('create-group-form').reset();
      await DataLoader.loadGroups();
      this.showToast('Group created successfully', 'success');
    } catch (error) {
      this.showToast(error.message || 'Failed to create group', 'error');
    }
  },

  // Handle create policy
  async handleCreatePolicy() {
    const scope = document.getElementById('policy-scope').value;
    const targetId = document.getElementById('policy-target-id').value;
    const policyType = document.getElementById('policy-type').value;
    const content = document.getElementById('policy-content').value.trim();
    const priority = parseInt(document.getElementById('policy-priority').value, 10);

    if (!content) {
      this.showToast('Please enter policy content', 'error');
      return;
    }

    try {
      const parsedContent =
        policyType === 'llm'
          ? content
          : JSON.parse(content);

      await API.policies.create({
        scope,
        target_id: targetId || undefined,
        direction: 'outbound',
        resource: 'message.general',
        action: 'share',
        effect: 'deny',
        evaluator: policyType,
        policy_type: policyType,
        policy_content: parsedContent,
        priority,
      });

      this.hideModals();
      document.getElementById('create-policy-form').reset();
      await DataLoader.loadPolicies();
      this.showToast('Policy created successfully', 'success');
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.showToast('Structured and heuristic policies must use valid JSON', 'error');
      } else {
        this.showToast(error.message || 'Failed to create policy', 'error');
      }
    }
  },

  openAddFriendModal() {
    document.getElementById('add-friend-form')?.reset();
    this.showModal('search-users-modal');
  },

  async handleAddFriendRequest() {
    const usernameInput = document.getElementById('add-friend-username');
    const submitButton = document.getElementById('send-friend-request-btn');

    if (!usernameInput) {
      this.showToast('The add-by-username form is unavailable.', 'error');
      return;
    }

    const username = usernameInput.value.trim().replace(/^@+/, '');

    if (!username || username.length < 3) {
      this.showToast('Enter the exact Mahilo username you want to add.', 'error');
      return;
    }

    if (State.user?.username?.toLowerCase() === username.toLowerCase()) {
      this.showToast('You cannot send a request to your own username.', 'error');
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
    const normalizedUsername = username.trim().replace(/^@+/, '');

    try {
      const result = await API.friends.request(normalizedUsername);
      this.hideModals();
      document.getElementById('add-friend-form')?.reset();
      await DataLoader.loadFriends();
      this.showToast(
        result.status === 'accepted'
          ? result.message || `${normalizedUsername} is now part of your network`
          : `Friend request sent to ${normalizedUsername}`,
        'success'
      );
    } catch (error) {
      this.showToast(error.message || 'Failed to send friend request', 'error');
    }
  },

  // Handle friend actions
  async handleAcceptFriend(id) {
    try {
      await API.friends.accept(id);
      await DataLoader.loadFriends();
      this.showToast('Friend request accepted', 'success');
    } catch (error) {
      this.showToast('Failed to accept friend request', 'error');
    }
  },

  async handleRejectFriend(id) {
    try {
      await API.friends.reject(id);
      await DataLoader.loadFriends();
      this.showToast('Friend request rejected', 'success');
    } catch (error) {
      this.showToast('Failed to reject friend request', 'error');
    }
  },

  async handleBlockFriend(id) {
    try {
      await API.friends.block(id);
      await DataLoader.loadFriends();
      this.showToast('User blocked', 'success');
    } catch (error) {
      this.showToast('Failed to block user', 'error');
    }
  },

  async handleUnfriend(id) {
    try {
      await API.friends.unfriend(id);
      await DataLoader.loadFriends();
      this.showToast('Friend removed', 'success');
    } catch (error) {
      this.showToast('Failed to remove friend', 'error');
    }
  },

  // Handle send message (user-facing chat)
  async handleSendMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();

    if (!message || !State.selectedChat) return;

    const thread = State.conversations.get(State.selectedChat) || [];
    const latestMessage = thread[thread.length - 1] || null;
    const latestRecord = latestMessage ? State.messagesById.get(latestMessage.id) : null;
    const isGroupThread = latestMessage?.recipientType === 'group';

    if (isGroupThread && !latestRecord?.recipientId) {
      this.showToast(
        'Group replies are unavailable until the server includes a stable group identifier.',
        'info'
      );
      return;
    }

    const payload = {
      recipient: isGroupThread ? latestRecord.recipientId : State.selectedChat,
      recipient_type: isGroupThread ? 'group' : 'user',
      message,
      context: 'Sent from the Mahilo dashboard',
    };

    try {
      const result = await API.messages.send(payload);

      input.value = '';
      await DataLoader.loadLogFeed();
      this.showToast(`Message queued: ${result.status}`, 'success');
    } catch (error) {
      this.showToast(error.message || 'Failed to send message', 'error');
    }
  },

  // Handle send test message (developer view)
  async handleSendTestMessage() {
    const input = document.getElementById('dev-chat-input');
    const message = input.value.trim();
    
    if (!message || !State.selectedChat) return;

    try {
      const result = await API.messages.send({
        recipient: State.selectedChat,
        message,
        context: 'Test message from Developer Console',
      });

      input.value = '';
      await DataLoader.loadLogFeed();
      this.showToast(`Test message sent: ${result.status}`, 'success');
    } catch (error) {
      this.showToast(error.message || 'Failed to send test message', 'error');
    }
  },

  // Handle delete agent
  async handleDeleteAgent(id) {
    if (!confirm('Are you sure you want to delete this agent?')) return;

    try {
      await API.agents.delete(id);
      await DataLoader.loadAgents();
      this.hideModals();
      this.showToast('Agent deleted successfully', 'success');
    } catch (error) {
      this.showToast('Failed to delete agent', 'error');
    }
  },

  // Show agent details
  showAgentDetails(agent) {
    document.getElementById('detail-agent-icon').textContent = '🤖';
    document.getElementById('detail-agent-name').textContent = `${agent.label} (${agent.framework})`;
    document.getElementById('detail-agent-framework').textContent = agent.framework;
    document.getElementById('detail-agent-status').textContent = agent.status;
    document.getElementById('detail-agent-status').className = `status-badge ${agent.status}`;
    document.getElementById('detail-agent-id').textContent = agent.id;
    document.getElementById('detail-agent-label').textContent = agent.label;
    document.getElementById('detail-agent-callback').textContent = agent.callbackUrl || 'None';
    document.getElementById('detail-agent-public-key').textContent =
      agent.publicKey ? `${agent.publicKey.substring(0, 50)}...` : 'None';
    document.getElementById('detail-agent-alg').textContent = agent.publicKeyAlg || 'None';
    document.getElementById('detail-agent-priority').textContent = agent.routingPriority || 0;

    const capsContainer = document.getElementById('detail-agent-capabilities');
    capsContainer.innerHTML = '';
    if (agent.capabilities?.length) {
      agent.capabilities.forEach(cap => {
        const tag = document.createElement('span');
        tag.className = 'capability-tag';
        tag.textContent = cap;
        capsContainer.appendChild(tag);
      });
    } else {
      capsContainer.innerHTML = '<span class="capability-tag">None</span>';
    }

    // Bind delete button
    const deleteBtn = document.getElementById('delete-agent-btn');
    deleteBtn.onclick = () => this.handleDeleteAgent(agent.id);

    this.showModal('agent-details-modal');
  },

  // Populate policy targets
  populatePolicyTargets(scope) {
    const select = document.getElementById('policy-target-id');
    select.innerHTML = '<option value="">Select...</option>';

    if (scope === 'user') {
      State.friends
        .filter(f => f.status === 'accepted')
        .forEach(friend => {
          const option = document.createElement('option');
          option.value = friend.userId;  // Use the actual user ID, not friendship ID
          option.textContent = friend.displayName || friend.username;
          select.appendChild(option);
        });
    } else if (scope === 'group') {
      State.groups.forEach(group => {
          const option = document.createElement('option');
          option.value = group.id;
          option.textContent = group.name;
          select.appendChild(option);
      });
    }
  },

  // Switch view
  switchView(view) {
    State.currentView = view;

    // Update nav
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.view === view);
    });

    // Update page title
    const titles = {
      overview: { title: 'Overview', subtitle: 'Your trust network at a glance' },
      agents: { title: 'My Agents', subtitle: 'Manage your agent connections' },
      friends: { title: 'Friends', subtitle: 'Connect with other users' },
      groups: { title: 'Groups', subtitle: 'Collaborate with multiple friends' },
      messages: { title: 'Messages', subtitle: 'Talk directly with your trusted network' },
      logs: { title: 'Delivery Logs', subtitle: 'Monitor and audit message delivery' },
      policies: { title: 'Policies', subtitle: 'Control what your agents can share' },
      settings: { title: 'Settings', subtitle: 'Manage your preferences and notification settings' },
      developer: { title: 'Developer Tools', subtitle: 'Debug and test messaging' },
    };

    const { title, subtitle } = titles[view] || titles.overview;
    document.getElementById('page-title').textContent = title;
    document.getElementById('page-subtitle').textContent = subtitle;

    // Show view
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const nextView = document.getElementById(`${view}-view`);
    if (!nextView) {
      console.warn(`View not found: ${view}`);
      State.currentView = 'overview';
      document.getElementById('overview-view')?.classList.add('active');
      return;
    }
    nextView.classList.add('active');

    // Load data if needed
    if (view === 'messages') {
      this.renderConversations();
      if (State.selectedChat) {
        this.renderChat(State.selectedChat);
      }
    } else if (view === 'logs') {
      this.hideNotificationDot();
      this.renderLogs();
    } else if (view === 'settings') {
      DataLoader.loadPreferences();
    } else if (view === 'developer') {
      this.renderDevConversations();
      this.renderDevApiKey();
    }
  },

  // Show landing page
  showLanding() {
    document.getElementById('landing-page').classList.remove('hidden');
    document.getElementById('dashboard-screen').classList.add('hidden');
    document.getElementById('ws-status').style.display = 'none';
    this.initLandingAnimations();
  },

  // Initialize landing page animations
  initLandingAnimations() {
    // Scroll reveal observer
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
        }
      });
    }, { threshold: 0.1 });

    document.querySelectorAll('.reveal-on-scroll').forEach(el => observer.observe(el));

    // Nav scroll effect
    const handleScroll = () => {
      const nav = document.querySelector('.landing-nav');
      if (nav) nav.classList.toggle('scrolled', window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    handleScroll();

    // Typewriter effect for solution demo
    const demoText = '"Hey, ask my contacts if anyone knows a good dentist in SF."';
    const demoEl = document.getElementById('demo-prompt-text');
    const demoSection = document.getElementById('solution-section');

    if (demoEl && demoSection) {
      let typed = false;
      const typeObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting && !typed) {
            typed = true;
            let i = 0;
            demoEl.textContent = '';
            const cursor = demoEl.previousElementSibling;
            const interval = setInterval(() => {
              demoEl.textContent += demoText[i];
              i++;
              if (i >= demoText.length) {
                clearInterval(interval);
                if (cursor) cursor.style.display = 'none';
                // Show response cards after typing finishes
                setTimeout(() => {
                  document.querySelectorAll('.demo-response').forEach((card, idx) => {
                    setTimeout(() => {
                      card.style.opacity = '1';
                      card.style.transform = 'translateY(0)';
                    }, idx * 400);
                  });
                }, 300);
              }
            }, 35);
          }
        });
      }, { threshold: 0.3 });
      typeObserver.observe(demoSection);
    }
  },

  // Show dashboard
  showDashboard() {
    document.getElementById('landing-page').classList.add('hidden');
    document.getElementById('dashboard-screen').classList.remove('hidden');
    document.getElementById('ws-status').style.display = 'flex';
    
    // Update sidebar
    document.getElementById('sidebar-username').textContent = State.user?.username || 'User';
    document.getElementById('user-avatar-initial').textContent = 
      (State.user?.display_name?.[0] || State.user?.username?.[0] || 'U').toUpperCase();
    document.getElementById('welcome-name').textContent =
      State.user?.display_name || State.user?.username || 'Friend';
  },

  // Show modal
  showModal(id) {
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById(id).classList.remove('hidden');
  },

  // Hide all modals
  hideModals() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  },

  // Update counts
  updateAgentCount(count) {
    document.getElementById('agent-count').textContent = count;
    document.getElementById('agent-count').classList.toggle('hidden', count === 0);
    document.getElementById('overview-agent-count').textContent = count;
  },

  updateFriendCount(count) {
    document.getElementById('friend-count').textContent = count;
    document.getElementById('friend-count').classList.toggle('hidden', count === 0);
    document.getElementById('overview-friend-count').textContent = count;
    document.getElementById('profile-friend-count').textContent = count;
  },

  updatePendingCount(count) {
    const badge = document.getElementById('pending-count');
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  },

  updateGroupCount(count) {
    document.getElementById('group-count').textContent = count;
    document.getElementById('group-count').classList.toggle('hidden', count === 0);
    document.getElementById('overview-group-count').textContent = count;
    document.getElementById('profile-group-count').textContent = count;
  },

  // Render functions
  renderAgents() {
    const grid = document.getElementById('agents-grid');
    
    if (!State.agents.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon-large">🤖</div>
          <h3>No agents yet</h3>
          <p>Connect your first agent to join your trust network</p>
          <button class="squishy-btn btn-primary" id="add-first-agent">
            <span>🚀</span> Connect Your First Agent
          </button>
        </div>
      `;
      document.getElementById('add-first-agent')?.addEventListener('click', () => {
        this.showModal('add-agent-modal');
      });
      return;
    }

    grid.innerHTML = State.agents.map(agent => `
      <div class="agent-card" onclick="UI.showAgentDetails(${JSON.stringify(agent).replace(/"/g, '&quot;')})">
        <div class="agent-card-header">
          <div class="agent-avatar">🤖</div>
          <div class="agent-info">
            <div class="agent-name">${agent.label}</div>
            <div class="agent-framework">${agent.framework}</div>
          </div>
          <span class="agent-status ${agent.status}">
            <span class="status-dot"></span>
            ${agent.status}
          </span>
        </div>
        <div class="agent-card-body">
          <div class="agent-description">${agent.description || 'No description'}</div>
          <div class="agent-capabilities">
            ${agent.capabilities.map(c => `<span class="capability-tag">${c}</span>`).join('') || '<span class="capability-tag">No capabilities</span>'}
          </div>
        </div>
        <div class="agent-card-footer">
          <button class="squishy-btn btn-secondary btn-small" onclick="event.stopPropagation(); UI.showAgentDetails(${JSON.stringify(agent).replace(/"/g, '&quot;')})">
            Details
          </button>
          <button class="squishy-btn btn-primary btn-small" onclick="event.stopPropagation(); UI.handlePingAgent('${agent.id}')">
            Ping
          </button>
        </div>
      </div>
    `).join('');
  },

  async handlePingAgent(id) {
    try {
      const result = await API.agents.ping(id);
      if (result.success) {
        this.showToast(`Agent responded in ${result.latency_ms}ms`, 'success');
      } else {
        this.showToast(`Agent ping failed: ${result.error}`, 'error');
      }
    } catch (error) {
      this.showToast('Failed to ping agent', 'error');
    }
  },

  renderFriends(filter = 'all') {
    const list = document.getElementById('friends-list');
    
    let friends = State.friends;
    if (filter !== 'all') {
      friends = friends.filter(f => f.status === filter || (filter === 'sent' && f.direction === 'sent' && f.status === 'pending'));
    }

    if (!friends.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon-large">👥</div>
          <h3>No ${filter === 'all' ? 'friends' : filter + ' requests'} yet</h3>
          <p>Add people you trust to start asking around</p>
        </div>
      `;
      return;
    }

    list.innerHTML = friends.map(friend => `
      <div class="friend-item">
        <div class="friend-avatar">
          ${(friend.displayName?.[0] || friend.username?.[0] || '?').toUpperCase()}
        </div>
        <div class="friend-info">
          <div class="friend-name">${friend.displayName || friend.username}</div>
          <div class="friend-username">@${friend.username}</div>
        </div>
        <span class="friend-status ${friend.status}">
          ${friend.status === 'pending' ? (friend.direction === 'sent' ? 'Sent' : 'Pending') : friend.status}
        </span>
        <div class="friend-actions">
          ${friend.status === 'pending' && friend.direction === 'received' ? `
            <button class="squishy-btn btn-primary btn-small" onclick="UI.handleAcceptFriend('${friend.id}')">Accept</button>
            <button class="squishy-btn btn-secondary btn-small" onclick="UI.handleRejectFriend('${friend.id}')">Reject</button>
          ` : friend.status === 'accepted' ? `
            <button class="squishy-btn btn-secondary btn-small" onclick="UI.handleBlockFriend('${friend.id}')">Block</button>
            <button class="squishy-btn btn-danger btn-small" onclick="UI.handleUnfriend('${friend.id}')">Unfriend</button>
          ` : friend.status === 'blocked' ? `
            <button class="squishy-btn btn-secondary btn-small" onclick="UI.handleUnfriend('${friend.id}')">Remove</button>
          ` : `
            <button class="squishy-btn btn-secondary btn-small" onclick="UI.handleUnfriend('${friend.id}')">Cancel</button>
          `}
        </div>
      </div>
    `).join('');
  },

  renderGroups() {
    const grid = document.getElementById('groups-grid');
    
    if (!State.groups.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon-large">🏘️</div>
          <h3>No groups yet</h3>
          <p>Create a group to ask around a specific circle</p>
          <button class="squishy-btn btn-primary" id="create-first-group">
            <span>🏘️</span> Create Your First Group
          </button>
        </div>
      `;
      document.getElementById('create-first-group')?.addEventListener('click', () => {
        this.showModal('create-group-modal');
      });
      return;
    }

    grid.innerHTML = State.groups.map(group => `
      <div class="group-card">
        <div class="group-icon">🏘️</div>
        <div class="group-name">${group.name}</div>
        <div class="group-description">${group.description || 'No description'}</div>
        <div class="group-meta">
          <span>👥 ${group.memberCount || 0} members</span>
          <span>${group.inviteOnly ? '🔒 Invite only' : '🌐 Public'}</span>
          <span>${group.status === 'invited' ? '✉️ Invited' : `Role: ${group.role || 'member'}`}</span>
        </div>
        ${group.status === 'invited' ? `
          <div class="group-card-actions">
            <button class="squishy-btn btn-primary btn-small" onclick="UI.handleJoinGroup('${group.id}')">Join Invite</button>
          </div>
        ` : group.status === 'active' && group.role !== 'owner' ? `
          <div class="group-card-actions">
            <button class="squishy-btn btn-secondary btn-small" onclick="UI.handleLeaveGroup('${group.id}')">Leave Group</button>
          </div>
        ` : ''}
      </div>
    `).join('');
  },

  async handleJoinGroup(groupId) {
    const group = State.groups.find((entry) => entry.id === groupId);

    if (!group) {
      this.showToast('Group not found', 'error');
      return;
    }

    if (group.status === 'invited') {
      try {
        await API.groups.join(groupId);
        await DataLoader.loadGroups();
        this.showToast(`Joined ${group.name}`, 'success');
      } catch (error) {
        this.showToast(error.message || 'Failed to join group', 'error');
      }
      return;
    }

    this.showToast('Only invited groups can be joined from this view.', 'info');
  },

  async handleLeaveGroup(groupId) {
    const group = State.groups.find((entry) => entry.id === groupId);

    if (!group) {
      this.showToast('Group not found', 'error');
      return;
    }

    if (!confirm(`Leave ${group.name}?`)) {
      return;
    }

    try {
      await API.groups.leave(groupId);
      await DataLoader.loadGroups();
      this.showToast(`Left ${group.name}`, 'success');
    } catch (error) {
      this.showToast(error.message || 'Failed to leave group', 'error');
    }
  },

  renderPolicies(scope = 'all') {
    const list = document.getElementById('policies-list');
    
    let policies = State.policies;
    if (scope !== 'all') {
      policies = policies.filter(p => p.scope === scope);
    }

    if (!policies.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon-large">🛡️</div>
          <h3>No policies yet</h3>
          <p>Create policies to control what your agents can share</p>
          <button class="squishy-btn btn-primary" id="create-first-policy">
            <span>🛡️</span> Create Your First Policy
          </button>
        </div>
      `;
      document.getElementById('create-first-policy')?.addEventListener('click', () => {
        this.showModal('create-policy-modal');
      });
      return;
    }

    list.innerHTML = policies.map(policy => `
      <div class="policy-card">
        <div class="policy-header">
          <span class="policy-title">${policy.policyType === 'heuristic' ? '📋' : '🧠'} ${policy.effect} policy</span>
          <div class="policy-badges">
            <span class="policy-badge ${policy.scope}">${policy.scope}</span>
            <span class="policy-badge">${policy.direction}</span>
            <span class="policy-badge ${policy.enabled ? 'enabled' : 'disabled'}">${policy.enabled ? 'enabled' : 'disabled'}</span>
          </div>
        </div>
        <div class="policy-content">${policy.contentText}</div>
        <div class="log-details">
          <span class="log-detail">Selector: ${policy.resource}${policy.action ? ` / ${policy.action}` : ''}</span>
          <span class="log-detail">Evaluator: ${policy.evaluator}</span>
        </div>
        <div class="policy-actions">
          <button class="squishy-btn btn-secondary btn-small" onclick="UI.handleTogglePolicy('${policy.id}', ${!policy.enabled})">
            ${policy.enabled ? 'Disable' : 'Enable'}
          </button>
          <button class="squishy-btn btn-danger btn-small" onclick="UI.handleDeletePolicy('${policy.id}')">
            Delete
          </button>
        </div>
      </div>
    `).join('');
  },

  async handleTogglePolicy(id, enabled) {
    try {
      await API.policies.update(id, { enabled });
      await DataLoader.loadPolicies();
      this.showToast(`Policy ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (error) {
      this.showToast('Failed to update policy', 'error');
    }
  },

  async handleDeletePolicy(id) {
    if (!confirm('Are you sure you want to delete this policy?')) return;

    try {
      await API.policies.delete(id);
      await DataLoader.loadPolicies();
      this.showToast('Policy deleted', 'success');
    } catch (error) {
      this.showToast('Failed to delete policy', 'error');
    }
  },

  renderSettings() {
    const prefs = State.preferences;
    if (!prefs) return;

    // Notification preferences
    if (prefs.preferredChannel !== undefined) {
      document.getElementById('pref-channel').value = prefs.preferredChannel || '';
    }
    if (prefs.urgentBehavior) {
      document.getElementById('pref-urgent').value = prefs.urgentBehavior;
    }

    // Quiet hours
    if (prefs.quietHours) {
      document.getElementById('pref-quiet-enabled').checked = prefs.quietHours.enabled;
      document.getElementById('pref-quiet-start').value = prefs.quietHours.start || '22:00';
      document.getElementById('pref-quiet-end').value = prefs.quietHours.end || '07:00';
      document.getElementById('pref-quiet-timezone').value = prefs.quietHours.timezone || 'UTC';
      
      // Show/hide quiet hours row
      const row = document.getElementById('quiet-hours-row');
      row.classList.toggle('hidden', !prefs.quietHours.enabled);
    }

    // LLM defaults
    if (prefs.defaultLlmProvider !== undefined) {
      document.getElementById('pref-llm-provider').value = prefs.defaultLlmProvider || '';
    }
    if (prefs.defaultLlmModel !== undefined) {
      document.getElementById('pref-llm-model').value = prefs.defaultLlmModel || '';
    }
  },

  renderConversations() {
    const list = document.getElementById('conversations-list');
    if (!list) {
      return;
    }
    
    // Build conversations from loaded messages first so non-friend threads still show up.
    const conversations = new Map();

    State.conversations.forEach((messages, counterpart) => {
      const friend = State.friends.find((entry) => entry.username === counterpart);
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

    State.friends.filter(f => f.status === 'accepted').forEach(friend => {
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
          (Date.parse(rightLast?.timestamp || '') || 0) -
          (Date.parse(leftLast?.timestamp || '') || 0)
        );
      })
      .map(([username, conv]) => {
        const lastMessage = conv.messages[conv.messages.length - 1];
        return `
          <div class="conversation-item ${State.selectedChat === username ? 'active' : ''}" onclick="UI.selectChat('${username}')">
            <div class="conversation-avatar">${conv.name[0].toUpperCase()}</div>
            <div class="conversation-info">
              <div class="conversation-name">${conv.name}</div>
              <div class="conversation-preview">${lastMessage?.previewText || lastMessage?.message || 'No messages yet'}</div>
            </div>
            <div class="conversation-meta">
              <div class="conversation-time">${lastMessage ? new Date(lastMessage.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</div>
            </div>
          </div>
        `;
      }).join('');
  },

  selectChat(username) {
    State.selectedChat = username;
    
    const friend = State.friends.find(f => f.username === username);
    const messages = State.conversations.get(username) || [];
    const name = friend?.displayName || messages[messages.length - 1]?.counterpartLabel || username;
    const isGroupThread = messages.some((entry) => entry.recipientType === 'group');
    const latestMessage = messages[messages.length - 1] || null;
    const latestRecord = latestMessage ? State.messagesById.get(latestMessage.id) : null;
    const canSend =
      !isGroupThread ||
      Boolean(latestRecord?.recipientId);

    const placeholder = document.getElementById('chat-placeholder');
    const chatContainer = document.getElementById('chat-container');
    const chatInput = document.getElementById('chat-input');
    const sendButton = document.getElementById('send-message-btn');
    if (!placeholder || !chatContainer) {
      return;
    }

    placeholder.classList.add('hidden');
    chatContainer.classList.remove('hidden');
    
    document.getElementById('chat-recipient-avatar').textContent = name[0].toUpperCase();
    document.getElementById('chat-recipient-name').textContent = name;
    document.getElementById('chat-recipient-status').textContent = isGroupThread
      ? 'Group thread'
      : friend
        ? 'Online'
        : 'Conversation';

    if (chatInput) {
      chatInput.disabled = !canSend;
      chatInput.placeholder = canSend
        ? 'Type a message...'
        : 'Group replies need a stable group ID from the server';
    }

    if (sendButton) {
      sendButton.disabled = !canSend;
    }
    
    this.renderConversations();
    this.renderChat(username);
  },

  renderChat(username) {
    const container = document.getElementById('chat-messages');
    if (!container) {
      return;
    }
    const messages = State.conversations.get(username) || [];
    
    container.innerHTML = messages.map(msg => `
      <div class="message ${msg.sent ? 'sent' : 'received'}">
        <div class="message-content">${msg.message}</div>
        <div class="message-time">
          ${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          ${msg.status && msg.status !== 'delivered' ? ` • ${msg.status}` : ''}
        </div>
      </div>
    `).join('');
    
    container.scrollTop = container.scrollHeight;
  },

  renderLogs(direction = 'all') {
    const list = document.getElementById('logs-list');

    const items = Helpers.logFeed(
      State.messages,
      State.reviews,
      State.blockedEvents,
      direction
    );

    if (!items.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon-large">📋</div>
          <h3>No delivery logs yet</h3>
          <p>Message delivery history will appear here for monitoring and audit</p>
        </div>
      `;
      return;
    }

    list.innerHTML = items.map(item => {
      if (item.kind === 'review') {
        return `
          <div class="log-item">
            <div class="log-header">
              <div class="log-direction">
                <div class="log-direction-icon ${item.transportDirection}">
                  ${item.transportDirection === 'sent' ? '⏸️' : '🧾'}
                </div>
                <div>
                  <div class="log-participants">
                    Review required: ${item.transportDirection === 'sent' ? `To: ${item.recipient}` : `From: ${item.sender}`}
                  </div>
                  <div class="log-meta">
                    <span>${new Date(item.timestamp).toLocaleString()}</span>
                    <span>ID: ${item.reviewId.substring(0, 12)}...</span>
                  </div>
                </div>
              </div>
              <span class="log-status ${item.status}">${item.status}</span>
            </div>
            <div class="log-content">${item.messagePreview || item.summary}</div>
            <div class="log-details">
              <span class="log-detail">Decision: ${item.decision}</span>
              <span class="log-detail">Mode: ${item.deliveryMode || 'review_required'}</span>
              <span class="log-detail">Selector: ${item.selectors.resource || 'message.general'}</span>
            </div>
          </div>
        `;
      }

      if (item.kind === 'blocked') {
        return `
          <div class="log-item">
            <div class="log-header">
              <div class="log-direction">
                <div class="log-direction-icon ${item.transportDirection}">
                  🚫
                </div>
                <div>
                  <div class="log-participants">
                    Blocked event: ${item.transportDirection === 'sent' ? `To: ${item.recipient}` : `From: ${item.sender}`}
                  </div>
                  <div class="log-meta">
                    <span>${new Date(item.timestamp).toLocaleString()}</span>
                    <span>ID: ${item.blockedEventId.substring(0, 12)}...</span>
                  </div>
                </div>
              </div>
              <span class="log-status ${item.status}">${item.status}</span>
            </div>
            <div class="log-content">${item.reason}</div>
            <div class="log-details">
              <span class="log-detail">Selector: ${item.selectors.resource || 'message.general'}</span>
              ${item.payloadHash ? `<span class="log-detail">Hash: ${item.payloadHash.substring(0, 16)}...</span>` : ''}
            </div>
          </div>
        `;
      }

      return `
        <div class="log-item">
          <div class="log-header">
            <div class="log-direction">
              <div class="log-direction-icon ${item.transportDirection}">
                ${item.transportDirection === 'sent' ? '📤' : '📥'}
              </div>
              <div>
                <div class="log-participants">
                  ${item.transportDirection === 'sent' ? `To: ${item.recipient}` : `From: ${item.sender}`}
                </div>
                <div class="log-meta">
                  <span>${new Date(item.timestamp).toLocaleString()}</span>
                  <span>ID: ${item.messageId.substring(0, 8)}...</span>
                </div>
              </div>
            </div>
            <span class="log-status ${item.status}">${item.status}</span>
          </div>
          <div class="log-content">${item.messageText || '(no content)'}</div>
          <div class="log-details">
            <span class="log-detail">🤖 ${item.senderAgent || 'unknown'}</span>
            ${item.correlationId ? `<span class="log-detail">🔗 ${item.correlationId.substring(0, 8)}...</span>` : ''}
            ${item.recipientType === 'group' ? '<span class="log-detail">👥 Group</span>' : ''}
          </div>
        </div>
      `;
    }).join('');
  },

  renderDevConversations() {
    const list = document.getElementById('dev-conversations-list');
    
    const acceptedFriends = State.friends.filter(f => f.status === 'accepted');

    if (!acceptedFriends.length) {
      list.innerHTML = `
        <div class="empty-state small" style="padding: 40px 20px;">
          <div class="empty-icon" style="font-size: 3rem; margin-bottom: 16px;">👥</div>
          <p style="font-weight: 700; color: var(--color-text); margin-bottom: 8px;">No friends available</p>
          <p class="hint" style="font-size: 0.9rem;">Add friends first to test messaging</p>
        </div>
      `;
      return;
    }

    list.innerHTML = acceptedFriends.map(friend => {
      const name = friend.displayName || friend.username;
      const messages = State.conversations.get(friend.username) || [];
      const lastMessage = messages[messages.length - 1];
      
      return `
        <div class="conversation-item ${State.selectedChat === friend.username ? 'active' : ''}" 
             onclick="UI.selectDevChat('${friend.username}')">
          <div class="conversation-avatar">${name[0].toUpperCase()}</div>
          <div class="conversation-info">
            <div class="conversation-name">${name}</div>
            <div class="conversation-preview">${lastMessage?.previewText || 'Click to test messaging'}</div>
          </div>
        </div>
      `;
    }).join('');
  },

  selectDevChat(username) {
    State.selectedChat = username;
    
    const friend = State.friends.find(f => f.username === username);
    const name = friend?.displayName || username;
    
    document.getElementById('dev-chat-placeholder').classList.add('hidden');
    document.getElementById('dev-chat-container').classList.remove('hidden');
    
    document.getElementById('dev-chat-recipient-avatar').textContent = name[0].toUpperCase();
    document.getElementById('dev-chat-recipient-name').textContent = name;
    document.getElementById('dev-chat-recipient-status').textContent = 'Test Mode';
    
    this.renderDevConversations();
    this.renderDevChat(username);
  },

  renderDevChat(username) {
    const container = document.getElementById('dev-chat-messages');
    const messages = State.conversations.get(username) || [];
    
    container.innerHTML = messages.map(msg => `
      <div class="message ${msg.sent ? 'sent' : 'received'}">
        <div class="message-content">${msg.message}</div>
        <div class="message-time">
          ${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          ${msg.status ? ` • ${msg.status}` : ''}
        </div>
      </div>
    `).join('');
    
    container.scrollTop = container.scrollHeight;
  },

  renderDevApiKey() {
    const display = document.getElementById('dev-api-key-display');
    if (display && State.apiKey) {
      // Show first 20 chars and last 10 chars, mask the middle
      const key = State.apiKey;
      const masked = key.length > 30 
        ? `${key.substring(0, 20)}...${key.substring(key.length - 10)}`
        : key;
      display.textContent = masked;
    }
  },

  renderOverviewAgents() {
    const list = document.getElementById('overview-agent-list');
    
    if (!State.agents.length) {
      list.innerHTML = `
        <div class="empty-state small" style="padding: 30px 20px;">
          <div class="empty-icon" style="font-size: 2.5rem; margin-bottom: 12px;">🤖</div>
          <p style="font-weight: 700; color: var(--color-text); font-size: 0.95rem;">No agents yet</p>
        </div>
      `;
      return;
    }

    list.innerHTML = State.agents.slice(0, 3).map(agent => `
      <div class="agent-status-item">
        <span class="status-indicator ${agent.status}"></span>
        <span class="agent-status-name">${agent.label}</span>
        <span class="agent-status-framework">${agent.framework}</span>
      </div>
    `).join('');
  },

  renderOverviewFriends() {
    const list = document.getElementById('overview-friend-list');
    const acceptedFriends = State.friends.filter(f => f.status === 'accepted');
    
    if (!acceptedFriends.length) {
      list.innerHTML = `
        <div class="empty-state small" style="padding: 30px 20px;">
          <div class="empty-icon" style="font-size: 2.5rem; margin-bottom: 12px;">👋</div>
          <p style="font-weight: 700; color: var(--color-text); font-size: 0.95rem;">No friends yet</p>
        </div>
      `;
      return;
    }

    list.innerHTML = acceptedFriends.slice(0, 5).map(friend => `
      <div class="friend-preview-item">
        <div class="friend-preview-avatar">${(friend.displayName?.[0] || friend.username?.[0]).toUpperCase()}</div>
        <span class="friend-preview-name">${friend.displayName || friend.username}</span>
      </div>
    `).join('');
  },

  renderOverviewGroups() {
    // Already handled by updateGroupCount
  },

  renderOverviewMessages() {
    const list = document.getElementById('overview-message-list');
    
    if (!State.messages.length) {
      list.innerHTML = `
        <div class="empty-state small" style="padding: 40px 20px;">
          <div class="empty-icon" style="font-size: 3rem; margin-bottom: 16px;">📨</div>
          <p style="font-weight: 700; color: var(--color-text); margin-bottom: 8px;">No messages yet</p>
          <p class="hint" style="font-size: 0.9rem;">Start chatting with your friends!</p>
        </div>
      `;
      return;
    }

    list.innerHTML = State.messages.slice(0, 5).map(msg => `
      <div class="message-preview-item">
        <span class="message-preview-sender">${msg.counterpartLabel}</span>
        <span class="message-preview-text">${msg.previewText}</span>
        <span class="message-preview-time">${new Date(msg.timestamp).toLocaleDateString()}</span>
      </div>
    `).join('');
  },

  renderProfile() {
    const user = State.user;
    if (!user) return;

    document.getElementById('profile-avatar').textContent = 
      (user.display_name?.[0] || user.username?.[0] || 'U').toUpperCase();
    document.getElementById('profile-username').textContent = user.username;
    document.getElementById('profile-display-name').textContent = user.display_name || user.username;
    document.getElementById('profile-agent-count').textContent = State.agents.length;
  },

  // Toast notifications
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️',
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
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  },

  // Update WebSocket status
  updateWSStatus(status) {
    const dot = document.getElementById('ws-dot');
    const text = document.getElementById('ws-text');
    
    dot.className = 'ws-dot';
    
    switch (status) {
      case 'connected':
        dot.classList.add('connected');
        text.textContent = 'Live';
        break;
      case 'connecting':
        dot.classList.add('connecting');
        text.textContent = 'Connecting...';
        break;
      case 'error':
      case 'disconnected':
        dot.classList.add('error');
        text.textContent = 'Offline';
        break;
    }
  },

  // Show notification dot
  showNotificationDot() {
    document.getElementById('notification-dot').classList.remove('hidden');
  },

  hideNotificationDot() {
    document.getElementById('notification-dot').classList.add('hidden');
  },

  // Copy to clipboard
  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      this.showToast('Copied to clipboard!', 'success');
    } catch (err) {
      // Fallback
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      this.showToast('Copied to clipboard!', 'success');
    }
  },
};

// ========================================
// Initialize App
// ========================================
document.addEventListener('DOMContentLoaded', () => {
  UI.init();
});

// Expose UI for onclick handlers
window.UI = UI;
