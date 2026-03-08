# Mahilo <-> OpenClaw Plugin Contract

> **Status**: Active (implementation-aligned)
> **Contract Version**: `1.0.0`
> **Last Updated**: 2026-03-08
> **Applies To**: Mahilo server in this repo and the OpenClaw plugin in `plugins/openclaw-mahilo/`

---

## Purpose

This document is the runtime contract between:

- **Mahilo server**: identity, policy resolution, audit, and final enforcement.
- **OpenClaw plugin**: native hooks, prompt-time context, send UX, and user-driven outcomes/overrides.

The goal is to let plugin and server teams integrate without guessing payloads.

---

## Core Rules

1. **Mahilo is policy truth**.
   - Final `allow` / `ask` / `deny` decisions come from the server.
   - Preflight helps UX, but does not bypass final send-time enforcement.

2. **Plugin requests are user-authenticated**.
   - All plugin routes require `Authorization: Bearer <mahilo_api_key>`.
   - Agent-behavior routes validate `sender_connection_id` ownership when provided.

3. **Selectors are plugin-declared and server-normalized**.
   - Server validates selector shape.
   - Unknown resources are allowed only when namespaced (for example `custom.preference`).

4. **Policy outcomes are business outcomes**.
   - `allow`, `ask`, and `deny` are returned in normal JSON payloads.
   - Validation/auth/resource failures use HTTP `4xx`/`5xx`.

---

## Versioning and Compatibility

- Contract version: `1.0.0`
- API namespace: `/api/v1`
- Non-breaking changes may add optional fields.
- Plugin clients must ignore unknown response fields.

---

## Shared Vocabulary

### Selector object

```json
{
  "direction": "outbound",
  "resource": "location.current",
  "action": "share"
}
```

### Selector rules

- `direction` supported values:
  - `outbound`
  - `inbound`
  - `request`
  - `response`
  - `notification`
  - `error`
- `resource` token pattern: `^[a-z0-9._-]+$` (case-insensitive), max `120` chars.
- `action` token pattern: `^[a-z0-9._-]+$` (case-insensitive), max `120` chars.
- Built-in resources:
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
- Legacy resources also accepted for compatibility:
  - `calendar`
  - `location`
  - `document`
  - `contact`
  - `action`
  - `meta`

Defaults when selectors are omitted:

```json
{
  "direction": "outbound",
  "resource": "message.general",
  "action": "share"
}
```

---

## Authentication and Verification

Required auth header for all routes:

```http
Authorization: Bearer <mahilo_api_key>
```

Verification requirements by route:

- `POST /api/v1/plugin/context`: authenticated user required, Twitter verification not required.
- `POST /api/v1/plugin/resolve`: authenticated + verified user required.
- `POST /api/v1/plugin/outcomes`: authenticated + verified user required.
- `POST /api/v1/plugin/overrides`: authenticated + verified user required.
- `POST /api/v1/messages/send`: authenticated + verified user required.

Idempotency:

- `POST /api/v1/messages/send`: `idempotency_key` in body.
- `POST /api/v1/plugin/outcomes`: `idempotency_key` in body or `Idempotency-Key` header.

---

## Plugin -> Server API

### 1) Get Prompt Context

Endpoint:

```http
POST /api/v1/plugin/context
```

Request body:

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

Request notes:

- `sender_connection_id` required.
- `recipient_type` defaults to `user`.
- `recipient_type=group` is currently rejected with `UNSUPPORTED_RECIPIENT_TYPE`.
- `declared_selectors` is also accepted; `draft_selectors` takes precedence when both are set.

Response example:

```json
{
  "contract_version": "1.0.0",
  "policy_guidance": {
    "default_decision": "ask",
    "reason_code": "context.ask.role.structured",
    "relevant_decisions": [
      {
        "decision": "ask",
        "direction": "outbound",
        "matched_policy_ids": ["pol_ask_1"],
        "message_id": "msg_1",
        "reason_code": "policy.ask.role.structured",
        "selectors": {
          "action": "share",
          "direction": "outbound",
          "resource": "location.current"
        },
        "status": "review_required",
        "timestamp": "2026-03-08T10:00:00.000Z",
        "winning_policy_id": "pol_ask_1"
      }
    ],
    "relevant_policies": [
      {
        "effect": "ask",
        "evaluator": "structured",
        "id": "pol_ask_1",
        "priority": 80,
        "scope": "role",
        "selectors": {
          "action": "share",
          "direction": "outbound",
          "resource": "location.current"
        },
        "target_id": "close_friends"
      }
    ],
    "summary": "...",
    "winning_policy_id": "pol_ask_1"
  },
  "recipient": {
    "connected_since": "2026-03-08T09:00:00.000Z",
    "display_name": null,
    "id": "usr_alice",
    "relationship": "friend",
    "roles": ["close_friends"],
    "username": "alice"
  },
  "recent_interactions": [
    {
      "direction": "outbound",
      "message_id": "msg_1",
      "summary": "Shared a city-level location update...",
      "timestamp": "2026-03-08T10:00:00.000Z"
    }
  ],
  "sender_connection": {
    "framework": "openclaw",
    "id": "conn_sender",
    "label": "default"
  },
  "suggested_selectors": {
    "action": "share",
    "direction": "outbound",
    "resource": "location.current"
  }
}
```

### 2) Resolve Draft (Preflight)

Endpoint:

```http
POST /api/v1/plugin/resolve
```

Request body:

```json
{
  "sender_connection_id": "conn_sender",
  "recipient": "alice",
  "recipient_type": "user",
  "recipient_connection_id": "conn_alice",
  "routing_hints": {
    "labels": ["work"],
    "tags": ["calendar"]
  },
  "message": "Alice is at home right now.",
  "context": "User asked whether Alice is available nearby.",
  "payload_type": "text/plain",
  "direction": "outbound",
  "resource": "location.current",
  "action": "share",
  "declared_selectors": {
    "direction": "outbound",
    "resource": "location.current",
    "action": "share"
  },
  "correlation_id": "corr_123",
  "idempotency_key": "idem_123"
}
```

Request notes:

- `sender_connection_id` is optional; when omitted, server picks the highest-priority active connection for the authenticated user.
- `declared_selectors` takes precedence over top-level `direction/resource/action`.
- Policy preflight runs only when `trustedMode=true` and `payload_type != application/mahilo+ciphertext`; otherwise decision defaults to `allow`.
- No message or delivery record is created.

Response example:

```json
{
  "contract_version": "1.0.0",
  "resolution_id": "res_123",
  "decision": "ask",
  "delivery_mode": "review_required",
  "resolution_summary": "Message requires review before delivery.",
  "agent_guidance": "This draft requires review before delivery. Ask for approval or create an override.",
  "reason_code": "policy.ask.resolved",
  "server_selectors": {
    "action": "share",
    "direction": "outbound",
    "resource": "location.current"
  },
  "matched_policies": [
    {
      "effect": "ask",
      "evaluator": "structured",
      "id": "pol_ask_1",
      "phase": "structured",
      "priority": 90,
      "scope": "global"
    }
  ],
  "applied_policy": {
    "guardrail_id": null,
    "matched_policy_ids": ["pol_ask_1"],
    "resolver_layer": "user_policies",
    "winning_policy_id": "pol_ask_1"
  },
  "resolved_recipient": {
    "recipient": "alice",
    "recipient_connection_id": "conn_alice",
    "recipient_type": "user"
  },
  "review": {
    "required": true,
    "review_id": null
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

`delivery_mode` values:

- `full_send`
- `review_required`
- `hold_for_approval`
- `blocked`

Group preflight note:

- For `recipient_type=group`, response currently returns a single aggregate `recipient_results` entry for the group target (not per-member fan-out rows).

### 3) Final Send

Endpoint:

```http
POST /api/v1/messages/send
```

This endpoint is not under `/plugin`, but plugin clients use it for final delivery after preflight.
Policy enforcement follows the same trusted-mode/plaintext condition as `/api/v1/plugin/resolve`.

Plugin-relevant request fragment:

```json
{
  "sender_connection_id": "conn_sender",
  "recipient": "alice",
  "recipient_type": "user",
  "message": "Alice is at home right now.",
  "declared_selectors": {
    "direction": "outbound",
    "resource": "location.current",
    "action": "share"
  },
  "resolution_id": "res_123",
  "idempotency_key": "idem_123"
}
```

Response example (policy blocked / ask case is still HTTP `200`):

```json
{
  "message_id": "msg_123",
  "status": "review_required",
  "delivery_status": "pending",
  "resolution": {
    "resolution_id": "res_123",
    "decision": "ask",
    "delivery_mode": "review_required",
    "summary": "Message requires review before delivery.",
    "reason": null,
    "reason_code": "policy.ask.resolved",
    "resolver_layer": "user_policies",
    "guardrail_id": null,
    "winning_policy_id": "pol_ask_1",
    "matched_policy_ids": ["pol_ask_1"]
  },
  "recipient_results": [
    {
      "recipient": "alice",
      "decision": "ask",
      "delivery_mode": "review_required",
      "delivery_status": "pending"
    }
  ]
}
```

Idempotency replay example:

```json
{
  "message_id": "msg_123",
  "status": "review_required",
  "deduplicated": true,
  "resolution": {
    "resolution_id": "res_123",
    "decision": "ask",
    "delivery_mode": "review_required",
    "summary": "Message requires review before delivery.",
    "reason": null,
    "reason_code": "policy.ask.resolved",
    "resolver_layer": "user_policies",
    "guardrail_id": null,
    "winning_policy_id": "pol_ask_1",
    "matched_policy_ids": ["pol_ask_1"]
  },
  "recipient_results": [
    {
      "recipient": "usr_alice",
      "decision": "ask",
      "delivery_mode": "review_required",
      "delivery_status": "review_required"
    }
  ]
}
```

### 4) Report Outcome

Endpoint:

```http
POST /api/v1/plugin/outcomes
```

Request body:

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
  ],
  "idempotency_key": "idem_plugin_outcomes_record_1"
}
```

Allowed `outcome` values:

- `sent`
- `partial_sent`
- `blocked`
- `review_requested`
- `review_approved`
- `review_rejected`
- `withheld`
- `send_failed`

Success response:

```json
{
  "recorded": true,
  "event_id": "evt_123"
}
```

Deduplicated retry response:

```json
{
  "recorded": true,
  "event_id": "evt_123",
  "deduplicated": true
}
```

### 5) Create Override

Endpoint:

```http
POST /api/v1/plugin/overrides
```

Request body:

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
  "reason": "User approved sharing current location one time with Alice.",
  "derived_from_message_id": "msg_source",
  "priority": 90
}
```

Validation rules:

- `kind` values: `one_time`, `temporary`, `persistent`.
- `scope` values: `global`, `user`, `group`, `role`.
- `scope=global` requires `target_id` absent/null.
- `scope=user|group|role` requires `target_id`.
- `kind=one_time` enforces `max_uses=1`.
- `kind=temporary` requires `expires_at` or `ttl_seconds`.
- `kind=persistent` forbids `expires_at`, `ttl_seconds`, and `max_uses`.
- `expires_at` and `ttl_seconds` are mutually exclusive.

Success response (`201`):

```json
{
  "policy_id": "pol_789",
  "kind": "one_time",
  "created": true
}
```

---

## Not Implemented Yet (Do Not Integrate Against)

These routes are not available in this repo yet:

- `GET /api/v1/plugin/reviews`
- `POST /api/v1/plugin/reviews/:review_id/decision`
- `GET /api/v1/plugin/events/blocked`

They are planned under SRV-044 and remain out of current contract scope.

---

## Server -> Plugin Delivery Callback

Mahilo delivers inbound messages to connection callback URLs.

Headers:

```http
Content-Type: application/json
X-Mahilo-Signature: sha256=<hmac>
X-Mahilo-Timestamp: <unix_seconds>
X-Mahilo-Message-Id: <message_id>
X-Mahilo-Delivery-Id: <delivery_id>   # group fan-out only
X-Mahilo-Group-Id: <group_id>         # group fan-out only
```

HMAC input:

```text
<timestamp>.<raw_request_body>
```

Callback payload example:

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
  "encryption": {
    "alg": "xchacha20poly1305",
    "key_id": "key_1"
  },
  "sender_signature": {
    "alg": "ed25519",
    "key_id": "signing_key_1",
    "signature": "base64sig"
  },
  "context": "Urgent coordination request.",
  "selectors": {
    "direction": "inbound",
    "resource": "location.current",
    "action": "request"
  },
  "resolution_id": "res_123",
  "review_required": false,
  "delivery_mode": "full_send",
  "group_id": null,
  "group_name": null,
  "timestamp": "2026-03-08T12:15:00.000Z"
}
```

Callback response rules:

- Any `2xx` means accepted.
- Non-`2xx` or timeout is queued for retry.

---

## Error Model

Server errors use this envelope:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_CODE",
  "details": []
}
```

`details` is included for validation failures and may be absent for other errors.

Examples:

- Validation (`400`): `{"error":"Validation Error","code":"VALIDATION_ERROR","details":[...]}`
- App error (`4xx/5xx`): `{"error":"Sender connection not found or inactive","code":"SENDER_CONNECTION_NOT_FOUND"}`
- HTTP middleware error (`401/403/429`): `{"error":"Missing Authorization header","code":"HTTP_ERROR"}`

Common machine codes relevant to plugin integration:

- `VALIDATION_ERROR`
- `SENDER_CONNECTION_NOT_FOUND`
- `USER_NOT_FOUND`
- `GROUP_NOT_FOUND`
- `NOT_FRIENDS`
- `NOT_MEMBER`
- `CONNECTION_NOT_FOUND`
- `NO_CONNECTIONS`
- `INVALID_SELECTOR`
- `INVALID_OVERRIDE`
- `INVALID_ROLE`
- `MESSAGE_NOT_FOUND`
- `MESSAGE_SENDER_MISMATCH`
- `SOURCE_MESSAGE_NOT_FOUND`
- `UNSUPPORTED_RECIPIENT_TYPE`
- `PAYLOAD_TOO_LARGE`

---

## Contract Validation Coverage

Current integration tests covering this contract:

- `tests/integration/plugin-context.test.ts`
- `tests/integration/plugin-resolve.test.ts`
- `tests/integration/plugin-outcomes.test.ts`
- `tests/integration/plugin-overrides.test.ts`
- `tests/integration/selector-aware-send.test.ts`
