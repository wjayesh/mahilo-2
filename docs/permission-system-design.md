# Mahilo Permission System: Design Document

> **Status**: Design Phase
> **Last Updated**: 2026-01-30
> **Core Thesis**: Permissions should be learned, not configured. The agent builds a model of user preferences through natural interaction, and Mahilo enforces these as policies.

---

## Table of Contents

1. [The Core Problem](#the-core-problem)
2. [Design Principles](#design-principles)
3. [The Three-Layer Model](#the-three-layer-model)
4. [Where Do Nuances Live? (Policies)](#where-do-nuances-live-policies)
5. [Policy Types and Scopes](#policy-types-and-scopes)
6. [Policy Retrieval Optimization](#policy-retrieval-optimization)
7. [The Learning-to-Policy Pipeline](#the-learning-to-policy-pipeline)
8. [Message Type Taxonomy](#message-type-taxonomy)
9. [Request/Response Tracking](#requestresponse-tracking)
10. [The Plugin Prompt Injection](#the-plugin-prompt-injection)
11. [Inbound Request Handling](#inbound-request-handling)
12. [Implementation Considerations](#implementation-considerations)

---

## The Core Problem

When Alice's agent asks Bob's agent "What's on your calendar tomorrow?", multiple decisions need to happen:

1. Can Bob's agent access Bob's calendar at all? (Capability)
2. Can Bob's agent share calendar info with Alice? (Sharing Policy)
3. At what granularity? (availability vs. event details)
4. Should this request even reach Bob's agent? (Request Policy)

**The tension**: Users don't want to configure everything upfront (high friction), but we can't rely purely on agent judgment (no enforcement).

**The solution**: Agent learns preferences through natural interaction → preferences are converted to Mahilo policies → Mahilo enforces policies as a safety net.

---

## Design Principles

### 1. Learn, Don't Configure
Users shouldn't fill out permission forms. They respond naturally ("just tell her I'm free, not the details") and the system learns.

### 2. One Decision, Many Applications
When a user makes a decision, the agent should ask: "Should I apply this to all friends, or just Alice?" One interaction creates a rule that handles hundreds of future cases.

### 3. Agent Learns, Mahilo Enforces
The agent uses judgment to make decisions, but Mahilo validates outbound messages against stored policies. We don't rely solely on agent judgment — there's always a policy enforcement layer.

### 4. Graceful Degradation
Instead of hard yes/no, agents can share partial information: "Bob has something tomorrow afternoon but I'd need to check with him for specifics."

### 5. Transparent Reasoning
Users always know what was shared and why. This builds trust and allows correction.

### 6. Context Over Rules
Provide rich context to agents (who's asking, past decisions, trust level) and let them make informed judgments, rather than rigid rule matching.

---

## The Three-Layer Model

### Layer 1: Capability (What Can My Agent Access?)

This is about the agent's relationship with the user's data and integrations.

| Integration | Access Level | Example |
|-------------|--------------|---------|
| Calendar | read | Can see events |
| Calendar | write | Can create/modify events |
| Location | current | Can see current location |
| Location | history | Can see location history |
| Contacts | read | Can see contact list |
| Email | read | Can read emails |

**Where this lives**: Configured when setting up the agent (standard OAuth-style). This is NOT about sharing — just about what the agent can access for the user's own benefit.

**Mahilo's role**: Mahilo doesn't manage this layer directly. This is between the user and their agent framework (Clawdbot, etc.).

### Layer 2: Sharing Policy (What Can My Agent Share?)

This is about the agent's relationship with other agents — what information can flow outward.

| Data Type | Granularity | With Whom | Decision |
|-----------|-------------|-----------|----------|
| Calendar | availability (free/busy) | friends | auto-share |
| Calendar | event details | friends | ask user |
| Calendar | event details | close_friends | auto-share |
| Location | city | friends | auto-share |
| Location | exact address | anyone | always ask |

**Where this lives**: As policies in Mahilo, learned through interaction.

**Mahilo's role**:
- Stores policies (learned from agent interactions)
- Evaluates outbound messages against policies
- Rejects messages that violate policies (safety net)

### Layer 3: Request Policy (What Can Other Agents Ask?)

This is about other agents' relationship with my agent — what requests are allowed to reach my agent.

| Request Type | From Whom | Action |
|--------------|-----------|--------|
| Any | blocked users | reject at Mahilo, never reaches agent |
| Location requests | unknown agents | reject at Mahilo |
| Calendar requests | friends | allow, provide context |
| Urgent/emergency framing | anyone | flag as potential manipulation |

**Where this lives**: As policies in Mahilo.

**Mahilo's role**:
- Filters inbound messages before delivery
- Blocked message types never reach the agent
- Allowed messages are delivered with enriched context

---

## Where Do Nuances Live? (Policies)

**Answer: In Mahilo, as policies.**

The agent learns preferences through conversation, but those preferences are quantified and stored as enforceable policies in Mahilo. This is critical because:

1. **We can't rely on agent judgment alone** — agents can make mistakes, be manipulated, or hallucinate
2. **Policies provide a safety net** — even if the agent tries to share something it shouldn't, Mahilo blocks it
3. **Policies are portable** — if the user switches agent frameworks, their preferences travel with them
4. **Policies are auditable** — users can see exactly what rules govern their data

### The Flow

```
User says: "Don't share my event details with anyone"
              ↓
Agent understands the preference
              ↓
Agent calls Mahilo API: POST /api/v1/policies
{
  "scope": "global",
  "policy_type": "llm",
  "policy_content": "Reject any outbound message that contains specific calendar event details (event names, attendees, descriptions). Availability (free/busy) is allowed."
}
              ↓
Policy stored in Mahilo
              ↓
Future: Agent tries to send event details
              ↓
Mahilo evaluates against policies → REJECTED
              ↓
Agent receives rejection, can rephrase or ask user
```

---

## Policy Types and Scopes

### Policy Types

#### 1. Heuristic Policies (Fast, Deterministic)
Pattern-based rules that can be evaluated without LLM calls.

```json
{
  "policy_type": "heuristic",
  "policy_content": {
    "blockedPatterns": ["\\b\\d{16}\\b", "SSN", "credit card"],
    "maxLength": 1000,
    "requireContext": true
  }
}
```

**Use cases**:
- Block obvious sensitive patterns (credit cards, SSN)
- Enforce message length limits
- Require context for all messages

#### 2. LLM Policies (Sophisticated, Contextual)
Natural language rules evaluated by an LLM.

```json
{
  "policy_type": "llm",
  "policy_content": "Allow sharing calendar availability (free/busy times) but reject any message that contains specific event details like event names, meeting titles, attendee names, or event descriptions."
}
```

**Use cases**:
- Nuanced content filtering ("availability yes, details no")
- Context-dependent decisions
- Intent analysis

### Policy Scopes

#### 1. Global Policies
Apply to all outbound messages from this user.

```json
{
  "scope": "global",
  "target_id": null,
  "policy_content": "Never share exact location or home address"
}
```

#### 2. Per-User Policies
Apply to messages sent to a specific friend.

```json
{
  "scope": "user",
  "target_id": "alice_user_id",
  "policy_content": "With Alice, share work calendar but not personal calendar"
}
```

#### 3. Per-Group Policies (Chat Groups)
Apply to messages sent to a specific Mahilo group.

```json
{
  "scope": "group",
  "target_id": "work_team_group_id",
  "policy_content": "In work group, keep discussions professional. No personal health or family information."
}
```

#### 4. Per-Role Policies (Trust Tiers) — NEW
Apply to messages sent to users with a specific trust level/tag.

```json
{
  "scope": "role",
  "target_id": "close_friends",
  "policy_content": "With close friends, calendar event details are okay to share"
}
```

**Role examples**:
- `close_friends` — highest trust, more sharing allowed
- `friends` — standard trust
- `acquaintances` — limited trust
- `work_contacts` — professional context only
- `unknown` — minimal sharing, ask for most things

**Note**: Users can tag their friends with roles. A friend can have multiple roles.

### Policy Evaluation Order

1. Check if recipient is blocked → reject immediately
2. Evaluate global policies (highest priority first)
3. Evaluate role-based policies (if recipient has roles)
4. Evaluate per-user policies (most specific)
5. Evaluate per-group policies (if sending to group)

If ANY policy fails → message rejected with feedback.

---

## Policy Retrieval Optimization

### The Problem: Policy Explosion

Over time, a user's agent learns many nuances. After 2 months of use, you might have hundreds of LLM policies:

```
- "Share availability with friends but not event details"
- "With Alice specifically, work calendar is okay"
- "Never share location with acquaintances"
- "In the work group, keep things professional"
- "Don't mention health appointments to anyone"
- ... (hundreds more)
```

If we dump all 1000 lines of policies into an LLM call for every message, that's:
- Slow (high latency)
- Expensive (many tokens)
- Potentially confusing (too much context)

### Solution: Hierarchical Policy Retrieval

We use a funnel approach to narrow down relevant policies:

```
All Policies (1000)
       ↓
 Filter by scope (recipient, role, group)
       ↓
Candidate Policies (50-100)
       ↓
 Filter by resource/action
       ↓
Relevant Policies (10-20)
       ↓
 Vector search for semantic relevance
       ↓
Final Policies (3-5)
       ↓
 LLM evaluation
```

### Step 1: Scope Filtering (Fast, Database Query)

```sql
SELECT * FROM policies WHERE
  user_id = :sender_user_id
  AND (
    scope = 'global'
    OR (scope = 'user' AND target_id = :recipient_user_id)
    OR (scope = 'role' AND target_id IN (:recipient_roles))
    OR (scope = 'group' AND target_id = :group_id)
  )
  AND enabled = true
ORDER BY priority DESC;
```

This reduces 1000 policies to maybe 50-100 relevant ones.

### Step 2: Resource/Action Filtering (Fast, Database Query)

Filter by the message's resource and action:

```sql
-- Policies can be scoped to specific resources/actions
SELECT * FROM policies WHERE
  id IN (:candidate_policy_ids)
  AND (
    applicable_resource IS NULL  -- applies to all resources
    OR applicable_resource = :message_resource
  )
  AND (
    applicable_actions IS NULL  -- applies to all actions
    OR :message_action IN (SELECT value FROM json_each(applicable_actions))
  )
  AND (
    applicable_direction IS NULL  -- applies to both request/response
    OR applicable_direction = :message_direction
  );
```

**Enhanced Policy Schema:**

```json
{
  "policy_type": "llm",
  "policy_content": "For location responses, only share city-level location, never exact address or real-time location.",
  "applicable_resource": "location",
  "applicable_actions": ["read_current", "read_coarse", "read_history"],
  "applicable_direction": "response"
}
```

This reduces 50-100 policies to maybe 10-20.

### Step 3: Vector Search (Semantic Relevance)

For the remaining policies, use vector embeddings to find the most semantically relevant:

```typescript
// Embed the outgoing message
const messageEmbedding = await embed(outgoingMessage);

// Find policies with similar content
const relevantPolicies = await vectorSearch({
  collection: 'policy_embeddings',
  query: messageEmbedding,
  filter: { policy_id: { $in: candidatePolicyIds } },
  limit: 5
});
```

**When to embed policies:**
- On policy creation/update, compute and store embedding of `policy_content`
- Embedding captures semantic meaning ("calendar availability" ≈ "schedule free time")

This reduces 10-20 policies to the 3-5 most relevant.

### Step 4: LLM Evaluation (Final Check)

Now we call the LLM with only 3-5 highly relevant policies:

```typescript
const evaluation = await llm.evaluate({
  message: outgoingMessage,
  policies: relevantPolicies,  // Just 3-5, not 1000
  prompt: `
    Check if this message violates any of the following policies.
    Message: "${outgoingMessage}"

    Policies:
    ${relevantPolicies.map(p => `- ${p.policy_content}`).join('\n')}

    For each policy, respond PASS or FAIL with brief explanation.
  `
});
```

### Optimization Summary

| Stage | Method | Input | Output | Speed |
|-------|--------|-------|--------|-------|
| 1. Scope filter | SQL query | 1000 | 50-100 | <10ms |
| 2. Resource/action filter | SQL query | 50-100 | 10-20 | <5ms |
| 3. Vector search | Embedding similarity | 10-20 | 3-5 | <50ms |
| 4. LLM evaluation | LLM call | 3-5 | Pass/Fail | ~500ms |

**Total: ~600ms** vs **several seconds** for naive approach.

### When to Skip Steps

- **No action specified?** Filter by resource only, then vector search
- **Few total policies (<20)?** Skip vector search, send all to LLM
- **Heuristic policies only?** Skip LLM entirely, evaluate patterns directly

### Policy Embedding Storage

```sql
-- Add to policies table
ALTER TABLE policies ADD COLUMN embedding BLOB;  -- Vector embedding
ALTER TABLE policies ADD COLUMN applicable_types TEXT;  -- JSON array of message types

-- Or separate table for vector search
CREATE TABLE policy_embeddings (
  policy_id TEXT PRIMARY KEY REFERENCES policies(id),
  embedding BLOB NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## The Learning-to-Policy Pipeline

This is how agent learning becomes enforceable policy.

### Step 1: Natural Interaction

```
Alice's agent: "What's Bob doing tomorrow?"

Bob's agent to Bob: "Alice is asking about your calendar. What should I share?"

Bob: "Just tell her I'm free after 3, don't mention the dentist appointment"
```

### Step 2: Agent Extracts Preference

The agent understands:
- Share: availability/free-busy times
- Don't share: specific event details
- Context: this was about calendar, with a friend

### Step 3: Agent Generalizes (One Decision, Many Applications)

Agent to Bob: "Got it. Should I apply this rule to all friends, or just Alice?"

Bob: "All friends is fine"

### Step 4: Agent Creates Policy via Mahilo API

```
POST /api/v1/policies
{
  "scope": "role",
  "target_id": "friends",
  "policy_type": "llm",
  "policy_content": "For calendar-related questions: share availability (free/busy, general time slots) but do not share specific event details (event names, descriptions, attendees, locations of specific events).",
  "priority": 10
}
```

### Step 5: Mahilo Stores and Enforces

Future messages are validated against this policy. If Bob's agent accidentally includes "dentist appointment at 2pm", Mahilo rejects it.

### Step 6: Feedback Loop

If rejected, agent can:
- Rephrase the message
- Ask Bob for guidance
- Learn that this type of content triggers rejection

---

## Message Type System

### What Types Are (and Aren't) For

Before diving into the design, it's important to understand what message types actually help with:

| Purpose | Types Help? | Why |
|---------|-------------|-----|
| **Security enforcement** | **No** | Content must be analyzed — a malicious agent can lie about the type |
| **Policy retrieval optimization** | **Yes** | Filter policies by resource/action before expensive LLM calls |
| **Context for receiving agent** | **Somewhat** | Hints at intent, but agent should verify against content |
| **Logging/analytics** | **Yes** | Understand communication patterns across users |
| **Rate limiting by category** | **Yes** | "Max 10 location requests/hour from acquaintances" |
| **Request/response correlation** | **Yes** | Link responses to their originating requests |

**Key insight**: Types are for **organization and optimization**, not security. A `type: calendar_request` message could still contain "where are you?" in the content. Real security comes from content-based LLM policies.

### Design: Primitives + Structured Metadata

Instead of a flat enumeration of 100+ specific types, we use a composable structure:

**Why not flat types?**
```
# Flat approach - becomes unmanageable
location_current_request
location_coarse_request
location_subscribe_request
location_eta_request
location_verify_proximity_request
location_checkin_request
calendar_availability_request
calendar_propose_hold_request
calendar_confirm_request
... (endless growth)
```

**Problems with flat types:**
- Endless enum growth
- Brittle interop (every new action needs a new type)
- Version explosion
- Hard to compose actions
- Policies become lists of 50 types

**Better: Primitives + metadata**
```json
{
  "direction": "request",
  "resource": "location",
  "action": "subscribe",
  "schema": "mahilo.location.subscribe.v1"
}
```

This keeps the protocol stable while letting "what is being attempted" be expressed as (direction, resource, action) + optional schema version.

### The Type Structure

```typescript
interface MessageType {
  // Required: One of four primitives
  direction: 'request' | 'response' | 'notification' | 'error';

  // Required: What resource/domain this is about
  resource: 'calendar' | 'location' | 'document' | 'contact' | 'action' | 'meta';

  // Optional: Specific action on the resource
  action?: string;

  // Optional: Schema version for structured payloads
  schema?: string;
}
```

### Direction Primitives

| Direction | Description | Example |
|-----------|-------------|---------|
| `request` | Asking for information or action | "When is Bob free?" |
| `response` | Replying to a request | "Bob is free Thursday" |
| `notification` | One-way informational message | "Bob's schedule changed" |
| `error` | Error or inability to fulfill | "I can't access Bob's calendar" |

### Resource Domains

| Resource | Description | Example Actions |
|----------|-------------|-----------------|
| `calendar` | Schedule, availability, events | `read_availability`, `read_details`, `propose_hold`, `confirm`, `cancel` |
| `location` | Whereabouts, places | `read_current`, `read_coarse`, `read_history`, `subscribe`, `share_eta`, `verify_proximity`, `checkin` |
| `document` | Files, content | `read`, `summarize`, `share`, `request_access` |
| `contact` | People, introductions | `introduce`, `share_info`, `connect` |
| `action` | Tasks, reminders, approvals | `remind`, `approve`, `execute`, `delegate` |
| `meta` | System-level communication | `capabilities`, `escalate`, `acknowledge`, `ping` |

### Example: Location Resource Actions

Location is a great example of why (resource, action) is better than flat types:

| Action | Privacy Shape | Description |
|--------|---------------|-------------|
| `read_current` | High sensitivity | Exact current location |
| `read_coarse` | Medium sensitivity | City-level only |
| `read_history` | High sensitivity | Past locations |
| `subscribe` | Very high | Stream updates for N hours |
| `share_eta` | Medium | ETA to destination, not raw coordinates |
| `verify_proximity` | Low | "Are we within 50m?" — yes/no, no location revealed |
| `checkin` | User-initiated | "I'm here" event |

These are materially different privacy shapes. With flat types, you'd need 7+ types just for location. With (resource, action), you have one resource and composable actions.

### Example: Calendar Resource Actions

| Action | Description |
|--------|-------------|
| `read_availability` | Free/busy windows |
| `read_details` | Event names, attendees, descriptions |
| `propose_hold` | Suggest a tentative time |
| `confirm` | Confirm a proposed time |
| `cancel` | Cancel an event |
| `explain_constraints` | "I can't do mornings" |

### Message Examples

**Request for calendar availability:**
```json
{
  "direction": "request",
  "resource": "calendar",
  "action": "read_availability",
  "content": "When is Bob free this week?"
}
```

**Response with availability:**
```json
{
  "direction": "response",
  "resource": "calendar",
  "action": "read_availability",
  "in_response_to": "msg_123",
  "content": "Bob is free Thursday after 2pm and Friday morning."
}
```

**Request for coarse location:**
```json
{
  "direction": "request",
  "resource": "location",
  "action": "read_coarse",
  "content": "What city is Bob in?"
}
```

**Notification (no request):**
```json
{
  "direction": "notification",
  "resource": "calendar",
  "action": "update",
  "content": "Heads up: Bob's Thursday afternoon just got booked."
}
```

**Error response:**
```json
{
  "direction": "error",
  "resource": "calendar",
  "in_response_to": "msg_123",
  "content": "I don't have access to Bob's calendar."
}
```

### Schema Versioning (Optional)

For structured payloads, schemas allow evolution without breaking changes:

```json
{
  "direction": "request",
  "resource": "location",
  "action": "subscribe",
  "schema": "mahilo.location.subscribe.v1",
  "content": "...",
  "structured_payload": {
    "duration_hours": 2,
    "granularity": "city",
    "update_frequency_minutes": 30
  }
}
```

Schemas are namespaced: `mahilo.{resource}.{action}.v{version}`

### Validation

Mahilo validates the structure, not an enum:

```typescript
const VALID_DIRECTIONS = ['request', 'response', 'notification', 'error'];
const VALID_RESOURCES = ['calendar', 'location', 'document', 'contact', 'action', 'meta'];

// Known actions per resource (for validation/suggestions, not strict enforcement)
const KNOWN_ACTIONS: Record<string, string[]> = {
  calendar: ['read_availability', 'read_details', 'propose_hold', 'confirm', 'cancel', 'explain_constraints'],
  location: ['read_current', 'read_coarse', 'read_history', 'subscribe', 'share_eta', 'verify_proximity', 'checkin'],
  document: ['read', 'summarize', 'share', 'request_access'],
  contact: ['introduce', 'share_info', 'connect'],
  action: ['remind', 'approve', 'execute', 'delegate'],
  meta: ['capabilities', 'escalate', 'acknowledge', 'ping']
};

function validateMessageType(msg: Message): ValidationResult {
  if (!VALID_DIRECTIONS.includes(msg.direction)) {
    return { valid: false, error: `Invalid direction: ${msg.direction}` };
  }
  if (!VALID_RESOURCES.includes(msg.resource)) {
    return { valid: false, error: `Invalid resource: ${msg.resource}` };
  }
  // Action validation is a warning, not an error (allows extension)
  if (msg.action && !KNOWN_ACTIONS[msg.resource]?.includes(msg.action)) {
    return { valid: true, warning: `Unknown action '${msg.action}' for resource '${msg.resource}'` };
  }
  return { valid: true };
}
```

### API Endpoint for Type Discovery

```
GET /api/v1/message-schema

Response:
{
  "directions": ["request", "response", "notification", "error"],
  "resources": {
    "calendar": {
      "description": "Schedule, availability, events",
      "actions": [
        { "name": "read_availability", "description": "Get free/busy windows" },
        { "name": "read_details", "description": "Get event details" },
        { "name": "propose_hold", "description": "Suggest a tentative time" },
        ...
      ]
    },
    "location": {
      "description": "Whereabouts, places",
      "actions": [
        { "name": "read_current", "description": "Current exact location" },
        { "name": "read_coarse", "description": "City-level location" },
        ...
      ]
    },
    ...
  },
  "version": "1.0"
}
```

### Resource-Based Policies

Policies target (resource, action) combinations:

**Block all location requests from acquaintances:**
```json
{
  "scope": "role",
  "target_id": "acquaintances",
  "policy_type": "resource_block",
  "resource": "location",
  "action": "*",
  "effect": "deny"
}
```

**Allow coarse location only for friends:**
```json
{
  "scope": "role",
  "target_id": "friends",
  "policy_type": "resource_rule",
  "resource": "location",
  "action": "read_coarse",
  "effect": "allow"
}
```

**LLM policy scoped to calendar responses:**
```json
{
  "scope": "global",
  "policy_type": "llm",
  "policy_content": "When sharing calendar details, never include attendee names or meeting descriptions. Only share time slots.",
  "applicable_resource": "calendar",
  "applicable_actions": ["read_details"]
}
```

### Response Type Inference

When responding to a request, the response type is predictable:

```typescript
function inferResponseType(request: Message): Partial<MessageType> {
  return {
    direction: 'response',
    resource: request.resource,
    action: request.action  // Usually the same action
  };
}
```

The plugin can auto-suggest: "This looks like a response to a calendar/read_availability request."

### Adding New Actions

New actions can be added without protocol changes:

1. **Agent uses new action**: `action: "share_eta"` for location
2. **Mahilo logs warning**: "Unknown action 'share_eta' for resource 'location'"
3. **If pattern emerges**: Add to known actions in next release
4. **No breaking changes**: Old agents ignore, new agents can use

### Extensibility via Custom Resources

For domain-specific use cases, custom resources can be namespaced:

```json
{
  "direction": "request",
  "resource": "custom.fitness",
  "action": "read_workout_history",
  "schema": "myapp.fitness.workout.v1"
}
```

Custom resources are allowed but not validated by Mahilo (pass-through).

---

## Request/Response Tracking

### Why Track Request/Response Pairs?

To provide rich context for future interactions:
> "Past similar decisions:
> - 2024-01-20: Carol (friend) asked `calendar_availability_request`
>   → You responded `calendar_availability_response`: "Bob is free Thursday afternoon"
>   → Outcome: shared (availability only)
> - 2024-01-18: Dan (acquaintance) asked `calendar_details_request`
>   → You responded `meta_escalation`: "I'd need to check with Bob first"
>   → Outcome: escalated → Bob approved availability only"

This context helps agents make consistent decisions and shows users what happened.

### The Full Tracking Model

```
┌─────────────────────────────────────────────────────────────────┐
│                      REQUEST ARRIVES                             │
│  message_id: msg_001                                            │
│  from: alice                                                    │
│  to: bob                                                        │
│  direction: request                                             │
│  resource: calendar                                             │
│  action: read_availability                                      │
│  content: "When is Bob free this week?"                         │
│  timestamp: 2024-01-20T10:00:00Z                                │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                    Bob's agent processes
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      RESPONSE SENT                               │
│  message_id: msg_002                                            │
│  from: bob                                                      │
│  to: alice                                                      │
│  direction: response                                            │
│  resource: calendar                                             │
│  action: read_availability                                      │
│  content: "Bob is free Thursday after 2pm"                      │
│  in_response_to: msg_001  ←── LINKS TO REQUEST                  │
│  timestamp: 2024-01-20T10:00:05Z                                │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                    Plugin reports outcome
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    OUTCOME RECORDED                              │
│  request_id: msg_001                                            │
│  response_id: msg_002                                           │
│  outcome: shared                                                │
│  outcome_details: "Shared availability (free/busy), no event    │
│                    details per user preference"                 │
│  policy_applied: [policy_123, policy_456]                       │
│  user_involved: false (auto-approved)                           │
└─────────────────────────────────────────────────────────────────┘
```

### Enhanced Message Schema

```sql
-- Core message type (primitives + metadata)
ALTER TABLE messages ADD COLUMN direction TEXT NOT NULL;      -- 'request', 'response', 'notification', 'error'
ALTER TABLE messages ADD COLUMN resource TEXT NOT NULL;       -- 'calendar', 'location', etc.
ALTER TABLE messages ADD COLUMN action TEXT;                  -- 'read_availability', 'read_coarse', etc.
ALTER TABLE messages ADD COLUMN in_response_to TEXT REFERENCES messages(id);

-- Outcome tracking (on responses)
ALTER TABLE messages ADD COLUMN outcome TEXT;
  -- 'shared' = information was shared as requested
  -- 'partial' = some info shared, some withheld
  -- 'declined' = request was declined
  -- 'escalated' = asked user for guidance
  -- 'error' = something went wrong

ALTER TABLE messages ADD COLUMN outcome_details TEXT;
  -- Human-readable explanation: "Shared availability only, withheld event details"

ALTER TABLE messages ADD COLUMN policies_evaluated TEXT;
  -- JSON array of policy IDs that were checked

ALTER TABLE messages ADD COLUMN user_involved BOOLEAN DEFAULT FALSE;
  -- TRUE if user was asked for input on this decision

-- Indexes for efficient querying
CREATE INDEX idx_messages_resource ON messages(resource);
CREATE INDEX idx_messages_resource_action ON messages(resource, action);
CREATE INDEX idx_messages_in_response_to ON messages(in_response_to);
CREATE INDEX idx_messages_resource_sender ON messages(resource, sender_user_id);
```

### Tracking Flow in Detail

#### Step 1: Inbound Request Logged

```typescript
// When Mahilo receives an inbound message
await db.insert(messages).values({
  id: 'msg_001',
  sender_user_id: 'alice_id',
  recipient_id: 'bob_id',
  direction: 'request',
  resource: 'calendar',
  action: 'read_availability',
  payload: 'When is Bob free this week?',
  status: 'delivered',
  // in_response_to: null (this is a new request)
});
```

#### Step 2: Response Linked to Request

```typescript
// When Bob's agent sends a response
POST /api/v1/messages/send
{
  "recipient": "alice",
  "message": "Bob is free Thursday after 2pm",
  "direction": "response",
  "resource": "calendar",
  "action": "read_availability",
  "in_response_to": "msg_001"  // ← Links to original request
}
```

Mahilo validates:
- `msg_001` exists
- `msg_001` was sent by Alice to Bob
- Response resource/action matches the request

#### Step 3: Outcome Reported

The plugin reports what happened:

```typescript
// After the message is sent (or blocked)
POST /api/v1/messages/:id/outcome
{
  "outcome": "partial",
  "outcome_details": "Shared availability (Thursday afternoon). Withheld event details per global policy.",
  "policies_evaluated": ["policy_123", "policy_456"],
  "user_involved": false
}
```

Alternatively, outcome can be included in the send request:

```typescript
POST /api/v1/messages/send
{
  "recipient": "alice",
  "message": "Bob is free Thursday after 2pm",
  "message_type": "calendar_availability_response",
  "in_response_to": "msg_001",
  "outcome_metadata": {
    "outcome": "partial",
    "outcome_details": "Shared availability only"
  }
}
```

### Querying History for Context

#### Get Past Similar Interactions

```
GET /api/v1/messages/history?
  resource=calendar&
  action=read_availability&
  include_responses=true&
  limit=5

Response:
{
  "interactions": [
    {
      "request": {
        "id": "msg_001",
        "from": "alice",
        "direction": "request",
        "resource": "calendar",
        "action": "read_availability",
        "content": "When is Bob free this week?",
        "timestamp": "2024-01-20T10:00:00Z"
      },
      "response": {
        "id": "msg_002",
        "direction": "response",
        "resource": "calendar",
        "action": "read_availability",
        "content": "Bob is free Thursday after 2pm",
        "outcome": "shared",
        "outcome_details": "Shared availability only",
        "timestamp": "2024-01-20T10:00:05Z"
      }
    },
    // ... more interactions
  ]
}
```

#### Get Interactions with Specific Person

```
GET /api/v1/messages/history?
  with_user=alice&
  include_responses=true&
  limit=10
```

#### Get All Location-Related Interactions

```
GET /api/v1/messages/history?
  resource=location&
  include_responses=true
```

#### Get All Escalated Interactions

```
GET /api/v1/messages/history?
  outcome=escalated&
  include_responses=true
```

### Using History in Context Injection

The plugin fetches relevant history and formats it:

```typescript
async function getRelevantHistory(
  senderUsername: string,
  messageType: string
): Promise<FormattedHistory[]> {
  // Get past interactions of same type from same sender
  const sameSenderSameType = await mahilo.getHistory({
    with_user: senderUsername,
    message_type: messageType,
    include_responses: true,
    limit: 3
  });

  // Get past interactions of same type from anyone
  const sameTypeAnyUser = await mahilo.getHistory({
    message_type: messageType,
    include_responses: true,
    limit: 3
  });

  return formatForPrompt([...sameSenderSameType, ...sameTypeAnyUser]);
}
```

### Summarization Option (LLM-Assisted)

For very active users, raw history might be overwhelming. Option to summarize:

```
GET /api/v1/messages/history?
  message_type=calendar_availability_request&
  summarize=true

Response:
{
  "summary": "Over the past month, you've received 12 calendar availability requests. You typically share free/busy times but not event details. With close friends (Alice, Carol), you've occasionally shared event names. You escalated to Bob twice when the request seemed unusual.",
  "patterns": [
    { "rule": "availability with friends", "frequency": 10, "typical_outcome": "shared" },
    { "rule": "event details with close_friends", "frequency": 2, "typical_outcome": "shared" }
  ]
}
```

This can be computed on-demand or pre-computed periodically.

---

## The Plugin Prompt Injection

The Mahilo plugin injects context into the agent at two key moments:
1. **On receiving a message** — Who's asking, what policies apply, past similar interactions
2. **After sending a response** — What was shared, what was learned, prompting for generalization

### Part 1: Incoming Message Context

This is injected when a message arrives from another agent.

```markdown
═══════════════════════════════════════════════════════════════════════════════
MAHILO: INCOMING MESSAGE
═══════════════════════════════════════════════════════════════════════════════

FROM: alice
  → Display name: Alice Chen
  → Relationship: friend (connected since January 15, 2024)
  → Trust level: friend
  → Roles: [close_friends, work_contacts]
  → Past interactions: 23 messages exchanged

MESSAGE TYPE:
  → Direction: request
  → Resource: calendar
  → Action: read_availability

MESSAGE:
"Hey! Alice's agent here. Alice is trying to schedule a coffee chat
with Bob sometime this week. When might Bob be free?"

═══════════════════════════════════════════════════════════════════════════════
CONTEXT FOR YOUR RESPONSE
═══════════════════════════════════════════════════════════════════════════════

YOUR ACTIVE POLICIES (relevant to calendar/read_availability):
  • [policy_123] Calendar availability with friends: AUTO-SHARE
  • [policy_456] Calendar event details with friends: ASK BOB FIRST
  • [policy_789] Calendar event details with close_friends: AUTO-SHARE

  Note: Alice has role [close_friends], so event details are allowed.

PAST SIMILAR INTERACTIONS (calendar/read_availability):

  From Alice (this sender):
    • 2024-01-15: request → calendar/read_availability
      → You responded: "Bob is free Wednesday afternoon"
      → Outcome: shared (availability only)

  From others:
    • 2024-01-20: Carol (friend) → request → calendar/read_availability
      → You responded: "Bob is free Thursday afternoon"
      → Outcome: shared (availability only)

    • 2024-01-18: Dan (acquaintance) → request → calendar/read_details
      → You responded: "I'd need to check with Bob first"
      → Outcome: escalated → Bob approved availability only

DECISIONS BOB HAS MADE (relevant):
  • "Share availability with friends" (learned 2024-01-10)
  • "Alice is a close friend, she can know more details" (learned 2024-01-16)
  • "Never share health appointment details" (learned 2024-01-08)

═══════════════════════════════════════════════════════════════════════════════
GUIDANCE
═══════════════════════════════════════════════════════════════════════════════

Based on policies and past behavior, you MAY share:
  ✓ General availability (free/busy)
  ✓ Specific time slots
  ✓ Event details (Alice is close_friend) — but NOT health appointments

Your response will be validated against Bob's policies before delivery.
If it violates a policy, you'll be notified and can rephrase.

WHEN TO ASK BOB:
  → The request seems unusual for this relationship
  → You're unsure about the appropriate level of detail
  → The request involves sensitive topics not covered by policies
  → This is a new type of request you haven't handled before

═══════════════════════════════════════════════════════════════════════════════
```

### Part 2: Post-Response Transparency Note

After the agent sends a response, the plugin injects a transparency note. This serves multiple purposes:
- Informs the user what was shared
- Creates an audit trail
- Prompts for learning opportunities

```markdown
═══════════════════════════════════════════════════════════════════════════════
MAHILO: MESSAGE SENT ✓
═══════════════════════════════════════════════════════════════════════════════

TO: alice (in response to calendar_availability_request)

WHAT YOU SENT:
"Bob is free Thursday after 2pm and Friday morning. He has a team standup
Thursday at 10am but otherwise flexible. Want me to block off a time?"

POLICY CHECK: ✓ PASSED
  • Evaluated 3 policies
  • No violations detected

WHAT WAS SHARED:
  • ✓ Availability information (allowed: friends + close_friends)
  • ✓ Event detail: "team standup" (allowed: close_friends only)

WHAT WAS WITHHELD:
  • Bob's dentist appointment at 2pm Tuesday (health-related, always private)

OUTCOME RECORDED:
  • Type: shared (partial)
  • Details: "Shared availability and one work event. Withheld health appointment."

───────────────────────────────────────────────────────────────────────────────
This interaction has been logged. Bob can review anytime in Mahilo dashboard.
═══════════════════════════════════════════════════════════════════════════════
```

### Part 3: Learning Prompt (One Decision → Many Applications)

When the agent makes a decision that could become a general rule, prompt for generalization.

```markdown
═══════════════════════════════════════════════════════════════════════════════
MAHILO: LEARNING OPPORTUNITY
═══════════════════════════════════════════════════════════════════════════════

You just shared work event details with Alice (close_friend).

This might be worth turning into a policy for future interactions.

QUESTIONS TO ASK BOB:

1. "I shared your team standup with Alice since she's a close friend.
    Should I share work event details with all close friends in the future,
    or just Alice?"

    If Bob says "all close friends" → Create policy:
    {
      scope: "role",
      target_id: "close_friends",
      policy_type: "llm",
      policy_content: "Work-related event details (meetings, standups, deadlines)
                       may be shared with close friends."
    }

    If Bob says "just Alice" → Create policy:
    {
      scope: "user",
      target_id: "alice_user_id",
      policy_type: "llm",
      policy_content: "Work-related event details may be shared with Alice."
    }

2. "I withheld your dentist appointment since it's health-related.
    Is that the right call? Should health appointments always stay private?"

    If Bob confirms → Ensure global policy exists:
    {
      scope: "global",
      policy_type: "llm",
      policy_content: "Never share health-related appointments or medical
                       information with anyone, regardless of trust level."
    }

───────────────────────────────────────────────────────────────────────────────
TIP: One thoughtful decision now saves many future interruptions!
═══════════════════════════════════════════════════════════════════════════════
```

### Part 4: Encouraging User Involvement

The prompt should encourage the agent to ask the user when appropriate, rather than guessing.

**Include in the GUIDANCE section:**

```markdown
WHEN TO INVOLVE BOB (ask before responding):

  ALWAYS ASK if:
    • Request type is new (you've never handled this before)
    • Sender is new (first interaction with this person)
    • Request seems sensitive (financial, health, location)
    • You're not confident in the right response

  CONSIDER ASKING if:
    • Request is unusual for this sender
    • Multiple policies give conflicting guidance
    • Sharing could have significant consequences

  OKAY TO PROCEED if:
    • Clear policy match exists
    • Past interactions show consistent pattern
    • Request is routine and low-sensitivity

WHEN YOU DO ASK, frame it helpfully:
  ✓ "Alice is asking about your calendar. Based on past interactions, I'd share
     availability but not event details. Sound right, or would you like me to
     handle it differently?"

  ✗ "Alice wants your calendar info. What should I do?"
     (Too vague — doesn't help Bob make a quick decision)
```

### Part 5: Error/Rejection Handling

When Mahilo rejects a message for policy violation:

```markdown
═══════════════════════════════════════════════════════════════════════════════
MAHILO: MESSAGE BLOCKED ✗
═══════════════════════════════════════════════════════════════════════════════

Your message to alice was not sent.

WHAT YOU TRIED TO SEND:
"Bob is at 123 Main Street right now, he'll be there for another hour."

POLICY VIOLATION:
  • [policy_456] "Never share exact location or home address"
  • Triggered by: "123 Main Street" (exact address detected)

SUGGESTED ALTERNATIVES:
  • Share general area: "Bob is in downtown SF"
  • Share availability: "Bob is busy for the next hour"
  • Ask Bob: "Alice is asking for your exact location. Share it?"

ACTION NEEDED:
  → Rephrase your response to comply with policies, OR
  → Ask Bob if he wants to override this policy for this specific case

═══════════════════════════════════════════════════════════════════════════════
```

### Key Principles for Prompt Injection

1. **Be Specific**: Show exact policy IDs, exact past interactions, exact decisions
2. **Be Actionable**: Clear guidance on what to do, not just what the rules are
3. **Encourage Learning**: Prompt for generalization after novel decisions
4. **Show Work**: Transparency about what was shared, why, and what was withheld
5. **Make Asking Easy**: Frame questions to Bob so they're quick to answer
6. **Build Trust**: Always log, always show, let Bob review anytime

### Technical Implementation

```typescript
interface MahiloPromptContext {
  // Incoming message info
  sender: {
    username: string;
    displayName: string;
    relationship: string;
    connectedSince: Date;
    roles: string[];
    interactionCount: number;
  };
  messageType: string;
  messageContent: string;

  // Policies
  relevantPolicies: Array<{
    id: string;
    scope: string;
    content: string;
    recommendation: 'allow' | 'ask' | 'block';
  }>;

  // History
  pastInteractions: Array<{
    date: Date;
    from: string;
    type: string;
    response: string;
    outcome: string;
  }>;

  // Learned preferences
  relevantDecisions: Array<{
    decision: string;
    learnedDate: Date;
  }>;
}

function formatIncomingPrompt(ctx: MahiloPromptContext): string {
  // Build the structured prompt shown above
}

function formatPostResponsePrompt(
  response: SentMessage,
  policiesChecked: Policy[],
  sharedItems: string[],
  withheldItems: string[]
): string {
  // Build the transparency note shown above
}

function formatLearningPrompt(
  interaction: Interaction,
  potentialRules: PotentialRule[]
): string {
  // Build the learning opportunity prompt
}
```

---

## Inbound Request Handling

### The Philosophy: Context Over Rejection

Instead of rigidly rejecting requests, we:
1. **Block truly unwanted messages** at Mahilo (never reach agent)
2. **Provide rich context** for everything else
3. **Let the agent make informed judgments**
4. **Validate the agent's response** before sending

### What Gets Blocked at Mahilo

These messages never reach the agent:

| Condition | Action |
|-----------|--------|
| Sender is blocked | Reject, don't store |
| Message type blocked for this sender's role | Reject, store in filtered log |
| Sender not a friend (and friendship required) | Reject with "not friends" error |
| Obvious spam/abuse patterns | Reject, flag for review |

### What Gets Delivered with Context

Everything else is delivered, but with context:

| Condition | Context Added |
|-----------|---------------|
| Request from unknown role | "⚠️ New contact, no history" |
| Unusual request pattern | "⚠️ This type of request is uncommon from this person" |
| Urgent framing | "⚠️ Message marked urgent - verify legitimacy" |
| Request for sensitive data | "⚠️ This involves [calendar/location/etc] - check policies" |

### Blocked Message Log

Users should be able to see what was blocked:

```
GET /api/v1/messages/blocked

[
  {
    "from": "spammy_agent",
    "type": "location_request",
    "blocked_reason": "location_request blocked for role: unknown",
    "timestamp": "2024-01-20T10:00:00Z"
  }
]
```

---

## Implementation Considerations

### New API Endpoints Needed

```
# Policy management (already exists, may need extensions)
POST   /api/v1/policies              # Create policy
GET    /api/v1/policies              # List policies
PATCH  /api/v1/policies/:id          # Update policy
DELETE /api/v1/policies/:id          # Delete policy

# New: Policy retrieval for enforcement
GET    /api/v1/policies/evaluate     # Get relevant policies for a message
                                     # (uses scope + type filtering + vector search)

# New: Role/tag management for friends
POST   /api/v1/friends/:id/roles     # Add role to friend
DELETE /api/v1/friends/:id/roles/:role  # Remove role
GET    /api/v1/roles                 # List available roles
POST   /api/v1/roles                 # Create custom role

# New: Message schema (read-only reference)
GET    /api/v1/message-schema        # List directions, resources, actions

# New: Message history with filtering
GET    /api/v1/messages/history      # Query with filters (type, user, outcome)
GET    /api/v1/messages/blocked      # View blocked messages
POST   /api/v1/messages/:id/outcome  # Report outcome of a response

# New: Context endpoint for plugins
GET    /api/v1/context/:username     # Get full context for a sender
                                     # (relationship, roles, history, policies)
```

### Database Schema Changes

```sql
-- ═══════════════════════════════════════════════════════════════════════════
-- MESSAGE TYPE SCHEMA (reference tables for validation)
-- ═══════════════════════════════════════════════════════════════════════════

-- Valid directions (primitives)
CREATE TABLE message_directions (
  direction TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

INSERT INTO message_directions (direction, description) VALUES
  ('request', 'Asking for information or action'),
  ('response', 'Replying to a request'),
  ('notification', 'One-way informational message'),
  ('error', 'Error or inability to fulfill');

-- Valid resources (domains)
CREATE TABLE message_resources (
  resource TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

INSERT INTO message_resources (resource, description) VALUES
  ('calendar', 'Schedule, availability, events'),
  ('location', 'Whereabouts, places'),
  ('document', 'Files, content'),
  ('contact', 'People, introductions'),
  ('action', 'Tasks, reminders, approvals'),
  ('meta', 'System-level communication');

-- Known actions per resource (for validation/suggestions, not strict)
CREATE TABLE message_actions (
  resource TEXT NOT NULL REFERENCES message_resources(resource),
  action TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (resource, action)
);

INSERT INTO message_actions (resource, action, description) VALUES
  -- Calendar
  ('calendar', 'read_availability', 'Get free/busy windows'),
  ('calendar', 'read_details', 'Get event details'),
  ('calendar', 'propose_hold', 'Suggest a tentative time'),
  ('calendar', 'confirm', 'Confirm a proposed time'),
  ('calendar', 'cancel', 'Cancel an event'),
  ('calendar', 'explain_constraints', 'Explain scheduling constraints'),
  -- Location
  ('location', 'read_current', 'Current exact location'),
  ('location', 'read_coarse', 'City-level location'),
  ('location', 'read_history', 'Past locations'),
  ('location', 'subscribe', 'Stream location updates'),
  ('location', 'share_eta', 'Share ETA to destination'),
  ('location', 'verify_proximity', 'Check if within distance'),
  ('location', 'checkin', 'User-initiated check-in'),
  -- Document
  ('document', 'read', 'Read document content'),
  ('document', 'summarize', 'Get document summary'),
  ('document', 'share', 'Share a document'),
  ('document', 'request_access', 'Request access to document'),
  -- Contact
  ('contact', 'introduce', 'Make an introduction'),
  ('contact', 'share_info', 'Share contact information'),
  ('contact', 'connect', 'Request to connect'),
  -- Action
  ('action', 'remind', 'Set a reminder'),
  ('action', 'approve', 'Approve something'),
  ('action', 'execute', 'Execute a task'),
  ('action', 'delegate', 'Delegate to someone'),
  -- Meta
  ('meta', 'capabilities', 'Query capabilities'),
  ('meta', 'escalate', 'Escalate to human'),
  ('meta', 'acknowledge', 'Simple acknowledgment'),
  ('meta', 'ping', 'Health check');


-- ═══════════════════════════════════════════════════════════════════════════
-- FRIEND ROLES
-- ═══════════════════════════════════════════════════════════════════════════

-- Available roles (some system-defined, some user-defined)
CREATE TABLE user_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),         -- NULL for system roles
  name TEXT NOT NULL,                         -- 'close_friends'
  description TEXT,
  is_system BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name)
);

-- Seed system roles
INSERT INTO user_roles (id, user_id, name, description, is_system) VALUES
  ('role_close_friends', NULL, 'close_friends', 'Highest trust tier', TRUE),
  ('role_friends', NULL, 'friends', 'Standard friends', TRUE),
  ('role_acquaintances', NULL, 'acquaintances', 'Casual contacts', TRUE),
  ('role_work_contacts', NULL, 'work_contacts', 'Professional context only', TRUE),
  ('role_family', NULL, 'family', 'Family members', TRUE);

-- Friend-to-role mapping (many-to-many)
CREATE TABLE friend_roles (
  friendship_id TEXT NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,
  role_name TEXT NOT NULL,                   -- references user_roles.name
  assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (friendship_id, role_name)
);

CREATE INDEX idx_friend_roles_role ON friend_roles(role_name);


-- ═══════════════════════════════════════════════════════════════════════════
-- MESSAGE ENHANCEMENTS
-- ═══════════════════════════════════════════════════════════════════════════

-- Message type structure (primitives + metadata)
ALTER TABLE messages ADD COLUMN direction TEXT NOT NULL
  REFERENCES message_directions(direction);
ALTER TABLE messages ADD COLUMN resource TEXT NOT NULL
  REFERENCES message_resources(resource);
ALTER TABLE messages ADD COLUMN action TEXT;                 -- optional, free-form but validated
ALTER TABLE messages ADD COLUMN schema_version TEXT;         -- e.g., 'mahilo.location.subscribe.v1'

-- Request/response correlation
ALTER TABLE messages ADD COLUMN in_response_to TEXT
  REFERENCES messages(id);

-- Outcome tracking
ALTER TABLE messages ADD COLUMN outcome TEXT;
  -- 'shared', 'partial', 'declined', 'escalated', 'error'
ALTER TABLE messages ADD COLUMN outcome_details TEXT;
ALTER TABLE messages ADD COLUMN policies_evaluated TEXT;    -- JSON array of policy IDs
ALTER TABLE messages ADD COLUMN user_involved BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN blocked_reason TEXT;        -- null if delivered

-- Indexes for efficient querying
CREATE INDEX idx_messages_direction ON messages(direction);
CREATE INDEX idx_messages_resource ON messages(resource);
CREATE INDEX idx_messages_resource_action ON messages(resource, action);
CREATE INDEX idx_messages_in_response_to ON messages(in_response_to);
CREATE INDEX idx_messages_outcome ON messages(outcome);
CREATE INDEX idx_messages_resource_sender ON messages(resource, sender_user_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- POLICY ENHANCEMENTS
-- ═══════════════════════════════════════════════════════════════════════════

-- scope can now be: 'global', 'user', 'group', 'role'

-- Resource/action scoping for policies (null = applies to all)
ALTER TABLE policies ADD COLUMN applicable_resource TEXT
  REFERENCES message_resources(resource);
ALTER TABLE policies ADD COLUMN applicable_actions TEXT;    -- JSON array of actions, null = all
ALTER TABLE policies ADD COLUMN applicable_direction TEXT
  REFERENCES message_directions(direction);  -- 'request', 'response', or null for both

-- Vector embedding for semantic search
ALTER TABLE policies ADD COLUMN embedding BLOB;

-- Or separate table for embeddings (cleaner)
CREATE TABLE policy_embeddings (
  policy_id TEXT PRIMARY KEY REFERENCES policies(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,                       -- embedding model used
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);


-- ═══════════════════════════════════════════════════════════════════════════
-- INDEXES FOR POLICY RETRIEVAL
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX idx_policies_scope_target ON policies(scope, target_id);
CREATE INDEX idx_policies_user_scope ON policies(user_id, scope);
CREATE INDEX idx_policies_enabled ON policies(enabled) WHERE enabled = TRUE;
```

### Plugin SDK Requirements

The Mahilo plugin needs to:

#### 1. Fetch Context Before Presenting Messages

```typescript
const context = await mahilo.getContext(senderUsername);

// Returns:
interface MessageContext {
  sender: {
    username: string;
    displayName: string;
    relationship: 'friend' | 'acquaintance' | 'unknown';
    connectedSince: Date | null;
    roles: string[];
    interactionCount: number;
  };
  relevantPolicies: Array<{
    id: string;
    scope: string;
    content: string;
    recommendation: 'allow' | 'ask' | 'block';
  }>;
  pastInteractions: Array<{
    date: Date;
    from: string;
    type: string;
    responseSummary: string;
    outcome: string;
  }>;
  relevantDecisions: Array<{
    decision: string;
    learnedDate: Date;
  }>;
}
```

#### 2. Inject Context Into Agent Prompt

```typescript
// Format the structured prompt for injection
const incomingPrompt = mahilo.formatIncomingPrompt(message, context);
agent.injectSystemContext(incomingPrompt);

// After agent responds, format the transparency note
const postResponsePrompt = mahilo.formatPostResponsePrompt(
  sentMessage,
  policiesChecked,
  { shared: [...], withheld: [...] }
);
agent.injectSystemContext(postResponsePrompt);

// If learning opportunity exists, prompt for generalization
if (isNovelDecision(sentMessage)) {
  const learningPrompt = mahilo.formatLearningPrompt(
    sentMessage,
    potentialGeneralizations
  );
  agent.injectSystemContext(learningPrompt);
}
```

#### 3. Report Outcomes

```typescript
await mahilo.reportOutcome(messageId, {
  outcome: 'partial',
  details: 'Shared availability only, not event details',
  policiesEvaluated: ['policy_123', 'policy_456'],
  userInvolved: false
});
```

#### 4. Create Policies From Learned Preferences

```typescript
// After user confirms a generalization
await mahilo.createPolicy({
  scope: 'role',
  target_id: 'close_friends',
  policy_type: 'llm',
  policy_content: 'Work event details (meetings, standups) may be shared.',
  applicable_types: ['calendar_details_request', 'calendar_details_response'],
  priority: 50
});
```

#### 5. Validate Message Types

```typescript
// Before sending, ensure type is valid
const validTypes = await mahilo.getMessageTypes();
if (!validTypes.includes(messageType)) {
  throw new MahiloValidationError(`Invalid message type: ${messageType}`);
}

// Get suggested response type
const requestType = incomingMessage.type;
const suggestedResponseType = validTypes.find(t => t.type === requestType)?.expectedResponseType;
```

### Cold Start: Default Policies

When a user registers, create sensible default policies:

```typescript
const defaultPolicies = [
  // High priority: Block obvious sensitive patterns
  {
    scope: 'global',
    policy_type: 'heuristic',
    policy_content: {
      blockedPatterns: ['\\b\\d{16}\\b', 'SSN', 'password', 'secret']
    },
    priority: 100
  },

  // Location protection
  {
    scope: 'global',
    policy_type: 'llm',
    policy_content: 'Never share exact addresses or real-time location. City-level location is okay with friends.',
    applicable_types: ['location_current_response', 'location_history_response'],
    priority: 90
  },

  // Calendar protection
  {
    scope: 'global',
    policy_type: 'llm',
    policy_content: 'Share calendar availability (free/busy) freely with friends. Event details require close_friend role or explicit approval.',
    applicable_types: ['calendar_availability_response', 'calendar_details_response'],
    priority: 80
  },

  // Unknown contacts
  {
    scope: 'role',
    target_id: 'unknown',
    policy_type: 'llm',
    policy_content: 'For unknown contacts, only share basic public information. Ask user before sharing any personal details.',
    priority: 70
  },

  // Block sensitive request types from acquaintances
  {
    scope: 'role',
    target_id: 'acquaintances',
    policy_type: 'heuristic',
    policy_content: {
      blockedMessageTypes: ['location_current_request', 'document_request']
    },
    priority: 60
  }
];
```

### Default Roles

Pre-create system roles (available to all users):

| Role | Description | Trust Level | Default Behaviors |
|------|-------------|-------------|-------------------|
| `close_friends` | Highest trust tier | High | Event details, location city, contact intros allowed |
| `friends` | Standard friends | Medium | Availability, general info, social messages allowed |
| `acquaintances` | Casual contacts | Low | Basic public info only, many requests blocked |
| `work_contacts` | Professional context | Medium | Work calendar, professional info only |
| `family` | Family members | High | Similar to close_friends, personal context |

Users can create custom roles for specific needs (e.g., "book_club", "gym_buddies").

---

## Summary

### The Core Loop

1. **Message arrives** → Mahilo checks if it should be blocked
2. **If allowed** → Mahilo enriches with context (who, history, policies)
3. **Agent receives** → Uses context + judgment to craft response
4. **Agent responds** → Mahilo validates against policies
5. **If valid** → Message delivered, outcome logged
6. **If invalid** → Rejected, agent notified, can retry
7. **Agent learns** → Extracts preferences, creates/updates policies
8. **Policies stored** → Mahilo enforces going forward

### What Makes This Magical

| Principle | Implementation |
|-----------|----------------|
| No upfront config | Policies learned through natural conversation |
| One decision, many cases | Agent asks "apply to all friends?" and creates role-based policy |
| Safety net | Mahilo validates all outbound messages against policies |
| Transparency | Users see what was shared, why, and can adjust |
| Contextual intelligence | Rich context injection helps agents make good decisions |
| Progressive trust | Roles enable different sharing levels for different relationships |
| Graceful degradation | Agents can share partial info, ask for clarification |

### The Key Insight

**The agent is the learner, Mahilo is the enforcer.**

The agent has good judgment but isn't infallible. Mahilo doesn't have judgment but has perfect memory and consistent enforcement. Together, they create a system that's both intelligent and trustworthy.

---

## Open Questions

1. **Policy conflicts**: What happens when a per-user policy contradicts a per-role policy? (Suggestion: more specific wins)

2. **Policy explanation**: When a message is rejected, how detailed should the explanation be? (Too detailed might help adversaries)

3. **Learning confirmation**: Should every learned policy require user confirmation, or only major ones?

4. **Cross-device sync**: If user has multiple agents, should learned policies sync automatically?

5. **Policy sharing**: Can users share/import policy templates? ("Use the 'privacy-focused' template")

6. **Audit log access**: How long to retain interaction history? Who can access it?

---

## Next Steps

### Phase 1: Foundation (Database & API)

1. [ ] Create `message_directions`, `message_resources`, `message_actions` reference tables
2. [ ] Add `direction`, `resource`, `action`, `in_response_to`, `outcome` columns to messages table
3. [ ] Create `user_roles` and `friend_roles` tables
4. [ ] Add `applicable_resource`, `applicable_actions`, `applicable_direction` columns to policies table
5. [ ] Create `policy_embeddings` table for vector search
6. [ ] Add `GET /api/v1/message-schema` endpoint
7. [ ] Add message type validation to `POST /api/v1/messages/send`
8. [ ] Add `POST /api/v1/messages/:id/outcome` endpoint

### Phase 2: Policy Retrieval Optimization

9. [ ] Implement scope-based policy filtering (SQL)
10. [ ] Implement type-based policy filtering (SQL)
11. [ ] Set up vector embedding generation for policies (on create/update)
12. [ ] Implement vector search for policy retrieval
13. [ ] Build `GET /api/v1/policies/evaluate` endpoint (the full funnel)
14. [ ] Benchmark and tune retrieval performance

### Phase 3: Context & History

15. [ ] Build `GET /api/v1/context/:username` endpoint
16. [ ] Implement `GET /api/v1/messages/history` with filtering
17. [ ] Add request/response correlation logic
18. [ ] Build history summarization (optional LLM layer)
19. [ ] Add `GET /api/v1/messages/blocked` endpoint

### Phase 4: Role Management

20. [ ] Add role management endpoints for friendships
21. [ ] Seed system roles on server startup
22. [ ] Support custom user-defined roles
23. [ ] Integrate role-based policy scoping

### Phase 5: Plugin SDK

24. [ ] Design plugin SDK interface (TypeScript)
25. [ ] Implement `getContext()` function
26. [ ] Implement prompt formatting functions (incoming, post-response, learning)
27. [ ] Implement `reportOutcome()` function
28. [ ] Implement `createPolicy()` with validation
29. [ ] Build learning-to-policy pipeline helpers

### Phase 6: Default Policies & Cold Start

30. [ ] Create default policies on user registration
31. [ ] Build policy template system (optional)
32. [ ] Create onboarding flow for initial preferences (optional)

### Phase 7: Dashboard UI

33. [ ] Add policy management UI
34. [ ] Add role management UI
35. [ ] Add message history/audit view
36. [ ] Add blocked messages review UI
37. [ ] Add "what was shared" transparency view
