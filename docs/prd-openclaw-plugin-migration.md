# Mahilo OpenClaw Plugin PRD: Migration and Native Integration

> **Project**: Mahilo OpenClaw Plugin
> **Status**: Planning
> **Last Updated**: 2026-03-08
> **Primary Goal**: Move Mahilo’s OpenClaw plugin to a clean long-term home and evolve it into the preferred native client for Mahilo.

---

## What You Asked For

You want:

1. Mahilo server work to stay in this repo.
2. Plugin work to stop being trapped inside `myclawd` as legacy implementation detail.
3. A plan for whether the plugin should:
   - stay in `myclawd/extensions/mahilo`
   - move to a separate repo
   - or move into this repo under a dedicated plugin folder
4. A task list for migrating the existing plugin code and modernizing it.

This PRD is that plan.

The runtime contract the plugin should code against lives in `docs/openclaw-plugin-server-contract.md`.

---

## Recommendation

### Recommended Home

**Move the plugin into this repo** under a dedicated package directory, for example:

```text
plugins/openclaw-mahilo/
```

or

```text
plugins/openclaw/mahilo/
```

### Why This Is the Best Next Step

- server and plugin contracts can evolve together
- one repo makes API + plugin coordination much easier
- migration can happen incrementally from the current `myclawd` plugin
- the plugin can still be packaged as a standalone OpenClaw plugin package later
- if needed, it can be extracted into its own repo later without changing its package boundaries

### Why Not Keep It in `myclawd` Long-Term

- the plugin becomes coupled to one OpenClaw checkout
- server and plugin planning stays split across repos
- Mahilo-specific architecture gets buried inside another product repo

### Why Not Make It a Totally Separate Repo Right Now

- too much early coordination friction
- server contracts are still changing
- plugin migration is easier if code lands next to server work first

### Long-Term Packaging Model

Keep the plugin **physically inside this repo** for now, but structure it as a standalone OpenClaw package from day one:

- its own `package.json`
- its own `openclaw.plugin.json`
- its own tests
- no assumptions that it must live inside OpenClaw core

That gives you the best of both worlds.

---

## Current Plugin Inventory in `myclawd`

Current implementation lives in:

```text
myclawd/extensions/mahilo/
```

Major assets already exist:

- plugin manifest
- package metadata
- Mahilo API client
- config parsing
- key management
- local policy helpers
- outbound tools:
  - `talk_to_agent`
  - `talk_to_group`
  - `list_mahilo_contacts`
- webhook handling
- signature verification
- dedup logic
- trigger-agent bridge
- tests for client, policy, webhook, tools, and state

This means the job is **not** “invent the plugin from scratch.”
It is:

1. choose the long-term home
2. port the existing code cleanly
3. update it to the latest OpenClaw plugin architecture
4. re-point it at the improved Mahilo server contracts

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

## Plugin Product Goals

1. The plugin is the **best UX path** for OpenClaw users.
2. The plugin uses Mahilo server as the source of truth.
3. The plugin adds native OpenClaw value:
   - prompt context injection
   - native tools
   - send-time preflight
   - outcome reporting
   - lightweight review/override flows
4. The plugin remains installable/publishable as a normal OpenClaw plugin package.
5. The plugin does not duplicate the server’s final policy truth.

## Non-Goals

- Rebuilding all Mahilo policy logic locally as the primary truth
- Forking OpenClaw internals
- Making plugin migration depend on a totally separate repository immediately

---

## Repo / Packaging Decision

### 0.1 Create New Plugin Home in This Repo
- **ID**: `PLG2-001`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: None
- **Description**:
  - Create a new package directory in this repo for the OpenClaw plugin.
  - Recommended path: `plugins/openclaw-mahilo/`.
- **Acceptance Criteria**:
  - [x] Plugin package directory exists in this repo
  - [x] Directory is clearly plugin-specific, not server code
  - [x] Path choice is documented
- **Progress Notes**:
  - 2026-03-08: Started PLG2-001 implementation in this workspace.
  - 2026-03-08: Created `plugins/openclaw-mahilo/` with plugin-scoped README documenting the canonical path and scope.

### 0.2 Keep Package Extractable
- **ID**: `PLG2-002`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-001
- **Description**:
  - Structure the plugin as an isolated package so it can later be published or extracted.
- **Acceptance Criteria**:
  - [x] No hard dependency on repo-internal server source imports
  - [x] Plugin talks to Mahilo over HTTP / documented contracts only
  - [x] Build/test scripts are plugin-local
- **Progress Notes**:
  - 2026-03-08: Started PLG2-002 and audited plugin directory state against extractable package requirements.
  - 2026-03-08: Added standalone package scaffold (`package.json`, `tsconfig.json`, `src/`, `tests/`) under `plugins/openclaw-mahilo/`.
  - 2026-03-08: Implemented HTTP-only contract client targeting documented `/api/v1` Mahilo plugin endpoints with required auth/client headers.
  - 2026-03-08: Validated plugin-local commands: `bun run build` and `bun run test` (4 passing tests) from `plugins/openclaw-mahilo/`.

### 0.3 Migration Strategy Decision
- **ID**: `PLG2-003`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-001
- **Description**:
  - Decide on migration style:
    - copy-and-port
    - temporary mirror
    - phased replacement
  - Recommended: **copy-and-port**, then deprecate old location.
  - **Decision**: Use **copy-and-port**.
  - **Source-of-Truth Rules During Migration**:
    - Active development source of truth is `plugins/openclaw-mahilo/`.
    - `myclawd/extensions/mahilo/` is a legacy reference baseline during migration and should not be used for new feature work.
    - Do not run a temporary mirror or bidirectional sync between old and new locations.
    - If a critical fix must land in legacy code before full cutover, it should be authored in `plugins/openclaw-mahilo/` first, then explicitly cherry-picked/backported.
    - A migrated module is considered authoritative only after it is ported in `plugins/openclaw-mahilo/` and validated with plugin-local checks.
    - After Phase 1 completion, mark `myclawd/extensions/mahilo/` as deprecated/read-only.
- **Acceptance Criteria**:
  - [x] Migration approach is written down
  - [x] No ambiguity about source of truth during migration
- **Progress Notes**:
  - 2026-03-08: Started PLG2-003 and selected copy-and-port with explicit no-mirror source-of-truth rules for migration.
  - 2026-03-08: Finalized migration policy: `plugins/openclaw-mahilo/` is authoritative for active development; legacy path is reference-only until deprecation.

---

## Phase 1: Port the Existing Plugin

### 1.1 Port Package Metadata
- **ID**: `PLG2-010`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-001
- **Description**:
  - Bring over `package.json`, plugin manifest, README, tsconfig, and test config.
  - Rename package appropriately if needed.
- **Acceptance Criteria**:
  - [x] New plugin package has valid metadata
  - [x] Manifest/config schema load correctly
  - [x] Test runner can execute in isolation
- **Progress Notes**:
  - 2026-03-08: Started PLG2-010 by auditing plugin metadata artifacts and identifying missing manifest/test-config files to port.
  - 2026-03-08: Ported package metadata artifacts in `plugins/openclaw-mahilo/`, including `openclaw.plugin.json`, plugin-local `vitest.config.ts`, updated package scripts/fields, and README metadata notes.
  - 2026-03-08: Added plugin-local manifest validation tests (`tests/manifest.test.ts`) covering manifest metadata and config schema loading.
  - 2026-03-08: Validated in isolation from `plugins/openclaw-mahilo/` with `bun run build`, `bun run test` (6 passing), and `bun run validate:manifest` (2 passing).

### 1.2 Port Source Modules
- **ID**: `PLG2-011`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-010
- **Description**:
  - Port current modules:
    - client
    - config
    - keys
    - state
    - tools
    - webhook
    - policy helpers
- **Acceptance Criteria**:
  - [x] All current modules exist in new location
  - [x] Imports/build paths are fixed
  - [x] No leftover path coupling to `myclawd/extensions/mahilo`
- **Progress Notes**:
  - 2026-03-08: Started PLG2-011 by auditing plugin module gaps and beginning source-module port into `plugins/openclaw-mahilo/src/`.
  - 2026-03-08: Ported source modules into `plugins/openclaw-mahilo/src/` for `config`, `keys`, `state`, `tools`, `webhook`, and `policy-helpers`; updated `src/index.ts` exports and import wiring.
  - 2026-03-08: Added plugin-local validation tests for ported modules (`tests/config.test.ts`, `tests/keys.test.ts`, `tests/state.test.ts`, `tests/policy-helpers.test.ts`, `tests/tools.test.ts`, `tests/webhook.test.ts`).
  - 2026-03-08: Validated from `plugins/openclaw-mahilo/` with `bun run build` and `bun run test` (24 passing tests).

### 1.3 Port Tests
- **ID**: `PLG2-012`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-011
- **Description**:
  - Bring over existing tests as migration safety net.
- **Acceptance Criteria**:
  - [x] Current behavior is covered after migration
  - [x] Test suite runs from new plugin home
- **Progress Notes**:
  - 2026-03-08: Started PLG2-012 by auditing legacy tests in `myclawd/extensions/mahilo/tests` and mapping them to migrated modules under `plugins/openclaw-mahilo/src`.
  - 2026-03-08: Ported and expanded plugin-local tests for migrated modules (`client`, `config`, `keys`, `state`, `policy-helpers`, `tools`, `webhook`) with legacy parity scenarios adapted to contract-driven plugin behavior.
  - 2026-03-08: Validated from `plugins/openclaw-mahilo/` with `bun run test` (73 passing) and `bun run build`.

### 1.4 Inventory Legacy Gaps
- **ID**: `PLG2-013`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: PLG2-011
- **Description**:
  - Explicitly document which parts of the old plugin are legacy or need redesign.
- **Acceptance Criteria**:
  - [ ] Legacy assumptions are written down
  - [ ] Redesign items are separated from straight migration work

---

## Phase 2: Update to Latest OpenClaw Plugin Architecture

### 2.1 Modernize SDK Imports
- **ID**: `PLG2-020`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-011
- **Description**:
  - Move from older `clawdbot` / `Moltbot` import shapes to modern OpenClaw plugin SDK usage.
  - Prefer current OpenClaw plugin import paths.
- **Acceptance Criteria**:
  - [x] Plugin builds against current OpenClaw SDK surface
  - [x] No legacy naming leaks remain in public-facing plugin code
- **Progress Notes**:
  - 2026-03-08: Started PLG2-020 by auditing plugin exports and adding an OpenClaw SDK-facing plugin entry wired to current import paths (`openclaw/plugin-sdk/core`).
  - 2026-03-08: Added plugin-local tests for OpenClaw SDK registration and public-surface legacy-name guards, then validated with `bun run build`, `bun run test` (79 passing), and targeted TypeScript SDK compatibility compile for `src/openclaw-plugin.ts`.

### 2.2 Normalize Package Identity
- **ID**: `PLG2-021`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: PLG2-020
- **Description**:
  - Decide package identity for long-term use.
  - Example candidates:
    - `@mahilo/openclaw-plugin`
    - `@mahilo/openclaw-mahilo`
  - Keep runtime plugin ID stable (likely `mahilo`).
- **Acceptance Criteria**:
  - [ ] Package name chosen
  - [ ] Plugin ID chosen and stable
  - [ ] Config key expectations documented

### 2.3 Manifest / Config Schema Cleanup
- **ID**: `PLG2-022`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-020
- **Description**:
  - Modernize `openclaw.plugin.json`.
  - Remove stale config keys that should move server-side.
  - Keep plugin config focused on:
    - Mahilo base URL
    - Mahilo API key
    - callback path/url override
    - local cache / UX knobs
    - optional review behavior
- **Acceptance Criteria**:
  - [x] Config schema is clear and minimal
  - [x] Server-truth vs plugin-local config boundary is explicit
  - [x] Sensitive fields are marked clearly
- **Progress Notes**:
  - 2026-03-08: Started PLG2-022 by auditing `openclaw.plugin.json` and runtime config parsing for stale or server-owned keys.
  - 2026-03-08: Modernized manifest schema with explicit plugin-local boundary text, added callback path/url override support, and marked `apiKey` as sensitive (`format: password`, `writeOnly`, `x-sensitive`).
  - 2026-03-08: Tightened runtime config parsing to reject unsupported/server-owned keys and removed legacy user-config overrides for `contractVersion`, `pluginVersion`, and `callbackSecret`.
  - 2026-03-08: Added/updated config and manifest tests and validated with `bun run test` (83 passing), `bun run validate:manifest` (2 passing), and `bun run build`.

---

## Phase 3: Re-Contract the Plugin Around Server Truth

### 3.1 Replace Local Policy Truth with Server Preflight
- **ID**: `PLG2-030`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: PLG2-011, SRV-041
- **Description**:
  - Local filtering can remain as a lightweight safety helper, but final truth should come from Mahilo.
  - Plugin should call server preflight/resolve before final send.
- **Acceptance Criteria**:
  - [ ] Plugin does not own final policy truth
  - [ ] Server preflight result drives send behavior
  - [ ] Local policy logic is explicitly secondary or removed

### 3.2 Context Fetch for Prompt Injection
- **ID**: `PLG2-031`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-040
- **Description**:
  - Fetch selector-aware context from Mahilo before prompt build.
- **Acceptance Criteria**:
  - [ ] Plugin can fetch compact recipient context
  - [ ] Prompt injection format is stable and concise
  - [ ] Failure degrades gracefully

### 3.3 Outcome Reporting
- **ID**: `PLG2-032`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: SRV-042
- **Description**:
  - After send / escalation / rejection / partial share, report the outcome back to Mahilo.
- **Acceptance Criteria**:
  - [ ] Outcome round-trip is implemented
  - [ ] Mahilo history can learn from plugin activity

### 3.4 Temporary Override Flows
- **ID**: `PLG2-033`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: SRV-043
- **Description**:
  - Plugin should be able to request one-time or expiring overrides from Mahilo.
- **Acceptance Criteria**:
  - [ ] Plugin can create one-time overrides
  - [ ] Plugin can create expiring rules
  - [ ] UX is understandable to the agent/user

---

## Phase 4: Native OpenClaw Value

### 4.1 Prompt Hook Integration
- **ID**: `PLG2-040`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: PLG2-031
- **Description**:
  - Use `before_prompt_build` to inject Mahilo context natively.
- **Acceptance Criteria**:
  - [ ] Incoming messages get relationship/policy/history context
  - [ ] Prompt size stays bounded
  - [ ] Injection can be turned on/off cleanly

### 4.2 Native Tools
- **ID**: `PLG2-041`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: PLG2-020, PLG2-030
- **Description**:
  - Keep / update current tools:
    - `talk_to_agent`
    - `talk_to_group`
    - `list_mahilo_contacts`
  - Add new native tools if useful:
    - `get_mahilo_context`
    - `preview_mahilo_send`
    - `create_mahilo_override`
- **Acceptance Criteria**:
  - [ ] Tool set maps cleanly to server contracts
  - [ ] Naming stays stable and OpenClaw-friendly
  - [ ] Tools fail gracefully on network/server errors

### 4.3 Send-Time Hooks
- **ID**: `PLG2-042`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: PLG2-030
- **Description**:
  - Use message send hooks to preflight drafts, block or rewrite if needed, and surface review-required behavior.
- **Acceptance Criteria**:
  - [ ] Plugin can preflight outbound content
  - [ ] Plugin can cancel send when Mahilo denies
  - [ ] Plugin can surface review-required cases cleanly

### 4.4 Post-Send Hooks
- **ID**: `PLG2-043`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: PLG2-032
- **Description**:
  - Use post-send / agent-end hooks to report outcomes and create learning opportunities.
- **Acceptance Criteria**:
  - [ ] Plugin reports send results consistently
  - [ ] Plugin can trigger learning suggestions after novel decisions

### 4.5 Commands / Diagnostics
- **ID**: `PLG2-044`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: PLG2-020
- **Description**:
  - Add plugin-native diagnostics and management commands.
  - Examples:
    - `mahilo status`
    - `mahilo review`
    - `mahilo reconnect`
- **Acceptance Criteria**:
  - [ ] Operator can inspect plugin state quickly
  - [ ] Debugging common failures is easy

---

## Phase 5: Webhook and Inbound Processing

### 5.1 Port and Harden Webhook Route
- **ID**: `PLG2-050`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-011, PLG2-020
- **Description**:
  - Port webhook route using current OpenClaw route registration patterns.
  - Re-check auth and signature handling.
- **Acceptance Criteria**:
  - [x] Webhook route works in current OpenClaw plugin model
  - [x] Signature verification uses correct raw-body semantics
  - [x] Route auth mode is explicit
- **Progress Notes**:
  - 2026-03-08: Started PLG2-050 by auditing current plugin SDK registration flow and legacy webhook route behavior to port webhook routing into the modern OpenClaw plugin entrypoint.
  - 2026-03-08: Added `src/webhook-route.ts` and wired route registration into `registerMahiloOpenClawPlugin`, including explicit POST webhook route auth mode, raw-body request handling, and signature-first verification flow.
  - 2026-03-08: Added route registration and handler tests (`tests/openclaw-plugin.test.ts`, `tests/webhook-route.test.ts`) covering explicit auth mode, callback-path registration, and exact raw-body signature semantics.
  - 2026-03-08: Validated PLG2-050 with `bun run build` and `bun run test` from `plugins/openclaw-mahilo/` (90 passing tests).

### 5.2 Dedup / Idempotency
- **ID**: `PLG2-051`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-050
- **Description**:
  - Preserve and strengthen inbound dedup behavior.
- **Acceptance Criteria**:
  - [x] Retries do not cause duplicate agent runs
  - [x] Message IDs are tracked safely
- **Progress Notes**:
  - 2026-03-08: Started PLG2-051 by auditing webhook delivery processing and route wiring; identified that route-level dedupe state was not wired and duplicate deliveries still invoked `onAcceptedDelivery`.
  - 2026-03-08: Hardened inbound dedupe/idempotency by wiring handler-local dedupe state into webhook processing, preventing duplicate deliveries from triggering accepted-delivery callbacks, and validating/normalizing message IDs with payload/header consistency checks.
  - 2026-03-08: Added regression coverage in `tests/webhook.test.ts` and `tests/webhook-route.test.ts`, then validated with `bun run test` (93 passing) and `bun run build` from `plugins/openclaw-mahilo/`.

### 5.3 Inbound Message Routing
- **ID**: `PLG2-052`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: PLG2-050, SRV-032
- **Description**:
  - Route inbound Mahilo messages into the correct session / agent context.
- **Acceptance Criteria**:
  - [ ] Inbound messages land in the intended OpenClaw session/agent
  - [ ] Request/reply continuity is preserved

---

## Phase 6: Release, Compatibility, and Decommissioning

### 6.1 Publishable Package Readiness
- **ID**: `PLG2-060`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: PLG2-020, PLG2-022
- **Description**:
  - Make the plugin package publishable later, even if not published immediately.
- **Acceptance Criteria**:
  - [ ] `package.json` includes correct `openclaw.extensions`
  - [ ] Build/test story is clear
  - [ ] README explains local development and future publish path

### 6.2 Local Development Story
- **ID**: `PLG2-061`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: PLG2-001, PLG2-020
- **Description**:
  - Document how to use the plugin from this repo during development.
- **Acceptance Criteria**:
  - [ ] Devs know how to point OpenClaw at the local plugin package
  - [ ] No one needs the old `myclawd` copy for active development

### 6.3 Old Plugin Deprecation Plan
- **ID**: `PLG2-062`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: PLG2-011, PLG2-061
- **Description**:
  - Decide whether to:
    - delete old plugin after migration
    - leave a stub / README redirect
    - or freeze it temporarily
- **Acceptance Criteria**:
  - [ ] There is one obvious source of truth after migration
  - [ ] Team members are not confused about where to work

---

## Recommended Migration Order

1. PLG2-001 → PLG2-003
2. PLG2-010 → PLG2-013
3. PLG2-020 → PLG2-022
4. PLG2-030 → PLG2-033
5. PLG2-040 → PLG2-052
6. PLG2-060 → PLG2-062

---

## Definition of Done

This PRD is complete when:

- the Mahilo plugin has a clear long-term home
- the current `myclawd` plugin implementation has been ported
- the plugin uses Mahilo server as source of truth
- OpenClaw-native features (hooks, tools, diagnostics) are first-class
- local development no longer depends on editing the legacy plugin in `myclawd`
