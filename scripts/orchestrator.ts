#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  appendProgress,
  areAllTasksComplete,
  buildTaskPrompt,
  commitPendingChanges,
  ensureWorkspace,
  formatHistoryNote,
  getCurrentBranch,
  loadState,
  loadTasks,
  loadWorkflow,
  mergeTaskUniverses,
  previewWorkspacePath,
  pushBranch,
  reconcileWorkspace,
  runAgentForTask,
  saveState,
  selectNextTask,
} from "../src/orchestrator";

type CliOptions = {
  workflowFile: string;
  maxIterations?: number;
  once: boolean;
  dryRun: boolean;
};

const REPO_LOCK_NAME = "repo.lock";
const LOCK_POLL_MS = 1000;
const STALE_LOCK_MS = 60_000;

type RepoLockOwner = {
  pid: number | null;
  workflow: string;
  taskId: string;
  acquiredAt: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    workflowFile: "WORKFLOW.md",
    once: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workflow" && argv[index + 1]) {
      options.workflowFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--max-iterations" && argv[index + 1]) {
      options.maxIterations = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
    }
  }

  return options;
}

function getRepoLockPath(repoRoot: string): string {
  return resolve(repoRoot, ".mahilo-orchestrator", REPO_LOCK_NAME);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockOwner(lockPath: string): RepoLockOwner | null {
  const ownerPath = join(lockPath, "owner.json");
  if (!existsSync(ownerPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(ownerPath, "utf8")) as RepoLockOwner;
  } catch {
    return null;
  }
}

function tryRemoveStaleLock(lockPath: string): boolean {
  if (!existsSync(lockPath)) {
    return false;
  }

  const owner = readLockOwner(lockPath);
  if (owner?.pid && isProcessAlive(owner.pid)) {
    return false;
  }

  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (!owner || ageMs >= STALE_LOCK_MS || (owner.pid !== null && !isProcessAlive(owner.pid))) {
      rmSync(lockPath, { recursive: true, force: true });
      return true;
    }
  } catch {
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  }

  return false;
}

function acquireRepoLock(repoRoot: string, workflowName: string, taskId: string): string {
  const lockPath = getRepoLockPath(repoRoot);
  const ownerPath = join(lockPath, "owner.json");
  let lastReportedOwner = "";

  while (true) {
    try {
      mkdirSync(lockPath, { recursive: false });
      const owner: RepoLockOwner = {
        pid: process.pid,
        workflow: workflowName,
        taskId,
        acquiredAt: new Date().toISOString(),
      };
      writeFileSync(ownerPath, JSON.stringify(owner, null, 2) + "\n");
      return lockPath;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "EEXIST") {
        throw error;
      }

      if (tryRemoveStaleLock(lockPath)) {
        continue;
      }

      const owner = readLockOwner(lockPath);
      const ownerSummary = owner
        ? `${owner.workflow}:${owner.taskId}:${owner.pid ?? "unknown"}`
        : "unknown-owner";
      if (ownerSummary !== lastReportedOwner) {
        console.log(`Waiting for repo lock held by ${ownerSummary}`);
        lastReportedOwner = ownerSummary;
      }
      Bun.sleepSync(LOCK_POLL_MS);
    }
  }
}

function releaseRepoLock(lockPath: string) {
  rmSync(lockPath, { recursive: true, force: true });
}

function main() {
  const repoRoot = process.cwd();
  const options = parseArgs(process.argv.slice(2));
  const workflow = loadWorkflow(repoRoot, options.workflowFile);
  const maxIterations = options.maxIterations ?? workflow.maxIterations;
  const state = loadState(repoRoot, workflow);

  console.log(`Workflow: ${workflow.name}`);
  console.log(`Workflow file: ${workflow.workflowPath}`);
  console.log(`Task sources: ${workflow.taskSources.join(", ")}`);
  if (workflow.dependencySources.length > 0) {
    console.log(`Dependency sources: ${workflow.dependencySources.join(", ")}`);
  }
  console.log(`Workspace mode: ${workflow.workspaceMode}`);
  if (workflow.requiredBranch) {
    const currentBranch = getCurrentBranch(repoRoot);
    if (currentBranch !== workflow.requiredBranch) {
      console.error(
        `Refusing to run workflow on branch ${currentBranch ?? "(detached HEAD)"}. Expected ${workflow.requiredBranch}.`,
      );
      process.exit(1);
    }
    console.log(`Required branch: ${workflow.requiredBranch}`);
  }

  for (let attempt = 0; attempt < maxIterations; attempt += 1) {
    const actionableTasks = loadTasks(repoRoot, workflow.taskSources);
    const dependencyTasks = loadTasks(repoRoot, workflow.dependencySources);
    const taskUniverse = mergeTaskUniverses(actionableTasks, dependencyTasks);

    if (areAllTasksComplete(actionableTasks)) {
      appendProgress(repoRoot, workflow, [
        formatHistoryNote(null, "completed", "All tracked tasks are complete."),
      ]);
      console.log(workflow.completionPhrase);
      state.activeTaskId = null;
      saveState(repoRoot, workflow, state);
      return;
    }

    const task = selectNextTask(actionableTasks, state.activeTaskId, taskUniverse);
    state.iteration += 1;

    if (!task) {
      const blockedOrWaiting = actionableTasks
        .filter((candidate) => candidate.status !== "done")
        .map((candidate) => `${candidate.id}:${candidate.status}`)
        .join(", ");
      appendProgress(repoRoot, workflow, [
        `## Iteration ${state.iteration}`,
        formatHistoryNote(
          null,
          "idle",
          `No ready tasks found. Remaining tasks: ${blockedOrWaiting || "none"}`,
        ),
      ]);
      saveState(repoRoot, workflow, state);
      console.log("No ready tasks found. Waiting for dependencies or review states to clear.");
      return;
    }

    const workspace = options.dryRun
      ? {
          path: previewWorkspacePath(repoRoot, workflow, task),
          kind: workflow.workspaceMode === "shared" ? ("shared" as const) : ("git_worktree" as const),
        }
      : ensureWorkspace(repoRoot, workflow, task);
    const prompt = buildTaskPrompt(workflow, task, workspace.path);
    const taskWasActive = state.activeTaskId === task.id;
    state.activeTaskId = task.id;
    appendProgress(repoRoot, workflow, [
      `## Iteration ${state.iteration}`,
      formatHistoryNote(
        task.id,
        taskWasActive ? "continued" : "started",
        `Dispatching ${task.id} from ${task.filePath} in ${relative(repoRoot, resolve(workspace.path)) || "."} (${workspace.kind}).`,
      ),
    ]);
    saveState(repoRoot, workflow, state);

    console.log(`\n=== Iteration ${state.iteration}: ${task.id} ${task.title} ===`);
    console.log(`Workspace: ${workspace.path}`);
    console.log(`Workspace kind: ${workspace.kind}`);

    if (options.dryRun) {
      console.log("Dry run selected task summary:");
      console.log(`- Task: ${task.id}`);
      console.log(`- Status: ${task.status}`);
      console.log(`- Priority: ${task.priority}`);
      console.log(`- Depends on: ${task.dependsOn.join(", ") || "None"}`);
      console.log(`- Prompt preview: ${prompt.slice(0, 400)}${prompt.length > 400 ? "..." : ""}`);
      return;
    }

    const runResult = runAgentForTask(repoRoot, workflow, task, workspace.path, prompt);

    let refreshedActionableTasks = actionableTasks;
    let refreshedTask = task;
    let historyStatus: "completed" | "blocked" | "agent_error" | "continued" = "continued";
    let historyNote = `Agent exited with code ${runResult.exitCode}.`;
    let stopAfterIteration = false;

    const lockPath = acquireRepoLock(repoRoot, workflow.name, task.id);
    try {
      reconcileWorkspace(repoRoot, workspace);
      refreshedActionableTasks = loadTasks(repoRoot, workflow.taskSources);
      refreshedTask = refreshedActionableTasks.find((candidate) => candidate.id === task.id) ?? task;

      if (runResult.exitCode !== 0) {
        historyStatus = "agent_error";
        historyNote = `Agent command failed: ${runResult.commandLine}`;
      } else if (
        refreshedTask.status === "done" ||
        runResult.lastMessage.includes(`TASK_DONE ${task.id}`)
      ) {
        historyStatus = "completed";
        historyNote = `${task.id} completed.`;
        state.activeTaskId = null;

        if (workflow.autoCommitOnDone) {
          const commitMessage = `orchestrator: complete ${task.id} ${task.title}`;
          const commitResult = commitPendingChanges(repoRoot, commitMessage);

          if (commitResult.error) {
            historyStatus = "agent_error";
            historyNote = `${task.id} completed but auto-commit failed: ${commitResult.error}`;
            stopAfterIteration = true;
          } else if (commitResult.committed) {
            state.commitsSincePush += 1;
            state.lastCommittedTaskId = task.id;
            state.lastCommitSha = commitResult.commitSha;
            historyNote = `${task.id} completed and committed${commitResult.commitSha ? ` as ${commitResult.commitSha}` : ""}.`;

            const currentBranch = workflow.requiredBranch ?? getCurrentBranch(repoRoot);
            const shouldPush =
              workflow.autoPushEveryCommits > 0 &&
              (state.commitsSincePush >= workflow.autoPushEveryCommits ||
                runResult.lastMessage.includes(workflow.completionPhrase) ||
                areAllTasksComplete(refreshedActionableTasks));

            if (shouldPush && currentBranch) {
              const pushResult = pushBranch(repoRoot, currentBranch);
              if (pushResult.error) {
                historyStatus = "agent_error";
                historyNote = `${historyNote} Auto-push failed: ${pushResult.error}`;
                stopAfterIteration = true;
              } else {
                state.commitsSincePush = 0;
                historyNote = `${historyNote} Pushed ${currentBranch}.`;
              }
            }
          } else {
            historyNote = `${task.id} completed with no repository changes to commit.`;
          }
        }
      } else if (
        refreshedTask.status === "blocked" ||
        runResult.lastMessage.includes(`TASK_BLOCKED ${task.id}`)
      ) {
        historyStatus = "blocked";
        historyNote =
          runResult.lastMessage
            .split("\n")
            .find((line) => line.includes(`TASK_BLOCKED ${task.id}`)) ?? `${task.id} blocked.`;
        state.activeTaskId = null;
      }

      appendProgress(repoRoot, workflow, [formatHistoryNote(task.id, historyStatus, historyNote)]);
      state.history.push({
        iteration: state.iteration,
        taskId: task.id,
        timestamp: new Date().toISOString(),
        status: historyStatus,
        note: historyNote,
      });
      saveState(repoRoot, workflow, state);
    } catch (error) {
      historyStatus = "agent_error";
      historyNote = error instanceof Error ? error.message : String(error);
      state.activeTaskId = null;
      appendProgress(repoRoot, workflow, [formatHistoryNote(task.id, historyStatus, historyNote)]);
      state.history.push({
        iteration: state.iteration,
        taskId: task.id,
        timestamp: new Date().toISOString(),
        status: historyStatus,
        note: historyNote,
      });
      saveState(repoRoot, workflow, state);
      stopAfterIteration = true;
    } finally {
      releaseRepoLock(lockPath);
    }

    if (stopAfterIteration) {
      console.error(historyNote);
      process.exit(1);
    }

    if (
      runResult.lastMessage.includes(workflow.completionPhrase) ||
      areAllTasksComplete(refreshedActionableTasks)
    ) {
      if (workflow.autoCommitOnDone && state.commitsSincePush > 0) {
        const currentBranch = workflow.requiredBranch ?? getCurrentBranch(repoRoot);
        if (currentBranch) {
          const pushResult = pushBranch(repoRoot, currentBranch);
          if (pushResult.error) {
            console.error(`Final auto-push failed: ${pushResult.error}`);
            process.exit(1);
          }
          state.commitsSincePush = 0;
          saveState(repoRoot, workflow, state);
        }
      }
      console.log(workflow.completionPhrase);
      return;
    }

    if (options.once) {
      return;
    }

    const waitMs = workflow.pollIntervalSeconds * 1000;
    if (waitMs > 0) {
      Bun.sleepSync(waitMs);
    }
  }

  console.log(`Reached max iterations without seeing ${workflow.completionPhrase}.`);
}

main();
