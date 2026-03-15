---
name: mahilo-openclaw-sandbox-harness
task_sources:
  - docs/prd-openclaw-sandbox-harness.md
instruction_files:
  - CLAUDE.md
  - docs/openclaw-plugin-server-contract.md
  - docs/prd-openclaw-sandbox-harness.md
progress_file: .mahilo-orchestrator/sandbox-harness-progress.md
state_file: .mahilo-orchestrator/sandbox-harness-state.json
workspace_root: .mahilo-orchestrator/sandbox-harness-workspaces
workspace_mode: git_worktree
agent_command: codex
agent_args:
  - exec
  - --dangerously-bypass-approvals-and-sandbox
max_iterations: 0
poll_interval_seconds: 3
completion_phrase: COMPLETE
required_branch: feature/openclaw-sandbox-harness
auto_commit_on_done: true
auto_push_every_commits: 3
task_failure_retry_limit: 3
task_failure_backoff_seconds: 30
runtime_stall_timeout_seconds: 1800
---
# Mahilo OpenClaw Sandbox Harness Workflow

You are the implementation agent for building a fool-proof two-sandbox Mahilo/OpenClaw harness and then deriving a verified playbook and skill from it.

## How to Work

- Read the instruction files first.
- Treat the PRD as the issue tracker and source of truth.
- Implement only the assigned task and respect dependency ordering.
- Prefer focused, incremental changes that keep the harness runnable at every step.
- Run the most relevant validation for the code, scripts, docs, or harness logic you changed.
- Do not edit task-tracker status metadata in the PRD; the orchestrator owns task state.
- Do not add progress notes to the PRD unless the task explicitly requires it.

## Task Completion Rules

- Signal terminal completion with `TASK_DONE <id>`.
- Signal a real blocker with `TASK_BLOCKED <id>: <reason>`.
- If all tracked tasks are done, say `COMPLETE`.

## Coordination Rules

- Use the assigned workspace only.
- Prefer editing only:
  - `plugins/openclaw-mahilo/docs/`
  - `plugins/openclaw-mahilo/scripts/`
  - `plugins/openclaw-mahilo/tests/`
  - `tests/e2e/`
  - `tests/integration/`
  - `docs/`
  - `.codex/skills/`
- Avoid production server changes unless the harness cannot be made reproducible with existing API/admin/test surfaces.
- Keep deterministic no-model proof as the default operator path.
- Treat real-model `/v1/chat/completions` proof as a secondary path unless the task explicitly requires it.
- Treat the old sandbox skill/doc as historical reference only, not as the source of truth.
- Only create the new skill after the harness and playbook are verified.
- The final audit task may append new pending fix tasks and a new trailing audit task to the PRD when the live result reveals real issues.
