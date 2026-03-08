# Mahilo ↔ OpenClaw Plugin Contract

> **Status**: Draft — frozen for implementation
> **Contract Version**: `1.0.0`
> **Last Updated**: 2026-03-08
> **Applies To**: Mahilo server in this repo and the OpenClaw plugin that will live in `plugins/openclaw-mahilo/`

---

## Purpose

This document is the source of truth for the runtime contract between:

- the **Mahilo server**, which owns identity, policy resolution, audit, and final enforcement
- the **OpenClaw plugin**, which owns native hooks, tools, prompt-time context, and UX inside OpenClaw

The goal is to let the server and plugin move in parallel without re-negotiating request/response shapes every few days.

---

## Core Rules

1. **Mahilo server is the source of truth**.
   - Final `allow`, `ask`, or `deny` decisions are made on the server.
   - The plugin may cache, summarize, or preflight, but it does not own policy truth.

2. **The plugin acts on behalf of an authenticated user and connection**.
   - Every plugin-originated request must include the user API key.
   - Every plugin-originated request that represents agent behavior must include `sender_connection_id`.
   - The server must verify that the connection belongs to the authenticated user and is active.

3. **Selectors are declared by the plugin and normalized by the server**.
   - The plugin sends `direction`, `resource`, and `action` as declared selectors.
   - The server may accept them as-is, normalize them, or reject invalid values.
   - Future server-side selector verification/classification may override declared selectors.

4. **Preflight and final send must remain aligned**.
   - The plugin should call `resolve` before send for outbound messages.
   - The server must still evaluate policies again at final send time.
   - A preflight result never bypasses final enforcement.

5. **Policy outcomes are not transport errors**.
   - `allow`, `ask`, and `deny` are business outcomes.
   - Auth, validation, and missing-resource failures remain HTTP errors.
   - Policy decisions should be returned as structured JSON payloads.

6. **Blocked content is redacted for the agent, detailed for audit**.
   - The plugin gets short, actionable guidance.
   - The server stores deeper explanations for human audit and debugging.

---

## Versioning and Compatibility

- Contract version is `1.0.0`.
- The path namespace is `api/v1`.
- Non-breaking changes may:
  - add optional request fields
  - add optional response fields
  - add new enum values when clients are expected to ignore unknown values safely
- Breaking changes require either:
  - a new major contract version
  - or a new path namespace such as `api/v2`

### Compatibility Rules

- The plugin must ignore unknown response fields.
- The server should tolerate missing optional plugin fields.
- Required request fields must be explicit in this document.

---

## Ownership Split

### Server Owns

- authenticated identity
- connection ownership and status
- friendships, roles, groups, and recipient resolution
- policy storage and lifecycle
- policy resolution and final enforcement
- audit history, blocked events, and review queues
- delivery callbacks to plugin webhook endpoints

### Plugin Owns

- OpenClaw-native hooks and tool registration
- prompt-time context injection
- native send-time UX
- local review / override UX
- outcome reporting back to Mahilo
- local diagnostics and operator controls

---

## Shared Vocabulary

### Selector Object

Every policy-aware draft uses the canonical selector object:

```json
{
  "direction": "outbound",
  "resource": "location.current",
  "action": "share"
}
```

### Selector Rules

- `direction` is required and currently supports:
  - `outbound`
  - `inbound`
- `resource` is required and is a lowercase dot-delimited string.
- `action` is required and is a lowercase dot-delimited string.
- Unknown `resource` or `action` values should be namespaced, for example:
  - `custom.preference`
  - `plugin.review`

### Initial Shared Resource Vocabulary

The contract starts with these common resources:

- `message.general`
- `profile.basic`
- `contact.email`
- `contact.phone`
- `location.current`
- `location.history`
- `calendar.availability`
- `calendar.event`
- `financial.balance`
- `financial.transaction`
- `health.metric`
- `health.summary`

### Initial Shared Action Vocabulary

The contract starts with these common actions:

- `share`
- `request`
- `reply`
- `summarize`
- `route`
- `notify`

These registries may expand later without breaking the contract.

---

## Authentication and Headers

### Required Authentication

All plugin → server requests must include:

```http
Authorization: Bearer <mahilo_api_key>
```

### Recommended Client Headers

The plugin should also send:

```http
X-Mahilo-Client: openclaw-plugin
X-Mahilo-Plugin-Version: <plugin_version>
X-Mahilo-Contract-Version: 1.0.0
```

### Idempotency

For send and outcome reporting, the plugin should provide either:

- `Idempotency-Key` header
- or `idempotency_key` in the JSON body

The server may support both, but the plugin should be consistent.

---

## Common Request Fragments

### Sender Context

```json
{
  "sender_connection_id": "conn_123",
  "agent_session_id": "sess_456"
}
```

- `sender_connection_id` is required for agent-authored requests.
- `agent_session_id` is optional and plugin-local.

### Recipient Reference

```json
{
  "recipient": "alice",
  "recipient_type": "user",
  "recipient_connection_id": "conn_789",
  "routing_hints": {
    "labels": ["work"],
    "tags": ["calendar"]
  }
}
```

Rules:

- `recipient` is required.
- `recipient_type` is required and supports:
  - `user`
  - `group`
- `recipient_connection_id` is optional.
- `routing_hints` is optional.

### Draft Envelope

```json
{
  "message": "Alice is at home right now.",
  "context": "User asked whether Alice is available nearby.",
  "payload_type": "text/plain",
  "correlation_id": "corr_123",
  "idempotency_key": "idem_123",
  "declared_selectors": {
    "direction": "outbound",
    "resource": "location.current",
    "action": "share"
  }
}
```

---

## Plugin → Server API

### 1) Get Prompt Context

### Endpoint

```http
POST /api/v1/plugin/context
```

### Purpose

Fetch compact, prompt-ready context for a draft interaction before the model decides what to say.

### Request

```json
{
  "sender_connection_id": "conn_sender",
  "recipient": "alice",
  "recipient_type": "user",
  "draft_selectors": {
    "direction": "outbound",
    "resource": "location.current",
    "action": "share"
  },
  "include_recent_interactions": true,
  "interaction_limit": 5
}
```

### Response

```json
{
  "contract_version": "1.0.0",
  "recipient": {
    "id": "usr_alice",
    "username": "alice",
    "display_name": "Alice",
    "relationship": "friend",
    "roles": ["close_friend"],
    "connected_since": "2026-01-12T08:30:00.000Z"
  },
  "sender_connection": {
    "id": "conn_sender",
    "framework": "openclaw",
    "label": "default"
  },
  "policy_guidance": {
    "default_decision": "ask",
    "summary": "Alice is a close friend, but current location usually requires confirmation.",
    "relevant_policies": [
      {
        "id": "pol_1",
        "scope": "role",
        "target_id": "close_friend",
        "effect": "ask",
        "selectors": {
          "direction": "outbound",
          "resource": "location.current",
          "action": "share"
        }
      }
    ]
  },
  "recent_interactions": [
    {
      "message_id": "msg_1",
      "direction": "outbound",
      "summary": "Shared calendar availability",
      "timestamp": "2026-03-07T13:00:00.000Z"
    }
  ],
  "suggested_selectors": {
    "direction": "outbound",
    "resource": "location.current",
    "action": "share"
  }
}
```

### Notes

- The response is designed for prompt injection and tool guidance.
- `summary` should stay concise and safe for the model.
- The server may omit heavy policy details if the plugin only needs the summary.

---

### 2) Resolve a Draft Before Sending

### Endpoint

```http
POST /api/v1/plugin/resolve
```

### Purpose

Preview what Mahilo would do with a draft without creating final delivery.

### Request

```json
{
  "sender_connection_id": "conn_sender",
  "recipient": "alice",
  "recipient_type": "user",
  "recipient_connection_id": "conn_alice",
  "routing_hints": {
    "labels": ["work"]
  },
  "message": "Alice is at home right now.",
  "context": "User asked whether Alice is available nearby.",
  "payload_type": "text/plain",
  "correlation_id": "corr_123",
  "idempotency_key": "idem_123",
  "declared_selectors": {
    "direction": "outbound",
    "resource": "location.current",
    "action": "share"
  }
}
```

### Response

```json
{
  "contract_version": "1.0.0",
  "resolution_id": "res_123",
  "decision": "ask",
  "delivery_mode": "review_required",
  "resolution_summary": "Current location needs confirmation for this recipient.",
  "agent_guidance": "Ask for confirmation or create a temporary override before sending.",
  "server_selectors": {
    "direction": "outbound",
    "resource": "location.current",
    "action": "share"
  },
  "matched_policies": [
    {
      "id": "pol_1",
      "scope": "role",
      "effect": "ask",
      "priority": 100
    }
  ],
  "review": {
    "required": true,
    "review_id": "rev_123"
  },
  "recipient_results": [
    {
      "recipient": "alice",
      "decision": "ask",
      "delivery_mode": "review_required"
    }
  ],
  "expires_at": "2026-03-08T12:40:00.000Z"
}
```

### Decision Rules

- `decision` is always one of:
  - `allow`
  - `ask`
  - `deny`
- `delivery_mode` communicates practical behavior and may be:
  - `full_send`
  - `review_required`
  - `blocked`
  - `partial_send`
- Group sends must include `recipient_results` so the plugin can explain mixed outcomes.

### HTTP Semantics

- Valid policy outcomes return `200`.
- Auth, validation, or missing-resource failures return the appropriate `4xx`.
- Retryable server failures return `5xx`.

---

### 3) Final Send

### Endpoint

```http
POST /api/v1/messages/send
```

### Purpose

Create the actual Mahilo message delivery after preflight or direct send.

### Required Additions To Server Contract

The existing send route must be extended to accept:

```json
{
  "sender_connection_id": "conn_sender",
  "resolution_id": "res_123",
  "declared_selectors": {
    "direction": "outbound",
    "resource": "location.current",
    "action": "share"
  }
}
```

### Structured Response Shape

```json
{
  "message_id": "msg_123",
  "status": "rejected",
  "deduplicated": false,
  "resolution": {
    "resolution_id": "res_123",
    "decision": "deny",
    "delivery_mode": "blocked",
    "summary": "Current location cannot be shared with this recipient."
  },
  "recipient_results": [
    {
      "recipient": "alice",
      "decision": "deny",
      "delivery_status": "rejected"
    }
  ]
}
```

### Send Rules

- Final send must re-run policy evaluation.
- `resolution_id` is advisory and used for correlation, not bypass.
- A policy rejection should produce structured JSON rather than only an exception path.
- Group sends may return `status = partial` if some recipients are blocked.

---

### 4) Report Outcome

### Endpoint

```http
POST /api/v1/plugin/outcomes
```

### Purpose

Tell Mahilo what the plugin or user ultimately did with a decision.

### Request

```json
{
  "sender_connection_id": "conn_sender",
  "resolution_id": "res_123",
  "message_id": "msg_123",
  "outcome": "review_approved",
  "user_action": "created_one_time_override",
  "notes": "User approved sharing current location once.",
  "recipient_results": [
    {
      "recipient": "alice",
      "outcome": "sent"
    }
  ]
}
```

### Allowed Outcome Values

- `sent`
- `partial_sent`
- `blocked`
- `review_requested`
- `review_approved`
- `review_rejected`
- `withheld`
- `send_failed`

### Response

```json
{
  "recorded": true,
  "event_id": "evt_123"
}
```

---

### 5) Create Override or Learned Policy

### Endpoint

```http
POST /api/v1/plugin/overrides
```

### Purpose

Create a one-time, temporary, or persistent policy from a reviewed decision.

### Request

```json
{
  "sender_connection_id": "conn_sender",
  "source_resolution_id": "res_123",
  "kind": "one_time",
  "scope": "user",
  "target_id": "usr_alice",
  "selectors": {
    "direction": "outbound",
    "resource": "location.current",
    "action": "share"
  },
  "effect": "allow",
  "max_uses": 1,
  "reason": "User approved sharing current location one time with Alice."
}
```

### Rules

- `kind` must be one of:
  - `one_time`
  - `temporary`
  - `persistent`
- `one_time` requires `max_uses = 1`.
- `temporary` requires `expires_at` or `ttl_seconds`.
- `persistent` should be explicit and never inferred silently from a single review.

### Response

```json
{
  "policy_id": "pol_789",
  "kind": "one_time",
  "created": true
}
```

---

### 6) Review Queue

### List Review Items

```http
GET /api/v1/plugin/reviews?status=open&limit=20
```

### Response

```json
{
  "items": [
    {
      "review_id": "rev_123",
      "created_at": "2026-03-08T12:10:00.000Z",
      "recipient": "alice",
      "selectors": {
        "direction": "outbound",
        "resource": "location.current",
        "action": "share"
      },
      "summary": "Current location share requires confirmation.",
      "decision": "ask"
    }
  ],
  "next_cursor": null
}
```

### Resolve Review Item

```http
POST /api/v1/plugin/reviews/rev_123/decision
```

```json
{
  "decision": "allow",
  "notes": "Approved once by user.",
  "create_override": {
    "kind": "one_time",
    "max_uses": 1
  }
}
```

### Response

```json
{
  "review_id": "rev_123",
  "resolved": true,
  "result": "allow"
}
```

---

### 7) Blocked Event Feed

### Endpoint

```http
GET /api/v1/plugin/events/blocked?limit=20
```

### Purpose

Expose a redacted feed of blocked or denied events for operator review.

### Response

```json
{
  "items": [
    {
      "event_id": "evt_123",
      "created_at": "2026-03-08T12:00:00.000Z",
      "recipient": "alice",
      "selectors": {
        "direction": "outbound",
        "resource": "location.current",
        "action": "share"
      },
      "summary": "Blocked by policy.",
      "decision": "deny"
    }
  ]
}
```

---

## Server → Plugin Delivery Callback

Mahilo delivers inbound messages to the plugin using the callback URL registered for the sender connection.

### Headers

```http
Content-Type: application/json
X-Mahilo-Signature: sha256=<hmac>
X-Mahilo-Timestamp: <unix_seconds>
X-Mahilo-Message-Id: <message_id>
X-Mahilo-Delivery-Id: <delivery_id>        # optional
X-Mahilo-Group-Id: <group_id>              # optional
```

### Signature Rules

The HMAC input is:

```text
<timestamp>.<raw_request_body>
```

The plugin must verify the signature with the registered callback secret.

### Callback Body

```json
{
  "message_id": "msg_123",
  "delivery_id": "del_123",
  "correlation_id": "corr_123",
  "recipient_connection_id": "conn_local",
  "sender": "alice",
  "sender_user_id": "usr_alice",
  "sender_connection_id": "conn_alice",
  "sender_agent": "openclaw",
  "message": "Can you share where Bob is?",
  "payload_type": "text/plain",
  "context": "Urgent coordination request.",
  "selectors": {
    "direction": "inbound",
    "resource": "location.current",
    "action": "request"
  },
  "group_id": null,
  "group_name": null,
  "timestamp": "2026-03-08T12:15:00.000Z"
}
```

### Callback Response Rules

- Any `2xx` means the plugin accepted the payload.
- Non-`2xx` means Mahilo may retry delivery.
- The plugin should return success only after the message is durably accepted for local processing.

---

## Error Model

For non-policy failures, the server should respond with:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "recipient is required",
    "retryable": false,
    "details": null
  }
}
```

### Recommended Error Codes

- `AUTH_INVALID`
- `AUTH_FORBIDDEN`
- `CONNECTION_NOT_FOUND`
- `CONNECTION_INACTIVE`
- `USER_NOT_FOUND`
- `GROUP_NOT_FOUND`
- `NOT_FRIENDS`
- `VALIDATION_ERROR`
- `RATE_LIMITED`
- `CONFLICT`
- `INTERNAL_ERROR`

Policy outcomes should stay in the normal JSON envelope whenever possible.

---

## Contract Tests

The server and plugin should share contract tests for:

- auth and connection ownership validation
- selector validation and normalization
- preflight `allow` / `ask` / `deny`
- final send disagreement with stale preflight
- one-time override creation and consumption
- temporary override expiry
- group fan-out with mixed recipient outcomes
- callback signature verification
- blocked-event redaction

---

## Immediate Implementation Notes

### Server Team

Implement these items first:

1. `POST /api/v1/plugin/context`
2. `POST /api/v1/plugin/resolve`
3. Extend `POST /api/v1/messages/send` with `sender_connection_id`, `resolution_id`, and `declared_selectors`
4. `POST /api/v1/plugin/outcomes`
5. `POST /api/v1/plugin/overrides`
6. `GET /api/v1/plugin/reviews`
7. `POST /api/v1/plugin/reviews/:review_id/decision`
8. `GET /api/v1/plugin/events/blocked`
9. Extend callback delivery payload with sender identity and selectors

### Plugin Team

Build against this contract only:

1. fetch prompt context via `/api/v1/plugin/context`
2. preflight outbound drafts via `/api/v1/plugin/resolve`
3. send final messages via `/api/v1/messages/send`
4. report outcomes via `/api/v1/plugin/outcomes`
5. create overrides via `/api/v1/plugin/overrides`
6. consume review queue and blocked feed
7. verify callback signatures and parse callback payload v1

