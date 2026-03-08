# Mahilo Permission System: Design Document

> **Status**: Design Phase
> **Last Updated**: 2026-03-08
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
8. [Message Type System](#message-type-system)
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
  "direction": "response",
  "resource": "calendar",
  "action": "read_details",
  "effect": "deny",
  "evaluator": "llm",
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

The policy model must keep four axes separate:

1. **Scope** — who the policy applies to
2. **Selectors** — which message shape it applies to (`direction`, `resource`, `action`)
3. **Effect** — what happens when the policy matches (`allow`, `ask`, `deny`)
4. **Evaluator** — how Mahilo decides whether the policy matches (`structured`, `heuristic`, `llm`)

Earlier drafts mixed these together. In particular, `policy_type`, `resource_rule`, `resource_block`, and `applicable_types` were overlapping concepts. The canonical model below keeps them distinct.

### Canonical Policy Shape

```json
{
  "scope": "role",
  "target_id": "friends",
  "direction": "response",
  "resource": "calendar",
  "action": "read_details",
  "effect": "ask",
  "evaluator": "llm",
  "policy_content": "If the response would reveal event titles, attendee names, or descriptions, ask the user before sending unless a more specific allow policy exists.",
  "priority": 50,
  "effective_from": "2026-03-08T10:00:00Z",
  "expires_at": null,
  "max_uses": null,
  "source": "user_confirmed",
  "derived_from_message_id": "msg_123"
}
```

### Two Enforcement Layers

Mahilo should enforce two separate layers:

1. **Platform guardrails** — non-configurable rules that always win (credentials, raw secrets, obvious abuse, policy-bypass attempts, etc.)
2. **User policies** — learned or configured rules that can resolve to `allow`, `ask`, or `deny`

This matters because "more specific wins" is correct for user preferences, but **not** for platform safety guardrails. A per-user allow should never override a platform rule against leaking credentials.

### Scope (Who Does This Apply To?)

#### 1. Global Policies
Apply to all matching messages from this user.

```json
{
  "scope": "global",
  "target_id": null,
  "direction": "response",
  "resource": "location",
  "effect": "deny",
  "evaluator": "llm",
  "policy_content": "Do not reveal exact addresses or home location."
}
```

#### 2. Per-User Policies
Apply to one specific recipient.

```json
{
  "scope": "user",
  "target_id": "alice_user_id",
  "direction": "response",
  "resource": "calendar",
  "action": "read_details",
  "effect": "allow",
  "evaluator": "structured",
  "policy_content": "Alice may receive work calendar event details."
}
```

#### 3. Per-Role Policies
Apply to recipients with a given trust tag.

```json
{
  "scope": "role",
  "target_id": "close_friends",
  "direction": "response",
  "resource": "calendar",
  "action": "read_details",
  "effect": "allow",
  "evaluator": "structured",
  "policy_content": "Close friends may receive work event details."
}
```

#### 4. Per-Group Policies (Channel Overlays)
Apply only when the message is sent into a specific Mahilo group.

```json
{
  "scope": "group",
  "target_id": "work_team_group_id",
  "direction": "response",
  "resource": "calendar",
  "effect": "deny",
  "evaluator": "llm",
  "policy_content": "In this work group, do not disclose personal health or family information."
}
```

**Important**: group policies should act as **channel overlays**. They can narrow sharing or require review, but they should not expand what an individual recipient could receive one-to-one.

**Role examples**:
- `close_friends` — highest trust, more sharing allowed
- `friends` — standard trust
- `acquaintances` — limited trust
- `work_contacts` — professional context only
- `unknown` — minimal sharing, ask for most things

Users can tag a friend with multiple roles.

### Selectors (What Message Does This Apply To?)

Policies target message selectors, not giant flat enums:

- `direction` — `request`, `response`, `notification`, `error`
- `resource` — `calendar`, `location`, `document`, `contact`, `action`, `meta`, or namespaced custom resources
- `action` — optional, resource-specific operation such as `read_availability`, `read_details`, `read_coarse`

Selectors are primarily for **retrieval, routing, and precise policy matching**. They are not the only source of truth for security. Security decisions should be bound to:

- authenticated sender identity
- authenticated sender connection
- actual message content
- declared selectors as hints

In the MVP, Mahilo may accept `direction` / `resource` / `action` from an authenticated sender. Longer term, Mahilo should compare declared selectors with its own lightweight classification and flag mismatches.

### Effect (What Happens If It Matches?)

- `allow` — explicit exception or positive permission
- `ask` — require user approval / escalation before proceeding
- `deny` — block delivery

This is the axis that was previously implicit. `resource_block` and `resource_rule` should **not** be policy types — they are ordinary policies with different `effect` values.

### Evaluator (How Does Mahilo Judge the Policy?)

#### 1. Structured Policies
Fast exact-match policies with little or no content inspection.

**Use cases**:
- Allow coarse location to friends
- Deny all inbound location requests from acquaintances
- Create one-time or expiring overrides

#### 2. Heuristic Policies
Deterministic rule evaluation with regexes, length limits, allowlists/blocklists, or other simple logic.

```json
{
  "effect": "deny",
  "evaluator": "heuristic",
  "policy_content": {
    "blockedPatterns": ["\\b\\d{16}\\b", "SSN", "credit card"],
    "maxLength": 1000,
    "requireContext": true
  }
}
```

#### 3. LLM Policies
Contextual policies for nuanced content decisions.

```json
{
  "effect": "deny",
  "evaluator": "llm",
  "policy_content": "Allow calendar availability, but do not reveal event titles, attendee names, or event descriptions."
}
```

### Lifecycle and Provenance

Policies need to capture *when* and *why* they exist:

- `effective_from` — scheduled start time
- `expires_at` — temporary rule expiry
- `max_uses` — one-time or limited-use override
- `source` — `default`, `learned`, `user_confirmed`, `override`
- `derived_from_message_id` — which interaction created this rule

This is critical because many privacy decisions are situational. Novel decisions should usually start as temporary overrides, not permanent generalized rules.

### Policy Resolution Rules

This section replaces the older "if ANY policy fails → reject" rule.

1. **Run platform guardrails first** — they always win and are never overridden by user policies.
2. **Filter to active policies only** — `enabled`, in time window, and with remaining uses if applicable.
3. **Match exact selectors** — `direction`, `resource`, `action`, plus scope match for recipient / role / group.
4. **Resolve by specificity**:
   - direct messages: `user > role > global`
   - group messages: evaluate per recipient, then apply the `group` overlay as an additional constraint
5. **Resolve within the same specificity** using the safer outcome:
   - `deny > ask > allow`
6. **If a more specific user policy conflicts with a broader user policy, the more specific one wins**.
7. **If equally specific policies still conflict, the safer result wins** (`deny > ask > allow`).
8. **If nothing matches, fall back to default posture** — conservative for sensitive domains (location, health, finance, credentials), more permissive only for clearly low-sensitivity or public information.

This gives Mahilo a logical, explainable system:

- broad defaults
- role-based trust tiers
- per-user exceptions
- temporary overrides
- non-overridable platform guardrails

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

### Safe Retrieval Principle

Retrieval should optimize **latency and relevance**, not change policy semantics.

**A safety-critical deny rule must never disappear because it was not in the top 5 semantic matches.**

That means vector search can help rank or summarize contextual policies, but it should never be the reason a hard constraint is skipped.

### Recommended Retrieval Pipeline

```
Authenticate identity + resolve recipient/channel
       ↓
Filter to active policies (enabled, time window, remaining uses)
       ↓
Filter by scope (global, user, role, group overlay)
       ↓
Filter by exact selectors (direction, resource, action)
       ↓
Evaluate all structured + heuristic matches
       ↓
Evaluate contextual LLM matches
       ↓
Resolve effect (specificity + allow/ask/deny)
       ↓
Optional: use embeddings to rank explanations, history, or non-critical guidance
```

### Step 1: Resolve Identity and Channel Context

Before retrieval, Mahilo must know:

- authenticated sender user ID
- authenticated sender connection ID
- direct recipient or group target
- recipient roles (for direct or per-recipient group fan-out)
- whether this is an inbound request or outbound response

Policy evaluation should always be bound to authenticated identity, not free-form sender strings.

### Step 2: Filter to Active Policies

```sql
SELECT * FROM policies WHERE
  user_id = :sender_user_id
  AND enabled = true
  AND (effective_from IS NULL OR effective_from <= :now)
  AND (expires_at IS NULL OR expires_at > :now)
  AND (remaining_uses IS NULL OR remaining_uses > 0);
```

This removes expired temporary rules and spent one-time overrides before any deeper work.

### Step 3: Scope + Selector Filtering

```sql
SELECT * FROM policies WHERE
  id IN (:active_policy_ids)
  AND (
    scope = 'global'
    OR (scope = 'user' AND target_id = :recipient_user_id)
    OR (scope = 'role' AND target_id IN (:recipient_roles))
    OR (scope = 'group' AND target_id = :group_id)
  )
  AND (direction IS NULL OR direction = :message_direction)
  AND (resource IS NULL OR resource = :message_resource)
  AND (action IS NULL OR action = :message_action);
```

At this point, policy retrieval should already be narrow enough to be semantically correct. If too many policies still match, that is a signal that the policies are underspecified and should be split more precisely.

### Step 4: Evaluate Deterministic Policies First

All matching `structured` and `heuristic` policies should always be evaluated.

This includes:

- exact selector-based allows / asks / denies
- regex and pattern blocks
- one-time overrides
- expiring temporary permissions

These rules are safety-critical and inexpensive. They should never be dropped for performance reasons.

### Step 5: Evaluate Contextual LLM Policies

Only after exact filtering should Mahilo evaluate contextual `llm` policies.

If there are many candidate LLM policies:

- evaluate all matching `deny` and `ask` policies
- use embeddings only to **rank** explanatory or supportive context
- prefer better selectors over more aggressive semantic pruning

In other words, embeddings can help order the work, but not redefine what the candidate set means.

### Where Embeddings Still Help

Embeddings are still valuable for:

- finding similar past interactions to show the agent
- ranking explanatory policies in the prompt
- grouping near-duplicate learned rules for cleanup
- suggesting candidate policy merges or promotions

They are especially useful for history retrieval and summarization, where the cost of omission is lower than in enforcement.

### Optimization Summary

| Stage | Method | Notes |
|-------|--------|-------|
| Identity resolution | Auth + graph lookup | Required before any policy match |
| Active policy filter | SQL query | Removes expired / spent overrides |
| Scope + selector filter | SQL query | Primary narrowing mechanism |
| Deterministic evaluation | In-process logic | Evaluate all matches |
| Contextual evaluation | LLM call | Evaluate bounded exact-match candidates |
| Embedding ranking | Optional | Guidance/history, not hard safety gates |

### Policy Embedding Storage

```sql
CREATE TABLE policy_embeddings (
  policy_id TEXT PRIMARY KEY REFERENCES policies(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Embeddings should be derived from `policy_content` and metadata, but they should be treated as an optimization layer only.

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

### Step 3: Agent Asks for Scope **and** Duration

The next question should not be only "all friends or just Alice?" because many privacy decisions are situational.

Agent to Bob:

> "Got it. Should this be:
> - just this time,
> - until today ends,
> - for Alice specifically,
> - for all close friends,
> - or your normal rule going forward?"

This keeps the learning loop from over-generalizing a single contextual decision into a permanent preference.

### Step 4: Create a Temporary Rule First (Default)

For novel situations, Mahilo should prefer one-time or expiring overrides first.

**One-time override:**

```json
{
  "scope": "user",
  "target_id": "alice_user_id",
  "direction": "response",
  "resource": "calendar",
  "action": "read_details",
  "effect": "allow",
  "evaluator": "structured",
  "policy_content": "Allow this response once for Alice.",
  "max_uses": 1,
  "source": "override",
  "derived_from_message_id": "msg_123"
}
```

**Temporary rule until tonight:**

```json
{
  "scope": "user",
  "target_id": "alice_user_id",
  "direction": "response",
  "resource": "calendar",
  "action": "read_details",
  "effect": "allow",
  "evaluator": "structured",
  "policy_content": "Allow sharing today's work-event details with Alice.",
  "expires_at": "2026-03-08T23:59:59Z",
  "source": "override",
  "derived_from_message_id": "msg_123"
}
```

### Step 5: Promote to Persistent Policy Deliberately

Only after explicit confirmation ("yes, always do this") or repeated consistent temporary decisions should the system create a lasting generalized policy.

```json
{
  "scope": "role",
  "target_id": "friends",
  "direction": "response",
  "resource": "calendar",
  "action": "read_details",
  "effect": "deny",
  "evaluator": "llm",
  "policy_content": "For calendar-related questions, share availability but do not share specific event details such as event names, attendee names, or descriptions.",
  "priority": 10,
  "source": "user_confirmed"
}
```

### Step 6: Mahilo Stores, Resolves, and Enforces

Future messages are evaluated against:

- platform guardrails
- active temporary overrides
- persistent user policies
- group overlays (if applicable)

If Bob's agent accidentally includes "dentist appointment at 2pm", Mahilo can either `deny` or `ask`, depending on the resolved effective policy.

### Step 7: Feedback Loop

If a message is denied or escalated, the agent can:

- rephrase the message
- ask Bob for a one-time override
- promote a repeated pattern into a broader rule
- learn that this type of content is sensitive for this relationship or context

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
  "direction": "request",
  "resource": "location",
  "effect": "deny",
  "evaluator": "structured",
  "policy_content": "Location requests are blocked for acquaintances."
}
```

**Allow coarse location only for friends:**
```json
{
  "scope": "role",
  "target_id": "friends",
  "direction": "response",
  "resource": "location",
  "action": "read_coarse",
  "effect": "allow",
  "evaluator": "structured",
  "policy_content": "Friends may receive city-level location."
}
```

**LLM policy scoped to calendar responses:**
```json
{
  "scope": "global",
  "direction": "response",
  "resource": "calendar",
  "action": "read_details",
  "effect": "deny",
  "evaluator": "llm",
  "policy_content": "When sharing calendar details, never include attendee names or meeting descriptions. Only share time slots.",
  "priority": 80
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
> - 2024-01-20: Carol (friend) asked `request/calendar/read_availability`
>   → You responded `response/calendar/read_availability`: "Bob is free Thursday afternoon"
>   → Outcome: shared (availability only)
> - 2024-01-18: Dan (acquaintance) asked `request/calendar/read_details`
>   → You responded `response/meta/escalate`: "I'd need to check with Bob first"
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
  "direction": "response",
  "resource": "calendar",
  "action": "read_availability",
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
  selectors: { direction: string; resource: string; action?: string }
): Promise<FormattedHistory[]> {
  // Get past interactions of same selector shape from same sender
  const sameSenderSameType = await mahilo.getHistory({
    with_user: senderUsername,
    direction: selectors.direction,
    resource: selectors.resource,
    action: selectors.action,
    include_responses: true,
    limit: 3
  });

  // Get past interactions of same selector shape from anyone
  const sameTypeAnyUser = await mahilo.getHistory({
    direction: selectors.direction,
    resource: selectors.resource,
    action: selectors.action,
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
  direction=request&
  resource=calendar&
  action=read_availability&
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
  ✓ Event details (Alice is in `close_friends`) — but NOT health appointments

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

TO: alice (in response to request/calendar/read_availability)

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

When the agent makes a decision that could become a general rule, prompt for **scope and duration**, not just scope.

```markdown
═══════════════════════════════════════════════════════════════════════════════
MAHILO: LEARNING OPPORTUNITY
═══════════════════════════════════════════════════════════════════════════════

You just shared work event details with Alice (`close_friends`).

This might be worth turning into a policy for future interactions.

QUESTIONS TO ASK BOB:

1. "Was this:
    - just this one message,
    - okay until tonight,
    - okay for Alice specifically,
    - okay for all close friends,
    - or your usual rule going forward?"

    If Bob says "just this one" → Create override:
    {
      scope: "user",
      target_id: "alice_user_id",
      direction: "response",
      resource: "calendar",
      action: "read_details",
      effect: "allow",
      evaluator: "structured",
      policy_content: "Allow this response once for Alice.",
      max_uses: 1,
      source: "override"
    }

    If Bob says "until tonight" → Create temporary rule:
    {
      scope: "user",
      target_id: "alice_user_id",
      direction: "response",
      resource: "calendar",
      action: "read_details",
      effect: "allow",
      evaluator: "structured",
      policy_content: "Allow sharing today's work-event details with Alice.",
      expires_at: "2026-03-08T23:59:59Z",
      source: "override"
    }

    If Bob says "all close friends" → Create persistent policy:
    {
      scope: "role",
      target_id: "close_friends",
      direction: "response",
      resource: "calendar",
      action: "read_details",
      effect: "allow",
      evaluator: "structured",
      policy_content: "Close friends may receive work-related event details.",
      source: "user_confirmed"
    }

2. "I withheld your dentist appointment since it's health-related.
    Is that the right call? Should health appointments always stay private?"

    If Bob confirms → Ensure global deny exists:
    {
      scope: "global",
      direction: "response",
      resource: "calendar",
      action: "read_details",
      effect: "deny",
      evaluator: "llm",
      policy_content: "Do not reveal health-related appointments or medical
                       information with anyone unless Bob creates an explicit exception.",
      source: "user_confirmed"
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

When Mahilo blocks or pauses a message, the agent-facing view should be helpful but not overly revealing.

```markdown
═══════════════════════════════════════════════════════════════════════════════
MAHILO: REVIEW REQUIRED ✗
═══════════════════════════════════════════════════════════════════════════════

Your message to alice was not sent.

REASON CODE:
  • response.location.too_specific

SUMMARY:
  • This draft would reveal more precise location information than current
    policy allows for this recipient or channel.

SUGGESTED ALTERNATIVES:
  • Share general area: "Bob is in downtown SF"
  • Share availability: "Bob is busy for the next hour"
  • Ask Bob: "Alice is asking for your exact location. Share it?"

ACTION NEEDED:
  → Rephrase your response to comply with policy, OR
  → Ask Bob if he wants a one-time override or temporary exception

═══════════════════════════════════════════════════════════════════════════════
```

**User-facing audit views** can show exact policy IDs, exact matches, and detailed reasoning. Agent-facing rejection prompts should usually show:

- a stable reason code
- the general category of blocked content
- safe alternatives
- whether an override / ask path exists

### Key Principles for Prompt Injection

1. **Be Specific in the Right Place**: Show exact policy IDs and exact triggers in user-facing audit logs; keep agent-facing rejection prompts minimally revealing
2. **Be Actionable**: Clear guidance on what to do, not just what the rules are
3. **Encourage Learning**: Prefer temporary overrides first, then promote to durable policy only when the user confirms a lasting rule
4. **Show Work**: Transparency about what was shared, why, and what was withheld
5. **Make Asking Easy**: Frame questions to Bob so they're quick to answer
6. **Build Trust**: Always log, always show, and make expiry / override behavior reviewable

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
  messageSelectors: {
    direction: 'request' | 'response' | 'notification' | 'error';
    resource: string;
    action?: string;
    declaredBySender: boolean;
    verifiedByMahilo?: boolean;
  };
  messageContent: string;

  // Policies
  relevantPolicies: Array<{
    id: string;
    scope: string;
    effect: 'allow' | 'ask' | 'deny';
    evaluator: 'structured' | 'heuristic' | 'llm';
    content: string;
    expiresAt?: Date | null;
  }>;

  // History
  pastInteractions: Array<{
    date: Date;
    from: string;
    selectors: {
      direction: string;
      resource: string;
      action?: string;
    };
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

### The Philosophy: Authenticated Identity Before Context

Inbound policy handling should follow this order:

1. **Authenticate sender identity** — resolve authenticated sender user and sender connection
2. **Apply platform guardrails and request policies** — block obvious abuse or explicitly denied requests
3. **Interpret selectors carefully** — use declared `direction` / `resource` / `action` as hints, with optional Mahilo-side verification/classification
4. **Deliver with the right level of review** — normal delivery, review-required delivery, or block
5. **Validate any resulting response** before it leaves Mahilo

This keeps the system honest: request policy is tied to authenticated identity first, then to declared metadata, then to content.

### Request Policy Semantics

For inbound requests, the effect meanings are:

- `deny` — block the request at Mahilo; it never reaches the receiving agent
- `ask` — deliver with a `review_required` / `needs_approval` flag (or optionally hold for approval in stricter product modes)
- `allow` — deliver normally with context

This preserves the "context over rejection" principle without letting every potentially sensitive request flow through silently.

### What Gets Blocked at Mahilo

| Condition | Action | Audit Behavior |
|-----------|--------|----------------|
| Sender authentication fails | Reject immediately | Minimal blocked-event log only |
| Sender is blocked by the user | Reject immediately | Minimal blocked-event log |
| Request matches platform abuse guardrails | Reject / quarantine | Abuse/security log |
| Request matches a `deny` request policy | Reject immediately | Minimal blocked-event log |
| Sender is not allowed to contact this user | Reject immediately | Minimal blocked-event log |

### What Gets Delivered with Context

| Condition | Delivery Mode | Context Added |
|-----------|---------------|---------------|
| Request matches an `ask` policy | Review required | "Sensitive request — user review recommended" |
| Request from unknown or low-trust sender | Normal or review-required | "New contact / low-trust relationship" |
| Urgent or manipulative framing | Normal or review-required | "Urgent framing detected — verify legitimacy" |
| Declared selectors look suspicious | Normal or review-required | "Declared type may not match content" |
| Sensitive resource domain | Normal or review-required | "Location / calendar / health / finance sensitivity" |

### Blocked Message Log

Users should be able to inspect blocked events, but Mahilo should store **minimal metadata by default**, not necessarily full blocked content.

```json
{
  "id": "blocked_123",
  "sender": "spammy_agent",
  "reason_code": "request.location.denied_for_unknown_sender",
  "direction": "request",
  "resource": "location",
  "action": "read_current",
  "stored_payload_excerpt": null,
  "payload_hash": "sha256:...",
  "timestamp": "2026-03-08T10:00:00Z"
}
```

Full payload retention for blocked inbound messages should be opt-in or tightly redacted.

---

## Implementation Considerations

### Foundational Principle: Policy Binds to Identity

Mahilo policies should bind to:

- authenticated `sender_user_id`
- authenticated `sender_connection_id`
- resolved recipient or group target
- resolved relationship / role graph

They should **not** rely on free-form sender strings for enforcement.

`direction`, `resource`, and `action` are still valuable, but they should be treated as selectors from an authenticated source, not as independent proof of what the message really means.

### New API Endpoints Needed

```
# Policy management
POST   /api/v1/policies                 # Create policy or temporary override
GET    /api/v1/policies                 # List policies
PATCH  /api/v1/policies/:id             # Update policy
DELETE /api/v1/policies/:id             # Delete policy
POST   /api/v1/policies/resolve         # Preview resolution for a message draft

# Role management
POST   /api/v1/friends/:id/roles        # Add role to friend
DELETE /api/v1/friends/:id/roles/:role  # Remove role from friend
GET    /api/v1/roles                    # List available roles
POST   /api/v1/roles                    # Create custom role

# Message typing + context
GET    /api/v1/message-schema           # List directions, resources, actions
GET    /api/v1/context/:username        # Get sender/relationship/history/policy context
GET    /api/v1/messages/history         # Query history with filters
GET    /api/v1/messages/blocked         # View blocked inbound/outbound events
POST   /api/v1/messages/:id/outcome     # Report outcome of a response
```

No separate override endpoint is required if `POST /api/v1/policies` accepts `expires_at` and `max_uses`.

### Canonical Policy Type

```typescript
type PolicyScope = 'global' | 'user' | 'role' | 'group';
type PolicyEffect = 'allow' | 'ask' | 'deny';
type PolicyEvaluator = 'structured' | 'heuristic' | 'llm';

type PolicySource =
  | 'default'
  | 'learned'
  | 'user_confirmed'
  | 'override'
  | 'user_created'
  | 'legacy_migrated';

interface CanonicalPolicy {
  id: string;
  scope: PolicyScope;
  target_id: string | null;
  direction: 'outbound' | 'inbound' | 'request' | 'response' | 'notification' | 'error';
  resource: string;
  action: string | null;
  effect: PolicyEffect;
  evaluator: PolicyEvaluator;
  policy_content: unknown;
  effective_from: string | null;
  expires_at: string | null;
  max_uses: number | null;
  remaining_uses: number | null;
  source: PolicySource;
  derived_from_message_id: string | null;
  priority: number;
  enabled: boolean;
  created_at: string | null;
  updated_at: string | null;
}
```

`policy_content` can be:

- structured JSON for `structured`
- structured JSON for `heuristic`
- natural-language policy text for `llm`

### Database Schema Changes

Keep the message direction / resource / action reference tables from earlier in this document. On top of that, the key schema changes are:

```sql
-- Policies: make selectors, effect, lifecycle, and provenance explicit
ALTER TABLE policies ADD COLUMN direction TEXT;
ALTER TABLE policies ADD COLUMN resource TEXT;
ALTER TABLE policies ADD COLUMN action TEXT;
ALTER TABLE policies ADD COLUMN effect TEXT NOT NULL DEFAULT 'ask';
ALTER TABLE policies ADD COLUMN evaluator TEXT NOT NULL DEFAULT 'llm';
ALTER TABLE policies ADD COLUMN effective_from DATETIME;
ALTER TABLE policies ADD COLUMN expires_at DATETIME;
ALTER TABLE policies ADD COLUMN max_uses INTEGER;
ALTER TABLE policies ADD COLUMN remaining_uses INTEGER;
ALTER TABLE policies ADD COLUMN source TEXT NOT NULL DEFAULT 'learned';
ALTER TABLE policies ADD COLUMN derived_from_message_id TEXT REFERENCES messages(id);

CREATE INDEX idx_policies_lookup
  ON policies(user_id, enabled, scope, target_id);

CREATE INDEX idx_policies_selectors
  ON policies(direction, resource, action);

CREATE INDEX idx_policies_lifecycle
  ON policies(effective_from, expires_at);
```

```sql
-- Messages: persist selectors, outcomes, and stronger identity binding
ALTER TABLE messages ADD COLUMN direction TEXT NOT NULL;
ALTER TABLE messages ADD COLUMN resource TEXT NOT NULL;
ALTER TABLE messages ADD COLUMN action TEXT;
ALTER TABLE messages ADD COLUMN in_response_to TEXT REFERENCES messages(id);
ALTER TABLE messages ADD COLUMN outcome TEXT;
ALTER TABLE messages ADD COLUMN outcome_details TEXT;
ALTER TABLE messages ADD COLUMN policies_evaluated TEXT;
ALTER TABLE messages ADD COLUMN sender_connection_id TEXT REFERENCES agent_connections(id);
ALTER TABLE messages ADD COLUMN classified_direction TEXT;
ALTER TABLE messages ADD COLUMN classified_resource TEXT;
ALTER TABLE messages ADD COLUMN classified_action TEXT;
```

The `classified_*` columns are optional but useful later if Mahilo starts verifying declared selectors against its own classifier.

### Resolver Flow

```typescript
async function resolvePolicies(ctx: ResolutionContext): Promise<ResolutionResult> {
  await runPlatformGuardrails(ctx);

  const activePolicies = await getActivePolicies(ctx);
  const matchingPolicies = filterByScopeAndSelectors(activePolicies, ctx);

  const deterministicMatches = evaluateDeterministicPolicies(matchingPolicies, ctx);
  const llmMatches = await evaluateContextualPolicies(matchingPolicies, ctx);

  const resolved = resolveBySpecificityAndEffect([
    ...deterministicMatches,
    ...llmMatches,
  ]);

  if (resolved.appliedPolicy?.remainingUses === 1) {
    await consumeOneTimeOverride(resolved.appliedPolicy.id);
  }

  return resolved;
}
```

The resolver should return:

- final effect: `allow`, `ask`, or `deny`
- winning policy (if any)
- policies evaluated
- human explanation for audit
- minimal reason code for agent-facing prompts

### Group Message Enforcement

Group messages should be enforced per recipient, not just once at the group level.

Recommended model:

1. Create a parent group message record
2. For each recipient in the group:
   - resolve recipient roles
   - evaluate global + role + user policies for that recipient
   - apply group policy as an overlay
   - produce `allow`, `ask`, or `deny` for that delivery
3. Fan out only to recipients that pass resolution
4. Record partial deliveries explicitly

This means one group message may be:

- delivered to some members
- held / escalated for some members
- denied for others

That behavior is more correct than a single coarse group-wide allow/deny decision.

### Temporary Overrides and Promotion

The learning system should default to **temporary overrides first**:

- one-time override → `max_uses = 1`
- expiring rule → `expires_at = ...`
- recurring rule → no expiry, but only after user confirmation

Promotion rules should be conservative:

- repeated temporary overrides can trigger a suggestion
- promotion should still be explicit (`source = user_confirmed`)
- expired and spent policies should be ignored by default and optionally garbage-collected later

### Default Policies & Cold Start

Cold start should be conservative for high-sensitivity domains.

```typescript
const defaultPolicies = [
  {
    scope: 'global',
    target_id: null,
    direction: 'response',
    resource: null,
    action: null,
    effect: 'deny',
    evaluator: 'heuristic',
    policy_content: {
      blockedPatterns: ['\\b\\d{16}\\b', 'SSN', 'password', 'secret', 'api[_\\s-]?key']
    },
    priority: 100,
    source: 'default'
  },
  {
    scope: 'global',
    target_id: null,
    direction: 'response',
    resource: 'location',
    action: 'read_current',
    effect: 'deny',
    evaluator: 'llm',
    policy_content: 'Do not reveal exact address, home location, apartment number, or GPS-level coordinates unless the user creates an explicit exception.',
    priority: 90,
    source: 'default'
  },
  {
    scope: 'global',
    target_id: null,
    direction: 'response',
    resource: 'calendar',
    action: 'read_details',
    effect: 'ask',
    evaluator: 'llm',
    policy_content: 'Calendar event titles, attendee names, descriptions, and sensitive appointment details require review unless a more specific allow policy exists.',
    priority: 80,
    source: 'default'
  },
  {
    scope: 'role',
    target_id: 'unknown',
    direction: 'response',
    resource: null,
    action: null,
    effect: 'ask',
    evaluator: 'llm',
    policy_content: 'For unknown contacts, ask before sharing personal, location, health, finance, or relationship information.',
    priority: 70,
    source: 'default'
  },
  {
    scope: 'role',
    target_id: 'acquaintances',
    direction: 'request',
    resource: 'location',
    action: null,
    effect: 'deny',
    evaluator: 'structured',
    policy_content: 'Inbound location requests from acquaintances are denied by default.',
    priority: 60,
    source: 'default'
  }
];
```

This gives new users a reasonable baseline without forcing them through a giant setup wizard.

---

## Summary

### The Core Loop

1. **Sender authenticates** → Mahilo knows the user and connection making the request
2. **Inbound request screened** → Platform guardrails and request policies decide block / review / allow
3. **If delivered** → Mahilo injects identity, history, selectors, and relevant policy context
4. **Agent drafts response** → Uses context and user-facing judgment
5. **Mahilo resolves outbound policy** → Platform guardrails + active overrides + persistent policies + group overlays
6. **Per-recipient result applied** → `allow`, `ask`, or `deny`
7. **Outcome logged** → What was shared, withheld, blocked, or escalated
8. **Learning loop runs** → Temporary override first, permanent policy only after explicit confirmation

### What Makes This Magical

| Principle | Implementation |
|-----------|----------------|
| No upfront config | Learn through natural interaction and lightweight confirmation |
| One decision, many cases | Promote repeated decisions into reusable role or user policies |
| Situational nuance | Use expiring rules and one-time overrides before permanent generalization |
| Safety net | Resolve all outbound responses against platform guardrails and user policies |
| Transparency | Log what was shared, what was withheld, and why |
| Progressive trust | Roles and per-user exceptions capture relationship nuance |
| Group correctness | Evaluate group fan-out per recipient with channel overlays |

### The Key Insight

**The agent is the learner; Mahilo is the resolver and enforcer.**

The agent handles nuance, conversation, and user experience. Mahilo provides authenticated identity, consistent memory, lifecycle-aware overrides, and deterministic enforcement.

---

## Open Questions

1. **Inbound `ask` behavior**: Should review-required requests be delivered with a flag by default, or held until explicit approval?
2. **Promotion threshold**: How many repeated temporary overrides should trigger a policy-promotion suggestion?
3. **Agent-facing rejection detail**: How much detail is useful without helping adversarial prompt steering?
4. **Selector verification**: When should Mahilo merely flag a declared-vs-classified mismatch, and when should it block?
5. **Multi-agent sync**: If a user has several agents or devices, how should policy ownership and conflict resolution work?
6. **Retention and redaction**: How long should blocked logs and sensitive audit trails be retained, and what must be redacted by default?

---

## Next Steps

### Phase 1: Canonical Schema & API

1. [ ] Add `direction`, `resource`, `action`, `effect`, `evaluator` to policies
2. [ ] Add lifecycle fields: `effective_from`, `expires_at`, `max_uses`, `remaining_uses`
3. [ ] Add provenance fields: `source`, `derived_from_message_id`
4. [ ] Add message selector fields and `sender_connection_id`
5. [ ] Update policy CRUD validation to the canonical model
6. [ ] Keep `GET /api/v1/message-schema` as the selector reference endpoint

### Phase 2: Resolver & Lifecycle

7. [ ] Implement platform guardrails as a separate non-overridable layer
8. [ ] Replace additive first-fail logic with specificity-based resolution
9. [ ] Implement one-time overrides and expiring rules
10. [ ] Decrement `remaining_uses` on applied overrides
11. [ ] Return structured resolution results (`allow` / `ask` / `deny` + explanation)

### Phase 3: Identity & Inbound Hardening

12. [ ] Persist and use `sender_connection_id` in message flows
13. [ ] Bind policy resolution to authenticated sender identity and connection
14. [ ] Add request-policy evaluation before inbound delivery
15. [ ] Add minimal blocked-event logging with redaction
16. [ ] Keep declared selectors as hints; add optional mismatch detection later

### Phase 4: Group Delivery & History

17. [ ] Enforce group messages per recipient during fan-out
18. [ ] Store per-recipient resolution outcomes
19. [ ] Improve history retrieval using selectors and relationship context
20. [ ] Use embeddings for history / explanation ranking, not hard safety gates

### Phase 5: Product Surface

21. [ ] Add UI for policies, temporary overrides, and expiry review
22. [ ] Add blocked/review queue UI
23. [ ] Add policy-promotion suggestions UI
24. [ ] Add policy templates / import-export only after the core resolver is stable
