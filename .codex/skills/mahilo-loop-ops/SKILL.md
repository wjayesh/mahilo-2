---
name: mahilo-loop-ops
description: Use this skill when asked to start, stop, restart, inspect, or troubleshoot the Mahilo autonomous orchestrator loops, including the server and plugin workflows, `screen` sessions, workflow files, logs, progress files, and integration-branch safety checks.
---

# Mahilo Loop Ops

## Overview

Use this skill for operating the Mahilo autonomous development loops in this repo. It covers the branch check, dry-run checks, detached `screen` startup, health checks, log inspection, and safe restart flow for the server and plugin orchestrators.

## Preconditions

- Run from the Mahilo repo root.
- Confirm the current branch is `autonomous/server-integration` before starting any loop.
- Treat `WORKFLOW.md` as the server workflow and `WORKFLOW.plugin.md` as the plugin workflow.
- Use the integration branch, not `main`, for autonomous work.

## Quick Start

1. Verify the branch and basic task selection:
   - `git branch --show-current`
   - `bun run orchestrate:dry-run`
   - `bun run orchestrate:plugin:dry-run`
2. Start the server loop in detached `screen`:
   - `screen -dmS mahilo-server-loop zsh -lc 'cd /Users/wjayesh/apps/mahilo-2 && bun run orchestrate >> .mahilo-orchestrator/server-loop.log 2>&1'`
3. Start the plugin loop in detached `screen`:
   - `screen -dmS mahilo-plugin-loop zsh -lc 'cd /Users/wjayesh/apps/mahilo-2 && bun run orchestrate:plugin >> .mahilo-orchestrator/plugin-loop.log 2>&1'`
4. Confirm both sessions exist:
   - `screen -ls`

## Health Checks

Use these commands to confirm the loops are healthy:

- Active screen sessions:
  - `screen -ls`
- Server progress:
  - `tail -n 40 .mahilo-orchestrator/progress.md`
- Plugin progress:
  - `tail -n 40 .mahilo-orchestrator/plugin-progress.md`
- Server runtime log:
  - `tail -n 80 .mahilo-orchestrator/server-loop.log`
- Plugin runtime log:
  - `tail -n 80 .mahilo-orchestrator/plugin-loop.log`
- One-shot task selection checks:
  - `bun run orchestrate:once`
  - `bun run orchestrate:plugin:once`

A healthy loop should keep its `screen` session alive, append progress lines, and either work the current task or sleep between iterations without repeated crashes.

## Restart Flow

Use this when the orchestrator, workflow files, or shared orchestration code changed.

1. Stop existing sessions if present:
   - `screen -S mahilo-server-loop -X quit`
   - `screen -S mahilo-plugin-loop -X quit`
2. Confirm they are gone:
   - `screen -ls`
3. Re-run the dry-run commands:
   - `bun run orchestrate:dry-run`
   - `bun run orchestrate:plugin:dry-run`
4. Start both detached sessions again with the Quick Start commands.

## Stop Flow

- Stop server loop:
  - `screen -S mahilo-server-loop -X quit`
- Stop plugin loop:
  - `screen -S mahilo-plugin-loop -X quit`
- Confirm shutdown:
  - `screen -ls`

## Safety Rules

- Do not start the loops from `main`.
- Keep the server and plugin loops on the same integration branch unless the workflow model is intentionally changed.
- If you need to edit orchestrator code or shared workflow files while loops are live, prefer a quick stop/restart or acquire the same repo lock used by the orchestrator before manual commit/push steps.
- Prefer reading `docs/autonomous-orchestrator.md`, `WORKFLOW.md`, and `WORKFLOW.plugin.md` before changing loop behavior.

## Important Paths

- Server workflow: `WORKFLOW.md`
- Plugin workflow: `WORKFLOW.plugin.md`
- Orchestrator runtime: `scripts/orchestrator.ts`
- Orchestrator core: `src/orchestrator.ts`
- Server progress: `.mahilo-orchestrator/progress.md`
- Plugin progress: `.mahilo-orchestrator/plugin-progress.md`
- Server log: `.mahilo-orchestrator/server-loop.log`
- Plugin log: `.mahilo-orchestrator/plugin-loop.log`
- Orchestrator state: `.mahilo-orchestrator/state.json`
- Plugin state: `.mahilo-orchestrator/plugin-state.json`

## When To Escalate

Escalate when:

- a loop repeatedly exits on the same task
- `screen` sessions disappear immediately after startup
- dry runs do not pick the expected ready task
- the integration branch is wrong or dirty in a way that blocks safe restart
- the plugin loop needs a server or contract change instead of a plugin-only change
