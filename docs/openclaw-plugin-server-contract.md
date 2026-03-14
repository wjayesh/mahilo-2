# Mahilo <-> OpenClaw Plugin Contract

> **Status**: Active (implementation-aligned)
> **Contract Version**: `1.0.0`
> **Last Updated**: 2026-03-14
> **Applies To**: Mahilo server in this repo and the OpenClaw plugin in `plugins/openclaw-mahilo/`

---

## Purpose

This document is the runtime contract between:

- **Mahilo server**: identity and access checks, selector normalization, applicable-policy filtering, trusted-mode resolution, lifecycle mutation, and persisted audit/outcome storage.
- **OpenClaw plugin**: native hooks, prompt-time advisory context, preview UX, non-trusted local evaluation, local provider credential handling, transport initiation, and user-driven outcomes/overrides.

The goal is to let plugin and server teams integrate without guessing payloads.

---

## Core Rules

1. **Mahilo is policy truth and lifecycle authority**.
   - Canonical policies live on the server.
   - Plugin-local evaluation is allowed only from server-issued policy bundles plus the shared resolver.
   - The server is still authoritative for lifecycle mutation, persisted message artifacts, and audit surfaces.

2. **Advisory context is not enforcement**.
   - `POST /api/v1/plugin/context` is prompt-time guidance only.
   - `policy_guidance.default_decision` is not a send token, a commit token, or a substitute for live resolution.

3. **Preview is not live send**.
   - `POST /api/v1/plugin/resolve` creates no message artifact, no delivery record, and no lifecycle mutation.
   - In non-trusted mode, live sends must use the bundle -> local evaluation -> local-decision commit flow. Preview `resolution_id` values are not a substitute.

4. **Live enforcement depends on runtime mode**.
   - Trusted plaintext sends use server-side policy evaluation in `POST /api/v1/messages/send`.
   - Non-trusted sends use plugin-local evaluation, then commit the local decision, then transport only committed `allow` recipients.
   - Ciphertext payloads are not policy-evaluated server-side from payload content; if enforcement is required there, the plugin must evaluate before transport.

5. **Selectors are plugin-declared and server-normalized**.
   - Server validates selector shape.
   - Unknown resources are allowed only when namespaced (for example `custom.preference`).

6. **LLM defaults are hints, not credentials**.
   - Bundle responses may return provider/model defaults only when an applicable LLM policy exists.
   - Mahilo never returns provider secrets or host credentials.
   - Missing or failed local LLM evaluation must degrade to `ask`, not fail open.

7. **Group fanout is per-recipient**.
   - Group bundles carry group overlays plus member-specific inputs and per-member `resolution_id` values.
   - Local group commits, send retries, review surfaces, blocked-event surfaces, and outcome reports are all per committed member artifact.

8. **Policy outcomes are business outcomes**.
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

- `POST /api/v1/plugin/context`: authenticated user required; active invite-backed account is not required.
- `POST /api/v1/plugin/bundles/direct-send`: authenticated + active invite-backed account required.
- `POST /api/v1/plugin/bundles/group-fanout`: authenticated + active invite-backed account required.
- `POST /api/v1/plugin/local-decisions/commit`: authenticated + active invite-backed account required.
- `POST /api/v1/plugin/resolve`: authenticated + active invite-backed account required.
- `POST /api/v1/plugin/outcomes`: authenticated + active invite-backed account required.
- `POST /api/v1/plugin/overrides`: authenticated + active invite-backed account required.
- `GET /api/v1/plugin/reviews`: authenticated + active invite-backed account required.
- `GET /api/v1/plugin/events/blocked`: authenticated + active invite-backed account required.
- `POST /api/v1/messages/send`: authenticated + active invite-backed account required.

Idempotency:

- `POST /api/v1/messages/send`: `idempotency_key` in body. When resuming a committed local `allow`, the bound `resolution_id` also deduplicates retries of that same artifact.
- `POST /api/v1/plugin/local-decisions/commit`: authoritative commit key is `resolution_id`; `idempotency_key` in body or `Idempotency-Key` header may additionally deduplicate retries for the same committed artifact.
- `POST /api/v1/plugin/outcomes`: `idempotency_key` in body or `Idempotency-Key` header.

---

## Surface Matrix

| Surface | Endpoint / handle | Intended use | Creates message or lifecycle mutation? | Live-send rule |
| --- | --- | --- | --- | --- |
| Advisory context | `POST /api/v1/plugin/context` | Prompt-time hints and relationship context | No | Never use `policy_guidance.default_decision` as live authorization |
| Preview / preflight | `POST /api/v1/plugin/resolve` | Preview UX and trusted-mode parity checks | No | Preview `resolution_id` is ephemeral and not reused for local commit/send |
| Direct local bundle | `POST /api/v1/plugin/bundles/direct-send` | Direct non-trusted local enforcement input | No | Later commit/send must use `bundle_metadata.resolution_id` |
| Group local bundle | `POST /api/v1/plugin/bundles/group-fanout` | Group non-trusted fanout input | No | Later commit/send must use `members[*].resolution_id` per recipient |
| Local decision commit | `POST /api/v1/plugin/local-decisions/commit` | Persist the plugin-local decision | Yes | `ask`/`deny` stop here; `allow` continues to transport |
| Final send / transport | `POST /api/v1/messages/send` | Trusted server send or resume committed local `allow` | Yes | Local group sends call this per allowed user recipient, not once for the whole group |
| Outcome report | `POST /api/v1/plugin/outcomes` | Append post-send or post-review audit | Appends audit only | Correlated by `message_id`; local group reports are per member artifact |
| Override creation | `POST /api/v1/plugin/overrides` | Create an explicit override policy | Creates policy | Can follow preview, review, or blocked outcomes |

---

## End-to-End Flows

### Direct User Send in Non-Trusted Mode

1. Optional: call `POST /api/v1/plugin/context` for prompt hints only.
2. Optional: call `POST /api/v1/plugin/resolve` for preview UX only.
3. Call `POST /api/v1/plugin/bundles/direct-send`.
4. Evaluate locally from `applicable_policies` with the shared resolver. If an LLM policy applies, use `llm.subject` and optional `llm.provider_defaults`, but source credentials from the plugin/OpenClaw environment.
5. Call `POST /api/v1/plugin/local-decisions/commit` with the bundle `resolution_id`.
6. If the committed decision is `allow`, call `POST /api/v1/messages/send` with the same `resolution_id`. If the decision is `ask` or `deny`, do not send.
7. Optionally call `POST /api/v1/plugin/outcomes` with the returned `message_id`.

### Group Fanout in Non-Trusted Mode

1. Optional: use `/plugin/context` or `/plugin/resolve` only for UX; neither endpoint authorizes the live group send path.
2. Call `POST /api/v1/plugin/bundles/group-fanout`.
3. Evaluate members locally in bundle order, combining `group_overlay_policies` with each member's `member_applicable_policies`.
4. Commit each member in bundle order with `POST /api/v1/plugin/local-decisions/commit`, `group_id`, and that member's `resolution_id`.
5. Transport only members whose committed decision is `allow`, using `POST /api/v1/messages/send` with `recipient_type=user` and the member `resolution_id`.
6. Use `aggregate_metadata` only for plugin UX summaries. Review, blocked-event, and outcome surfaces are recorded per committed member artifact, not per bundle.

### Trusted Preview and Trusted Send

1. `POST /api/v1/plugin/resolve` remains the preview surface when `trustedMode=true` and the payload is not ciphertext.
2. `POST /api/v1/messages/send` performs authoritative server-side policy evaluation only in that trusted/plaintext path.
3. This is the only mode where preview/send parity comes from the server evaluation itself. In local mode, preview is informational and live enforcement comes from bundle evaluation plus commit.

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
- The response intentionally omits `bundle_metadata`, `resolution_id`, `llm.provider_defaults`, and detailed policy internals. It is safe prompt context, not a live-send contract.
- Plugin clients must not use `policy_guidance.default_decision` as a substitute for bundle evaluation, local-decision commit, or trusted `/messages/send`.

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
        "message_id": "msg_1",
        "reason_code": "policy.ask.role.structured",
        "selectors": {
          "action": "share",
          "direction": "outbound",
          "resource": "location.current"
        },
        "status": "review_required",
        "timestamp": "2026-03-08T10:00:00.000Z"
      }
    ],
    "summary": "...",
    "policy_signal": {
      "applicable_policy_count": 1,
      "scope_counts": {
        "global": 0,
        "role": 1,
        "user": 0
      }
    }
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

### 2) Get Direct-Send Policy Bundle

Endpoint:

```http
POST /api/v1/plugin/bundles/direct-send
```

Request body:

```json
{
  "sender_connection_id": "conn_sender",
  "recipient": "alice",
  "recipient_type": "user",
  "declared_selectors": {
    "direction": "outbound",
    "resource": "location.current",
    "action": "share"
  }
}
```

Request notes:

- `sender_connection_id` is optional; when omitted, server picks the highest-priority active connection for the authenticated user.
- `recipient_type=user` is currently required for this direct-send bundle. Group fan-out uses a separate contract.
- The bundle intentionally excludes prompt/advisory fields from `/plugin/context` and does not resolve delivery routing.
- `applicable_policies` are already filtered by server-side recipient identity, role membership, selector context, and lifecycle eligibility.
- `bundle_metadata.resolution_id` is the send/report correlation handle for later local-decision commit work.
- The bundle creates no message artifact, no delivery record, and no lifecycle mutation on its own.
- `llm.provider_defaults` contains only non-secret provider/model hints and is `null` when no applicable LLM policy exists or no default is configured. Deterministic-only local evaluation still proceeds when it is `null`.

Response example:

```json
{
  "contract_version": "1.0.0",
  "bundle_type": "direct_send",
  "bundle_metadata": {
    "bundle_id": "bundle_123",
    "resolution_id": "res_123",
    "issued_at": "2026-03-14T10:30:00.000Z",
    "expires_at": "2026-03-14T10:35:00.000Z"
  },
  "authenticated_identity": {
    "sender_user_id": "usr_sender",
    "sender_connection_id": "conn_sender"
  },
  "selector_context": {
    "action": "share",
    "direction": "outbound",
    "resource": "location.current"
  },
  "recipient": {
    "id": "usr_alice",
    "type": "user",
    "username": "alice"
  },
  "applicable_policies": [
    {
      "id": "pol_role_1",
      "scope": "role",
      "target_id": "close_friends",
      "direction": "outbound",
      "resource": "location.current",
      "action": "share",
      "effect": "ask",
      "evaluator": "structured",
      "policy_content": {},
      "effective_from": null,
      "expires_at": null,
      "max_uses": null,
      "remaining_uses": null,
      "source": "user_created",
      "derived_from_message_id": null,
      "learning_provenance": null,
      "priority": 80,
      "created_at": "2026-03-14T10:00:00.000Z"
    }
  ],
  "llm": {
    "subject": "alice",
    "provider_defaults": null
  }
}
```

### 2a) Get Group-Fanout Policy Bundle

Endpoint:

```http
POST /api/v1/plugin/bundles/group-fanout
```

Request body:

```json
{
  "sender_connection_id": "conn_sender",
  "recipient": "grp_hiking",
  "recipient_type": "group",
  "declared_selectors": {
    "direction": "outbound",
    "resource": "message.general",
    "action": "share"
  }
}
```

Request notes:

- `sender_connection_id` is optional; when omitted, server picks the highest-priority active connection for the authenticated user.
- `recipient_type=group` is required for this fan-out bundle.
- This contract prepares member-level local enforcement inputs for both direct group sends and `ask_network` group asks.
- `group_overlay_policies` contain only group-scope policies; each member row carries only the member-specific/global/role policies that must be combined with those overlays locally.
- `members[*].resolution_id` is the authoritative per-recipient correlation handle derived from `bundle_metadata.resolution_id`.
- `aggregate_metadata` describes the trusted mixed-outcome rule used for partial fan-out summaries.
- The bundle creates no message artifact, no delivery record, and no lifecycle mutation on its own.
- In local mode, `aggregate_metadata` is for plugin-side summary UX only. Review, blocked-event, and outcome surfaces are later recorded per committed member artifact.
- Each `members[*].llm.provider_defaults` follows the same provider/model-only rule as the direct-send bundle. Missing defaults do not block deterministic-only local evaluation for that member.

Response example:

```json
{
  "contract_version": "1.0.0",
  "bundle_type": "group_fanout",
  "bundle_metadata": {
    "bundle_id": "bundle_456",
    "resolution_id": "res_456",
    "issued_at": "2026-03-14T10:30:00.000Z",
    "expires_at": "2026-03-14T10:35:00.000Z"
  },
  "authenticated_identity": {
    "sender_user_id": "usr_sender",
    "sender_connection_id": "conn_sender"
  },
  "selector_context": {
    "action": "share",
    "direction": "outbound",
    "resource": "message.general"
  },
  "group": {
    "id": "grp_hiking",
    "type": "group",
    "name": "Weekend Hikers",
    "member_count": 3
  },
  "aggregate_metadata": {
    "fanout_mode": "per_recipient",
    "mixed_decision_priority": ["allow", "ask", "deny"],
    "partial_reason_code": "policy.partial.group_fanout",
    "empty_group_summary": "No active recipients in group.",
    "partial_summary_template": "Partial group delivery: {delivered} delivered, {pending} pending, {denied} denied, {review_required} review-required, {failed} failed.",
    "policy_evaluation_mode": "group_outbound_fanout"
  },
  "group_overlay_policies": [
    {
      "id": "pol_group_1",
      "scope": "group",
      "target_id": "grp_hiking",
      "direction": "outbound",
      "resource": "message.general",
      "action": "share",
      "effect": "allow",
      "evaluator": "structured",
      "policy_content": {},
      "effective_from": null,
      "expires_at": null,
      "max_uses": null,
      "remaining_uses": null,
      "source": "user_created",
      "derived_from_message_id": null,
      "learning_provenance": null,
      "priority": 10,
      "created_at": "2026-03-14T10:00:00.000Z"
    }
  ],
  "members": [
    {
      "recipient": {
        "id": "usr_alice",
        "type": "user",
        "username": "alice"
      },
      "roles": ["close_friends"],
      "resolution_id": "res_456_usr_alice",
      "member_applicable_policies": [
        {
          "id": "pol_user_1",
          "scope": "user",
          "target_id": "usr_alice",
          "direction": "outbound",
          "resource": "message.general",
          "action": "share",
          "effect": "ask",
          "evaluator": "structured",
          "policy_content": {},
          "effective_from": null,
          "expires_at": null,
          "max_uses": null,
          "remaining_uses": null,
          "source": "user_created",
          "derived_from_message_id": null,
          "learning_provenance": null,
          "priority": 80,
          "created_at": "2026-03-14T10:00:00.000Z"
        }
      ],
      "llm": {
        "subject": "alice",
        "provider_defaults": null
      }
    }
  ]
}
```

### 2b) Commit Local Decision

Endpoint:

```http
POST /api/v1/plugin/local-decisions/commit
```

Request body:

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
  "idempotency_key": "idem_local_commit_1",
  "local_decision": {
    "decision": "ask",
    "delivery_mode": "review_required",
    "reason": "Local review is required before sharing current location.",
    "reason_code": "policy.ask.user.structured",
    "winning_policy_id": "pol_user_1"
  }
}
```

Request notes:

- Mahilo uses a dedicated commit endpoint for plugin-local decisions. `/api/v1/plugin/outcomes` remains the post-send and post-review outcome-reporting channel.
- `resolution_id` is the authoritative local-evaluation attempt key. Retries with the same `resolution_id` deduplicate and return the existing artifact.
- `idempotency_key` in the body or `Idempotency-Key` header may also be supplied. Reusing that key for a different `resolution_id` is rejected.
- Current implementation accepts direct user-send commits and per-recipient group-fanout commits. Group fan-out commits still use `recipient_type=user`; when the winning policy may depend on group overlays, clients must also send `group_id` from the source fan-out bundle.
- For group fan-out, plugin clients must commit members in the bundle member order and reuse each member `resolution_id`. This preserves trusted lifecycle semantics for shared one-time or limited policies across partial fan-out.
- On the first successful commit, the server performs authoritative winning-policy lifecycle mutation and persists a message artifact even when transport never starts.
- `allow` commits create a pending message artifact. Later `POST /api/v1/messages/send` must reuse the same `resolution_id` so transport binds to that committed local decision.
- `ask` commits create a `review_required` message artifact that later appears in `GET /api/v1/plugin/reviews`.
- `deny` commits create a `rejected` message artifact that later appears in `GET /api/v1/plugin/events/blocked`.
- Queue and blocked-event APIs expose these local decisions through the normal audit fields, with `audit.policy_evaluation_mode = "plugin_local_pre_delivery"` when the record originated from local commit.
- Degraded local LLM review outcomes use explicit reason codes under `policy.ask.llm.<kind>`. Current kinds include `unavailable`, normalized transport/provider/parser kinds such as `network`, `provider`, `invalid_response`, `timeout`, `unknown`, and `skip`.
- Plugin clients must treat those degraded-review codes as review-required even when local UX is configured with `reviewMode=auto`; evaluator uncertainty must not silently auto-send.

Success response example:

```json
{
  "recorded": true,
  "committed": true,
  "message_id": "msg_123",
  "status": "review_required",
  "resolution": {
    "resolution_id": "res_123",
    "decision": "ask",
    "delivery_mode": "review_required",
    "summary": "Local review is required before sharing current location.",
    "reason_code": "policy.ask.user.structured"
  },
  "recipient_results": [
    {
      "recipient": "alice",
      "decision": "ask",
      "delivery_mode": "review_required",
      "delivery_status": "review_required"
    }
  ]
}
```

Deduplicated retry example:

```json
{
  "recorded": true,
  "committed": true,
  "deduplicated": true,
  "message_id": "msg_123",
  "status": "review_required",
  "resolution": {
    "resolution_id": "res_123",
    "decision": "ask",
    "delivery_mode": "review_required",
    "summary": "Local review is required before sharing current location.",
    "reason_code": "policy.ask.user.structured"
  },
  "recipient_results": [
    {
      "recipient": "alice",
      "decision": "ask",
      "delivery_mode": "review_required",
      "delivery_status": "review_required"
    }
  ]
}
```

### 3) Resolve Draft (Preflight)

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
- Agent-facing preflight responses intentionally expose only outcome-safe explanation fields (`decision`, `delivery_mode`, `reason_code`, summary) and omit detailed policy internals.
- No message or delivery record is created.
- The returned `resolution_id` is preview-scoped. Plugin clients must not reuse it for non-trusted local commit/send; fetch a bundle to obtain the authoritative local-enforcement `resolution_id`.

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

### 4) Final Send

Endpoint:

```http
POST /api/v1/messages/send
```

This endpoint is not under `/plugin`. Plugin clients use it in two different ways:

- **Trusted/plaintext send**: when `trustedMode=true` and `payload_type != application/mahilo+ciphertext`, Mahilo evaluates policy on the server here.
- **Resumed local `allow` send**: after a successful `POST /api/v1/plugin/local-decisions/commit` with `decision=allow`, the plugin resumes transport here by reusing the committed `resolution_id`.

Transport rules:

- Local `ask` and `deny` decisions do not call `/messages/send`; the commit response is already the terminal pre-delivery artifact.
- Direct local sends must reuse the committed `resolution_id`.
- Local group fan-out does not send the original group target back through `/messages/send` after commit. It sends each allowed member separately as `recipient_type=user` with that member `resolution_id`.
- When a `resolution_id` is already bound to a committed local artifact, sender connection, recipient, recipient connection (when already bound), selectors, payload, payload type, and context must match that artifact or the server returns `LOCAL_DECISION_CONFLICT`.
- Replays with the same committed `resolution_id` deduplicate to the existing message, even if a later retry supplies a different `idempotency_key`.

Plugin-relevant request fragment for a resumed local `allow`:

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

Trusted direct review-required response example (no transport started, still HTTP `200`):

```json
{
  "message_id": "msg_123",
  "status": "review_required",
  "resolution": {
    "resolution_id": "res_123",
    "decision": "ask",
    "delivery_mode": "review_required",
    "summary": "Message requires review before delivery.",
    "reason_code": "policy.ask.resolved"
  },
  "recipient_results": [
    {
      "recipient": "alice",
      "decision": "ask",
      "delivery_mode": "review_required",
      "delivery_status": "review_required"
    }
  ]
}
```

Resumed local `allow` response example:

```json
{
  "message_id": "msg_123",
  "status": "delivered",
  "delivery_status": "delivered",
  "resolution": {
    "resolution_id": "res_123",
    "decision": "allow",
    "delivery_mode": "full_send",
    "summary": "Message allowed by policy.",
    "reason_code": "policy.allow.user.structured"
  },
  "recipient_results": [
    {
      "recipient": "alice",
      "decision": "allow",
      "delivery_mode": "full_send",
      "delivery_status": "delivered"
    }
  ]
}
```

Trusted `recipient_type=group` sends additionally return aggregate fan-out counters (`recipients`, `delivered`, `pending`, `failed`, `denied`, `review_required`) plus per-recipient `recipient_results`. That aggregate group response shape is not reused in local group fan-out, because local mode commits and reports each member separately.

### 5) Report Outcome

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

Request notes:

- Outcome reports append audit detail to an existing `message_id`; they do not create a new message artifact and do not mutate policy lifecycle.
- For locally committed direct sends, use the `message_id` returned by `/api/v1/plugin/local-decisions/commit` or the resumed `/api/v1/messages/send`.
- For local group fan-out, report outcomes per committed member artifact. There is no bundle-level aggregate outcome endpoint.
- `resolution_id` is optional but should be supplied whenever available so plugin reports correlate cleanly with the committed/send artifact.

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

### 6) Create Override

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

### 7) Query Review Queue

Endpoint:

```http
GET /api/v1/plugin/reviews
```

Auth:

- Requires authenticated + active invite-backed account.

Query params:

- `status` optional: `review_required`, `approval_pending`, or comma-separated list.
- `direction` optional: `all` (default), `outbound`, `inbound`.
- `limit` optional: max `100`, default `50`.
- Responses include a rich `audit` object for user/admin debugging (resolver layer, matched/winning policy IDs, evaluated policy trail, and explanation context when available).
- Local `ask` commits appear here as ordinary review records. `audit.policy_evaluation_mode` distinguishes local commit records (`plugin_local_pre_delivery`) from trusted send records (`outbound_pre_delivery` / `inbound_pre_delivery`).
- Local `allow` commits do not appear here, because they are stored as pending transport artifacts rather than review items.

Success response:

```json
{
  "contract_version": "1.0.0",
  "review_queue": {
    "count": 2,
    "direction": "all",
    "statuses": ["review_required", "approval_pending"]
  },
  "reviews": [
    {
      "review_id": "rev_msg_123",
      "message_id": "msg_123",
      "status": "review_required",
      "queue_direction": "outbound",
      "decision": "ask",
      "delivery_mode": "review_required",
      "summary": "Message requires review before delivery.",
      "reason_code": "policy.ask.resolved",
      "audit": {
        "resolver_layer": "user_policies",
        "winning_policy_id": "pol_ask_1",
        "matched_policy_ids": ["pol_ask_1"],
        "resolution_explanation": "User-scoped ask policy requires review.",
        "evaluated_policies": [
          {
            "policy_id": "pol_ask_1",
            "effect": "ask",
            "scope": "user",
            "evaluator": "structured",
            "phase": "deterministic",
            "matched": true
          }
        ]
      },
      "message_preview": "Draft preview...",
      "selectors": {
        "direction": "outbound",
        "resource": "location.current",
        "action": "share"
      },
      "created_at": "2026-03-08T12:00:00.000Z"
    }
  ]
}
```

### 8) Query Blocked Events

Endpoint:

```http
GET /api/v1/plugin/events/blocked
```

Auth:

- Requires authenticated + active invite-backed account.

Query params:

- `direction` optional: `all` (default), `outbound`, `inbound`.
- `limit` optional: max `100`, default `50`.
- `include_payload_excerpt` optional: `false` by default.
- Local `deny` commits appear here as ordinary blocked events. In local group fan-out, denied members appear one event per committed member artifact.
- Local `allow` commits never appear here.
- `audit.policy_evaluation_mode` distinguishes local commit blocks (`plugin_local_pre_delivery`) from trusted send-time blocks.

Success response:

```json
{
  "contract_version": "1.0.0",
  "retention": {
    "blocked_event_log": "metadata_only",
    "payload_excerpt_default": "omitted",
    "payload_excerpt_included": false,
    "payload_hash_algorithm": "sha256",
    "source_message_payload": "messages table may retain full payload for delivery/audit compatibility"
  },
  "blocked_events": [
    {
      "id": "blocked_msg_123",
      "message_id": "msg_123",
      "queue_direction": "outbound",
      "sender": "bob",
      "reason_code": "policy.deny.user.structured",
      "reason": "Message blocked by policy.",
      "direction": "outbound",
      "resource": "location.current",
      "action": "share",
      "audit": {
        "resolver_layer": "user_policies",
        "winning_policy_id": "pol_block_1",
        "matched_policy_ids": ["pol_block_1"],
        "evaluated_policies": [
          {
            "policy_id": "pol_block_1",
            "effect": "deny",
            "scope": "user",
            "evaluator": "structured",
            "phase": "deterministic",
            "matched": true
          }
        ]
      },
      "stored_payload_excerpt": null,
      "payload_hash": "sha256:...",
      "timestamp": "2026-03-08T12:00:00.000Z"
    }
  ]
}
```

Retention behavior:

- Blocked-event API responses are metadata-first by default (`stored_payload_excerpt` omitted).
- Callers can request a short excerpt with `include_payload_excerpt=true`.
- `payload_hash` is always included for correlation without exposing full payload content.

---

## Not Implemented Yet (Do Not Integrate Against)

This route is not available in this repo yet:

- `POST /api/v1/plugin/reviews/:review_id/decision`

It remains out of current contract scope.

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
- `INVALID_LOCAL_DECISION`
- `INVALID_QUERY`
- `INVALID_ROLE`
- `FORBIDDEN`
- `LOCAL_DECISION_CONFLICT`
- `LOCAL_DECISION_STALE`
- `MESSAGE_NOT_FOUND`
- `MESSAGE_SENDER_MISMATCH`
- `SOURCE_MESSAGE_NOT_FOUND`
- `UNSUPPORTED_RECIPIENT_TYPE`
- `PAYLOAD_TOO_LARGE`

---

## Contract Validation Coverage

Current integration tests covering this contract:

- `tests/integration/plugin-context.test.ts`
- `tests/integration/plugin-direct-send-bundle.test.ts`
- `tests/integration/plugin-group-fanout-bundle.test.ts`
- `tests/integration/plugin-local-decision-commit.test.ts`
- `tests/integration/plugin-resolve.test.ts`
- `tests/integration/plugin-outcomes.test.ts`
- `tests/integration/plugin-overrides.test.ts`
- `tests/integration/plugin-events-reviews.test.ts`
- `tests/integration/group-fanout-resolution.test.ts`
- `tests/integration/selector-aware-send.test.ts`
