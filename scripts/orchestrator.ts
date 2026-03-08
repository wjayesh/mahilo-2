#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  appendProgress,
  areAllTasksComplete,
  buildTaskPrompt,
  cherryPickCommits,
  commitPendingChanges,
  ensureWorkspace,
  formatHistoryNote,
  getCurrentBranch,
  listUniqueCommits,
  loadState,
  loadTasks,
  loadWorkflow,
  mergeTaskUniverses,
  previewWorkspacePath,
  pushBranch,
  runAgentForTask,
  saveState,
  selectNextTask,
  type Task,
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

  let staleByAge = false;
  try {
    const stats = statSync(lockPath);
    staleByAge = Date.now() - stats.mtimeMs > STALE_LOCK_MS;
  } catch {
    staleByAge = true;
  }

  if (!owner || staleByAge) {
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  }

  return false;
}

function acquireRepoLock(repoRoot: string, workflow: string, taskId: string): string {
  const lockPath = getRepoLockPath(repoRoot);
  mkdirSync(resolve(repoRoot, ".mahilo-orchestrator"), { recursive: true });

  while (true) {
    try {
      mkdirSync(lockPath);
      const owner: RepoLockOwner = {
        pid: process.pid,
        workflow,
        taskId,
        acquiredAt: new Date().toISOString(),
      };
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify(owner, null, 2));
      return lockPath;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
      if (!tryRemoveStaleLock(lockPath)) {
        Bun.sleepSync(LOCK_POLL_MS);
      }
    }
  }
}

function releaseRepoLock(lockPath: string) {
  rmSync(lockPath, { recursive: true, force: true });
}

function loadActionableTasks(repoRoot: string, workflowPath: string) {
  const workflow = loadWorkflow(repoRoot, workflowPath);
  const actionable = loadTasks(repoRoot, workflow.taskSources);
  const dependencies = loadTasks(repoRoot, workflow.dependencySources);
  const taskUniverse = mergeTaskUniverses(actionable, dependencies);
  return { workflow, actionable, taskUniverse };
}

function findTaskById(tasks: Task[], taskId: string): Task | null {
  return tasks.find((task) => task.id === taskId) ?? null;
}

function didTaskComplete(task: Task, lastMessage: string): boolean {
  return task.status === "done" || lastMessage.includes(`TASK_DONE ${task.id}`);
}

function didTaskBlock(task: Task, lastMessage: string): boolean {
  return task.status === "blocked" || lastMessage.includes(`TASK_BLOCKED ${task.id}`);
}

function extractBlockedReason(taskId: string, lastMessage: string): string {
  return (
    lastMessage
      .split("\n")
      .find((line) => line.includes(`TASK_BLOCKED ${taskId}`)) ?? `${taskId} blocked.`
  );
}

function maybePushBranch(repoRoot: string, branch: string, commitsSincePush: number, force = false) {
  if (!force && commitsSincePush <= 0) {
    return { pushed: false, error: null };
  }
  return pushBranch(repoRoot, branch);
}

function integrateTerminalTask(params: {
  repoRoot: string;
  workflow: ReturnType<typeof loadWorkflow>;
  task: Task;
  terminalStatus: "completed" | "blocked";
  rootActionableTasks: Task[];
  state: ReturnType<typeof loadState>;
}): {
  historyNote: string;
  refreshedActionableTasks: Task[];
} {
  const { repoRoot, workflow, task, terminalStatus, rootActionableTasks, state } = params;
  const integrationBranch = workflow.requiredBranch ?? getCurrentBranch(repoRoot);
  if (!integrationBranch) {
    throw new Error("Could not determine the integration branch for task integration.");
  }

  const workspace = ensureWorkspace(repoRoot, workflow, task);
  const commitVerb = terminalStatus === "completed" ? "complete" : "block";
  const commitMessage = `orchestrator: ${commitVerb} ${task.id} ${task.title}`;
  const commitResult = commitPendingChanges(workspace.path, commitMessage);
  if (commitResult.error) {
    throw new Error(`${task.id} ${commitVerb} auto-commit failed in task branch: ${commitResult.error}`);
  }

  const lockPath = acquireRepoLock(repoRoot, workflow.name, task.id);
  try {
    const uniqueCommits = listUniqueCommits(workspace.path, integrationBranch);
    if (uniqueCommits.length === 0) {
      const rootTask = findTaskById(rootActionableTasks, task.id);
      const rootAlreadyMatches =
        (terminalStatus === "completed" && rootTask?.status === "done") ||
        (terminalStatus === "blocked" && rootTask?.status === "blocked");
      if (!rootAlreadyMatches) {
        throw new Error(
          `${task.id} reached ${terminalStatus} but produced no new task-branch commits to integrate.`,
        );
      }
      return {
        historyNote: `${task.id} already reflected on ${integrationBranch}; no new commits to integrate.`,
        refreshedActionableTasks: rootActionableTasks,
      };
    }

    const cherryPickResult = cherryPickCommits(repoRoot, uniqueCommits);
    if (cherryPickResult.error) {
      throw new Error(`${task.id} integration failed: ${cherryPickResult.error}`);
    }

    state.commitsSincePush += cherryPickResult.commitCount;
    state.lastCommittedTaskId = task.id;
    state.lastCommitSha = cherryPickResult.lastCommitSha;

    const refreshedActionableTasks = loadTasks(repoRoot, workflow.taskSources);
    const refreshedTask = findTaskById(refreshedActionableTasks, task.id);
    const terminalLabel = terminalStatus === "completed" ? "completed" : "blocked";
    let historyNote = `${task.id} ${terminalLabel} and integrated ${cherryPickResult.commitCount} commit${
      cherryPickResult.commitCount === 1 ? "" : "s"
    }${cherryPickResult.lastCommitSha ? ` as ${cherryPickResult.lastCommitSha}` : ""}.`;

    const shouldPush =
      workflow.autoPushEveryCommits > 0 &&
      (state.commitsSincePush >= workflow.autoPushEveryCommits ||
        areAllTasksComplete(refreshedActionableTasks));

    if (shouldPush) {
      const pushResult = maybePushBranch(repoRoot, integrationBranch, state.commitsSincePush, true);
      if (pushResult.error) {
        throw new Error(`${historyNote} Auto-push failed: ${pushResult.error}`);
      }
      state.commitsSincePush = 0;
      historyNote = `${historyNote} Pushed ${integrationBranch}.`;
    }

    if (terminalStatus === "completed" && refreshedTask?.status !== "done") {
      throw new Error(`${task.id} integrated successfully but root task status is not done.`);
    }
    if (terminalStatus === "blocked" && refreshedTask?.status !== "blocked") {
      throw new Error(`${task.id} integrated successfully but root task status is not blocked.`);
    }

    return { historyNote, refreshedActionableTasks };
  } finally {
    releaseRepoLock(lockPath);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const workflow = loadWorkflow(repoRoot, options.workflowFile);
  const requiredBranch = workflow.requiredBranch;
  const currentBranch = getCurrentBranch(repoRoot);

  if (requiredBranch && currentBranch !== requiredBranch) {
    console.error(
      `Workflow ${workflow.name} requires branch ${requiredBranch}, but current branch is ${currentBranch ?? "(detached)"}.`,
    );
    process.exit(1);
  }

  const state = loadState(repoRoot, workflow);
  const maxIterations = options.maxIterations ?? workflow.maxIterations;

  for (let loop = 0; loop < maxIterations; loop += 1) {
    const { actionable, taskUniverse } = loadActionableTasks(repoRoot, options.workflowFile);
    const task = selectNextTask(actionable, state.activeTaskId, taskUniverse);

    if (!task) {
      state.activeTaskId = null;
      appendProgress(repoRoot, workflow, [formatHistoryNote(null, "idle", "No ready tasks.")]);
      saveState(repoRoot, workflow, state);

      if (areAllTasksComplete(actionable)) {
        const integrationBranch = workflow.requiredBranch ?? getCurrentBranch(repoRoot);
        if (integrationBranch && workflow.autoCommitOnDone && state.commitsSincePush > 0) {
          const pushResult = maybePushBranch(repoRoot, integrationBranch, state.commitsSincePush, true);
          if (pushResult.error) {
            console.error(`Final auto-push failed: ${pushResult.error}`);
            process.exit(1);
          }
          state.commitsSincePush = 0;
          saveState(repoRoot, workflow, state);
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
      continue;
    }

    const workspacePreview = previewWorkspacePath(repoRoot, workflow, task);
    const prompt = buildTaskPrompt(workflow, task, workspacePreview);

    state.iteration += 1;
    state.activeTaskId = task.id;
    appendProgress(repoRoot, workflow, [
      formatHistoryNote(
        task.id,
        task.id === state.lastCommittedTaskId ? "continued" : "started",
        `Selected ${task.id} in ${workspacePreview === repoRoot ? "." : workspacePreview}.`,
      ),
    ]);
    saveState(repoRoot, workflow, state);

    console.log(`\n=== Iteration ${state.iteration}: ${task.id} ${task.title} ===`);
    console.log(`Workspace: ${workspacePreview}`);

    if (options.dryRun) {
      console.log("Dry run selected task summary:");
      console.log(`- Task: ${task.id}`);
      console.log(`- Status: ${task.status}`);
      console.log(`- Priority: ${task.priority}`);
      console.log(`- Depends on: ${task.dependsOn.join(", ") || "None"}`);
      console.log(`- Prompt preview: ${prompt.slice(0, 400)}${prompt.length > 400 ? "..." : ""}`);
      return;
    }

    const workspace = ensureWorkspace(repoRoot, workflow, task);
    const runResult = runAgentForTask(repoRoot, workflow, task, workspace.path, buildTaskPrompt(workflow, task, workspace.path));

    let refreshedActionableTasks = actionable;
    let historyStatus: "completed" | "blocked" | "agent_error" | "continued" = "continued";
    let historyNote = `Agent exited with code ${runResult.exitCode}.`;
    let stopAfterIteration = false;

    try {
      const workspaceActionableTasks = loadTasks(workspace.path, workflow.taskSources);
      const workspaceTask = findTaskById(workspaceActionableTasks, task.id) ?? task;

      if (runResult.exitCode !== 0) {
        historyStatus = "agent_error";
        historyNote = `Agent command failed: ${runResult.commandLine}`;
        state.activeTaskId = null;
        stopAfterIteration = true;
      } else if (didTaskComplete(workspaceTask, runResult.lastMessage)) {
        historyStatus = "completed";
        state.activeTaskId = null;
        const integrationResult = integrateTerminalTask({
          repoRoot,
          workflow,
          task: workspaceTask,
          terminalStatus: "completed",
          rootActionableTasks: actionable,
          state,
        });
        refreshedActionableTasks = integrationResult.refreshedActionableTasks;
        historyNote = integrationResult.historyNote;
      } else if (didTaskBlock(workspaceTask, runResult.lastMessage)) {
        historyStatus = "blocked";
        state.activeTaskId = null;
        const integrationResult = integrateTerminalTask({
          repoRoot,
          workflow,
          task: workspaceTask,
          terminalStatus: "blocked",
          rootActionableTasks: actionable,
          state,
        });
        refreshedActionableTasks = integrationResult.refreshedActionableTasks;
        historyNote = extractBlockedReason(task.id, runResult.lastMessage);
        if (integrationResult.historyNote) {
          historyNote = `${historyNote} ${integrationResult.historyNote}`;
        }
      } else {
        historyStatus = "continued";
        historyNote = `${task.id} remains ${workspaceTask.status}.`;
        state.activeTaskId = task.id;
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
    }

    if (stopAfterIteration) {
      console.error(historyNote);
      process.exit(1);
    }

    if (
      runResult.lastMessage.includes(workflow.completionPhrase) ||
      areAllTasksComplete(refreshedActionableTasks)
    ) {
      const integrationBranch = workflow.requiredBranch ?? getCurrentBranch(repoRoot);
      if (integrationBranch && workflow.autoCommitOnDone && state.commitsSincePush > 0) {
        const pushResult = maybePushBranch(repoRoot, integrationBranch, state.commitsSincePush, true);
        if (pushResult.error) {
          console.error(`Final auto-push failed: ${pushResult.error}`);
          process.exit(1);
        }
        state.commitsSincePush = 0;
        saveState(repoRoot, workflow, state);
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
