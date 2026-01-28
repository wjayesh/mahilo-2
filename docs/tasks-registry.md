# Mahilo Registry: Tasks by Phase

> **Project**: Mahilo Registry (Separate Service)  
> **Phases**: 1 - Core Infrastructure (done), 2 - Groups and Advanced Features, 3 - Federation, 4 - Advanced Intelligence, 5 - Ecosystem  
> **Phase 1 Goal**: Enable two Clawdbot instances to communicate via Mahilo

---

## Status Legend

| Status | Meaning |
|--------|---------|
| `pending` | Not started |
| `in-progress` | Currently being worked on |
| `blocked` | Waiting on something |
| `review` | Ready for review |
| `done` | Completed |

---

## Task List

### 1. Project Setup

#### 1.1 Initialize Project Repository
- **ID**: `REG-001`
- **Status**: `done`
- **Priority**: P0
- **Notes**:
  - Create new repo `mahilo` (or `mahilo-registry`)
  - TypeScript project with modern tooling
  - Consider: Bun for runtime (fast, modern), Hono for HTTP (lightweight)
  - Setup: eslint, prettier, vitest
- **Acceptance Criteria**:
  - [ ] Repo created with basic structure
  - [ ] `package.json` with dependencies
  - [ ] TypeScript configured
  - [ ] Basic build/test scripts working

#### 1.2 Choose and Configure Database
- **ID**: `REG-002`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - SQLite for self-hosted (via better-sqlite3 or Drizzle)
  - Design for PostgreSQL compatibility later
  - Consider Drizzle ORM for type-safe queries
- **Acceptance Criteria**:
  - [ ] Database client configured
  - [ ] Migrations system setup
  - [ ] Initial schema created

#### 1.3 Setup HTTP Server
- **ID**: `REG-003`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - Hono or Fastify (lightweight, fast)
  - OpenAPI/Swagger spec generation
  - Health check endpoint
- **Acceptance Criteria**:
  - [ ] Server starts and responds to health check
  - [ ] Basic middleware (logging, error handling)
  - [ ] CORS configured

---

### 2. Database Schema

#### 2.1 Create Users Table
- **ID**: `REG-004`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - Fields: id, username, display_name, api_key_hash, created_at
  - Username unique, case-insensitive
  - Consider soft delete (deleted_at)
- **Acceptance Criteria**:
  - [ ] Migration creates table
  - [ ] Indexes on username, api_key_hash

#### 2.2 Create Agent Connections Table
- **ID**: `REG-005`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - Fields: id, user_id, framework, label, description, capabilities, public_key, public_key_alg, routing_priority, callback_url, callback_secret, status, last_seen, created_at
  - Foreign key to users
  - Unique constraint on (user_id, framework, label)
- **Acceptance Criteria**:
  - [ ] Migration creates table with FK
  - [ ] Indexes on user_id, status

#### 2.3 Create Friendships Table
- **ID**: `REG-006`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - Fields: id, requester_id, addressee_id, status, created_at
  - Status: pending, accepted, blocked
  - Unique constraint on (requester_id, addressee_id)
- **Acceptance Criteria**:
  - [ ] Migration creates table
  - [ ] Indexes for bidirectional friendship lookups

#### 2.4 Create Messages Table
- **ID**: `REG-007`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - Fields: id, correlation_id, sender_user_id, sender_agent, recipient_type, recipient_id, recipient_connection_id, payload, payload_type, encryption, sender_signature, context, status, rejection_reason, retry_count, idempotency_key, created_at, delivered_at
  - For delivery tracking and audit
- **Acceptance Criteria**:
  - [ ] Migration creates table
  - [ ] Indexes on sender, recipient, status, correlation_id

#### 2.5 Create Policies Table
- **ID**: `REG-008`
- **Status**: `done`
- **Priority**: P1
- **Notes**: 
  - Fields: id, user_id, scope, target_id, policy_type, policy_content, priority, enabled, created_at
  - Scope: global, user, group
  - Policy type: heuristic, llm
- **Acceptance Criteria**:
  - [ ] Migration creates table
  - [ ] Indexes on user_id, scope

---

### 3. Authentication

#### 3.1 Implement API Key Generation
- **ID**: `REG-009`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - Format: `mhl_<random_32_chars>`
  - Include key ID prefix for indexed lookup (e.g., `mhl_<kid>_<secret>`)
  - Store hashed (argon2id)
  - Key shown only once at creation
- **Acceptance Criteria**:
  - [ ] Key generation function
  - [ ] Hashing with argon2id
  - [ ] Verification function

#### 3.2 Implement Auth Middleware
- **ID**: `REG-010`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - Extract `Authorization: Bearer <key>` header
  - Verify against database
  - Use key ID prefix for indexed lookup
  - Attach user to request context
  - Rate limiting per user (simple in-memory for MVP)
- **Acceptance Criteria**:
  - [ ] Middleware extracts and validates key
  - [ ] Returns 401 for invalid/missing key
  - [ ] Attaches user info to request

#### 3.3 User Registration Endpoint
- **ID**: `REG-011`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - `POST /api/v1/auth/register`
  - Input: username, display_name (optional)
  - Output: user_id, api_key
  - Validate username (alphanumeric, 3-30 chars)
- **Acceptance Criteria**:
  - [ ] Endpoint creates user
  - [ ] Returns API key (only time it's shown)
  - [ ] Rejects duplicate usernames

#### 3.4 API Key Rotation Endpoint
- **ID**: `REG-012`
- **Status**: `done`
- **Priority**: P1
- **Notes**: 
  - `POST /api/v1/auth/rotate-key`
  - Requires current valid key
  - Invalidates old key, returns new one
- **Acceptance Criteria**:
  - [ ] Endpoint rotates key
  - [ ] Old key no longer works

---

### 4. Agent Connection Management

#### 4.1 Register Agent Endpoint
- **ID**: `REG-013`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - `POST /api/v1/agents`
  - Input: framework, label, description, capabilities, public_key, public_key_alg, routing_priority, callback_url, callback_secret (optional)
  - Auto-generate callback_secret if not provided
  - Upsert by (user_id, framework, label); allow rotate_secret to update callback_secret/public_key
  - Validate callback_url is HTTPS (except localhost for dev)
  - Block private IP ranges in hosted mode (SSRF protection)
- **Acceptance Criteria**:
  - [ ] Creates agent connection
  - [ ] Returns connection_id, callback_secret
  - [ ] Validates URL format and blocks private IPs (hosted)
  - [ ] Supports metadata update + secret rotation for existing connections

#### 4.2 List Agents Endpoint
- **ID**: `REG-014`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - `GET /api/v1/agents`
  - Returns user's agent connections
  - Don't expose callback_secret in list
  - Add `GET /api/v1/contacts/:username/connections` for routing selection (friends only)
- **Acceptance Criteria**:
  - [ ] Returns list of user's agents
  - [ ] Includes status, last_seen
  - [ ] Provides friend connection listing for routing selection

#### 4.3 Delete Agent Endpoint
- **ID**: `REG-015`
- **Status**: `done`
- **Priority**: P1
- **Notes**: 
  - `DELETE /api/v1/agents/:id`
  - Only owner can delete
  - Soft delete or hard delete?
- **Acceptance Criteria**:
  - [ ] Deletes agent connection
  - [ ] Returns success confirmation

#### 4.4 Agent Ping/Health Check
- **ID**: `REG-016`
- **Status**: `done`
- **Priority**: P2
- **Notes**: 
  - `POST /api/v1/agents/:id/ping`
  - Tests callback URL reachability
  - Updates last_seen timestamp
- **Acceptance Criteria**:
  - [ ] Pings callback URL
  - [ ] Returns latency
  - [ ] Updates last_seen

---

### 5. Friendship Management

#### 5.1 Send Friend Request Endpoint
- **ID**: `REG-017`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - `POST /api/v1/friends/request`
  - Input: username (of addressee)
  - Creates pending friendship
  - Can't request self, can't duplicate
- **Acceptance Criteria**:
  - [ ] Creates pending friendship
  - [ ] Prevents duplicate requests
  - [ ] Returns friendship_id

#### 5.2 Accept Friend Request Endpoint
- **ID**: `REG-018`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - `POST /api/v1/friends/:id/accept`
  - Only addressee can accept
  - Changes status to accepted
- **Acceptance Criteria**:
  - [ ] Changes status to accepted
  - [ ] Only addressee can accept
  - [ ] Returns updated friendship

#### 5.3 List Friends Endpoint
- **ID**: `REG-019`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - `GET /api/v1/friends`
  - Query param: status (accepted, pending, blocked)
  - Returns both directions (requester and addressee)
- **Acceptance Criteria**:
  - [ ] Lists friends by status
  - [ ] Includes username, display_name
  - [ ] Bidirectional lookup

#### 5.4 Block/Unfriend Endpoints
- **ID**: `REG-020`
- **Status**: `done`
- **Priority**: P1
- **Notes**: 
  - `POST /api/v1/friends/:id/block`
  - `DELETE /api/v1/friends/:id`
  - Block prevents future requests
- **Acceptance Criteria**:
  - [ ] Block changes status
  - [ ] Delete removes friendship
  - [ ] Blocked users can't send requests

---

### 6. Message Routing

#### 6.1 Send Message Endpoint
- **ID**: `REG-021`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - `POST /api/v1/messages/send`
  - Input: recipient, recipient_type, recipient_connection_id, routing_hints, message, context, payload_type, encryption, sender_signature, correlation_id, idempotency_key
  - Core routing logic:
    1. Validate relationship (friends?)
    2. (Trusted mode only) Apply policies if plaintext provided
    3. Route to recipient_connection_id
    4. HTTP POST to callback URL
    5. Track delivery status
  - Enforce max payload size and store an audit entry
- **Acceptance Criteria**:
  - [ ] Validates friendship
  - [ ] Stores message for tracking
  - [ ] Calls recipient's callback URL
  - [ ] Returns message_id, status
  - [ ] Supports recipient_connection_id and idempotency_key
  - [ ] Enforces max payload size
  - [ ] Records audit log for routing and policy decisions

#### 6.2 Callback URL Delivery
- **ID**: `REG-022`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - HTTP POST to agent's callback_url
  - Include signature header (HMAC-SHA256)
  - Include timestamp header
  - Include message_id header
  - Include encryption + sender_signature fields in body
  - Timeout: 30 seconds
  - Expect 2xx response
- **Acceptance Criteria**:
  - [ ] Signs request with callback_secret
  - [ ] Includes required headers
  - [ ] Handles success/failure

#### 6.3 Delivery Retry Logic
- **ID**: `REG-023`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - On failure/timeout: queue for retry
  - Exponential backoff: 1s, 2s, 4s, 8s...
  - Max retries: 5
  - After max: mark as failed
  - Simple in-memory queue for MVP (consider BullMQ later)
  - Use idempotency_key + message_id de-dupe to prevent duplicate processing
- **Acceptance Criteria**:
  - [ ] Queues failed messages
  - [ ] Retries with backoff
  - [ ] Updates status after max retries

#### 6.4 Message History Endpoint
- **ID**: `REG-024`
- **Status**: `done`
- **Priority**: P2
- **Notes**: 
  - `GET /api/v1/messages`
  - Query: since, limit, direction (sent/received)
  - For audit/debugging
  - Respect retention policy (purge after delivery if configured)
- **Acceptance Criteria**:
  - [ ] Returns message history
  - [ ] Filters by direction
  - [ ] Pagination support

---

### 7. Policy System (Basic)

#### 7.1 Implement Heuristic Policy Evaluation
- **ID**: `REG-025`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - Validate JSON policy rules on create/update
  - Rules: maxLength, blockedPatterns, requireContext
  - Actual evaluation happens in plugin by default
  - Registry evaluation only in trusted-routing mode
- **Acceptance Criteria**:
  - [ ] Validates policy format on write
  - [ ] Returns clear validation errors
  - [ ] Optional evaluation path works in trusted mode

#### 7.2 Create Policy Endpoint
- **ID**: `REG-026`
- **Status**: `done`
- **Priority**: P1
- **Notes**: 
  - `POST /api/v1/policies`
  - Input: scope, target_id, policy_type, policy_content, priority
  - Validate policy_content format
- **Acceptance Criteria**:
  - [ ] Creates policy
  - [ ] Validates policy format
  - [ ] Returns policy_id

#### 7.3 Policy CRUD Endpoints
- **ID**: `REG-027`
- **Status**: `done`
- **Priority**: P1
- **Notes**: 
  - `GET /api/v1/policies` - List
  - `PATCH /api/v1/policies/:id` - Update
  - `DELETE /api/v1/policies/:id` - Delete
- **Acceptance Criteria**:
  - [ ] List returns user's policies
  - [ ] Update works for content, priority, enabled
  - [ ] Delete removes policy

#### 7.4 Integrate Policy Evaluation in Message Send
- **ID**: `REG-028`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - Default: registry does not evaluate message content (E2E mode)
  - Trusted mode: evaluate policies before routing:
    1. Load user's global policies
    2. Load per-recipient policies
    3. Evaluate in priority order
    4. If any fail: reject message
- **Acceptance Criteria**:
  - [ ] E2E mode skips content evaluation
  - [ ] Trusted mode evaluates before delivery
  - [ ] Rejects with clear reason when enabled

---

### 8. Testing & Documentation

#### 8.1 Unit Tests for Core Functions
- **ID**: `REG-029`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - Auth: key generation, verification
  - Policy: heuristic evaluation
  - Signature: HMAC generation/verification
- **Acceptance Criteria**:
  - [ ] >80% coverage on core functions
  - [ ] All edge cases tested

#### 8.2 Integration Tests for API Endpoints
- **ID**: `REG-030`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - Test each endpoint with valid/invalid inputs
  - Test auth requirements
  - Test relationship checks
- **Acceptance Criteria**:
  - [ ] All endpoints have tests
  - [ ] Auth enforced on protected endpoints

#### 8.3 E2E Test: Two Users Exchange Messages
- **ID**: `REG-031`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - Create two users
  - Make them friends
  - Register agents with mock callback URLs
  - Send message, verify delivery
- **Acceptance Criteria**:
  - [ ] Full flow works end-to-end
  - [ ] Callback receives correct payload

#### 8.4 API Documentation
- **ID**: `REG-032`
- **Status**: `done`
- **Priority**: P1
- **Notes**: 
  - OpenAPI spec (auto-generated or manual)
  - README with quick start
  - Examples for each endpoint
- **Acceptance Criteria**:
  - [ ] OpenAPI spec available
  - [ ] README covers setup and usage

---

### 9. Deployment

#### 9.1 Dockerfile for Self-Hosting
- **ID**: `REG-033`
- **Status**: `done`
- **Priority**: P1
- **Notes**: 
  - Multi-stage build
  - Minimal production image
  - Configurable via env vars
  - Volume mount for SQLite
- **Acceptance Criteria**:
  - [ ] Docker image builds
  - [ ] Runs with SQLite
  - [ ] Configurable via env

#### 9.2 Local Development Setup
- **ID**: `REG-034`
- **Status**: `done`
- **Priority**: P0
- **Notes**: 
  - Simple `npm run dev` or `bun run dev`
  - Auto-creates SQLite DB
  - Seed data for testing (optional)
- **Acceptance Criteria**:
  - [ ] Dev server starts easily
  - [ ] Hot reload works

#### 9.3 Production Deployment Guide
- **ID**: `REG-035`
- **Status**: `done`
- **Priority**: P2
- **Notes**: 
  - Document: env vars, DB setup, reverse proxy
  - Security checklist
  - Monitoring recommendations
- **Acceptance Criteria**:
  - [ ] Deployment guide in docs
  - [ ] Security checklist

---

### 10. Groups (Phase 2)

#### 10.1 Create Groups Table
- **ID**: `REG-036`
- **Status**: `done`
- **Priority**: P0
- **Notes**:
  - Fields: id, name, description, owner_user_id, invite_only, created_at, updated_at
  - Name unique (case-insensitive)
- **Acceptance Criteria**:
  - [ ] Migration creates table
  - [ ] Indexes on name, owner_user_id

#### 10.2 Create Group Memberships Table
- **ID**: `REG-037`
- **Status**: `done`
- **Priority**: P0
- **Notes**:
  - Fields: id, group_id, user_id, role, status, invited_by_user_id, created_at
  - Role: owner, admin, member
  - Status: invited, pending, active
  - Unique constraint on (group_id, user_id)
- **Acceptance Criteria**:
  - [ ] Migration creates table
  - [ ] Indexes on group_id, user_id, status

---

### 11. Group Management (Phase 2)

#### 11.1 Create Group Endpoint
- **ID**: `REG-038`
- **Status**: `done`
- **Priority**: P0
- **Notes**:
  - `POST /api/v1/groups`
  - Input: name, description?, invite_only?
  - Creator becomes owner + active member
- **Acceptance Criteria**:
  - [ ] Group created with owner membership
  - [ ] Returns group_id

#### 11.2 List Groups Endpoint
- **ID**: `REG-039`
- **Status**: `done`
- **Priority**: P0
- **Notes**:
  - `GET /api/v1/groups`
  - Returns groups for the authenticated user
  - Include role and member_count
- **Acceptance Criteria**:
  - [ ] Lists groups the user belongs to
  - [ ] Includes role and member_count

#### 11.3 Invite User Endpoint
- **ID**: `REG-040`
- **Status**: `done`
- **Priority**: P0
- **Notes**:
  - `POST /api/v1/groups/:id/invite`
  - Owner/admin only
  - Creates invited membership entry
- **Acceptance Criteria**:
  - [ ] Creates invite for target user
  - [ ] Prevents duplicate invites

#### 11.4 Join Group Endpoint
- **ID**: `REG-041`
- **Status**: `done`
- **Priority**: P0
- **Notes**:
  - `POST /api/v1/groups/:id/join`
  - Allow join if invite_only is false or user is invited
- **Acceptance Criteria**:
  - [ ] Joins group when allowed
  - [ ] Denies join when not invited

#### 11.5 Leave Group Endpoint
- **ID**: `REG-042`
- **Status**: `done`
- **Priority**: P1
- **Notes**:
  - `DELETE /api/v1/groups/:id/leave`
  - Owner cannot leave without transfer or deletion
- **Acceptance Criteria**:
  - [ ] Removes membership
  - [ ] Enforces owner transfer rule

---

### 12. Group Policies (Phase 2)

#### 12.1 Enforce Group Policy Scope
- **ID**: `REG-043`
- **Status**: `done`
- **Priority**: P0
- **Notes**:
  - Policies with scope=group require membership or ownership
  - Validate target_id belongs to a group the user can manage
- **Acceptance Criteria**:
  - [ ] Only authorized members can manage group policies
  - [ ] Invalid target_id is rejected

#### 12.2 Evaluate Group Policies for Group Messages
- **ID**: `REG-044`
- **Status**: `done`
- **Priority**: P0
- **Notes**:
  - In trusted mode, apply group policies before routing
  - Define evaluation order with user policies
- **Acceptance Criteria**:
  - [ ] Group policies evaluated for group sends
  - [ ] Policy failure blocks delivery with reason

---

### 13. Group Messaging (Phase 2)

#### 13.1 Send Message to Group
- **ID**: `REG-045`
- **Status**: `done`
- **Priority**: P0
- **Notes**:
  - Extend `POST /api/v1/messages/send` with recipient_type=group
  - Validate sender membership
- **Acceptance Criteria**:
  - [ ] Group recipient accepted and stored
  - [ ] Non-members are rejected

#### 13.2 Fan-out Delivery Tracking
- **ID**: `REG-046`
- **Status**: `done`
- **Priority**: P0
- **Notes**:
  - Deliver to each member's active connection(s)
  - Track per-recipient delivery status (child records)
  - Exclude sender's own connection if desired
- **Acceptance Criteria**:
  - [ ] Fan-out delivers to all eligible members
  - [ ] Delivery status tracked per recipient

#### 13.3 talk_to_group Tool Support
- **ID**: `REG-047`
- **Status**: `done`
- **Priority**: P1
- **Notes**:
  - Document payload shape for group sends
  - Provide examples for the `talk_to_group` tool
- **Acceptance Criteria**:
  - [ ] Docs show how to use `talk_to_group`

---

### 14. Realtime Notifications (Phase 2)

#### 14.1 WebSocket Auth and Connection
- **ID**: `REG-048`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - `GET /api/v1/notifications/ws`
  - Authenticate with API key
  - Keepalive/ping support
- **Acceptance Criteria**:
  - [ ] Authenticated clients can connect
  - [ ] Connections stay alive with ping/pong

#### 14.2 WebSocket Event Types
- **ID**: `REG-049`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - Events: message_received, delivery_status, group_invite, group_join
  - Define event payload schema
- **Acceptance Criteria**:
  - [ ] Events emitted for message and group lifecycle
  - [ ] Payload schema documented

---

### 15. Testing & Documentation (Phase 2)

#### 15.1 Group Flow Integration Tests
- **ID**: `REG-050`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - Create group, invite, join, send group message
  - Validate fan-out delivery
- **Acceptance Criteria**:
  - [ ] Integration tests cover group flows

#### 15.2 API Documentation for Groups
- **ID**: `REG-051`
- **Status**: `done`
- **Priority**: P1
- **Notes**:
  - Update OpenAPI and README for group endpoints and WebSocket
- **Acceptance Criteria**:
  - [ ] Docs updated with group APIs and events

---

### 16. Federation (Phase 3)

#### 16.1 Create Registry Instances Table
- **ID**: `REG-052`
- **Status**: `pending`
- **Priority**: P0
- **Notes**:
  - Fields: id, name, base_url, public_key, status, created_at
  - Unique on base_url
- **Acceptance Criteria**:
  - [ ] Migration creates table
  - [ ] Indexes on base_url, status

#### 16.2 Federation Trust Configuration
- **ID**: `REG-053`
- **Status**: `pending`
- **Priority**: P0
- **Notes**:
  - Allowlist trusted registry instances
  - Store signing keys or shared secrets
- **Acceptance Criteria**:
  - [ ] Trust config enforced for federation calls
  - [ ] Untrusted instances rejected

---

### 17. Federation API (Phase 3)

#### 17.1 Instance Handshake Endpoint
- **ID**: `REG-054`
- **Status**: `pending`
- **Priority**: P0
- **Notes**:
  - Endpoint for mutual verification and key exchange
  - Challenge/response to confirm ownership of keys
- **Acceptance Criteria**:
  - [ ] Instances can be verified and registered

#### 17.2 Remote User Discovery Endpoint
- **ID**: `REG-055`
- **Status**: `pending`
- **Priority**: P0
- **Notes**:
  - Lookup user by username on a federated instance
  - Return routing hint for outbound messages
- **Acceptance Criteria**:
  - [ ] Discovery works for trusted peers only

#### 17.3 Remote Connection Lookup Endpoint
- **ID**: `REG-056`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - Return connection metadata for remote users (privacy-safe)
- **Acceptance Criteria**:
  - [ ] Returns only allowed metadata
  - [ ] Access restricted to trusted instances

---

### 18. Federated Routing (Phase 3)

#### 18.1 Outbound Federated Routing
- **ID**: `REG-057`
- **Status**: `pending`
- **Priority**: P0
- **Notes**:
  - Forward messages to recipient's registry
  - Sign payloads and include timestamps
- **Acceptance Criteria**:
  - [ ] Outbound messages forwarded to correct instance
  - [ ] Payloads signed and verified

#### 18.2 Inbound Federated Message Verification
- **ID**: `REG-058`
- **Status**: `pending`
- **Priority**: P0
- **Notes**:
  - Verify signature, timestamp, and trust
  - Map remote sender to local representation
- **Acceptance Criteria**:
  - [ ] Invalid or untrusted messages rejected
  - [ ] Valid messages routed locally

#### 18.3 Delivery Status Relay
- **ID**: `REG-059`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - Report delivery status back to originating registry
  - Idempotent updates
- **Acceptance Criteria**:
  - [ ] Status updates propagate reliably

#### 18.4 Federation Retry and Rate Limiting
- **ID**: `REG-060`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - Retry policy for federation requests
  - Per-instance rate limits
- **Acceptance Criteria**:
  - [ ] Retries and limits enforced

---

### 19. Testing & Documentation (Phase 3)

#### 19.1 Federation E2E Tests
- **ID**: `REG-061`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - Two registries with trust established
  - Send message across instances
- **Acceptance Criteria**:
  - [ ] Federated messaging works end-to-end

#### 19.2 Federation Deployment Docs
- **ID**: `REG-062`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - Document federation setup, keys, allowlist
- **Acceptance Criteria**:
  - [ ] Federation docs added

---

### 20. Capability Discovery (Phase 4)

#### 20.1 Capability Index and Search
- **ID**: `REG-063`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - Index connection capabilities/tags
  - Provide search endpoint for capability lookup
- **Acceptance Criteria**:
  - [ ] Capability search returns matching connections

#### 20.2 Capability Refresh/Heartbeat
- **ID**: `REG-064`
- **Status**: `pending`
- **Priority**: P2
- **Notes**:
  - Endpoint for agents to refresh capability metadata
  - Update last_seen and capabilities
- **Acceptance Criteria**:
  - [ ] Capability updates recorded

---

### 21. Fuzzy Resolution (Phase 4)

#### 21.1 Fuzzy Username Resolution
- **ID**: `REG-065`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - Fuzzy match recipient names with confidence scoring
  - Return suggestions when ambiguous
- **Acceptance Criteria**:
  - [ ] Fuzzy matching returns ranked suggestions

#### 21.2 Ambiguity Handling Endpoint
- **ID**: `REG-066`
- **Status**: `pending`
- **Priority**: P2
- **Notes**:
  - Endpoint to fetch suggestions for partial names
- **Acceptance Criteria**:
  - [ ] Suggestions endpoint returns ranked list

---

### 22. Conversation Summaries (Phase 4)

#### 22.1 Conversation Summary Storage
- **ID**: `REG-067`
- **Status**: `pending`
- **Priority**: P2
- **Notes**:
  - Summarize conversations (opt-in) and store per thread
  - Configurable retention
- **Acceptance Criteria**:
  - [ ] Summaries stored with metadata

#### 22.2 Summary Retrieval Endpoint
- **ID**: `REG-068`
- **Status**: `pending`
- **Priority**: P2
- **Notes**:
  - Fetch summary by correlation_id or thread id
- **Acceptance Criteria**:
  - [ ] Summary endpoint returns latest summary

---

### 23. Smart Routing (Phase 4)

#### 23.1 Smart Routing Heuristics
- **ID**: `REG-069`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - Use capabilities, routing_priority, last_seen for selection
- **Acceptance Criteria**:
  - [ ] Best connection selected for routing

#### 23.2 LLM-Assisted Routing
- **ID**: `REG-070`
- **Status**: `pending`
- **Priority**: P2
- **Notes**:
  - Optional trusted-mode LLM routing on plaintext
  - Config gated
- **Acceptance Criteria**:
  - [ ] LLM routing can be enabled and disabled

---

### 24. Testing & Documentation (Phase 4)

#### 24.1 Advanced Routing Tests
- **ID**: `REG-071`
- **Status**: `pending`
- **Priority**: P2
- **Notes**:
  - Tests for fuzzy resolution and smart routing
- **Acceptance Criteria**:
  - [ ] Tests cover ambiguous routing cases

#### 24.2 Advanced Feature Docs
- **ID**: `REG-072`
- **Status**: `pending`
- **Priority**: P2
- **Notes**:
  - Document capability search, fuzzy resolution, routing
- **Acceptance Criteria**:
  - [ ] Docs updated for advanced features

---

### 25. Plugin Marketplace (Phase 5)

#### 25.1 Marketplace Schema
- **ID**: `REG-073`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - Tables for plugins, versions, owners, ratings
- **Acceptance Criteria**:
  - [ ] Marketplace tables created

#### 25.2 Marketplace Submission and Listing
- **ID**: `REG-074`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - Endpoints to submit, list, and view plugins
- **Acceptance Criteria**:
  - [ ] Submission and listing endpoints work

#### 25.3 Marketplace Review Workflow
- **ID**: `REG-075`
- **Status**: `pending`
- **Priority**: P2
- **Notes**:
  - Approval state and moderation flow
- **Acceptance Criteria**:
  - [ ] Review workflow enforced

---

### 26. Policy Templates (Phase 5)

#### 26.1 Policy Template Catalog
- **ID**: `REG-076`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - Store reusable policy templates with metadata
- **Acceptance Criteria**:
  - [ ] Templates stored and listed

#### 26.2 Apply Template to User or Group
- **ID**: `REG-077`
- **Status**: `pending`
- **Priority**: P1
- **Notes**:
  - Endpoint to apply template to user or group policies
- **Acceptance Criteria**:
  - [ ] Policies created from templates

---

### 27. Analytics (Phase 5)

#### 27.1 Metrics Collection and Storage
- **ID**: `REG-078`
- **Status**: `pending`
- **Priority**: P2
- **Notes**:
  - Track delivery counts, latency, failures
- **Acceptance Criteria**:
  - [ ] Metrics stored for reporting

#### 27.2 Analytics Dashboard API
- **ID**: `REG-079`
- **Status**: `pending`
- **Priority**: P2
- **Notes**:
  - Aggregated metrics endpoint (time series)
- **Acceptance Criteria**:
  - [ ] Metrics API returns aggregates

---

### 28. Mobile App Support (Phase 5)

#### 28.1 Mobile Auth and Session Management
- **ID**: `REG-080`
- **Status**: `pending`
- **Priority**: P2
- **Notes**:
  - Token-based auth with refresh
- **Acceptance Criteria**:
  - [ ] Access and refresh tokens supported

#### 28.2 Push Notification Hooks
- **ID**: `REG-081`
- **Status**: `pending`
- **Priority**: P2
- **Notes**:
  - Emit hooks for invites and message delivery events
- **Acceptance Criteria**:
  - [ ] Hook configuration works

---

### 29. Testing & Documentation (Phase 5)

#### 29.1 Ecosystem Docs
- **ID**: `REG-082`
- **Status**: `pending`
- **Priority**: P2
- **Notes**:
  - Document marketplace, templates, analytics, mobile flows
- **Acceptance Criteria**:
  - [ ] Docs updated for ecosystem features

#### 29.2 Ecosystem E2E Tests
- **ID**: `REG-083`
- **Status**: `pending`
- **Priority**: P2
- **Notes**:
  - E2E tests for marketplace and templates
- **Acceptance Criteria**:
  - [ ] Ecosystem tests cover key flows

---

## Summary

| Priority | Total | Pending | In Progress | Done |
|----------|-------|---------|-------------|------|
| P0       | 40    | 6       | 0           | 34   |
| P1       | 26    | 15      | 0           | 11   |
| P2       | 17    | 14      | 0           | 3    |
| **Total**| 83    | 35      | 0           | 48   |

---

## Dependencies

```
REG-001 (Project Setup)
    └── REG-002 (Database) ─────┐
    └── REG-003 (HTTP Server) ──┼── REG-004 to REG-008 (Schema)
                                │
REG-004 (Users Table) ──────────┼── REG-009 to REG-012 (Auth)
                                │
REG-005 (Agent Connections) ────┼── REG-013 to REG-016 (Agent Mgmt)
                                │
REG-006 (Friendships) ──────────┼── REG-017 to REG-020 (Friend Mgmt)
                                │
REG-007 (Messages) + REG-009 ───┼── REG-021 to REG-024 (Message Routing)
                                │
REG-008 (Policies) + REG-021 ───┴── REG-025 to REG-028 (Policy System)
```
