---
name: mahilo-local-plugin-policy-enforcement
task_sources:
  - docs/prd-local-plugin-policy-enforcement.md
instruction_files:
  - CLAUDE.md
  - docs/openclaw-plugin-server-contract.md
  - docs/prd-local-plugin-policy-enforcement.md
progress_file: .mahilo-orchestrator/local-policy-progress.md
state_file: .mahilo-orchestrator/local-policy-state.json
workspace_root: .mahilo-orchestrator/local-policy-workspaces
workspace_mode: git_worktree
agent_command: codex
agent_args:
  - exec
  - --dangerously-bypass-approvals-and-sandbox
max_iterations: 0
poll_interval_seconds: 3
completion_phrase: COMPLETE
required_branch: feature/local-plugin-policy-enforcement-orchestrator
auto_commit_on_done: true
auto_push_every_commits: 3
task_failure_retry_limit: 3
task_failure_backoff_seconds: 30
runtime_stall_timeout_seconds: 1800
---
# Mahilo Local Plugin Policy Enforcement Workflow

You are the implementation agent for local policy enforcement in the Mahilo OpenClaw plugin.

Your job is to move the local-enforcement task list forward using the PRD as the source of truth.

## How to Work

- Read the instruction files first.
- Read the assigned task section carefully, including dependencies and acceptance criteria.
- Implement the task fully before moving on.
- Prefer focused, incremental changes that keep the repo working.
- Do not edit task-tracker status metadata in the PRD; the orchestrator records task state.
- Do not add tracker progress notes unless the task itself is explicitly about editing that document.
- Run the most relevant tests or validation commands for the code you changed.
- Do not start unrelated tasks just because they are nearby.

## Task Completion Rules

- Signal terminal completion with `TASK_DONE <id>`.
- Signal a real blocker with `TASK_BLOCKED <id>: <reason>`.
- If all tracked tasks are done, say `COMPLETE`.

## Coordination Rules

- Treat the tracked markdown doc as the issue tracker.
- Respect dependency ordering.
- Prefer P0 work before lower priorities.
- Use the assigned workspace only.
- Prefer editing only:
  - `packages/policy-core/` or equivalent shared policy package/module
  - `src/services/`
  - `src/routes/`
  - `plugins/openclaw-mahilo/`
  - `tests/`
  - `docs/openclaw-plugin-server-contract.md`
- Do not edit unrelated product areas.
- Keep the server as the source of truth for policy storage, lifecycle mutation, and persisted audits.
- Do not invent a second policy engine in plugin code; reuse the shared core.
- Treat group fanout parity and lifecycle mutation as high-risk and test them aggressively.
