# Mahilo Registry: Phase 1 Tasks

> **Project**: Mahilo Registry (Separate Service)  
> **Phase**: 1 - Core Infrastructure  
> **Goal**: Enable two Clawdbot instances to communicate via Mahilo

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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
- **Priority**: P0
- **Notes**: 
  - Fields: id, correlation_id, sender_user_id, sender_agent, recipient_type, recipient_id, recipient_connection_id, payload, payload_type, encryption, sender_signature, context, status, rejection_reason, retry_count, idempotency_key, created_at, delivered_at
  - For delivery tracking and audit
- **Acceptance Criteria**:
  - [ ] Migration creates table
  - [ ] Indexes on sender, recipient, status, correlation_id

#### 2.5 Create Policies Table
- **ID**: `REG-008`
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
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
- **Status**: `pending`
- **Priority**: P2
- **Notes**: 
  - Document: env vars, DB setup, reverse proxy
  - Security checklist
  - Monitoring recommendations
- **Acceptance Criteria**:
  - [ ] Deployment guide in docs
  - [ ] Security checklist

---

## Summary

| Priority | Total | Pending | In Progress | Done |
|----------|-------|---------|-------------|------|
| P0       | 19    | 19      | 0           | 0    |
| P1       | 10    | 10      | 0           | 0    |
| P2       | 6     | 6       | 0           | 0    |
| **Total**| 35    | 35      | 0           | 0    |

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
