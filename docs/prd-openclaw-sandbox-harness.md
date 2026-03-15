# Mahilo PRD: Fool-Proof OpenClaw Sandbox Harness

> **Status**: Proposed
> **Owner**: Codex / Orchestrator
> **Primary Goal**: Build a reproducible, fool-proof two-sandbox harness that proves plugin load, Mahilo registration, friendship setup, message delivery, and policy enforcement end to end, then derive the operator playbook and skill from that verified harness.

## Why This Exists

The current operator surface is useful, but it does not yet prove the exact thing we now care about most:

- two real isolated OpenClaw sandboxes
- both registered against the same Mahilo server
- both backed by real Mahilo users and webhook connections
- friendship and optional role setup between those users
- a real plugin-originated send from sandbox A to sandbox B
- clear proof of whether policy enforcement blocked, held, or delivered the message
- a reproducible playbook that still works after future repo changes

## Current Assessment

The existing skill and live-test doc are useful only as historical reference. They are not sufficient as the final proof harness, and they should not drive the implementation order.

What already exists:

- [openclaw-sandbox-live-test.md](/Users/wjayesh/apps/mahilo-2/plugins/openclaw-mahilo/docs/openclaw-sandbox-live-test.md) covers isolated `OPENCLAW_HOME`, plugin loading, runtime bootstrap state, and one real OpenClaw gateway.
- [seed-local-policy-sandbox.ts](/Users/wjayesh/apps/mahilo-2/plugins/openclaw-mahilo/scripts/seed-local-policy-sandbox.ts) already seeds active users, connections, friendships, policies, groups, and a runtime-state file.
- [message-exchange.test.ts](/Users/wjayesh/apps/mahilo-2/tests/e2e/message-exchange.test.ts) demonstrates the canonical Mahilo API order for register -> connection -> friendship -> accept -> send -> receive.

What is missing or stale:

- the live-test doc still shows public `/api/v1/auth/register` examples without invite-token handling
- the live-test flow is one OpenClaw gateway plus a dummy HTTP receiver, not two real OpenClaw sandboxes
- there is no single reproducible command path that starts Mahilo, both gateways, and validation checks together
- the current skill is stale and should not be treated as the operator source of truth
- there is no fool-proof verification surface for local policy outcomes `allow`, `ask`, `deny`, and missing-local-LLM fallback in the live sandbox harness

## Target Outcome

After this project:

- the default operator path is reproducible from a fresh temp root
- we can run one command or one short sequence to stand up the harness, run the checks, and collect artifacts
- a verified playbook is written from the working harness, not from stale assumptions
- a new skill is written from the verified playbook after the harness is proven
- the playbook clearly distinguishes:
  - no-model deterministic proof
  - optional real-model proof
  - current known blockers

## Scope

In scope:

- plugin build and local load validation
- dual OpenClaw sandbox bootstrap
- Mahilo server bootstrap against a temp SQLite DB
- user registration or sandbox provisioning for two active Mahilo users
- agent connection registration for both sandboxes
- runtime bootstrap state for both sandboxes
- friendship and optional friendship-role setup
- direct-send local policy enforcement validation
- delivery verification on the receiver sandbox
- a new playbook and a new skill derived from the verified harness

Out of scope for P0:

- general browser/dashboard auth testing
- production deployment automation
- CI-hosted provider credentials
- requiring a paid live model turn for the default proof path

## Assumptions

- P0 proof should work without requiring a real model invocation.
- P0 must still use two real OpenClaw gateways, not a dummy receiver.
- A real `/v1/chat/completions` turn remains valuable, but it is a secondary validation path because local provider auth can vary by machine.
- The default harness should prefer API-driven provisioning where practical and keep direct-DB seeding as a fallback-only escape hatch.

## Bootstrap And Provisioning Strategy

The default harness path is an explicit API-driven identity/bootstrap flow plus local runtime-store writes. The baseline proof will not depend on the stale one-gateway doc flow, `mahilo setup`, or plugin startup auto-registration.

Default sequence for the dual-sandbox proof:

1. Create a fresh temp root with one Mahilo DB, sandbox A paths, sandbox B paths, and fixed callback URLs for both gateways.
2. Start Mahilo with `ADMIN_API_KEY` enabled so the harness can mint invite tokens without mutating the DB by hand.
3. Create one invite token per sandbox user with `POST /api/v1/admin/invite-tokens`.
4. Register the sender and receiver through `POST /api/v1/auth/register` with those invite tokens so both users are created on the real invite-backed path.
5. Register one webhook agent connection per user through `POST /api/v1/agents` using the planned gateway callback URLs for sandbox A and sandbox B.
6. Write one runtime bootstrap file per sandbox from the API outputs: `apiKey`, `username`, `callbackConnectionId`, `callbackSecret`, and `callbackUrl`.
7. Establish friendship through the normal API flow: `POST /api/v1/friends/request` and `POST /api/v1/friends/:id/accept`.
8. Start or restart both OpenClaw gateways against those prewritten runtime stores before the scenario matrix runs.

Default-path decisions:

- The harness owns runtime bootstrap persistence. It writes the plugin's expected `version`/`servers` JSON envelope directly from Mahilo API responses instead of asking the plugin to self-bootstrap during the proof run.
- `POST /api/v1/admin/users` is not part of the baseline path because it bypasses the invite-backed registration path the harness is supposed to prove.
- Plugin startup auto-registration is useful as reference material, but it is not the default provisioning surface because it hides connection creation inside gateway startup and makes the two-sandbox proof harder to reason about.
- The old live-test doc, old skill, and `seed-local-policy-sandbox.ts` remain raw material only. They can inform scripts and fixtures, but they do not define the operator flow.

Fallback boundary:

- Direct DB seeding remains available only as an explicit escape hatch, for example when the invite-token/admin surface regresses or when later deterministic policy fixtures cannot be expressed reliably through current APIs.
- Any fallback seeding path must still emit the same downstream artifacts as the default path: two active users, two webhook connections, two runtime bootstrap files, and the same machine-readable provisioning summary shape.
- Fallback seeding must be operator-opt-in and clearly labeled in artifacts so the baseline deterministic proof never silently degrades from API-driven provisioning to DB mutation.

## Deliverables

- new playbook doc under [plugins/openclaw-mahilo/docs](/Users/wjayesh/apps/mahilo-2/plugins/openclaw-mahilo/docs)
- new skill under [.codex/skills](/Users/wjayesh/apps/mahilo-2/.codex/skills)
- one or more reusable harness scripts under [plugins/openclaw-mahilo/scripts](/Users/wjayesh/apps/mahilo-2/plugins/openclaw-mahilo/scripts)
- validation artifacts captured under the sandbox temp root and summarized in machine-readable form
- regression coverage for any new helper logic that is not trivially exercised by the live harness itself

## Success Matrix

The harness has two proof profiles. Only the first one gates P0 completion.

### Baseline Deterministic Proof

- Must pass from a fresh temp root with two real OpenClaw sandboxes and a fresh Mahilo DB.
- Must not require copied provider credentials, `auth-profiles.json`, `/v1/chat/completions`, or any paid-model turn.
- Must use the non-trusted direct-send proof path: bundle -> local evaluation -> local-decision commit -> transport only for committed `allow`.
- Must prove delivery and non-delivery against the second real OpenClaw sandbox, not a dummy HTTP receiver.

### Optional Real-Model Proof

- Runs only when the operator explicitly opts in and local provider credentials are available.
- Covers `ask_network`, `/v1/chat/completions`, and deeper live-session routing checks.
- Adds confidence, but a failure or skip here does not fail the baseline deterministic proof.

### Required P0 Gate Checks

| Gate | Check                                     | Pass Condition                                                                                                                                  | Minimum Evidence                                                                                                                  |
| ---- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `G1` | Plugin load in both sandboxes             | Both gateways start with the local Mahilo plugin enabled and expose the expected Mahilo tools.                                                  | Gateway startup logs plus `openclaw plugins list --json` or equivalent output showing `mahilo` and the expected tool names.       |
| `G2` | Runtime bootstrap and Mahilo registration | Each sandbox has one valid runtime bootstrap entry and one active Mahilo callback connection pointing at that sandbox's `/mahilo/incoming` URL. | Runtime-state JSON for sandbox A and B, Mahilo `GET /api/v1/agents` results, and health/readiness checks for all three processes. |
| `G3` | Friendship/contact readiness              | The sender and receiver users are active, connected to their own sandboxes, and have an accepted friendship before any policy scenario runs.    | Provisioning summary plus Mahilo friendship acceptance evidence or equivalent network-list evidence.                              |

### Required P0 Scenario Matrix

| Scenario             | Trigger / Fixture                                                                                               | Expected Outcome                                                                                                                                                                                                                                                                           | Required Evidence                                                                                                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `S1-send-receive`    | Sender sandbox performs one direct send to the receiver sandbox on the baseline path after `G1`-`G3` are green. | The sender sees a successful send result, Mahilo records a delivered message, and the receiver sandbox records an inbound event. No review or blocked record is created for that message.                                                                                                  | Sender-side result, Mahilo message identifier, and receiver-side transcript/log/webhook evidence showing payload arrival in sandbox B.                                                                                                                                                                                               |
| `S2-allow`           | A recipient or selector fixture that deterministically resolves to local `allow`.                               | `POST /api/v1/plugin/bundles/direct-send` returns a `resolution_id`, local evaluation resolves `allow`, `POST /api/v1/plugin/local-decisions/commit` persists that decision, `POST /api/v1/messages/send` resumes transport with the same `resolution_id`, and delivery reaches sandbox B. | Bundle response, commit response, resumed send response, shared `resolution_id`, resulting `message_id`, and receiver-side delivery evidence.                                                                                                                                                                                        |
| `S3-ask`             | A recipient or selector fixture that deterministically resolves to local `ask`.                                 | No transport send occurs, no delivery reaches sandbox B, and Mahilo review surfaces show the committed local decision.                                                                                                                                                                     | Bundle response, commit response with `decision=ask`, `GET /api/v1/plugin/reviews` evidence tied to the same `resolution_id`, and receiver-side absence evidence.                                                                                                                                                                    |
| `S4-deny`            | A recipient or selector fixture that deterministically resolves to local `deny`.                                | No transport send occurs, no delivery reaches sandbox B, and Mahilo blocked-event surfaces show the committed local decision.                                                                                                                                                              | Bundle response, commit response with `decision=deny`, `GET /api/v1/plugin/events/blocked` evidence tied to the same `resolution_id`, and receiver-side absence evidence.                                                                                                                                                            |
| `S5-missing-llm-key` | An LLM-evaluated policy is matched while local provider credentials are intentionally absent from the sandbox.  | Local evaluation degrades to `ask` instead of `allow`, no delivery reaches sandbox B, and the review artifact carries a degraded LLM reason code. The expected missing-credential code is `policy.ask.llm.unavailable`.                                                                    | Sandbox config/evidence that provider credentials were intentionally omitted, commit response with `decision=ask`, review evidence with `reason_code=policy.ask.llm.unavailable` (or a documented `policy.ask.llm.<kind>` if the harness intentionally simulates a different evaluator failure), and receiver-side absence evidence. |

### Baseline Exit Rule

- P0 is complete only when one clean-room harness run can execute every `G*` and `S*` row above and emit a per-row pass/fail result.
- The baseline verifier must fail if any required row is skipped, replaced by a manual judgment, or depends on a model-provider success.
- Optional real-model checks must be reported separately as `optional` or `skipped_optional`; they must never be blended into the baseline pass signal.
- The playbook, scripts, and machine-readable artifacts must use stable scenario IDs from this matrix so later tasks can automate verification against the same contract.

### Optional P1 Coverage

- `ask_network` across two real sandboxes
- `/v1/chat/completions`-driven live model turns
- same-thread inbound routing behavior beyond direct-send fallback-to-`main`

## Status Legend

| Status        | Meaning                         |
| ------------- | ------------------------------- |
| `pending`     | Not started                     |
| `in-progress` | In progress                     |
| `blocked`     | Waiting on a real blocker       |
| `review`      | Implemented and awaiting review |
| `done`        | Completed                       |

## Phase 0: Lock the Harness Design

### 0.1 Lock the Success Matrix

- **ID**: `SBX-001`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: None
- **Description**:
  - Convert the vague “it works” goal into an explicit matrix of required scenarios, expected outcomes, and evidence.
  - Define the baseline deterministic proof path first and treat real-model proof as optional.
- **Acceptance Criteria**:
  - [ ] Required proof scenarios are documented as allow/ask/deny/missing-key/send-receive checks
  - [ ] The project avoids accidentally depending on a paid-model turn for the baseline proof
  - [ ] The success matrix is concrete enough to drive build and verification work

- **Notes**:
  - 2026-03-15T09:42:05.838Z: SBX-001 completed via orchestrator integration.
### 0.2 Decide the Bootstrap and Provisioning Strategy

- **ID**: `SBX-002`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `SBX-001`
- **Description**:
  - Decide how the harness will provision two active Mahilo users, two OpenClaw gateways, and two runtime bootstrap stores.
  - Reuse old surfaces only as raw material; do not spend time reproducing the stale operator flow first.
- **Acceptance Criteria**:
  - [ ] The default provisioning path is chosen before implementation branches
  - [ ] The harness design is explicit about API-driven provisioning vs fallback DB seeding
  - [ ] The plan is centered on the dual-sandbox proof, not on preserving the stale skill/doc

- **Notes**:
  - 2026-03-15T09:44:42.278Z: SBX-002 completed via orchestrator integration.
### 0.3 Define the Verification Artifact Contract

- **ID**: `SBX-003`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `SBX-001`, `SBX-002`
- **Description**:
  - Define exactly what artifacts the harness must write so later review, debugging, and skill-writing can rely on them.
- **Acceptance Criteria**:
  - [ ] Artifact expectations are explicit: logs, summaries, transcripts, Mahilo-side evidence
  - [ ] The artifact contract is strong enough to support the final audit task
  - [ ] The harness can later generate a playbook and a skill from those artifacts

#### Verification Artifact Contract

Each harness invocation must write one run-scoped output tree under the fresh temp root. That tree has two distinct audiences, and the harness must keep them separate:

- `runtime/`: secret-bearing files needed to continue the live run. This may contain API keys, callback secrets, invite tokens, unredacted runtime-state JSON, and other bootstrap state that later steps need.
- `artifacts/`: review-safe evidence for operators and automation. The final audit task, the later playbook, and the later skill must rely on this directory plus the recorded run command instead of terminal memory or ad hoc reruns.

Minimum layout:

```text
<run-root>/
  runtime/
    provisioning.json
    sandbox-a/runtime-state.json
    sandbox-b/runtime-state.json
  artifacts/
    run-context.json
    verification-summary.json
    operator-summary.md
    commands.jsonl
    logs/
      mahilo.log
      gateway-a.log
      gateway-b.log
    provisioning/
      bootstrap-summary.json
      friendship-summary.json
      policy-summary.json
    sandboxes/
      sandbox-a/
        config.redacted.json
        runtime-state.redacted.json
        plugin-list.json
        webhook-head.json
      sandbox-b/
        config.redacted.json
        runtime-state.redacted.json
        plugin-list.json
        webhook-head.json
    scenarios/
      G1/
        result.json
        evidence-index.json
      G2/
        result.json
        evidence-index.json
      G3/
        result.json
        evidence-index.json
      S1-send-receive/
        result.json
        evidence-index.json
      S2-allow/
        result.json
        evidence-index.json
      S3-ask/
        result.json
        evidence-index.json
      S4-deny/
        result.json
        evidence-index.json
      S5-missing-llm-key/
        result.json
        evidence-index.json
```

Contract rules:

- `run-context.json` is the canonical run manifest. It must include `artifact_contract_version`, `run_id`, timestamps, git commit or dirty-state marker, workspace root, entry command, selected proof profile, `trusted_mode`, provisioning mode (`api` vs `fallback_seed`), base URLs, ports, and the absolute paths for `runtime/` and `artifacts/`.
- `commands.jsonl` is the canonical execution transcript for reproducibility. Each record must capture the logical step id, command or HTTP action, working directory, redacted environment overrides, start/end timestamps, exit status or HTTP status, and pointers to any captured stdout/stderr or response body files.
- `verification-summary.json` is the canonical machine-readable verdict for the whole run. It must be sufficient for `SBX-051`, `SBX-060`, and `SBX-090` without opening arbitrary logs first.
- `operator-summary.md` is the short human digest. It must say what command ran, whether the deterministic baseline passed, which optional checks were skipped or failed, where the artifacts live, and what known limitations remain.
- Every scenario directory must contain `result.json` and `evidence-index.json`. `result.json` carries the verdict. `evidence-index.json` maps evidence roles to stable relative paths so later tasks do not have to guess filenames.
- Scenario directories and `verification-summary.json.scenarios[*].id` values must use the exact `G*` and `S*` ids from the success matrix so the harness, playbook, skill, and final audit all speak the same contract.
- Each `evidence-index.json` entry must identify at least the evidence `role`, `source_kind`, relative `path`, and any related ids such as `message_id`, `resolution_id`, `review_id`, or `blocked_event_id`.
- Missing required artifacts are a run failure, not a warning. A scenario cannot be marked passed if its required evidence files are absent or broken.

Minimum `verification-summary.json` and per-scenario `result.json` shape:

```json
{
  "artifact_contract_version": 1,
  "run_id": "2026-03-15T12-00-00Z",
  "overall": {
    "baseline": "passed",
    "optional": "skipped_optional"
  },
  "scenarios": [
    {
      "id": "S3-ask",
      "profile": "baseline",
      "status": "passed",
      "expected_outcome": "ask",
      "observed_outcome": "ask",
      "correlation": {
        "resolution_id": "res_123",
        "message_id": null,
        "review_id": "msg_review_123",
        "blocked_event_id": null
      },
      "reason_codes": [],
      "artifact_roles": {
        "sender_transcript": "scenarios/S3-ask/sender-tool-result.json",
        "mahilo_review_evidence": "scenarios/S3-ask/reviews.json",
        "receiver_absence_evidence": "scenarios/S3-ask/receiver-absence.json"
      }
    }
  ]
}
```

Required evidence by gate or scenario:

| Gate / scenario | Required artifact roles |
| --------------- | ----------------------- |
| `G1` | Startup logs for both gateways, `openclaw plugins list --json` output for both sandboxes, and `HEAD /mahilo/incoming` evidence for both gateways. |
| `G2` | Redacted runtime-state evidence for sandbox A and B, Mahilo agent-registration evidence, and readiness checks for Mahilo plus both gateways. |
| `G3` | Provisioning summary, friendship request/accept evidence or equivalent Mahilo network evidence, and the final sender/receiver identity mapping used by later scenarios. |
| `S1-send-receive` | Sender-side transcript or tool result, Mahilo-side delivery evidence tied to a `message_id`, receiver-side transcript or webhook evidence, and explicit absence checks for review/blocked state on that message. |
| `S2-allow` | Bundle response, local-decision commit response, resumed send response, Mahilo-side delivery evidence, and receiver-side delivery evidence. |
| `S3-ask` | Bundle response, local-decision commit response with `decision=ask`, Mahilo review evidence tied to the same `resolution_id`, and receiver absence evidence. |
| `S4-deny` | Bundle response, local-decision commit response with `decision=deny`, Mahilo blocked-event evidence tied to the same `resolution_id`, and receiver absence evidence. |
| `S5-missing-llm-key` | Evidence that local provider credentials were intentionally absent, bundle response, local-decision commit response with `decision=ask`, Mahilo review evidence with the degraded LLM reason code, and receiver absence evidence. |
| Optional checks such as `ask_network` or real-model turns | The same structure as above, but marked with `profile=optional` and `status=passed|failed|blocked|skipped_optional` so optional results never silently affect the baseline verdict. |

Evidence-source rules:

- Sender-side evidence must come from a real OpenClaw surface: tool invocation result, command output, or session transcript.
- Receiver-side evidence must come from the real receiver sandbox: inbound webhook capture, session transcript, or equivalent gateway-owned record.
- Mahilo-side evidence must come from a server-visible source: API response, structured DB snapshot, or structured server log excerpt with the source called out explicitly in `evidence-index.json`.
- Absence evidence must be explicit. For `ask`, `deny`, and missing-key scenarios, the harness must record the receiver check that proved no delivery occurred instead of only omitting a positive delivery file.

Redaction rules:

- `artifacts/` must never contain live API keys, callback secrets, invite tokens, provider keys, raw `Authorization` headers, or unredacted runtime bootstrap blobs.
- Secret-bearing files may remain under `runtime/`, but any pointer to them from `artifacts/` must use a redacted path reference, hash, or boolean presence marker.
- Operator-facing summaries may keep message bodies and selector details only when they are needed to explain the scenario result. Sensitive blocked or review-required payloads should default to excerpts or hashes unless full payload retention is the thing being tested.

Audit and operator-surface rules:

- The final audit task must be able to decide whether the latest harness run is green by reading `artifacts/verification-summary.json`, `artifacts/operator-summary.md`, and the scenario evidence they point to.
- The future playbook must be derivable from `run-context.json`, `commands.jsonl`, and the successful baseline scenario artifacts. If a command, path, or expected output is missing from those artifacts, the contract is incomplete.
- The future skill must be derivable from the same artifacts plus the operator summary. It should not need repo archaeology or stale historical docs to reconstruct the proof flow.

- **Notes**:
  - 2026-03-15T09:48:40.209Z: SBX-003 completed via orchestrator integration.
## Phase 1: Build the Dual-Sandbox Bootstrap Surface

### 1.1 Add a Dual-Sandbox Bootstrap Script

- **ID**: `SBX-010`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `SBX-002`, `SBX-003`
- **Description**:
  - Add a reusable script that creates a fresh temp root for:
    - one Mahilo DB
    - sandbox A OpenClaw home/config/runtime-state
    - sandbox B OpenClaw home/config/runtime-state
    - logs and artifact directories
  - It should produce stable, discoverable paths and port assignments.
- **Acceptance Criteria**:
  - [ ] A single script can create a fresh dual-sandbox root without touching the user’s normal OpenClaw install
  - [ ] Both sandboxes get isolated `OPENCLAW_HOME`, config, and runtime-state paths
  - [ ] The script emits a machine-readable summary of the generated paths and ports

- **Notes**:
  - 2026-03-15T09:57:29.717Z: SBX-010 completed via orchestrator integration.
### 1.2 Add a Config Generator for Both OpenClaw Gateways

- **ID**: `SBX-011`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `SBX-010`
- **Description**:
  - Generate two OpenClaw config files that load the local Mahilo plugin from the repo path and point each gateway at the shared local Mahilo server.
  - Keep provider auth copying optional and explicit.
- **Acceptance Criteria**:
  - [ ] Both config files are generated from the harness inputs instead of handwritten shell heredocs
  - [ ] Plugin load paths point at the local repo checkout
  - [ ] The configs clearly distinguish deterministic proof from optional live-model proof inputs

- **Notes**:
  - 2026-03-15T10:05:14.669Z: SBX-011 completed via orchestrator integration.
### 1.3 Add Process Lifecycle and Readiness Helpers

- **ID**: `SBX-012`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `SBX-010`, `SBX-011`
- **Description**:
  - Add helpers to start, poll, stop, and clean up:
    - Mahilo server
    - OpenClaw gateway A
    - OpenClaw gateway B
  - Prefer predictable local ports and explicit readiness checks.
- **Acceptance Criteria**:
  - [ ] The harness can start all three processes from a clean temp root
  - [ ] Health/readiness checks exist for Mahilo and both gateways
  - [ ] Shutdown and cleanup are deterministic enough to rerun the harness back-to-back

- **Notes**:
  - 2026-03-15T10:18:50.001Z: SBX-012 completed via orchestrator integration.
### 1.4 Add Log and Artifact Capture

- **ID**: `SBX-013`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `SBX-012`
- **Description**:
  - Capture logs and artifacts that make failures debuggable without rerunning blind.
  - Include Mahilo logs, both gateway logs, runtime summaries, and any receiver-side evidence.
- **Acceptance Criteria**:
  - [ ] Harness output paths are stable and documented
  - [ ] Failures can be triaged from collected artifacts
  - [ ] Sensitive values are redacted from operator-facing summaries

## Phase 2: Provision Two Real Sandboxes Against Mahilo

### 2.1 Implement a Reproducible Sandbox Provisioning Path

- **ID**: `SBX-020`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: `SBX-002`, `SBX-010`
- **Description**:
  - Decide and implement the default provisioning path for two active Mahilo users.
  - Prefer API-driven provisioning with invite-token support.
  - Keep direct-DB seeding as a fallback only if the API path cannot cover the harness reliably.
- **Acceptance Criteria**:
  - [ ] The default path does not rely on stale no-invite registration assumptions
  - [ ] The default path produces active Mahilo users usable by plugin-protected routes
  - [ ] Any fallback seeding path is clearly labeled as fallback-only

- **Notes**:
  - 2026-03-15T10:29:46.128Z: SBX-020 completed via orchestrator integration.
### 2.2 Register Two Users and Persist Auth Artifacts

- **ID**: `SBX-021`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-020`
- **Description**:
  - Automate registration/provisioning of sender and receiver Mahilo users and persist only the auth artifacts needed by the harness.
- **Acceptance Criteria**:
  - [ ] Two active Mahilo users are created reproducibly
  - [ ] Required API keys or bootstrap artifacts are written for later steps
  - [ ] The harness summary records enough metadata to continue without rerunning provisioning

### 2.3 Register Agent Connections and Runtime Bootstrap for Both Sandboxes

- **ID**: `SBX-022`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-021`
- **Description**:
  - Register one Mahilo agent connection per sandbox pointing at each gateway’s `/mahilo/incoming` callback URL.
  - Persist runtime bootstrap state for both sandboxes in the shape the plugin already expects.
- **Acceptance Criteria**:
  - [ ] Mahilo has one active OpenClaw connection for each sandbox user
  - [ ] Each runtime-state file contains the matching API key, username, connection id, secret, and callback URL
  - [ ] Both gateways can start with those runtime-state files and attach to the expected Mahilo identity

### 2.4 Automate Friendship, Optional Roles, and Group Setup

- **ID**: `SBX-023`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-021`, `SBX-022`
- **Description**:
  - Automate the friend request / accept flow between sandbox A and sandbox B.
  - Add optional role assignment and group setup for later scenarios.
- **Acceptance Criteria**:
  - [ ] Sender and receiver become accepted friends through the harness flow
  - [ ] Optional friendship-role assignment is supported
  - [ ] Group setup exists when needed for later `ask_network` or fanout scenarios

### 2.5 Seed Policy Scenarios for Live Validation

- **ID**: `SBX-024`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-021`, `SBX-023`
- **Description**:
  - Seed or create sender-side policies that exercise:
    - deterministic allow
    - deterministic ask
    - deterministic deny
    - missing-local-LLM degraded review
- **Acceptance Criteria**:
  - [ ] The harness can create or seed policies for each target scenario
  - [ ] Policy setup is explicit enough to explain later results
  - [ ] The seeded scenarios line up with the success matrix from `SBX-001`

## Phase 3: Prove Send, Receive, and Policy Enforcement

### 3.1 Verify Plugin Load and Webhook Surfaces on Both Gateways

- **ID**: `SBX-030`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-012`, `SBX-022`
- **Description**:
  - Verify that the Mahilo plugin loads on both OpenClaw gateways and that `/mahilo/incoming` is reachable for both.
- **Acceptance Criteria**:
  - [ ] `openclaw plugins list --json` shows the Mahilo plugin in both sandboxes
  - [ ] `HEAD /mahilo/incoming` succeeds on both gateways
  - [ ] Any startup bootstrap or identity mismatch is surfaced before later scenarios run

### 3.2 Prove Direct Allow Delivery from Sandbox A to Sandbox B

- **ID**: `SBX-031`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-024`, `SBX-030`
- **Description**:
  - Execute a real plugin-originated direct send from sandbox A to sandbox B in an allow scenario.
  - Verify that sandbox B actually receives it.
- **Acceptance Criteria**:
  - [ ] The send originates through the Mahilo plugin in sandbox A
  - [ ] Mahilo records the send as delivered
  - [ ] Sandbox B records receipt through its real OpenClaw webhook/session surface

### 3.3 Prove Direct Ask Holds Delivery and Surfaces Review State

- **ID**: `SBX-032`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-024`, `SBX-030`
- **Description**:
  - Execute a direct send that should resolve to local `ask`.
  - Verify no message is delivered to sandbox B and Mahilo records the held/review state correctly.
- **Acceptance Criteria**:
  - [ ] The plugin returns a review/hold result instead of sending
  - [ ] Sandbox B does not receive the message
  - [ ] Mahilo review surfaces reflect the local decision coherently

### 3.4 Prove Direct Deny Blocks Delivery and Surfaces Blocked State

- **ID**: `SBX-033`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-024`, `SBX-030`
- **Description**:
  - Execute a direct send that should resolve to local `deny`.
  - Verify no message is delivered to sandbox B and Mahilo records the blocked state correctly.
- **Acceptance Criteria**:
  - [ ] The plugin returns a blocked result instead of sending
  - [ ] Sandbox B does not receive the message
  - [ ] Mahilo blocked-event or equivalent evidence reflects the denial

### 3.5 Prove Missing Local LLM Credentials Degrade to Ask

- **ID**: `SBX-034`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-024`, `SBX-030`
- **Description**:
  - Exercise an LLM-policy scenario with local credentials intentionally absent so the live harness proves the documented fail-to-`ask` behavior.
- **Acceptance Criteria**:
  - [ ] The result degrades to `ask` rather than silently allowing delivery
  - [ ] Sandbox B does not receive the message
  - [ ] The failure mode is captured in the operator evidence and later playbook

### 3.6 Prove or Bound the Two-Sandbox `ask_network` Story

- **ID**: `SBX-035`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `SBX-023`, `SBX-030`
- **Description**:
  - Attempt a real `ask_network` flow across the two-sandbox harness.
  - If a remaining live-routing limitation still exists, capture it as an explicit known blocker instead of glossing over it.
- **Acceptance Criteria**:
  - [ ] Either `ask_network` works across the live harness or the blocker is reproduced cleanly
  - [ ] The outcome is reflected honestly in the playbook and skill
  - [ ] Routing evidence is preserved in logs or transcripts

### 3.7 Prove Trusted-vs-Local Mode Parity in the Harness

- **ID**: `SBX-036`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `SBX-031`, `SBX-032`, `SBX-033`
- **Description**:
  - Re-run a minimal subset of scenarios with `TRUSTED_MODE=true` so the harness documents the difference between server-enforced and plugin-local paths.
- **Acceptance Criteria**:
  - [ ] At least one allow and one hold/block scenario are exercised in both modes
  - [ ] The playbook documents what changes between the two modes
  - [ ] Any intentional differences are called out explicitly

## Phase 4: Package the Verified Operator Surface

### 4.1 Write a New Playbook from the Verified Harness

- **ID**: `SBX-040`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-050`, `SBX-060`
- **Description**:
  - Write a fresh playbook from the verified dual-sandbox harness instead of trying to rehabilitate the stale operator doc first.
  - The playbook should contain the exact commands, paths, and expected outputs for the deterministic proof path.
- **Acceptance Criteria**:
  - [ ] The playbook is derived from the working harness, not stale assumptions
  - [ ] The default proof path uses two real OpenClaw sandboxes
  - [ ] The playbook clearly distinguishes must-pass proof from optional advanced checks

### 4.2 Create a New Sandbox Harness Skill from the Verified Playbook

- **ID**: `SBX-041`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-040`
- **Description**:
  - Create a new skill for the verified dual-sandbox harness.
  - Do this only after the playbook reflects a working harness.
- **Acceptance Criteria**:
  - [ ] A new skill file exists under `.codex/skills/`
  - [ ] The skill references the verified playbook
  - [ ] The skill’s expected outputs match current harness behavior

### 4.3 Add a Troubleshooting and Known-Blocker Matrix

- **ID**: `SBX-042`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `SBX-035`, `SBX-040`, `SBX-041`
- **Description**:
  - Document the most likely live harness failures and their first diagnostics:
    - invite-token/provisioning failures
    - runtime bootstrap mismatch
    - plugin not loaded
    - webhook reachability
    - policy route auth failures
    - residual `ask_network` session-routing blockers
- **Acceptance Criteria**:
  - [ ] The playbook or new skill includes a concise troubleshooting matrix
  - [ ] Known blockers are framed as explicit limitations, not silent assumptions
  - [ ] An operator can tell whether to rerun, fix env, or treat the issue as a product bug

## Phase 5: Make the Harness Runnable and Reusable

### 5.1 Add a Machine-Runnable Harness Entry Point

- **ID**: `SBX-050`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-012`, `SBX-024`
- **Description**:
  - Add one primary entry point that boots the harness, runs the checks, and writes artifacts.
  - It can call smaller scripts internally, but the operator surface should stay short.
- **Acceptance Criteria**:
  - [ ] A primary command exists for the default deterministic proof path
  - [ ] The command is documented in the later playbook and skill
  - [ ] The command can be rerun from a clean checkout without secret repo knowledge

### 5.2 Add Structured Verification Output

- **ID**: `SBX-051`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `SBX-031`, `SBX-032`, `SBX-033`, `SBX-034`, `SBX-050`
- **Description**:
  - Emit a structured summary of what the harness observed so failures are obvious and future reruns are comparable.
- **Acceptance Criteria**:
  - [ ] The harness writes a machine-readable result summary
  - [ ] The summary includes pass/fail per scenario and pointers to relevant artifacts
  - [ ] The summary redacts secrets while keeping enough detail for debugging

### 5.3 Add Regression Coverage Around New Helper Logic

- **ID**: `SBX-052`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `SBX-010`, `SBX-011`, `SBX-012`, `SBX-050`
- **Description**:
  - Add targeted tests around any nontrivial helper logic introduced for the harness.
  - Focus on config generation, summary writing, and command/result parsing rather than trying to unit test every shell step.
- **Acceptance Criteria**:
  - [ ] New helper logic has targeted regression coverage where appropriate
  - [ ] The tests exercise failure-prone branches, not just happy paths
  - [ ] The harness stays maintainable as the repo evolves

## Phase 6: Run the Harness and Close the Loop

### 6.1 Run the Harness End to End

- **ID**: `SBX-060`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-050`, `SBX-051`
- **Description**:
  - Run the harness against the current `main` code and capture the full result.
- **Acceptance Criteria**:
  - [ ] The harness is executed from scratch against a fresh temp root
  - [ ] Artifacts and summaries are captured
  - [ ] The operator result is unambiguous about what passed and what failed

### 6.2 Fix Directly Obvious Harness Failures and Rerun

- **ID**: `SBX-061`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-060`
- **Description**:
  - Fix directly obvious harness issues surfaced by the first live run and rerun once.
  - Deeper or newly discovered bugs that deserve their own tracked work will be handled by the final audit task.
- **Acceptance Criteria**:
  - [ ] Any directly obvious harness issue from the first run is fixed
  - [ ] Any discovered harness bug is fixed or explicitly documented as a blocker
  - [ ] A rerun produces a cleaner baseline for the final audit task

### 6.3 Publish the Final Operator Summary

- **ID**: `SBX-062`
- **Status**: `pending`
- **Priority**: P1
- **Depends on**: `SBX-041`, `SBX-042`, `SBX-061`
- **Description**:
  - Close the loop with a concise operator summary that says:
    - what the default proof path is
    - what commands to run
    - what “green” looks like
    - what remains known-limited
- **Acceptance Criteria**:
  - [ ] The final operator summary exists in the updated doc/skill surface
  - [ ] The default proof command path is obvious
  - [ ] Remaining limitations are stated directly

## Phase 7: Adaptive Audit Loop

### 7.1 Audit the Latest Result and Expand the Tracker if Needed

- **ID**: `SBX-090`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-062`
- **Description**:
  - The final worker for this static PRD reviews the latest harness run, the latest artifacts, and the new operator surfaces.
  - If the harness is genuinely green and the operator surfaces are accurate, it closes the project.
  - If it finds real bugs, gaps, or misleading test results, it must append new pending fix tasks to this PRD and also append a new trailing audit task that depends on those fix tasks, so the orchestrator continues automatically.
- **Acceptance Criteria**:
  - [ ] If the harness is green, the task records that no further follow-up tasks are needed
  - [ ] If issues are found, the task appends concrete new pending tasks to this PRD instead of burying them in prose
  - [ ] If issues are found, the task also appends a new trailing audit task that depends on those new fix tasks
  - [ ] The workflow does not reach a true end state until the latest audit task finds no additional work

## Recommended Execution Order

1. `SBX-001` through `SBX-003`
2. `SBX-010` through `SBX-013`
3. `SBX-020` through `SBX-024`
4. `SBX-030` through `SBX-036`
5. `SBX-050` through `SBX-052`
6. `SBX-060` through `SBX-062`
7. `SBX-040` through `SBX-042`
8. `SBX-090`

## Notes for the Orchestrator

- Treat the old sandbox skill/doc as historical reference only. Do not spend early project time trying to preserve or reproduce them.
- Build the dual-sandbox harness first, run it, then derive the new playbook and the new skill from the verified result.
- P0 is the deterministic two-sandbox proof. Real-model `/v1/chat/completions` proof is valuable, but it should not block the harness from being useful if local provider auth is unavailable.
- The final audit task is allowed to append new pending tasks and a new trailing audit task to this PRD when the live result exposes real bugs or misleading proof.
- Reuse existing APIs and scripts where possible. Avoid new production server behavior unless the harness truly cannot be made reproducible otherwise.
