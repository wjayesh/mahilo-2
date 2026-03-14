# Mahilo PRD: Local Plugin Policy Enforcement in Non-Trusted Mode

> **Project**: Mahilo local plugin policy enforcement
> **Status**: Planning
> **Last Updated**: 2026-03-14
> **Primary Goal**: Make non-trusted OpenClaw plugin sends enforce Mahilo policies locally without inventing a second policy engine.

---

## What You Asked For

You want non-trusted plugin mode to enforce Mahilo policies locally for the real outbound paths:

1. `send_message`
2. `ask_network`

You also want:

1. no second independent policy engine
2. shared resolution semantics between server and plugin
3. local LLM policy support in the plugin
4. safe failure semantics
5. an exhaustive task list that can be handed to the orchestrator

This PRD is that task list and implementation plan.

---

## Current State

Today, non-trusted plugin mode is not an enforcement path.

- The server policy engine is real, but message and plugin preflight evaluation only run in trusted mode.
- The plugin live send path goes straight to `/api/v1/messages/send`.
- The plugin has advisory context and a lightweight local helper, but not real send-path enforcement.
- `ask_network` ultimately reuses the same send helpers, so it inherits the same gap.
- LLM-backed policy evaluation exists only on the server and is Anthropic-specific.
- Current server LLM failure behavior is fail-open.
- One-time and expiring override lifecycle mutation is server-only.
- Current review and blocked-event surfaces are built from stored server-side message artifacts, which means locally blocked or locally held sends would not automatically appear there.

The result is simple:

- trusted mode: real enforcement
- non-trusted plugin mode: policy-aware UX, but not real enforcement

---

## Design Decisions

### 1. Enforcement Must Happen Before Transport

In non-trusted mode, the plugin must gate before it calls `/api/v1/messages/send`.

That applies to:

- direct person sends
- direct group sends
- `ask_network` contact fanout
- `ask_network` group ask

### 2. Do Not Rebuild Policy Logic in the Plugin

The plugin must not grow its own policy semantics.

Instead:

- extract shared pure resolution logic
- keep server-only DB loading and identity validation on the server
- let the plugin evaluate locally from a server-provided policy bundle plus a shared resolver

### 3. Server Remains the Source of Truth

The server remains authoritative for:

- policy storage
- friendship/role/group membership lookup
- applicable policy selection
- lifecycle mutation for one-time and limited overrides
- persisted audits, reviews, and blocked-event records

The plugin becomes the local enforcement runtime, not the policy authority.

### 4. Add a Real Plugin Policy Bundle Contract

Do not overload `/plugin/context` or the current advisory `default_decision`.

The plugin needs a dedicated contract that returns the exact data required for local enforcement:

- applicable canonical policies
- selector context
- subject metadata for LLM policies
- member-level inputs for group fanout
- any required provider/model defaults
- enough metadata to persist a later local decision with idempotency

### 5. LLM Failure Must Degrade to `ask`

When an applicable LLM policy exists, local failures must not fail open.

For plugin-local evaluation:

- missing credential: `ask`
- provider timeout: `ask`
- provider/network error: `ask`
- malformed model output: `ask`

This safety ask must not be auto-converted into a send by `reviewMode="auto"`.

### 6. Group Sends Need Member-Level Parity

Group sends cannot use a single coarse group decision.

They must preserve the current trusted semantics:

- base user/role/global policy resolution per member
- group overlay as an additional constraint
- aggregate status and recipient-level results for partial fanout

### 7. Local Decisions Must Still Be Auditable

If the plugin blocks or holds a message locally, Mahilo still needs a server-visible artifact for:

- review queues
- blocked-event views
- lifecycle mutation
- idempotent retries
- later override flows

### 8. Host OpenClaw Credential Reuse Is Not a V1 Dependency

Current plugin APIs do not expose a safe typed host-provider credential interface.

Initial implementation should use:

- plugin-local config
- env fallback

Host credential reuse can be a later OpenClaw SDK follow-up, not a blocker for this project.

---

## Scope

### In Scope

- shared policy-core extraction
- plugin-local deterministic policy evaluation
- plugin-local LLM policy evaluation
- direct send gating
- `ask_network` gating
- group fanout parity
- lifecycle-safe local-decision commit/reporting
- review and blocked-event persistence for local decisions
- parity and regression testing
- orchestrator-ready workflow and task sequencing

### Out of Scope

- changing the meaning of existing policy scopes or effects
- replacing Mahilo server as policy authority
- scraping host OpenClaw secrets from untyped runtime internals
- redesigning Mahilo reviews UX beyond what is required for correctness
- broad new DLP or secret-scanning features unrelated to current Mahilo policy semantics

---

## Definition of Done

This project is done when all of the following are true:

1. In non-trusted mode, plugin `send_message` and `ask_network` enforce Mahilo policies before transport.
2. Local enforcement uses shared resolution semantics, not plugin-only duplicates.
3. Group sends and group ask-around preserve recipient-level parity with trusted server behavior.
4. Applicable LLM policies can be evaluated locally in the plugin with `ask` fallback on evaluator failure.
5. One-time and limited overrides remain lifecycle-safe and idempotent.
6. Locally blocked and locally held sends appear correctly in Mahilo audit/review surfaces.
7. Trusted-mode and local-mode parity tests cover deterministic, LLM, group, and failure cases.

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

## Phase 0: Shared Core Extraction

### 0.1 Create a Shared Policy Core Package
- **ID**: `LPE-001`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: None
- **Description**:
  - Create a shared package or module boundary for policy-core code that both server and plugin can import without pulling in server-only DB/config logic.
  - Preferred shape: `packages/policy-core/` or equivalent repo-level shared package.
  - Keep the surface minimal and explicitly provider-agnostic.
- **Acceptance Criteria**:
  - [ ] Shared package/module exists with its own entrypoint
  - [ ] Plugin can import it without importing server `src/` implementation files directly
  - [ ] No DB, route, or environment loading logic is moved into the shared package
  - [ ] Build/test tooling can resolve the shared package from both server and plugin code

- **Notes**:
  - 2026-03-14T11:39:19.171Z: LPE-001 completed via orchestrator integration.
### 0.2 Extract Shared Selector and Filtering Primitives
- **ID**: `LPE-002`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `LPE-001`
- **Description**:
  - Extract shared selector normalization and matching helpers now duplicated or partially duplicated across server and plugin.
  - Include direction/resource/action normalization and alias handling required for parity.
  - If lifecycle filtering remains server-owned, keep the filtering rules documented and reused through the bundle contract.
- **Acceptance Criteria**:
  - [ ] Shared selector helpers exist and are used by both server and plugin enforcement code
  - [ ] Direction alias behavior matches current server behavior
  - [ ] Plugin advisory-only selector normalization is no longer a separate source of truth
  - [ ] Unit tests cover selector normalization and candidate filtering parity

- **Notes**:
  - 2026-03-14T12:44:27.513Z: LPE-002 completed via orchestrator integration.
### 0.3 Extract Deterministic Resolution Semantics
- **ID**: `LPE-003`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `LPE-001`, `LPE-002`
- **Description**:
  - Move the pure deterministic policy logic into the shared core:
    - rule parsing and validation
    - heuristic and structured evaluation
    - match ordering
    - scope specificity resolution
    - group overlay constraint behavior
    - result shaping, reason codes, and resolution explanation assembly
  - Do not move server wrappers that load data or mutate lifecycle counters.
- **Acceptance Criteria**:
  - [ ] Shared deterministic resolver can evaluate a supplied canonical policy set and return a full `PolicyResult`
  - [ ] Server wrappers call the shared resolver with no trusted-mode behavior drift
  - [ ] Plugin local enforcement can call the same resolver
  - [ ] Unit parity tests cover no-match, conflict, specificity, and group-overlay cases

- **Notes**:
  - 2026-03-14T12:53:56.209Z: LPE-003 completed via orchestrator integration.
### 0.4 Extract a Provider-Neutral LLM Evaluator Contract
- **ID**: `LPE-004`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `LPE-001`
- **Description**:
  - Separate LLM policy prompt building, PASS/FAIL parsing, and normalized result/error types from provider-specific HTTP transport.
  - Introduce a shared evaluator dependency interface that the resolver can call when it encounters `evaluator="llm"`.
  - Keep provider adapters outside the shared core.
- **Acceptance Criteria**:
  - [ ] Shared core depends on an injected LLM evaluator interface, not Anthropic-specific code
  - [ ] Shared prompt and parser behavior are covered by unit tests
  - [ ] Server Anthropic path is refactored to use the new abstraction
  - [ ] Plugin can supply its own provider adapter later without changing policy semantics

- **Notes**:
  - 2026-03-14T13:02:27.758Z: LPE-004 completed via orchestrator integration.
### 0.5 Refactor Server Policy Adapters to Use the Shared Core
- **ID**: `LPE-005`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `LPE-002`, `LPE-003`, `LPE-004`
- **Description**:
  - Refactor server policy wrappers so that server routes still own:
    - DB-backed policy loading
    - friendship/role/group lookup
    - authenticated identity checks
    - guardrails
    - lifecycle consumption
  - Then feed the shared core with already-resolved inputs.
- **Acceptance Criteria**:
  - [ ] Trusted-mode server behavior remains unchanged for direct, inbound, and group flows
  - [ ] Server code no longer duplicates deterministic resolution rules that now live in the shared core
  - [ ] Existing trusted-mode tests still pass
  - [ ] Any remaining server-only logic is clearly isolated

---

- **Notes**:
  - 2026-03-14T13:10:26.735Z: LPE-005 completed via orchestrator integration.
## Phase 1: Server Contracts for Local Plugin Enforcement

### 1.1 Add a Direct-Send Policy Bundle Endpoint
- **ID**: `LPE-010`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `LPE-005`
- **Description**:
  - Add a dedicated server endpoint that returns the canonical inputs required for local plugin enforcement of a direct send.
  - The response should include:
    - authoritative selector context
    - applicable canonical policies
    - recipient identity metadata needed by the resolver
    - LLM subject/provider defaults where relevant
    - idempotency-safe bundle metadata for later decision commit/reporting
  - Do not reuse the current advisory `/plugin/context` response shape as the enforcement contract.
- **Acceptance Criteria**:
  - [ ] Endpoint returns only the data required for local evaluation and commit
  - [ ] Bundle uses authoritative server-side recipient/role/policy selection
  - [ ] Plugin can evaluate a direct user send locally without calling trusted-mode `/plugin/resolve`
  - [ ] Integration tests cover bundle shape and authorization rules

- **Notes**:
  - 2026-03-14T13:20:57.793Z: LPE-010 completed via orchestrator integration.
### 1.2 Add a Group Fanout Policy Bundle Endpoint
- **ID**: `LPE-011`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `LPE-010`
- **Description**:
  - Add a server contract that prepares member-level data for local group enforcement.
  - The bundle must preserve trusted group semantics:
    - member list
    - member-level applicable policies
    - group overlay inputs
    - aggregate metadata needed to reproduce recipient results and partial-delivery summaries
  - This endpoint must support both direct group sends and `ask_network` group asks.
- **Acceptance Criteria**:
  - [ ] Group bundle includes enough data to evaluate each recipient locally
  - [ ] Group overlay semantics can be reproduced without plugin-side DB lookups
  - [ ] Plugin can produce recipient-level and aggregate results consistent with trusted mode
  - [ ] Integration tests cover mixed allow/ask/deny outcomes across group members

- **Notes**:
  - 2026-03-14T13:34:59.049Z: LPE-011 completed via orchestrator integration.
### 1.3 Add a Local-Decision Commit Contract
- **ID**: `LPE-012`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `LPE-010`, `LPE-011`
- **Description**:
  - Add a server contract that accepts plugin-local evaluation results and performs authoritative server-side mutation/persistence work.
  - This contract must support:
    - lifecycle consumption for one-time and limited overrides
    - idempotent commit keyed to the local evaluation attempt
    - persistence of local review-held and blocked artifacts
    - persistence of local allow metadata so later send/outcome paths remain auditable
  - Decide and document whether this is a dedicated endpoint or an extension of `/messages/send` plus a companion local-report endpoint.
- **Acceptance Criteria**:
  - [ ] One-time and limited overrides cannot be double-spent through local retries
  - [ ] Local `ask` and `deny` decisions can be recorded without creating a delivered message
  - [ ] Local `allow` decisions can be tied to the later transport/send path with idempotency
  - [ ] Integration tests cover retries, duplicate commits, and send-after-allow flows

- **Notes**:
  - 2026-03-14T14:13:22.485Z: LPE-012 completed via orchestrator integration.
### 1.4 Surface Provider and Model Defaults for Local LLM Evaluation
- **ID**: `LPE-013`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `LPE-010`
- **Description**:
  - Expose server-side user defaults for provider/model selection where useful for plugin-local LLM evaluation.
  - Keep credentials local to the plugin/OpenClaw environment.
  - Use existing server preference storage if possible rather than creating a new preference source.
- **Acceptance Criteria**:
  - [ ] Local bundle or context response can provide provider/model defaults when configured
  - [ ] No provider credential is stored or returned by Mahilo
  - [ ] Missing defaults do not break deterministic-only policy evaluation
  - [ ] Tests cover preference readout and backward compatibility

### 1.5 Update Contract Documentation for Local Enforcement
- **ID**: `LPE-014`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `LPE-010`, `LPE-011`, `LPE-012`, `LPE-013`
- **Description**:
  - Update the server/plugin contract documentation to describe the new local-enforcement flow, response shapes, lifecycle semantics, and audit surfaces.
  - Explicitly distinguish:
    - advisory context
    - preview/resolve behavior
    - local enforcement bundle
    - local-decision commit/report behavior
- **Acceptance Criteria**:
  - [ ] Contract docs describe the new request/response flows end to end
  - [ ] Group fanout and audit semantics are documented
  - [ ] LLM default sourcing and credential boundaries are documented
  - [ ] Old doc/code drift around preview-vs-send is corrected

---

## Phase 2: Plugin Local Evaluation Runtime

### 2.1 Add a Plugin Local Policy Runtime Module
- **ID**: `LPE-020`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `LPE-003`, `LPE-004`, `LPE-010`, `LPE-011`
- **Description**:
  - Build a plugin runtime module that:
    - fetches a direct or group policy bundle
    - runs the shared resolver locally
    - evaluates any applicable LLM policies through the plugin provider adapter
    - returns a normalized decision payload usable by send tools and `ask_network`
  - This becomes the real local enforcement path in non-trusted mode.
- **Acceptance Criteria**:
  - [ ] Plugin can evaluate a direct send locally from a server bundle
  - [ ] Plugin can evaluate group/member fanout locally from a group bundle
  - [ ] Result shape contains enough metadata for tool UX and server commit
  - [ ] Existing lightweight guard helper is not the active enforcement path anymore

- **Notes**:
  - 2026-03-14T14:27:24.779Z: LPE-020 completed via orchestrator integration.
### 2.2 Extend Plugin Config and Manifest for Local LLM Evaluation
- **ID**: `LPE-021`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: None
- **Description**:
  - Extend plugin config and plugin manifests to support local policy LLM settings.
  - Recommended fields:
    - provider
    - model
    - timeout
    - optional auth-profile hint
    - optional env-var override
  - Do not make raw inline API keys the only supported path.
- **Acceptance Criteria**:
  - [ ] Plugin config schema accepts local policy LLM settings
  - [ ] Manifest marks sensitive credential fields correctly where applicable
  - [ ] Unknown-key validation remains strict
  - [ ] Tests cover config precedence and manifest validation

- **Notes**:
  - 2026-03-14T14:37:34.148Z: LPE-021 completed via orchestrator integration.
### 2.3 Implement the Plugin OpenAI LLM Adapter
- **ID**: `LPE-022`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `LPE-004`, `LPE-021`
- **Description**:
  - Implement a plugin-local provider adapter for OpenAI suitable for cheap/fast policy checks.
  - Use the shared evaluator contract and keep provider transport isolated from the shared resolver.
  - Start with a simple fetch-based adapter unless a stronger reason emerges to add a runtime SDK dependency.
- **Acceptance Criteria**:
  - [ ] Plugin can evaluate applicable LLM policies through OpenAI
  - [ ] Provider/model/timeout selection follows plugin config and safe fallback rules
  - [ ] Transport errors and malformed responses are normalized for the resolver
  - [ ] Unit tests cover success, timeout, auth failure, rate limit, server error, and malformed output

- **Notes**:
  - 2026-03-14T14:48:46.551Z: LPE-022 completed via orchestrator integration.
### 2.4 Implement Fail-Safe Local LLM Semantics
- **ID**: `LPE-023`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `LPE-020`, `LPE-022`
- **Description**:
  - Ensure local LLM evaluation never fails open when an applicable LLM policy is present.
  - Map local evaluator uncertainty to `ask` with explicit reason codes.
  - Prevent `reviewMode="auto"` from silently converting evaluator uncertainty into a send.
- **Acceptance Criteria**:
  - [ ] Missing key/config for applicable LLM policy yields `ask`
  - [ ] Provider/network/parser failures yield `ask`
  - [ ] Deterministic-only evaluations remain unaffected when no LLM policy applies
  - [ ] Tool result text and structured payloads expose degraded-review reason codes

- **Notes**:
  - 2026-03-14T14:58:35.747Z: LPE-023 completed via orchestrator integration.
### 2.5 Retire the Plugin Toy Guard From the Active Path
- **ID**: `LPE-024`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `LPE-020`
- **Description**:
  - Remove or demote the current lightweight local helper so it is no longer confused for real policy enforcement.
  - Keep any generic utility functions that still add value, but do not leave a second conflicting local-policy path in place.
- **Acceptance Criteria**:
  - [ ] Active send and ask paths do not rely on the toy local guard
  - [ ] Any remaining helper code is clearly scoped as utility or removed
  - [ ] Tests reflect the real enforcement runtime
  - [ ] Plugin docs no longer imply the helper is sufficient enforcement

---

## Phase 3: Plugin Send and Ask Integration

### 3.1 Gate Direct `send_message` in the Shared Send Path
- **ID**: `LPE-030`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `LPE-020`, `LPE-012`, `LPE-023`
- **Description**:
  - Insert local enforcement into the shared send path before transport so direct user and direct group sends both honor policy decisions in non-trusted mode.
  - Preserve the existing tool contract for status, decision, reason, resolution metadata, and post-send behavior.
- **Acceptance Criteria**:
  - [ ] Non-trusted direct sends do not call `/messages/send` when local decision is `ask` or `deny`
  - [ ] Allowed sends continue to transport with attached local-evaluation metadata as needed
  - [ ] Tool response format remains backward compatible for callers
  - [ ] Direct send tests verify no transport call on block/hold

- **Notes**:
  - 2026-03-14T15:15:59.541Z: LPE-030 completed via orchestrator integration.
### 3.2 Gate `ask_network` Contact Fanout
- **ID**: `LPE-031`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `LPE-030`
- **Description**:
  - Ensure `ask_network` contact fanout inherits the same local enforcement logic for each recipient send.
  - Preserve recipient-level delivery statuses, counts, gaps, and reply expectations.
- **Acceptance Criteria**:
  - [ ] Contact fanout applies local enforcement per recipient before transport
  - [ ] Mixed allow/ask/deny outcomes produce correct recipient-level statuses
  - [ ] Replies are only expected/routed for recipients whose ask actually went out
  - [ ] Fanout tests cover mixed outcomes and partial-send reporting

- **Notes**:
  - 2026-03-14T15:36:53.245Z: LPE-031 completed via orchestrator integration.
### 3.3 Gate `ask_network` Group Ask
- **ID**: `LPE-032`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `LPE-011`, `LPE-030`
- **Description**:
  - Apply the new group bundle and local evaluation path to group ask-around sends.
  - Preserve group summary text, delivery status, member-level reasoning, and reply-routing semantics.
- **Acceptance Criteria**:
  - [ ] Group ask-around uses member-level bundle data where required
  - [ ] Group ask-around block/hold cases do not register reply routes
  - [ ] Aggregate and recipient-level results match trusted behavior expectations
  - [ ] Tests cover group allow, group hold, group block, and partial fanout

### 3.4 Preserve Tool UX and Post-Send Hooks
- **ID**: `LPE-033`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `LPE-030`, `LPE-031`, `LPE-032`
- **Description**:
  - Keep tool text, structured results, post-send outcome hooks, learning suggestions, and route-registration behavior coherent when decisions are made locally.
  - Ensure locally held/blocked results do not pretend a transport send occurred.
- **Acceptance Criteria**:
  - [ ] Tool status/reason text remains sensible for local allow/ask/deny cases
  - [ ] Post-send hooks only run with semantics appropriate to what actually happened
  - [ ] No reply route is created for asks that were blocked or held locally
  - [ ] Tests cover after-tool details and route-registration behavior

### 3.5 Keep Preview and Advisory Context Explicitly Non-Authoritative
- **ID**: `LPE-034`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `LPE-030`
- **Description**:
  - Clean up any remaining confusion between advisory context, preview, and real enforcement.
  - Preview may still call `/plugin/resolve`, but the live send path must not depend on coarse `default_decision` logic.
- **Acceptance Criteria**:
  - [ ] Live non-trusted enforcement does not depend on advisory `default_decision`
  - [ ] Preview remains available without being mistaken for transport gating
  - [ ] Contract/docs/tests clearly separate preview from live local enforcement
  - [ ] Regression tests cover the distinction

---

## Phase 4: Audit, Reviews, and Lifecycle Safety

### 4.1 Persist Local Review-Held and Blocked Attempts
- **ID**: `LPE-040`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `LPE-012`, `LPE-033`
- **Description**:
  - Make sure local decisions that never hit transport still appear correctly in Mahilo's server-visible review and blocked-event surfaces.
  - Preserve enough data for later override, review, and analytics flows.
- **Acceptance Criteria**:
  - [ ] Locally held sends appear in the review surface with correct reasoning metadata
  - [ ] Locally blocked sends appear in blocked-event surfaces with correct reasoning metadata
  - [ ] No fake delivered message is created for a blocked local send
  - [ ] Integration tests cover review and blocked-event visibility for local decisions

### 4.2 Make Lifecycle Consumption Idempotent and Correct
- **ID**: `LPE-041`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `LPE-012`, `LPE-030`, `LPE-031`, `LPE-032`
- **Description**:
  - Guarantee that one-time and limited overrides behave correctly when the plugin evaluates locally.
  - Cover:
    - duplicate retries
    - replayed idempotency keys
    - commit-before-send vs send-after-commit sequences
    - partial group fanout
  - Match current trusted semantics unless a deliberate contract change is made and documented.
- **Acceptance Criteria**:
  - [ ] Duplicate local retries do not double-consume lifecycle-limited policies
  - [ ] Group/member-local decisions cannot consume lifecycle state inconsistently
  - [ ] Allow/ask/deny local paths behave consistently with documented lifecycle rules
  - [ ] Integration tests cover duplicate and partial-delivery cases

### 4.3 Add Observability for Local Policy Decisions
- **ID**: `LPE-042`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `LPE-030`, `LPE-040`
- **Description**:
  - Add diagnostics that make local enforcement debuggable in production:
    - reason codes
    - bundle identifiers
    - evaluator/provider timing
    - degraded-review causes
  - Keep secrets and raw payload leakage out of logs.
- **Acceptance Criteria**:
  - [ ] Local enforcement emits structured diagnostics suitable for debugging
  - [ ] Logs and events avoid leaking credential material
  - [ ] Degraded LLM reasons are distinguishable from matched-policy reasons
  - [ ] Tests or snapshots cover core diagnostic payloads

---

## Phase 5: Test and Validation Coverage

### 5.1 Add Shared-Core Parity Tests
- **ID**: `LPE-050`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `LPE-005`
- **Description**:
  - Add unit tests for the shared resolver covering deterministic and LLM-parity behavior.
  - Use the current trusted server behavior as the control surface.
- **Acceptance Criteria**:
  - [ ] Tests cover no-match, same-scope conflicts, specificity, group overlay, and invalid deterministic rules
  - [ ] Tests cover LLM pass/fail/error mapping through the shared evaluator interface
  - [ ] Shared-core outputs include stable effect, reason code, winning policy, and evaluated-policy assertions
  - [ ] Trusted-mode server tests continue to pass after extraction

### 5.2 Add Server Integration Tests for Bundles and Commit Paths
- **ID**: `LPE-051`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `LPE-012`, `LPE-013`
- **Description**:
  - Add integration tests for the new local bundle and local-decision commit/report contracts.
  - Cover authorization, idempotency, lifecycle mutation, and review/blocked artifact creation.
- **Acceptance Criteria**:
  - [ ] Direct-send bundle contract is covered by integration tests
  - [ ] Group bundle contract is covered by integration tests
  - [ ] Commit/report idempotency and lifecycle behavior are covered
  - [ ] Review/blocked artifact creation is covered

### 5.3 Add Plugin Config and Provider Adapter Tests
- **ID**: `LPE-052`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `LPE-021`, `LPE-022`, `LPE-023`
- **Description**:
  - Add plugin unit tests for local LLM config resolution and provider transport behavior.
  - Cover precedence rules between plugin config and environment fallback.
- **Acceptance Criteria**:
  - [ ] Config tests cover defaults, overrides, and unknown-key rejection
  - [ ] Provider tests cover success, timeout, 401, 429, 5xx, and malformed output
  - [ ] Missing credential for applicable LLM policies yields `ask`
  - [ ] Sensitive manifest fields are validated

### 5.4 Add Plugin `send_message` Local Enforcement Tests
- **ID**: `LPE-053`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `LPE-030`, `LPE-040`
- **Description**:
  - Add plugin tests that verify live `send_message` behavior in non-trusted mode.
  - Ensure the tool blocks transport when local evaluation says `ask` or `deny`.
- **Acceptance Criteria**:
  - [ ] Direct user send tests verify no transport call on local hold/block
  - [ ] Direct group send tests verify correct aggregate status behavior
  - [ ] Tool response shape remains compatible
  - [ ] Post-send details are correct for allow vs hold vs block

### 5.5 Add Plugin `ask_network` Local Enforcement Tests
- **ID**: `LPE-054`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `LPE-031`, `LPE-032`, `LPE-040`
- **Description**:
  - Add plugin tests for contact fanout and group ask-around under local enforcement.
  - Verify counts, gaps, reply expectations, and route registration.
- **Acceptance Criteria**:
  - [ ] Contact fanout tests cover mixed recipient outcomes
  - [ ] Group ask tests cover allow/hold/block and partial fanout
  - [ ] Reply routes are only registered for outbound asks that actually went out
  - [ ] Tool summaries remain coherent under mixed outcomes

### 5.6 Add Trusted-vs-Local Parity Integration Tests
- **ID**: `LPE-055`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `LPE-051`, `LPE-053`, `LPE-054`
- **Description**:
  - Add parity tests that compare trusted server evaluation with non-trusted plugin-local evaluation for the same policy/message/selectors.
  - Cover deterministic, LLM, lifecycle, and group cases.
- **Acceptance Criteria**:
  - [ ] Trusted and local paths agree on decision for deterministic cases
  - [ ] Trusted and local paths agree on decision for mocked LLM cases
  - [ ] Group/partial-fanout parity is covered
  - [ ] Any intentional drift is explicitly documented in the test or contract docs

### 5.7 Run Sandbox Validation Against an Isolated OpenClaw Instance
- **ID**: `LPE-056`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `LPE-053`, `LPE-054`, `LPE-055`
- **Description**:
  - Validate the finished local enforcement flow end to end in an isolated OpenClaw sandbox without disturbing the main install.
  - Exercise:
    - direct send allow/ask/deny
    - `ask_network` allow/ask/deny
    - group fanout
    - missing-key degraded review
    - review and blocked-event visibility
- **Acceptance Criteria**:
  - [ ] Sandbox validation covers direct sends and `ask_network`
  - [ ] Missing local LLM credential behavior is confirmed
  - [ ] Review and blocked-event surfaces match expected local decisions
  - [ ] Manual validation notes are captured in the PR/implementation summary

---

## Phase 6: Documentation and Rollout

### 6.1 Update Plugin and Server Docs
- **ID**: `LPE-060`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `LPE-014`, `LPE-021`, `LPE-030`, `LPE-040`
- **Description**:
  - Update README, plugin docs, and any operator notes so the local enforcement path is understandable and supportable.
  - Document:
    - new config fields
    - credential boundaries
    - degraded-review behavior
    - preview vs live enforcement
    - group/local audit semantics
- **Acceptance Criteria**:
  - [ ] Plugin README reflects real non-trusted enforcement behavior
  - [ ] Server docs explain the new bundle/commit/report flow
  - [ ] Operator guidance covers required config and expected failure semantics
  - [ ] Preview/context docs no longer overstate enforcement

### 6.2 Define Rollout and Enablement Rules
- **ID**: `LPE-061`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `LPE-056`, `LPE-060`
- **Description**:
  - Decide how this ships safely:
    - feature flag or immediate default
    - required config checks
    - migration notes for existing plugin users
    - fallback behavior when local provider credentials are absent
  - Write the rollout note explicitly so operators know what will happen on upgrade.
- **Acceptance Criteria**:
  - [ ] Rollout choice is documented
  - [ ] Upgrade/operator notes explain missing-key behavior clearly
  - [ ] Any gating flag/default is tested and documented
  - [ ] The release plan does not leave non-trusted mode ambiguously enforced

---

## Recommended Execution Order

1. `LPE-001` through `LPE-005`
2. `LPE-010` through `LPE-013`
3. `LPE-020` through `LPE-024`
4. `LPE-030` through `LPE-042`
5. `LPE-050` through `LPE-056`
6. `LPE-060` through `LPE-061`

---

## Notes for the Orchestrator

- This project spans both server and plugin code, so it should not run under the current plugin-only workflow.
- Group fanout parity and lifecycle mutation are the highest-risk areas.
- `send_message` and `ask_network` are both P0 because users can hit either path today.
- Host OpenClaw credential reuse is intentionally not a blocker for the first implementation.
- If a worker discovers that a dedicated shared package is impossible with the current build layout, the fallback is a tightly scoped shared module strategy with an explicit follow-up to package it properly.
