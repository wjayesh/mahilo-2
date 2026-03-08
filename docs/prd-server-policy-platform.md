# Mahilo Server PRD: Policy Platform and Plugin Contracts

> **Project**: Mahilo Server (`mahilo-2`)
> **Status**: Planning
> **Last Updated**: 2026-03-08
> **Primary Goal**: Turn Mahilo into the source of truth for identity, policy resolution, audit, and plugin-facing communication contracts.

---

## Why This Exists

The current server already provides:

- authentication and user identity
- friendships, roles, groups, and routing primitives
- message send / receive APIs
- centralized policy storage
- a policy context endpoint for recipients

But the current model still has the gaps we identified:

- mixed policy axes (`policy_type` vs scope vs selectors vs effect)
- additive "fail fast" semantics instead of explicit resolution
- no first-class temporary rules / expiry / one-time overrides
- weak separation between platform guardrails and user preferences
- incomplete inbound request policy semantics
- insufficient plugin-facing APIs for preflight, outcomes, review, and learning
- group enforcement that is not yet modeled per recipient

This PRD is the server-side execution plan to fix those gaps.

The formal server↔plugin runtime contract lives in `docs/openclaw-plugin-server-contract.md`.

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

## Product Goals

1. Mahilo is the **source of truth** for identity, relationships, policies, lifecycle, and audit.
2. Mahilo resolves policies into a clear result: `allow`, `ask`, or `deny`.
3. Mahilo supports **server-only** operation and **server + OpenClaw plugin** operation.
4. Mahilo exposes stable contracts that a plugin can use natively.
5. Mahilo supports situational privacy choices through **temporary overrides** and **expiring rules**.
6. Mahilo makes group fan-out and inbound request handling logically correct.

## Non-Goals

- Rebuilding OpenClaw inside this repo
- Full UI implementation in the first pass
- Making vector search a hard enforcement dependency
- Perfect local type/content verification in v1

---

## Existing Server Surfaces To Evolve

- `POST /api/v1/messages/send`
- `GET /api/v1/policies/context/:username`
- policy CRUD routes
- role and friendship lookups
- message history and reply policy summaries

These are strong starting points, but they need canonical policy semantics and stronger plugin-facing contracts.

---

## Phase 0: Freeze the Canonical Model

### 0.1 Canonical Policy Schema
- **ID**: `SRV-001`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: None
- **Description**:
  - Replace the old conceptual model with the canonical shape:
    - `scope`
    - `target_id`
    - `direction`
    - `resource`
    - `action`
    - `effect`
    - `evaluator`
    - `policy_content`
    - `effective_from`
    - `expires_at`
    - `max_uses`
    - `remaining_uses`
    - `source`
    - `derived_from_message_id`
  - Keep `priority`, `enabled`, and timestamps.
- **Acceptance Criteria**:
  - [ ] Canonical TS type exists in server code
  - [ ] Canonical schema documented in code and docs
  - [ ] All new APIs use the new model

### 0.2 Separate Guardrails from User Policies
- **ID**: `SRV-002`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-001
- **Description**:
  - Create an explicit layer for platform guardrails.
  - Guardrails are non-overridable by user policy.
  - User policies resolve after guardrails.
- **Acceptance Criteria**:
  - [ ] Guardrails are represented separately from user policies
  - [ ] Resolver order is documented and tested
  - [ ] A user allow cannot override a platform deny

### 0.3 Resolution Semantics
- **ID**: `SRV-003`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-001, SRV-002
- **Description**:
  - Replace additive "if any policy fails" evaluation.
  - Implement specificity-based resolution:
    - `user > role > global`
    - group overlay as additional constraint
    - same-level conflict resolution via `deny > ask > allow`
- **Acceptance Criteria**:
  - [ ] Resolver returns exactly one final effect
  - [ ] Conflict behavior is deterministic
  - [ ] Resolution explanation is preserved for audit

---

## Phase 1: Schema and Data Migration

### 1.1 Policies Table Expansion
- **ID**: `SRV-010`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-001
- **Description**:
  - Add selector, effect, evaluator, lifecycle, and provenance columns.
  - Preserve backward compatibility long enough for migration.
- **Acceptance Criteria**:
  - [ ] Migration adds all new columns
  - [ ] Indexes exist for lookup and lifecycle queries
  - [ ] Existing data remains readable during migration

### 1.2 Message Table Expansion
- **ID**: `SRV-011`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-001
- **Description**:
  - Add `direction`, `resource`, `action`, `in_response_to`, `outcome`, `outcome_details`, `policies_evaluated`, `sender_connection_id`.
  - Optionally add `classified_*` fields for future selector verification.
- **Acceptance Criteria**:
  - [ ] Messages persist selectors and outcomes
  - [ ] Sender connection can be tied to each message
  - [ ] Existing send flow keeps working during migration

### 1.3 Backfill / Compatibility Layer
- **ID**: `SRV-012`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: SRV-010, SRV-011
- **Description**:
  - Support old policy rows while the server migrates.
  - Add read/write translation where necessary.
- **Acceptance Criteria**:
  - [ ] Old rows can still be listed/read
  - [ ] New rows are written in the canonical format
  - [ ] Compatibility strategy is documented

---

## Phase 2: Resolver and Lifecycle

### 2.1 Active Policy Filtering
- **ID**: `SRV-020`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-010
- **Description**:
  - Evaluate only active policies:
    - enabled
    - effective time window
    - remaining uses > 0
- **Acceptance Criteria**:
  - [ ] Expired policies never participate
  - [ ] Spent one-time overrides never participate
  - [ ] Tests cover lifecycle boundaries

### 2.2 Deterministic Resolver
- **ID**: `SRV-021`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-003, SRV-020
- **Description**:
  - Evaluate structured and heuristic policies first.
  - Evaluate contextual LLM policies second.
  - Merge into a single final effect.
- **Acceptance Criteria**:
  - [ ] Returns `allow` / `ask` / `deny`
  - [ ] Returns winning policy and evaluated policies
  - [ ] Returns minimal reason code + full audit explanation

### 2.3 One-Time Overrides and Expiring Rules
- **ID**: `SRV-022`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-020, SRV-021
- **Description**:
  - Support `max_uses = 1`
  - Support `expires_at`
  - Support override provenance
- **Acceptance Criteria**:
  - [ ] One-time overrides are consumed after use
  - [ ] Expiring rules stop applying automatically
  - [ ] Audit shows who/what created them

### 2.4 Review / Ask Semantics
- **ID**: `SRV-023`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-021
- **Description**:
  - Define what `ask` means in server behavior.
  - Outbound: do not send until escalated or explicitly overridden.
  - Inbound: either mark review-required or hold for approval depending on mode.
- **Acceptance Criteria**:
  - [ ] Server behavior is consistent across flows
  - [ ] Plugin/server clients receive structured resolution
  - [ ] Audit distinguishes `ask` from `deny`

---

## Phase 3: Identity, Selectors, and Inbound Handling

### 3.1 Bind Messages to Authenticated Identity
- **ID**: `SRV-030`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-011
- **Description**:
  - Persist sender connection identity in the send path.
  - Ensure policy resolution uses authenticated sender identity + connection.
- **Acceptance Criteria**:
  - [ ] Every outbound message can reference sender user + connection
  - [ ] Resolver input includes authenticated identity
  - [ ] Signature / sender metadata are not the only identity source

### 3.2 Selector-Aware Send API
- **ID**: `SRV-031`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-011
- **Description**:
  - Extend `POST /messages/send` to accept canonical selectors.
  - Treat declared selectors as hints from trusted clients.
- **Acceptance Criteria**:
  - [ ] `direction`, `resource`, `action` accepted and stored
  - [ ] Validation exists for known resources/directions
  - [ ] Backward compatibility exists for old clients during transition

### 3.3 Inbound Request Policy Engine
- **ID**: `SRV-032`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-021, SRV-030, SRV-031
- **Description**:
  - Add pre-delivery request evaluation.
  - Support inbound `allow` / `ask` / `deny` semantics.
- **Acceptance Criteria**:
  - [ ] Inbound deny blocks before delivery
  - [ ] Inbound ask produces review-required behavior
  - [ ] Inbound audit log exists

### 3.4 Selector Verification Hooks (Future-Friendly)
- **ID**: `SRV-033`
- **Status**: `pending`
- **Priority**: P2
- **Depends on**: SRV-031
- **Description**:
  - Lay groundwork for comparing declared selectors with Mahilo-side classification.
- **Acceptance Criteria**:
  - [ ] Classified fields or hook points exist
  - [ ] Mismatch can be logged without blocking initial rollout

---

## Phase 4: Plugin-Facing API Contracts

### 4.1 Context Endpoint v2
- **ID**: `SRV-040`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-021, SRV-031
- **Description**:
  - Evolve recipient context endpoint to include selector-aware policy context.
  - Include relationship, roles, recent interactions, relevant decisions, and summary.
- **Acceptance Criteria**:
  - [ ] Plugin can fetch compact prompt-ready context
  - [ ] Response includes selectors and resolved guidance
  - [ ] Context stays stable enough for plugin consumption

### 4.2 Draft Resolution / Preflight Endpoint
- **ID**: `SRV-041`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-021, SRV-031
- **Description**:
  - New endpoint for plugin/server clients to preview send resolution before final send.
  - Input: recipient, selectors, content, context, routing info.
  - Output: `allow` / `ask` / `deny`, summary, applied policy info.
- **Acceptance Criteria**:
  - [ ] Can be called without creating final delivery
  - [ ] Matches actual send-time resolution behavior
  - [ ] Returns structured result for plugin UX

### 4.3 Outcome Reporting Endpoint
- **ID**: `SRV-042`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-011
- **Description**:
  - Endpoint to report whether a draft was shared, withheld, escalated, or partially sent.
- **Acceptance Criteria**:
  - [ ] Plugin can report outcomes after send or review
  - [ ] Server stores outcome for learning/audit
  - [ ] Correlates with original request/response pair

### 4.4 Temporary Override Creation Endpoint
- **ID**: `SRV-043`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: SRV-022
- **Description**:
  - Either extend policy create endpoint or add specialized helper behavior for one-time / expiring overrides.
- **Acceptance Criteria**:
  - [ ] One-time override creation is straightforward for plugin clients
  - [ ] Override source/provenance is explicit
  - [ ] Validation prevents malformed overrides

### 4.5 Blocked / Review Event APIs
- **ID**: `SRV-044`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: SRV-023, SRV-032
- **Description**:
  - Provide APIs to inspect blocked events and review-required events.
- **Acceptance Criteria**:
  - [ ] Minimal redacted blocked-event log exists
  - [ ] Review queue can be queried
  - [ ] Sensitive payload retention behavior is documented

---

## Phase 5: Group Delivery Correctness

### 5.1 Per-Recipient Fan-Out Resolution
- **ID**: `SRV-050`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-021, SRV-030, SRV-031
- **Description**:
  - Group delivery must resolve policies per recipient.
  - Group policy acts as overlay, not sole decision-maker.
- **Acceptance Criteria**:
  - [ ] A group message can produce mixed per-recipient results
  - [ ] Denied recipients do not receive the message
  - [ ] Partial delivery is explicitly logged

### 5.2 Per-Recipient Outcome Storage
- **ID**: `SRV-051`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: SRV-050
- **Description**:
  - Persist allow/ask/deny result per delivery target.
- **Acceptance Criteria**:
  - [ ] Delivery table or equivalent stores resolution per member
  - [ ] Group audit can explain who got what and why

---

## Phase 6: Learning and Audit

### 6.1 Learning Provenance
- **ID**: `SRV-060`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: SRV-010, SRV-011, SRV-042
- **Description**:
  - Track which interaction created or suggested a policy.
- **Acceptance Criteria**:
  - [ ] Policies can point to source message/interaction
  - [ ] Audit can show override → promoted rule history

### 6.2 Promotion Suggestions Model
- **ID**: `SRV-061`
- **Status**: `pending`
- **Priority**: P2
- **Depends on**: SRV-022, SRV-042, SRV-060
- **Description**:
  - Support repeated temporary overrides leading to a suggestion to create a durable policy.
- **Acceptance Criteria**:
  - [ ] Server can detect repeated patterns
  - [ ] Suggestion logic is separated from enforcement

### 6.3 Agent-Facing vs User-Facing Explanations
- **ID**: `SRV-062`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: SRV-021, SRV-044
- **Description**:
  - Minimal reason codes for agent clients
  - Rich detailed audit for users/admins
- **Acceptance Criteria**:
  - [ ] Agent-facing payload avoids oversharing policy details
  - [ ] User-facing audit includes enough debugging context

---

## Phase 7: Testing and Documentation

### 7.1 Resolver Test Matrix
- **ID**: `SRV-070`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-021, SRV-022, SRV-032, SRV-050
- **Description**:
  - Add tests for:
    - specificity conflicts
    - override expiry
    - one-time use depletion
    - inbound ask/deny
    - group partial delivery
- **Acceptance Criteria**:
  - [ ] High-risk policy semantics are covered by tests
  - [ ] Regressions are easy to catch

### 7.2 Contract Documentation
- **ID**: `SRV-071`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-040, SRV-041, SRV-042, SRV-043
- **Description**:
  - Document plugin-facing APIs and payloads.
- **Acceptance Criteria**:
  - [ ] API examples match actual implementation
  - [ ] Plugin/client teams can integrate without guessing

### 7.3 Migration Notes
- **ID**: `SRV-072`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: SRV-012
- **Description**:
  - Document old → new policy model migration.
- **Acceptance Criteria**:
  - [ ] Migration path is explicit
  - [ ] Breaking changes are called out clearly

---

## Server-First vs Plugin Mode

The server must support both:

1. **Server-only mode**
   - any agent framework can call Mahilo APIs directly
   - lower adoption friction
   - fewer native runtime features

2. **Server + plugin mode**
   - plugin fetches context, preflights drafts, reports outcomes
   - richer native tools and hooks
   - better UX and lower prompt overhead

The server is the same in both models. The plugin just becomes the best client.

---

## Recommended Build Order

1. SRV-001 → SRV-003
2. SRV-010 → SRV-023
3. SRV-030 → SRV-044
4. SRV-050 → SRV-062
5. SRV-070 → SRV-072

---

## Definition of Done

This PRD is complete when:

- server policy model is canonical and lifecycle-aware
- server resolution semantics are deterministic and test-covered
- plugin/server clients can use stable context, preflight, override, and outcome APIs
- inbound request handling and group fan-out are correct
- audit and explanation surfaces are good enough for both agents and humans
