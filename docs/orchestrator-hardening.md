# Orchestrator Hardening Decisions

> **Status**: Implemented on 2026-03-09
> **Scope**: Mahilo autonomous loop runtime, supervision, and macOS service integration

## Why We Did This

The original autonomous loop was productive, but it had two operational weaknesses:

1. a single task failure could terminate the whole background worker
2. detached `screen` sessions were too easy to lose without clear health signals

That meant the loop could stop even though there were still ready tasks, and the failure mode was more like "session disappeared" than "worker reported a durable unhealthy state".

## Decisions

### 1. Keep one orchestrator, add a light supervisor

We did **not** build a second orchestration layer.

Instead:
- `scripts/orchestrator.ts` still owns task selection, task execution, retries, integration, and progress
- `scripts/orchestrator-supervisor.ts` is only a process supervisor
- the supervisor starts the orchestrator, watches runtime heartbeats, and restarts it if the process dies or stalls

This keeps the architecture simple:
- orchestrator = workflow logic
- supervisor = process lifecycle

### 2. Make task failures non-fatal by default

Previously, agent failures or task integration errors could terminate the whole loop.

Now the orchestrator:
- records the failure in progress/state
- retries the task with exponential backoff
- keeps the task `pending` when the failure is a worker/runtime/integration problem
- continues running instead of killing the entire worker

Only an explicit `TASK_BLOCKED <id>` from the worker changes the task doc to `blocked`.

This choice keeps autonomous progress moving without turning orchestration glitches into false product blockers.

### 3. Add runtime heartbeats and status files

The orchestrator now writes a runtime status file that includes:
- current phase
- active task id
- iteration
- heartbeat timestamp
- last note / last error
- retry state

The supervisor reads that file to decide whether the worker is healthy or stale.

This gives us an inspection surface that is much better than relying only on `screen -ls`.

### 4. Use `launchd` as the preferred long-running service on macOS

We kept detached shell usage possible, but the preferred production-ish path is now:
- supervisor process
- optional `launchd` service for auto-start + restart

This is a better fit for your machine than continuing to treat `screen` as the primary daemon manager.

Follow-up implemented on 2026-03-09:
- the generated `launchd` plist now captures the install-time `PATH` and `HOME`
- this is required because the orchestrator spawns nested Codex workers as separate subprocesses, and `launchd`'s default minimal `PATH` was not sufficient to resolve `codex`

### 5. Avoid overengineering the stall detector

We intentionally did **not** switch the agent runner to a fully async event-streaming architecture.

Instead, we chose a simpler version:
- the orchestrator writes runtime heartbeats at phase boundaries
- the supervisor treats a worker as stale only after a generous timeout

That is enough to detect dead sessions or stuck workers without turning this into a full distributed control plane.

### 6. Refuse integration into a dirty shared repo

The orchestrator now checks that the shared integration checkout is clean before any task-branch cherry-pick.

If the repo is dirty:
- the task is left `pending`
- the loop records an integration/runtime failure
- the task is retried later with backoff

This is intentionally strict. The source-of-truth tracker files live in the shared repo, so silently cherry-picking across local edits is the wrong failure mode.

### 7. Prevent duplicate workers for the same workflow

The orchestrator now takes a workflow-scoped worker lock for the lifetime of the process.

That means:
- one plugin worker per repo clone
- one server worker per repo clone
- fast failure if a stale raw `bun run scripts/orchestrator.ts ...` process is still alive

This is the minimum needed to stop stray unsupervised workers from racing the supervised loop and mutating the tracker unexpectedly.

### 8. Make the orchestrator the only writer of tracked task status

Workers no longer edit the `Status` metadata in the PRD/task docs.

Instead:
- workers emit `TASK_DONE <id>` or `TASK_BLOCKED <id>: ...`
- the orchestrator integrates task-branch code first
- the orchestrator then updates the task tracker in the shared integration branch

This removes a large source of avoidable conflicts in adjacent task sections of the same PRD.

### 9. Refresh stale task branches after integration conflicts

Task workspaces are long-lived, so a task branch can drift behind the integration branch even when only one worker runs at a time.

The loop now:
- refreshes idle workspaces that have no local state when integration moves ahead
- treats cherry-pick content conflicts as stale-branch recovery
- rebuilds the task workspace from the latest integration branch before retrying

This is the right fix for overlapping code changes in long-lived task branches.

## Config Defaults

Both workflow files now include:
- `max_iterations: 0` to mean effectively unbounded loop runtime
- `task_failure_retry_limit: 3`
- `task_failure_backoff_seconds: 30`
- `runtime_stall_timeout_seconds: 1800`

These are intentionally conservative defaults.

## Operational Path

### Preferred

- `bun run orchestrate:supervisor:start:plugin`
- `bun run orchestrate:supervisor:status:plugin`
- `bun run orchestrate:launchd:install:plugin`

### Fallback

- direct `bun run orchestrate:plugin`
- detached `screen` sessions for temporary/manual debugging

## Tradeoffs We Accepted

- Repeated runtime failures can keep a task pending for a while instead of auto-blocking it, so operator inspection still matters.
- Runtime heartbeats are phase-level, not continuous sub-process telemetry.
- `launchd` support is installer-based rather than a large service-management framework.

## Follow-Up Ideas

If we want to go further later, the next sensible steps are:
- notifications on repeated failures or all tasks complete
- richer supervisor status output for humans
- a small command to requeue/reset tasks after operator review
