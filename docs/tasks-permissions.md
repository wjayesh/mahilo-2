# Mahilo Registry: Permission System Tasks

> **Project**: Mahilo Registry - Permission System
> **Phase**: 2 - Advanced Features
> **Goal**: Enable agents to learn and enforce user sharing preferences via policies

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

## Context: How Policies Work

When User A sends a message to User B:
1. Server knows the recipient (B) from the send request
2. Server looks up B's roles (from A's friend_roles)
3. Server gathers applicable policies: global → role-based → per-user
4. Server evaluates message against those policies
5. If rejected, agent gets feedback and can rephrase

**Critical for agent experience**: When A's agent receives a message FROM B and needs to reply, the agent should know what policies apply to B BEFORE crafting a response. This avoids the rejection loop.

---

## Task List

### 1. Friend Roles Schema

#### 1.1 Create User Roles Table
- **ID**: `PERM-001`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: None
- **Notes**:
  - Table for role definitions (system + user-defined)
  - System roles: close_friends, friends, acquaintances, work_contacts, family
  - User can create custom roles
- **Schema**:
  ```sql
  CREATE TABLE user_roles (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),  -- NULL for system roles
    name TEXT NOT NULL,
    description TEXT,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(user_id, name)
  );
  ```
- **Acceptance Criteria**:
  - [ ] Migration creates user_roles table
  - [ ] System roles seeded on server startup
  - [ ] Index on (user_id, name)

#### 1.2 Create Friend Roles Junction Table
- **ID**: `PERM-002`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PERM-001
- **Notes**:
  - Many-to-many: friendships can have multiple roles
  - A friend can be both "close_friends" and "work_contacts"
- **Schema**:
  ```sql
  CREATE TABLE friend_roles (
    friendship_id TEXT NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,
    role_name TEXT NOT NULL,
    assigned_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (friendship_id, role_name)
  );
  CREATE INDEX idx_friend_roles_role ON friend_roles(role_name);
  ```
- **Acceptance Criteria**:
  - [ ] Migration creates friend_roles table
  - [ ] Cascade delete when friendship deleted
  - [ ] Index on role_name for policy lookups

#### 1.3 Seed System Roles on Startup
- **ID**: `PERM-003`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PERM-001
- **Notes**:
  - Run on server startup (idempotent)
  - Insert system roles if not exist
- **System Roles**:
  ```typescript
  const systemRoles = [
    { name: 'close_friends', description: 'Highest trust tier - share most info' },
    { name: 'friends', description: 'Standard friends - share general info' },
    { name: 'acquaintances', description: 'Casual contacts - limited sharing' },
    { name: 'work_contacts', description: 'Professional context only' },
    { name: 'family', description: 'Family members - high trust' },
  ];
  ```
- **Acceptance Criteria**:
  - [ ] System roles inserted on first startup
  - [ ] No duplicates on subsequent startups
  - [ ] Roles have is_system=true

---

### 2. Role Management Endpoints

#### 2.1 List Available Roles
- **ID**: `PERM-004`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PERM-003
- **Endpoint**: `GET /api/v1/roles`
- **Notes**:
  - Return system roles + user's custom roles
  - Filter by `?type=system` or `?type=custom`
- **Response**:
  ```json
  {
    "roles": [
      { "name": "close_friends", "description": "...", "is_system": true },
      { "name": "my_custom_role", "description": "...", "is_system": false }
    ]
  }
  ```
- **Acceptance Criteria**:
  - [ ] Returns all system roles
  - [ ] Returns user's custom roles
  - [ ] Filter by type works

#### 2.2 Create Custom Role
- **ID**: `PERM-005`
- **Status**: `done`
- **Priority**: P1
- **Depends on**: PERM-001
- **Endpoint**: `POST /api/v1/roles`
- **Request**:
  ```json
  {
    "name": "book_club",
    "description": "Friends from my book club"
  }
  ```
- **Validation**:
  - Name must be unique for this user
  - Cannot use system role names
  - Alphanumeric + underscore only
- **Acceptance Criteria**:
  - [ ] Creates custom role for user
  - [ ] Validates name format
  - [ ] Prevents duplicate names
  - [ ] Prevents overwriting system roles

#### 2.3 Add Role to Friend
- **ID**: `PERM-006`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PERM-002
- **Endpoint**: `POST /api/v1/friends/:friendship_id/roles`
- **Request**:
  ```json
  {
    "role": "close_friends"
  }
  ```
- **Notes**:
  - friendship_id from GET /friends response
  - Role must exist (system or user's custom)
  - Idempotent (adding same role twice = no error)
- **Acceptance Criteria**:
  - [ ] Adds role to friendship
  - [ ] Validates role exists
  - [ ] Validates friendship belongs to user
  - [ ] Idempotent operation

#### 2.4 Remove Role from Friend
- **ID**: `PERM-007`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PERM-002
- **Endpoint**: `DELETE /api/v1/friends/:friendship_id/roles/:role_name`
- **Notes**:
  - Removes role assignment
  - 404 if role wasn't assigned
- **Acceptance Criteria**:
  - [ ] Removes role from friendship
  - [ ] Returns 404 if not assigned
  - [ ] Validates friendship belongs to user

#### 2.5 Get Friend's Roles
- **ID**: `PERM-008`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PERM-002
- **Endpoint**: `GET /api/v1/friends/:friendship_id/roles`
- **Notes**:
  - Also include roles in main GET /friends response
- **Response**:
  ```json
  {
    "roles": ["close_friends", "work_contacts"]
  }
  ```
- **Acceptance Criteria**:
  - [ ] Returns list of role names
  - [ ] Validates friendship belongs to user

#### 2.6 Update GET /friends to Include Roles
- **ID**: `PERM-009`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PERM-008
- **Notes**:
  - Modify existing friends endpoint
  - Include roles array for each friend
- **Updated Response**:
  ```json
  {
    "friends": [
      {
        "user_id": "usr_123",
        "username": "alice",
        "display_name": "Alice Smith",
        "status": "accepted",
        "friendship_id": "frnd_456",
        "roles": ["close_friends", "work_contacts"]
      }
    ]
  }
  ```
- **Acceptance Criteria**:
  - [ ] Each friend includes roles array
  - [ ] Empty array if no roles assigned
  - [ ] friendship_id included for role management

---

### 3. Role-Scoped Policies

#### 3.1 Update Policy Schema for Role Scope
- **ID**: `PERM-010`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PERM-001
- **Notes**:
  - Already supports scope: global, user, group
  - Add scope: role where target_id is role name
- **Validation Changes**:
  - When scope="role", target_id must be valid role name
  - Check against user_roles table
- **Example**:
  ```json
  {
    "scope": "role",
    "target_id": "close_friends",
    "policy_type": "llm",
    "policy_content": "With close friends, calendar event details are okay to share"
  }
  ```
- **Acceptance Criteria**:
  - [ ] Can create policy with scope="role"
  - [ ] Validates target_id is valid role name
  - [ ] Policy stored correctly

#### 3.2 Update Policy Evaluation for Roles
- **ID**: `PERM-011`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PERM-010, PERM-002
- **Notes**:
  - When evaluating policies for a message to recipient:
    1. Get friendship with recipient
    2. Get roles assigned to that friendship
    3. Include role-scoped policies where target_id IN (recipient's roles)
  - Evaluation order: global → role → per-user (most specific wins on conflict)
- **Code Location**: `src/services/policy.ts` - `evaluatePolicies()`
- **Acceptance Criteria**:
  - [ ] Role-scoped policies included when recipient has role
  - [ ] Multiple roles = multiple policy sets
  - [ ] Correct priority ordering

---

### 4. Policy Context for Incoming Messages

#### 4.1 Create Policy Context Endpoint
- **ID**: `PERM-012`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PERM-011
- **Endpoint**: `GET /api/v1/policies/context/:username`
- **Purpose**: When agent receives message from "alice" and needs to reply, call this to know what policies apply to alice BEFORE responding.
- **Notes**:
  - Returns policies that would apply if sending to this user
  - Includes sender's relationship info
  - Used to avoid rejection loop
- **Response**:
  ```json
  {
    "recipient": {
      "username": "alice",
      "display_name": "Alice Chen",
      "relationship": "friend",
      "friendship_id": "frnd_123",
      "roles": ["close_friends", "work_contacts"],
      "connected_since": "2024-01-15T10:00:00Z"
    },
    "applicable_policies": [
      {
        "id": "pol_123",
        "scope": "global",
        "policy_type": "llm",
        "policy_content": "Never share exact addresses",
        "priority": 90
      },
      {
        "id": "pol_456",
        "scope": "role",
        "target_id": "close_friends",
        "policy_type": "llm",
        "policy_content": "With close friends, calendar event details are okay",
        "priority": 80
      }
    ],
    "summary": "This friend has role 'close_friends'. You may share calendar availability and event details, but not exact addresses."
  }
  ```
- **Acceptance Criteria**:
  - [ ] Returns recipient relationship info
  - [ ] Returns all applicable policies (global + role + per-user)
  - [ ] Policies ordered by priority
  - [ ] 404 if username not found or not friends

#### 4.2 Add Policy Summary Generation
- **ID**: `PERM-013`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: PERM-012
- **Notes**:
  - Optional: Generate human-readable summary of policies
  - Can be done client-side or server-side with LLM
  - For MVP: just return policies, let agent interpret
- **Acceptance Criteria**:
  - [ ] Summary field included (can be empty for MVP)
  - [ ] If implemented: concise summary of what's allowed/blocked

#### 4.3 Update SKILL.md with Context Endpoint
- **ID**: `PERM-014`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PERM-012
- **Notes**:
  - Document the context endpoint
  - Explain when to call it (before replying to someone)
  - Show example flow
- **Content to Add**:
  ```markdown
  ### Before Replying to a Message

  When you receive a message from someone and need to reply:

  1. Call GET /api/v1/policies/context/:sender_username
  2. Review the applicable_policies
  3. Craft your response within those constraints
  4. Send the message

  This prevents your message from being rejected.
  ```
- **Acceptance Criteria**:
  - [ ] SKILL.md documents context endpoint
  - [ ] Includes example request/response
  - [ ] Explains the workflow

---

### 5. LLM Policy Evaluation

#### 5.1 Add LLM Client Configuration
- **ID**: `PERM-015`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: None
- **Notes**:
  - Environment variables for LLM API
  - Support Anthropic (Claude) as primary
  - Use fast model for policy evaluation (haiku)
- **Configuration**:
  ```bash
  ANTHROPIC_API_KEY=sk-ant-...
  LLM_POLICY_MODEL=claude-3-haiku-20240307
  LLM_POLICY_TIMEOUT_MS=5000
  ```
- **Acceptance Criteria**:
  - [ ] Config reads from environment
  - [ ] Graceful handling if not configured (skip LLM policies with warning)
  - [ ] Timeout configuration

#### 5.2 Implement LLM Policy Evaluation
- **ID**: `PERM-016`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: PERM-015
- **Notes**:
  - Currently LLM policies are skipped (see policy.ts:191)
  - Implement actual evaluation
- **Code Location**: `src/services/policy.ts`
- **Evaluation Prompt**:
  ```
  You are evaluating if a message complies with a policy.

  POLICY: {policy_content}

  MESSAGE TO: {recipient_username}
  MESSAGE CONTENT: {message_payload}
  MESSAGE CONTEXT: {message_context}

  Does this message comply with the policy?
  Answer with PASS or FAIL on the first line, followed by brief reasoning.
  ```
- **Acceptance Criteria**:
  - [ ] LLM called for policy_type="llm" when trustedMode=true
  - [ ] Response parsed for PASS/FAIL
  - [ ] Timeout handling (default to PASS with warning)
  - [ ] Error handling (LLM failure = PASS with warning)

#### 5.3 Add Policy Evaluation Caching
- **ID**: `PERM-017`
- **Status**: `pending`
- **Priority**: P2
- **Depends on**: PERM-016
- **Notes**:
  - Cache LLM policy results for identical (policy_id, message_hash) pairs
  - Short TTL (5 minutes) to avoid stale results
  - Optional: implement later if LLM costs become issue
- **Acceptance Criteria**:
  - [ ] Cache key: hash(policy_id + message_content)
  - [ ] TTL configurable via env
  - [ ] Cache hit skips LLM call

---

### 6. Default Policies

#### 6.1 Create Default Policy Templates
- **ID**: `PERM-018`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: PERM-016
- **Notes**:
  - Define sensible defaults for new users
  - Enabled by default, user can disable
- **Default Policies**:
  ```typescript
  const defaultPolicies = [
    // Block sensitive patterns (highest priority)
    {
      scope: 'global',
      policy_type: 'heuristic',
      policy_content: JSON.stringify({
        blockedPatterns: [
          '\\b\\d{16}\\b',           // Credit card
          '\\bSSN[:\\s]*\\d{3}',     // SSN
          '\\bpassword[:\\s]*\\S+',  // Passwords
        ]
      }),
      priority: 100,
      enabled: true,
    },
    // Location protection
    {
      scope: 'global',
      policy_type: 'llm',
      policy_content: 'Never share exact addresses, home location, or real-time coordinates. City-level location (e.g., "in San Francisco") is acceptable.',
      priority: 90,
      enabled: true,
    },
    // Calendar protection
    {
      scope: 'global',
      policy_type: 'llm',
      policy_content: 'Share calendar availability (free/busy times) freely with friends. Specific event details (meeting names, attendees, descriptions) should only be shared with close friends or explicit approval.',
      priority: 80,
      enabled: true,
    },
  ];
  ```
- **Acceptance Criteria**:
  - [ ] Default policies defined in code
  - [ ] Covers: sensitive patterns, location, calendar

#### 6.2 Create Policies on User Registration
- **ID**: `PERM-019`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: PERM-018
- **Notes**:
  - After successful user registration, create default policies
  - Add to auth.ts registration endpoint
- **Code Location**: `src/routes/auth.ts` - registration handler
- **Acceptance Criteria**:
  - [ ] Default policies created after user registration
  - [ ] Policies have user_id set correctly
  - [ ] No error if policy creation fails (log warning, don't block registration)

---

### 7. Enhanced Message History

#### 7.1 Add Interaction Count to Friends
- **ID**: `PERM-020`
- **Status**: `pending`
- **Priority**: P2
- **Depends on**: None
- **Notes**:
  - Count messages exchanged with each friend
  - Include in GET /friends and context endpoint
- **Implementation**:
  - Query messages table for count
  - Or: add counter column to friendships (updated on message send)
- **Acceptance Criteria**:
  - [ ] GET /friends includes interaction_count
  - [ ] Context endpoint includes interaction_count

#### 7.2 Add Past Interactions to Context
- **ID**: `PERM-021`
- **Status**: `pending`
- **Priority**: P2
- **Depends on**: PERM-012
- **Notes**:
  - Include recent message history in context endpoint
  - Last 5 messages with this user
  - Helps agent maintain conversation continuity
- **Response Addition**:
  ```json
  {
    "recent_interactions": [
      {
        "direction": "sent",
        "message": "Hey, when are you free?",
        "timestamp": "2024-01-30T15:00:00Z"
      },
      {
        "direction": "received",
        "message": "Thursday works for me",
        "timestamp": "2024-01-30T15:05:00Z"
      }
    ]
  }
  ```
- **Acceptance Criteria**:
  - [ ] Last 5 messages included
  - [ ] Both sent and received
  - [ ] Ordered by timestamp (newest last)

---

### 8. Testing

#### 8.1 Unit Tests for Role Functions
- **ID**: `PERM-022`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: PERM-003
- **Notes**:
  - Test role creation, assignment, removal
  - Test policy scope validation
- **Acceptance Criteria**:
  - [ ] Tests for seedSystemRoles()
  - [ ] Tests for role CRUD operations
  - [ ] Tests for friend_roles operations

#### 8.2 Unit Tests for Policy Evaluation with Roles
- **ID**: `PERM-023`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: PERM-011
- **Notes**:
  - Test that role-scoped policies are included
  - Test priority ordering
  - Test multiple roles scenario
- **Acceptance Criteria**:
  - [ ] Test: role policy included when recipient has role
  - [ ] Test: role policy excluded when recipient lacks role
  - [ ] Test: multiple roles = union of policies
  - [ ] Test: priority ordering respected

#### 8.3 Integration Tests for Policy Context Flow
- **ID**: `PERM-024`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: PERM-012
- **Notes**:
  - Full flow: register → befriend → assign role → create policy → get context
- **Acceptance Criteria**:
  - [ ] Context endpoint returns correct policies
  - [ ] Role changes reflected in context
  - [ ] Policy changes reflected in context

#### 8.4 Integration Tests for LLM Policy Evaluation
- **ID**: `PERM-025`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: PERM-016
- **Notes**:
  - Test with mock LLM (for CI)
  - Test with real LLM (manual/staging)
- **Acceptance Criteria**:
  - [ ] Mock test: LLM called with correct prompt
  - [ ] Mock test: PASS/FAIL parsed correctly
  - [ ] Mock test: timeout handled gracefully

---

## Implementation Order

### Sprint 1: Role Foundation (P0)
1. PERM-001: Create user_roles table
2. PERM-002: Create friend_roles table
3. PERM-003: Seed system roles
4. PERM-022: Unit tests for roles

### Sprint 2: Role API (P0)
5. PERM-004: GET /roles
6. PERM-005: POST /roles
7. PERM-006: POST /friends/:id/roles
8. PERM-007: DELETE /friends/:id/roles/:role
9. PERM-008: GET /friends/:id/roles
10. PERM-009: Update GET /friends

### Sprint 3: Role Policies (P0)
11. PERM-010: Update policy schema for role scope
12. PERM-011: Update policy evaluation for roles
13. PERM-023: Unit tests for role policy evaluation

### Sprint 4: Policy Context (P0)
14. PERM-012: GET /policies/context/:username
15. PERM-014: Update SKILL.md
16. PERM-024: Integration tests

### Sprint 5: LLM Evaluation (P1)
17. PERM-015: LLM client configuration
18. PERM-016: LLM policy evaluation
19. PERM-025: LLM evaluation tests

### Sprint 6: Default Policies (P1)
20. PERM-018: Default policy templates
21. PERM-019: Create on registration

### Sprint 7: Enhancements (P2)
22. PERM-013: Policy summary generation
23. PERM-017: Policy evaluation caching
24. PERM-020: Interaction count
25. PERM-021: Past interactions in context

---

## Notes

### Policy Evaluation Flow (Complete)

```
Agent receives message from Alice
         ↓
Agent calls: GET /api/v1/policies/context/alice
         ↓
Server returns:
  - Alice's relationship info (roles: [close_friends])
  - Applicable policies (global + role:close_friends + user:alice)
         ↓
Agent crafts response knowing constraints
         ↓
Agent calls: POST /api/v1/messages/send
         ↓
Server evaluates message against same policies
         ↓
If PASS: message delivered
If FAIL: rejection returned, agent can rephrase
```

### Server-Only vs Plugin Mode

All these features work in both modes:
- **Server-only (TRUSTED_MODE=true)**: Server evaluates policies, agent uses context endpoint
- **Plugin mode (TRUSTED_MODE=false)**: Plugin can fetch context, evaluate locally

### Migration Safety

All database migrations should be:
- Additive (new tables/columns, not modifications)
- Backwards compatible
- Tested in staging before production
