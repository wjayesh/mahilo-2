# Mahilo Autonomous Orchestrator

Mahilo now uses an in-repo autonomous development loop inspired by Symphony, but backed by markdown task lists instead of Linear.

## Goals

- keep task tracking in-repo
- dispatch one ready task at a time
- keep agent work focused on a single task
- support persistent progress and repeatable runs
- isolate task work with native git worktrees when desired
- keep `main` clean by reconciling into an integration branch
- keep long-running workers observable and restartable

## Source of Truth

- `WORKFLOW.md` is the default **server** workflow
- `WORKFLOW.plugin.md` is the separate plugin workflow
- `docs/prd-server-policy-platform.md` is the current server task source
- `docs/prd-openclaw-plugin-migration.md` is the current plugin task source
- `docs/openclaw-plugin-server-contract.md` is the shared server/plugin contract
- `docs/orchestrator-hardening.md` explains the runtime hardening decisions

## How It Works

1. Load a workflow file.
2. Parse task docs for task IDs, statuses, priorities, and dependencies.
3. Optionally parse separate dependency sources to gate tasks on external prerequisites.
4. Pick the next ready task, ignoring tasks currently cooling down after failure.
5. Create or reuse a task-specific git worktree branch.
6. Run `codex exec` with the workflow prompt plus the assigned task section.
7. Leave in-progress changes inside the task branch worktree until the task reaches a terminal state.
8. When a task reaches `done` or `blocked`, commit that work in the task branch.
9. Acquire a short repo-level lock only for integration-branch mutation.
10. Cherry-pick the new task-branch commit(s) into the shared integration branch.
11. Update tracked task status in the shared PRD only after successful integration.
12. Refresh stale task workspaces after integration conflicts or when they have drifted with no local state.
13. Retry worker/runtime/integration failures with backoff while keeping the task pending.
14. Write runtime heartbeat/status files for observability.
15. Optionally run the loop under the lightweight supervisor or `launchd`.
16. Repeat until all tracked tasks are complete or the loop is stopped.

## Files

- `src/orchestrator.ts` — parser, scheduler, dependency resolver, git-worktree manager, git integration helpers, and agent runner
- `scripts/orchestrator.ts` — CLI entrypoint and runtime loop
- `scripts/orchestrator-supervisor.ts` — lightweight process supervisor with restart/backoff logic
- `scripts/install-launchd.ts` — macOS `launchd` plist generator for supervised loops
- `scripts/ralph.sh` — compatibility wrapper that now calls the new orchestrator
- `.mahilo-orchestrator/state.json` — persisted server runtime state
- `.mahilo-orchestrator/plugin-state.json` — persisted plugin runtime state
- `.mahilo-orchestrator/runtime/*.runtime.json` — orchestrator heartbeat/status files
- `.mahilo-orchestrator/supervisor/*.json` — supervisor state files

## Safety and Git Behavior

- Workflows are branch-guarded and currently require `autonomous/server-integration`.
- The loop reconciles into the integration branch, never directly into `main`.
- Each completed or blocked terminal task is committed in its own task branch before integration.
- The integration branch stays linear by cherry-picking task commits instead of merging task branches.
- The loop auto-pushes after every 3 integrated task commits by default.
- Each workflow takes a single-instance worker lock, so duplicate server/plugin loops in the same clone fail fast.
- Concurrent workflows share a repo-level lock only around cherry-pick and push operations.
- Workers signal `TASK_DONE` / `TASK_BLOCKED`; the orchestrator owns tracked task status updates in the PRD.
- Repeated worker/runtime/integration failures are retried with backoff and do not mutate task status to `blocked`.
- Only an explicit `TASK_BLOCKED <id>` from the worker marks a task `blocked` in the PRD.
- Cherry-pick integration is refused when the shared integration checkout is dirty.
- Cherry-pick content conflicts trigger task-workspace refresh from latest integration before retry.
- A workflow that reaches terminal `COMPLETE` leaves the supervisor in `phase: completed` and does not restart.
- The plugin workflow is scoped away from server implementation files to reduce overlap.

## Recommended Commands

```bash
bun run orchestrate:supervisor:start:plugin
bun run orchestrate:supervisor:status:plugin
bun run orchestrate:supervisor:stop:plugin
bun run orchestrate:launchd:install:plugin
```

## Fallback Commands

```bash
bun run orchestrate:plugin
bun run orchestrate:plugin:dry-run
./scripts/ralph.sh
```

## Current Limitations

- Task parsing expects the current PRD format with `ID`, `Status`, `Priority`, and `Depends on` metadata lines.
- The orchestrator uses one active task at a time per workflow.
- Worktree cleanup is manual for now.
- Runtime heartbeats are phase-level, not continuous streaming telemetry.
