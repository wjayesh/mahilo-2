---
name: mahilo-loop-ops
description: Use this skill when asked to start, stop, restart, inspect, or troubleshoot the Mahilo autonomous orchestrator loops, including the server and plugin workflows, supervisor commands, `launchd` setup, workflow files, logs, progress files, and integration-branch safety checks.
---

# Mahilo Loop Ops

## Overview

Use this skill for operating the Mahilo autonomous development loops in this repo. The preferred path is now the lightweight supervisor, with optional `launchd` installation on macOS. Raw `screen` is only a fallback for temporary debugging.

## Preconditions

- Run from the Mahilo repo root.
- Confirm the current branch is `autonomous/server-integration` before starting any loop.
- Treat `WORKFLOW.md` as the server workflow and `WORKFLOW.plugin.md` as the plugin workflow.
- Use the integration branch, not `main`, for autonomous work.

## Preferred Commands

### Plugin loop

- Dry run:
  - `bun run orchestrate:plugin:dry-run`
- Start under the supervisor:
  - `bun run orchestrate:supervisor:start:plugin`
- Check status:
  - `bun run orchestrate:supervisor:status:plugin`
- Stop:
  - `bun run orchestrate:supervisor:stop:plugin`

### macOS `launchd`

- Generate/install the plugin plist:
  - `bun run orchestrate:launchd:install:plugin`
- Load it:
  - `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.mahilo.orchestrator.plugin.plist`
- Inspect it:
  - `launchctl print gui/$(id -u)/ai.mahilo.orchestrator.plugin`
- Unload it:
  - `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.mahilo.orchestrator.plugin.plist`

## Health Checks

Use these commands to confirm the loop is healthy:

- Supervisor status JSON:
  - `bun run orchestrate:supervisor:status:plugin`
- Orchestrator heartbeat/runtime state:
  - `cat .mahilo-orchestrator/runtime/plugin-state.runtime.json`
- Supervisor state:
  - `cat .mahilo-orchestrator/supervisor/plugin.json`
- Plugin progress:
  - `tail -n 40 .mahilo-orchestrator/plugin-progress.md`
- Plugin runtime log:
  - `tail -n 80 .mahilo-orchestrator/plugin-loop.log`

A healthy loop should show:
- a live supervisor pid
- recent heartbeat timestamps
- either an active task or a clear idle/cooldown state
- no stray raw `scripts/orchestrator.ts --workflow ...` worker outside the supervisor

For a fully completed workflow, the expected terminal state is:
- `supervisorPid: null`
- `running: false`
- `supervisorState.phase: "completed"`
- `runtimeState.lastExitReason: "complete"`

## Restart Flow

Use this when the orchestrator, supervisor, or workflow files changed.

1. Stop the supervisor:
   - `bun run orchestrate:supervisor:stop:plugin`
2. Confirm status is stopped:
   - `bun run orchestrate:supervisor:status:plugin`
3. Re-run the dry-run command:
   - `bun run orchestrate:plugin:dry-run`
4. Start the supervisor again:
   - `bun run orchestrate:supervisor:start:plugin`

## Failure Semantics

The hardened loop now:
- retries task failures with exponential backoff
- records retry cooldowns in state/runtime files
- keeps tasks `pending` when the failure is a worker/runtime/integration problem
- only marks a task `blocked` when the worker explicitly emits `TASK_BLOCKED <id>`
- owns task-tracker status updates itself; workers should not edit PRD status metadata
- refreshes stale task workspaces after cherry-pick conflicts before retrying
- takes a workflow-scoped worker lock so duplicate raw/supervised workers fail fast
- restarts the worker if the supervised process dies or becomes stale
- stops restarting once the workflow reaches terminal `COMPLETE`

## Fallback `screen` Usage

Use this only for temporary manual debugging.

- Start:
  - `screen -dmS mahilo-plugin-loop zsh -lc 'cd /Users/wjayesh/apps/mahilo-2 && bun run orchestrate:plugin >> .mahilo-orchestrator/plugin-loop.log 2>&1'`
- List:
  - `screen -ls`
- Stop:
  - `screen -S mahilo-plugin-loop -X quit`

## Important Paths

- Server workflow: `WORKFLOW.md`
- Plugin workflow: `WORKFLOW.plugin.md`
- Orchestrator runtime: `scripts/orchestrator.ts`
- Orchestrator supervisor: `scripts/orchestrator-supervisor.ts`
- `launchd` installer: `scripts/install-launchd.ts`
- Hardening decisions: `docs/orchestrator-hardening.md`
- Plugin progress: `.mahilo-orchestrator/plugin-progress.md`
- Plugin log: `.mahilo-orchestrator/plugin-loop.log`
- Orchestrator runtime state: `.mahilo-orchestrator/runtime/plugin-state.runtime.json`
- Supervisor state: `.mahilo-orchestrator/supervisor/plugin.json`

## When To Escalate

Escalate when:
- the same task keeps failing after retries and is not making progress
- supervisor says stopped but `pgrep` still finds a raw `scripts/orchestrator.ts --workflow ...` worker
- supervisor status shows repeated restart loops
- heartbeat timestamps stop moving even though the supervisor is alive
- the integration branch is wrong or dirty in a way that blocks safe restart
- the plugin loop needs a server or contract change instead of a plugin-only change
