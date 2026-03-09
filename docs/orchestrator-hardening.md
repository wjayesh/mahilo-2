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
- auto-blocks the task after the configured retry limit
- continues running instead of killing the entire worker

This choice keeps autonomous progress moving and makes failures explicit in the task docs.

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

### 5. Avoid overengineering the stall detector

We intentionally did **not** switch the agent runner to a fully async event-streaming architecture.

Instead, we chose a simpler version:
- the orchestrator writes runtime heartbeats at phase boundaries
- the supervisor treats a worker as stale only after a generous timeout

That is enough to detect dead sessions or stuck workers without turning this into a full distributed control plane.

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

- Auto-blocking after repeated failures may require manual unblocking later, but it is better than infinite crash loops.
- Runtime heartbeats are phase-level, not continuous sub-process telemetry.
- `launchd` support is installer-based rather than a large service-management framework.

## Follow-Up Ideas

If we want to go further later, the next sensible steps are:
- notifications on repeated failures or all tasks complete
- richer supervisor status output for humans
- a small command to unblock/requeue auto-blocked tasks
