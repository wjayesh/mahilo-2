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

## Deliverables

- new playbook doc under [plugins/openclaw-mahilo/docs](/Users/wjayesh/apps/mahilo-2/plugins/openclaw-mahilo/docs)
- new skill under [.codex/skills](/Users/wjayesh/apps/mahilo-2/.codex/skills)
- one or more reusable harness scripts under [plugins/openclaw-mahilo/scripts](/Users/wjayesh/apps/mahilo-2/plugins/openclaw-mahilo/scripts)
- validation artifacts captured under the sandbox temp root and summarized in machine-readable form
- regression coverage for any new helper logic that is not trivially exercised by the live harness itself

## Success Matrix

P0 must prove all of the following:

- plugin loads in both sandboxes
- both sandboxes register against Mahilo with valid runtime bootstrap state
- friendship exists between sender and recipient users
- direct send `allow` delivers to the receiver sandbox
- direct send `ask` does not deliver and appears in Mahilo review surfaces
- direct send `deny` does not deliver and appears in blocked-event surfaces
- missing local LLM credentials degrade to `ask` rather than silently allowing delivery
- the operator playbook is accurate enough that rerunning it from scratch does not require private repo knowledge

P1 can additionally prove:

- `ask_network` across two real sandboxes
- `/v1/chat/completions`-driven live model turns
- same-thread inbound routing behavior beyond direct-send fallback-to-`main`

## Status Legend

| Status | Meaning |
|--------|---------|
| `pending` | Not started |
| `in-progress` | In progress |
| `blocked` | Waiting on a real blocker |
| `review` | Implemented and awaiting review |
| `done` | Completed |

## Phase 0: Lock the Harness Design

### 0.1 Lock the Success Matrix
- **ID**: `SBX-001`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: None
- **Description**:
  - Convert the vague “it works” goal into an explicit matrix of required scenarios, expected outcomes, and evidence.
  - Define the baseline deterministic proof path first and treat real-model proof as optional.
- **Acceptance Criteria**:
  - [ ] Required proof scenarios are documented as allow/ask/deny/missing-key/send-receive checks
  - [ ] The project avoids accidentally depending on a paid-model turn for the baseline proof
  - [ ] The success matrix is concrete enough to drive build and verification work

### 0.2 Decide the Bootstrap and Provisioning Strategy
- **ID**: `SBX-002`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-001`
- **Description**:
  - Decide how the harness will provision two active Mahilo users, two OpenClaw gateways, and two runtime bootstrap stores.
  - Reuse old surfaces only as raw material; do not spend time reproducing the stale operator flow first.
- **Acceptance Criteria**:
  - [ ] The default provisioning path is chosen before implementation branches
  - [ ] The harness design is explicit about API-driven provisioning vs fallback DB seeding
  - [ ] The plan is centered on the dual-sandbox proof, not on preserving the stale skill/doc

### 0.3 Define the Verification Artifact Contract
- **ID**: `SBX-003`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-001`, `SBX-002`
- **Description**:
  - Define exactly what artifacts the harness must write so later review, debugging, and skill-writing can rely on them.
- **Acceptance Criteria**:
  - [ ] Artifact expectations are explicit: logs, summaries, transcripts, Mahilo-side evidence
  - [ ] The artifact contract is strong enough to support the final audit task
  - [ ] The harness can later generate a playbook and a skill from those artifacts

## Phase 1: Build the Dual-Sandbox Bootstrap Surface

### 1.1 Add a Dual-Sandbox Bootstrap Script
- **ID**: `SBX-010`
- **Status**: `pending`
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

### 1.2 Add a Config Generator for Both OpenClaw Gateways
- **ID**: `SBX-011`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: `SBX-010`
- **Description**:
  - Generate two OpenClaw config files that load the local Mahilo plugin from the repo path and point each gateway at the shared local Mahilo server.
  - Keep provider auth copying optional and explicit.
- **Acceptance Criteria**:
  - [ ] Both config files are generated from the harness inputs instead of handwritten shell heredocs
  - [ ] Plugin load paths point at the local repo checkout
  - [ ] The configs clearly distinguish deterministic proof from optional live-model proof inputs

### 1.3 Add Process Lifecycle and Readiness Helpers
- **ID**: `SBX-012`
- **Status**: `pending`
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
- **Status**: `pending`
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
