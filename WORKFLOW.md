---
name: mahilo-server-autonomous-development
task_sources:
  - docs/prd-server-policy-platform.md
  - docs/prd-dashboard-frontend-activation.md
instruction_files:
  - CLAUDE.md
  - docs/openclaw-plugin-server-contract.md
  - docs/permission-system-design.md
  - docs/prd-dashboard-frontend-activation.md
progress_file: .mahilo-orchestrator/progress.md
state_file: .mahilo-orchestrator/state.json
workspace_root: .mahilo-orchestrator/workspaces
workspace_mode: git_worktree
agent_command: codex
agent_args:
  - exec
  - --dangerously-bypass-approvals-and-sandbox
max_iterations: 0
poll_interval_seconds: 3
completion_phrase: COMPLETE
required_branch: current
auto_commit_on_done: true
auto_push_every_commits: 3
task_failure_retry_limit: 3
task_failure_backoff_seconds: 30
runtime_stall_timeout_seconds: 1800
---
# Mahilo Server Autonomous Workflow

You are the implementation agent for Mahilo server and dashboard work in this repo.

Your job is to autonomously move the server/dashboard task list forward using the task documents as the source of truth.

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

- Treat the tracked markdown docs as the issue tracker.
- Respect dependency ordering.
- Prefer P0 work before lower priorities.
- Use the assigned workspace only.
