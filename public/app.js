/**
 * Mahilo Dashboard - Main Application
 * Soft, squishy 3D game UI for agent management
 */

// ========================================
// Configuration
// ========================================
const CONFIG = {
  API_URL: 'http://localhost:8080/api/v1',
  WS_URL: 'ws://localhost:8080/api/v1/notifications/ws',
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
  friends: [],
  groups: [],
  messages: [],
  policies: [],
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
        this.apiKey = data.apiKey;
        this.user = data.user;
        return true;
      } catch (e) {
        console.error('Failed to parse session:', e);
      }
    }
    return false;
  },

  // Save state to localStorage
  save() {
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({
      apiKey: this.apiKey,
      user: this.user,
    }));
  },

  // Clear state
  clear() {
    this.user = null;
    this.apiKey = null;
    this.agents = [];
    this.friends = [];
    this.groups = [];
    this.messages = [];
    this.policies = [];
    this.conversations.clear();
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
    // Update conversations
    const sender = data.sender;
    if (!State.conversations.has(sender)) {
      State.conversations.set(sender, []);
    }
    State.conversations.get(sender).push(data);

    // Show notification
    UI.showToast(`New message from ${sender}`, 'info');

    // Update UI if in messages view
    if (State.currentView === 'messages') {
      UI.renderConversations();
      if (State.selectedChat === sender) {
        UI.renderChat(sender);
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
  async loadAll() {
    await Promise.all([
      this.loadAgents(),
      this.loadFriends(),
      this.loadGroups(),
      this.loadMessages(),
      this.loadPolicies(),
    ]);
  },

  async loadAgents() {
    try {
      State.agents = await API.agents.list();
      UI.updateAgentCount(State.agents.length);
      UI.renderAgents();
      UI.renderOverviewAgents();
    } catch (error) {
      console.error('Failed to load agents:', error);
    }
  },

  async loadFriends() {
    try {
      const all = await API.friends.list('accepted');
      const pending = await API.friends.list('pending');
      State.friends = [...all, ...pending];
      UI.updateFriendCount(all.length);
      UI.updatePendingCount(pending.filter(f => f.direction === 'received').length);
      UI.renderFriends();
      UI.renderOverviewFriends();
    } catch (error) {
      console.error('Failed to load friends:', error);
    }
  },

  async loadGroups() {
    try {
      State.groups = await API.groups.list();
      UI.updateGroupCount(State.groups.length);
      UI.renderGroups();
      UI.renderOverviewGroups();
    } catch (error) {
      console.error('Failed to load groups:', error);
    }
  },

  async loadMessages() {
    try {
      State.messages = await API.messages.list({ limit: 50 });
      UI.renderMessages();
      UI.renderOverviewMessages();
    } catch (error) {
      console.error('Failed to load messages:', error);
    }
  },

  async loadPolicies() {
    try {
      State.policies = await API.policies.list();
      UI.renderPolicies();
    } catch (error) {
      console.error('Failed to load policies:', error);
    }
  },

  async loadPreferences() {
    try {
      State.preferences = await API.preferences.get();
      UI.renderSettings();
    } catch (error) {
      console.error('Failed to load preferences:', error);
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
  checkAuth() {
    if (State.init()) {
      this.showDashboard();
      DataLoader.loadAll();
      WebSocketManager.connect();
    } else {
      this.showAuth();
    }
  },

  // Bind all event listeners
  bindEvents() {
    // User type tabs (Human vs Agent)
    document.querySelectorAll('.type-tab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const type = e.target.dataset.type;
        this.switchUserType(type);
      });
    });

    // Auth tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.target.dataset.tab;
        this.switchAuthTab(tab);
      });
    });

    // Login form
    document.getElementById('login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleLogin();
    });

    // Register form
    document.getElementById('register-form').addEventListener('submit', (e) => {
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
      this.showModal('search-users-modal');
    });

    document.getElementById('find-friends-quick')?.addEventListener('click', () => {
      this.switchView('friends');
      this.showModal('search-users-modal');
    });

    // Search users
    document.getElementById('search-username')?.addEventListener('input', (e) => {
      this.handleSearchUsers(e.target.value);
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
      DataLoader.loadMessages();
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
  },

  // Switch user type (Human vs Agent)
  switchUserType(type) {
    document.querySelectorAll('.type-tab').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`.type-tab[data-type="${type}"]`).classList.add('active');

    document.querySelectorAll('.user-type-section').forEach(section => section.classList.remove('active'));
    document.getElementById(`${type}-section`).classList.add('active');
  },

  // Switch auth tab
  switchAuthTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add('active');

    document.querySelectorAll('.auth-form').forEach(form => form.classList.remove('active'));
    document.getElementById(`${tab}-form`).classList.add('active');
  },

  // Handle login
  async handleLogin() {
    const apiKey = document.getElementById('login-api-key').value.trim();
    if (!apiKey) {
      this.showToast('Please enter your API key', 'error');
      return;
    }

    State.apiKey = apiKey;
    
    try {
      const user = await API.auth.me();
      State.user = user;
      State.save();
      
      this.showDashboard();
      DataLoader.loadAll();
      WebSocketManager.connect();
      this.showToast('Welcome back!', 'success');
    } catch (error) {
      State.apiKey = null;
      this.showToast('Invalid API key', 'error');
    }
  },

  // Handle register
  async handleRegister() {
    const username = document.getElementById('reg-username').value.trim();
    const displayName = document.getElementById('reg-display-name').value.trim();

    if (!username || username.length < 3) {
      this.showToast('Username must be at least 3 characters', 'error');
      return;
    }

    try {
      const result = await API.auth.register(username, displayName);
      State.apiKey = result.api_key;
      State.user = {
        user_id: result.user_id,
        username: result.username,
        display_name: displayName,
      };
      State.save();

      // Show API key modal
      document.getElementById('new-api-key').textContent = result.api_key;
      this.showModal('api-key-modal');
      
      this.showDashboard();
      WebSocketManager.connect();
    } catch (error) {
      this.showToast(error.message || 'Registration failed', 'error');
    }
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
    this.showAuth();
    this.showToast('Logged out successfully', 'success');
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

    // Generate a key pair if not provided
    let finalPublicKey = publicKey;
    let publicKeyAlg = 'ed25519';
    
    if (!finalPublicKey) {
      // In a real app, you'd generate this properly
      finalPublicKey = 'auto-generated-key-' + Date.now();
    }

    try {
      const result = await API.agents.register({
        framework,
        label,
        description,
        callback_url: callbackUrl,
        public_key: finalPublicKey,
        public_key_alg: publicKeyAlg,
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
      // Validate JSON for heuristic policies
      if (policyType === 'heuristic') {
        JSON.parse(content);
      }

      await API.policies.create({
        scope,
        target_id: targetId || undefined,
        policy_type: policyType,
        policy_content: content,
        priority,
      });

      this.hideModals();
      document.getElementById('create-policy-form').reset();
      await DataLoader.loadPolicies();
      this.showToast('Policy created successfully', 'success');
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.showToast('Invalid JSON in policy content', 'error');
      } else {
        this.showToast(error.message || 'Failed to create policy', 'error');
      }
    }
  },

  // Handle search users
  async handleSearchUsers(query) {
    const resultsContainer = document.getElementById('search-results');
    
    if (!query || query.length < 2) {
      resultsContainer.innerHTML = `
        <div class="empty-state small">
          <p>Type at least 2 characters to search</p>
        </div>
      `;
      return;
    }

    // For demo, show search interface
    // In real app, you'd have a search API endpoint
    resultsContainer.innerHTML = `
      <div class="search-result-item">
        <div class="search-result-info">
          <div class="search-result-name">${query}</div>
          <div class="search-result-username">@${query.toLowerCase()}</div>
        </div>
        <button class="squishy-btn btn-primary btn-small" onclick="UI.handleSendFriendRequest('${query.toLowerCase()}')">
          Add Friend
        </button>
      </div>
    `;
  },

  // Handle send friend request
  async handleSendFriendRequest(username) {
    try {
      await API.friends.request(username);
      this.hideModals();
      await DataLoader.loadFriends();
      this.showToast(`Friend request sent to ${username}`, 'success');
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
      
      // Add to conversation
      if (!State.conversations.has(State.selectedChat)) {
        State.conversations.set(State.selectedChat, []);
      }
      State.conversations.get(State.selectedChat).push({
        sender: State.user?.username || 'me',
        message,
        timestamp: new Date().toISOString(),
        sent: true,
        status: result.status,
        messageId: result.message_id,
      });

      this.renderDevChat(State.selectedChat);
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

  // Handle rotate callback secret
  async handleRotateCallbackSecret(id) {
    try {
      // This would require an API endpoint
      this.showToast('Callback secret rotation not yet implemented in API', 'warning');
    } catch (error) {
      this.showToast('Failed to rotate secret', 'error');
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
    document.getElementById('detail-agent-callback').textContent = agent.callback_url;
    document.getElementById('detail-agent-public-key').textContent = agent.public_key?.substring(0, 50) + '...' || 'None';
    document.getElementById('detail-agent-alg').textContent = agent.public_key_alg || 'None';
    document.getElementById('detail-agent-priority').textContent = agent.routing_priority || 0;

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
          option.value = friend.user_id;  // Use the actual user ID, not friendship ID
          option.textContent = friend.display_name || friend.username;
          select.appendChild(option);
        });
    } else if (scope === 'group') {
      State.groups.forEach(group => {
        const option = document.createElement('option');
        option.value = group.group_id;
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
      overview: { title: 'Overview', subtitle: 'Welcome back to your agent hub!' },
      agents: { title: 'My Agents', subtitle: 'Manage your agent connections' },
      friends: { title: 'Friends', subtitle: 'Connect with other users' },
      groups: { title: 'Groups', subtitle: 'Collaborate with multiple friends' },
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
    document.getElementById(`${view}-view`).classList.add('active');

    // Load data if needed
    if (view === 'logs') {
      this.renderLogs();
    } else if (view === 'settings') {
      DataLoader.loadPreferences();
    } else if (view === 'developer') {
      this.renderDevConversations();
      this.renderDevApiKey();
    }
  },

  // Show auth screen
  showAuth() {
    document.getElementById('auth-screen').classList.remove('hidden');
    document.getElementById('dashboard-screen').classList.add('hidden');
  },

  // Show dashboard
  showDashboard() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('dashboard-screen').classList.remove('hidden');
    
    // Update sidebar
    document.getElementById('sidebar-username').textContent = State.user?.username || 'User';
    document.getElementById('user-avatar-initial').textContent = 
      (State.user?.display_name?.[0] || State.user?.username?.[0] || 'U').toUpperCase();
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
          <p>Connect your first agent to start communicating with friends</p>
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
            ${agent.capabilities?.map(c => `<span class="capability-tag">${c}</span>`).join('') || '<span class="capability-tag">No capabilities</span>'}
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
          <p>Connect with other users to start messaging</p>
        </div>
      `;
      return;
    }

    list.innerHTML = friends.map(friend => `
      <div class="friend-item">
        <div class="friend-avatar">
          ${(friend.display_name?.[0] || friend.username?.[0] || '?').toUpperCase()}
        </div>
        <div class="friend-info">
          <div class="friend-name">${friend.display_name || friend.username}</div>
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
            <button class="squishy-btn btn-secondary btn-small" onclick="UI.switchView('messages'); UI.selectChat('${friend.username}')">Message</button>
            <button class="squishy-btn btn-danger btn-small" onclick="UI.handleUnfriend('${friend.id}')">Unfriend</button>
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
          <p>Create a group to collaborate with multiple friends</p>
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
      <div class="group-card" onclick="UI.handleJoinGroup('${group.group_id}')">
        <div class="group-icon">🏘️</div>
        <div class="group-name">${group.name}</div>
        <div class="group-description">${group.description || 'No description'}</div>
        <div class="group-meta">
          <span>👥 ${group.member_count || 0} members</span>
          <span>${group.invite_only ? '🔒 Invite only' : '🌐 Public'}</span>
        </div>
      </div>
    `).join('');
  },

  async handleJoinGroup(groupId) {
    // For demo, just show info
    this.showToast(`Group ${groupId} - Join functionality would go here`, 'info');
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
          <span class="policy-title">${policy.policy_type === 'heuristic' ? '📋' : '🧠'} Policy</span>
          <div class="policy-badges">
            <span class="policy-badge ${policy.scope}">${policy.scope}</span>
            <span class="policy-badge ${policy.enabled ? 'enabled' : 'disabled'}">${policy.enabled ? 'enabled' : 'disabled'}</span>
          </div>
        </div>
        <div class="policy-content">${policy.policy_content}</div>
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
    if (prefs.preferred_channel !== undefined) {
      document.getElementById('pref-channel').value = prefs.preferred_channel || '';
    }
    if (prefs.urgent_behavior) {
      document.getElementById('pref-urgent').value = prefs.urgent_behavior;
    }

    // Quiet hours
    if (prefs.quiet_hours) {
      document.getElementById('pref-quiet-enabled').checked = prefs.quiet_hours.enabled;
      document.getElementById('pref-quiet-start').value = prefs.quiet_hours.start || '22:00';
      document.getElementById('pref-quiet-end').value = prefs.quiet_hours.end || '07:00';
      document.getElementById('pref-quiet-timezone').value = prefs.quiet_hours.timezone || 'UTC';
      
      // Show/hide quiet hours row
      const row = document.getElementById('quiet-hours-row');
      row.classList.toggle('hidden', !prefs.quiet_hours.enabled);
    }

    // LLM defaults
    if (prefs.default_llm_provider !== undefined) {
      document.getElementById('pref-llm-provider').value = prefs.default_llm_provider || '';
    }
    if (prefs.default_llm_model !== undefined) {
      document.getElementById('pref-llm-model').value = prefs.default_llm_model || '';
    }
  },

  renderConversations() {
    const list = document.getElementById('conversations-list');
    
    // Build conversations from messages and friends
    const conversations = new Map();
    
    State.friends.filter(f => f.status === 'accepted').forEach(friend => {
      conversations.set(friend.username, {
        name: friend.display_name || friend.username,
        username: friend.username,
        messages: State.conversations.get(friend.username) || [],
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

    list.innerHTML = Array.from(conversations.entries()).map(([username, conv]) => {
      const lastMessage = conv.messages[conv.messages.length - 1];
      return `
        <div class="conversation-item ${State.selectedChat === username ? 'active' : ''}" onclick="UI.selectChat('${username}')">
          <div class="conversation-avatar">${conv.name[0].toUpperCase()}</div>
          <div class="conversation-info">
            <div class="conversation-name">${conv.name}</div>
            <div class="conversation-preview">${lastMessage?.message || 'No messages yet'}</div>
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
    const name = friend?.display_name || username;
    
    document.getElementById('chat-placeholder').classList.add('hidden');
    document.getElementById('chat-container').classList.remove('hidden');
    
    document.getElementById('chat-recipient-avatar').textContent = name[0].toUpperCase();
    document.getElementById('chat-recipient-name').textContent = name;
    document.getElementById('chat-recipient-status').textContent = 'Online';
    
    this.renderConversations();
    this.renderChat(username);
  },

  renderChat(username) {
    const container = document.getElementById('chat-messages');
    const messages = State.conversations.get(username) || [];
    
    container.innerHTML = messages.map(msg => `
      <div class="message ${msg.sent ? 'sent' : 'received'}">
        <div class="message-content">${msg.message}</div>
        <div class="message-time">${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
    `).join('');
    
    container.scrollTop = container.scrollHeight;
  },

  renderLogs(direction = 'all') {
    const list = document.getElementById('logs-list');
    
    let messages = State.messages;
    if (direction !== 'all') {
      messages = messages.filter(m => 
        (direction === 'sent' && m.sender === State.user?.username) ||
        (direction === 'received' && m.sender !== State.user?.username)
      );
    }

    if (!messages.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon-large">📋</div>
          <h3>No delivery logs yet</h3>
          <p>Message delivery history will appear here for monitoring and audit</p>
        </div>
      `;
      return;
    }

    list.innerHTML = messages.map(msg => {
      const isSent = msg.sender === State.user?.username;
      const statusClass = msg.status || 'pending';
      
      return `
        <div class="log-item">
          <div class="log-header">
            <div class="log-direction">
              <div class="log-direction-icon ${isSent ? 'sent' : 'received'}">
                ${isSent ? '📤' : '📥'}
              </div>
              <div>
                <div class="log-participants">
                  ${isSent ? `To: ${msg.recipient}` : `From: ${msg.sender}`}
                </div>
                <div class="log-meta">
                  <span>${new Date(msg.created_at).toLocaleString()}</span>
                  <span>ID: ${msg.id?.substring(0, 8)}...</span>
                </div>
              </div>
            </div>
            <span class="log-status ${statusClass}">${msg.status || 'pending'}</span>
          </div>
          <div class="log-content">${msg.message || msg.payload || '(no content)'}</div>
          <div class="log-details">
            <span class="log-detail">🤖 ${msg.sender_agent || 'unknown'}</span>
            ${msg.correlation_id ? `<span class="log-detail">🔗 ${msg.correlation_id.substring(0, 8)}...</span>` : ''}
            ${msg.recipient_type === 'group' ? '<span class="log-detail">👥 Group</span>' : ''}
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
      const name = friend.display_name || friend.username;
      const messages = State.conversations.get(friend.username) || [];
      const lastMessage = messages[messages.length - 1];
      
      return `
        <div class="conversation-item ${State.selectedChat === friend.username ? 'active' : ''}" 
             onclick="UI.selectDevChat('${friend.username}')">
          <div class="conversation-avatar">${name[0].toUpperCase()}</div>
          <div class="conversation-info">
            <div class="conversation-name">${name}</div>
            <div class="conversation-preview">${lastMessage?.message || 'Click to test messaging'}</div>
          </div>
        </div>
      `;
    }).join('');
  },

  selectDevChat(username) {
    State.selectedChat = username;
    
    const friend = State.friends.find(f => f.username === username);
    const name = friend?.display_name || username;
    
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
        <div class="friend-preview-avatar">${(friend.display_name?.[0] || friend.username?.[0]).toUpperCase()}</div>
        <span class="friend-preview-name">${friend.display_name || friend.username}</span>
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
        <span class="message-preview-sender">${msg.sender}</span>
        <span class="message-preview-text">${msg.message?.substring(0, 50)}${msg.message?.length > 50 ? '...' : ''}</span>
        <span class="message-preview-time">${new Date(msg.created_at).toLocaleDateString()}</span>
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
