# Mahilo Autonomous Orchestrator

Mahilo now uses an in-repo autonomous development loop inspired by Symphony, but backed by markdown task lists instead of Linear.

## Goals

- keep task tracking in-repo
- dispatch one ready task at a time
- keep agent work focused on a single task
- support persistent progress and repeatable runs
- isolate task work with native git worktrees when desired

## Source of Truth

- `WORKFLOW.md` is the default **server** workflow
- `WORKFLOW.plugin.md` is the separate plugin workflow
- `docs/prd-server-policy-platform.md` is the current server task source
- `docs/prd-openclaw-plugin-migration.md` is the current plugin task source
- `docs/openclaw-plugin-server-contract.md` is the shared server/plugin contract

## How It Works

1. Load a workflow file
2. Parse task docs for task IDs, statuses, priorities, and dependencies
3. Optionally parse separate dependency sources to gate tasks on external prerequisites
4. Pick the next ready task
5. Create or reuse a workspace
6. Sync the current integration-branch snapshot into the worktree so current docs and code are visible there
7. Run `codex exec` with the workflow prompt plus the assigned task section
8. Sync changed files back from the worktree into the integration branch after the agent finishes
9. Auto-commit each successfully completed task
10. Auto-push after every configured commit threshold, and on final completion
11. Re-read the task docs to see whether the task moved to `done`, `blocked`, or remains active
12. Repeat until all tracked tasks are complete or the loop limit is reached

## Files

- `src/orchestrator.ts` — parser, scheduler, dependency resolver, workspace manager, worktree snapshot sync, and agent runner
- `scripts/orchestrator.ts` — CLI entrypoint
- `scripts/ralph.sh` — compatibility wrapper that now calls the new orchestrator
- `.mahilo-orchestrator/state.json` — persisted server runtime state
- `.mahilo-orchestrator/progress.md` — server iteration log
- `.mahilo-orchestrator/plugin-state.json` — persisted plugin runtime state
- `.mahilo-orchestrator/plugin-progress.md` — plugin iteration log

## Safety and Git Behavior

- Workflows are branch-guarded and currently require `autonomous/server-integration`.
- The loop is intended to reconcile into the integration branch, not `main`.
- Each `TASK_DONE` result creates an automatic git commit.
- The loop auto-pushes after every 3 completed task commits by default.
- Concurrent workflows share a repo-level lock before reconcile/commit/push operations.
- The plugin workflow is scoped away from server implementation files to reduce overlap.

## Commands

```bash
bun run scripts/orchestrator.ts
bun run scripts/orchestrator.ts --once
bun run scripts/orchestrator.ts --once --dry-run
bun run scripts/orchestrator.ts --workflow WORKFLOW.plugin.md --once --dry-run
./scripts/ralph.sh
```

## Current Limitations

- Task parsing expects the current PRD format with `ID`, `Status`, `Priority`, and `Depends on` metadata lines.
- The orchestrator uses one active task at a time.
- Worktree cleanup is manual for now.
- The loop does not yet manage multiple parallel agents.
