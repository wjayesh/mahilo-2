---
name: mahilo-plugin-autonomous-development
task_sources:
  - docs/prd-openclaw-plugin-migration.md
dependency_sources:
  - docs/prd-server-policy-platform.md
instruction_files:
  - docs/openclaw-plugin-server-contract.md
  - docs/prd-openclaw-plugin-migration.md
progress_file: .mahilo-orchestrator/plugin-progress.md
state_file: .mahilo-orchestrator/plugin-state.json
workspace_root: .mahilo-orchestrator/plugin-workspaces
workspace_mode: git_worktree
agent_command: codex
agent_args:
  - exec
  - --dangerously-bypass-approvals-and-sandbox
max_iterations: 0
poll_interval_seconds: 3
completion_phrase: COMPLETE
required_branch: autonomous/server-integration
auto_commit_on_done: true
auto_push_every_commits: 3
task_failure_retry_limit: 3
task_failure_backoff_seconds: 30
runtime_stall_timeout_seconds: 1800
---
# Mahilo Plugin Autonomous Workflow

You are the implementation agent for the Mahilo OpenClaw plugin.

Your job is to autonomously move the plugin task list forward using the task documents as the source of truth.

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
- Respect dependency ordering, including server-side `SRV-*` dependencies from the shared contract.
- Prefer P0 work before lower priorities.
- Use the assigned workspace only.
- Prefer editing only `plugins/openclaw-mahilo/`, plugin-local tests/config, and `docs/prd-openclaw-plugin-migration.md`.
- Do not edit server implementation files, `docs/prd-server-policy-platform.md`, or `docs/openclaw-plugin-server-contract.md` from the plugin workflow.
- If plugin work requires a server or contract change, mark the task blocked and explain the dependency instead of editing shared files directly.
