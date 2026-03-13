#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  appendProgress,
  areAllTasksComplete,
  buildTaskPrompt,
  cherryPickCommits,
  commitPendingChanges,
  ensureDirectory,
  ensureWorkspace,
  formatHistoryNote,
  getCurrentBranch,
  getHeadCommit,
  getPendingChanges,
  listUniqueCommits,
  loadState,
  loadTasks,
  loadWorkflow,
  mergeTaskUniverses,
  previewWorkspacePath,
  pushBranch,
  removeWorkspace,
  resolvePath,
  runAgentForTask,
  saveState,
  selectNextTask,
  type OrchestratorState,
  type Task,
  type TaskStatus,
  type WorkspaceHandle,
  type WorkflowConfig,
} from "../src/orchestrator";

type CliOptions = {
  workflowFile: string;
  maxIterations?: number;
  once: boolean;
  dryRun: boolean;
};

type HistoryStatus = OrchestratorState["history"][number]["status"];
type RuntimePhase =
  | "starting"
  | "selecting"
  | "running-task"
  | "sleeping"
  | "idle"
  | "completed"
  | "stopped"
  | "error";

type RuntimeState = {
  workflowName: string;
  workflowPath: string;
  pid: number;
  currentBranch: string | null;
  phase: RuntimePhase;
  iteration: number;
  activeTaskId: string | null;
  startedAt: string;
  updatedAt: string;
  lastHeartbeatAt: string;
  lastNote: string | null;
  lastError: string | null;
  lastExitReason: string | null;
  consecutiveFailures: number;
  retryingTaskId: string | null;
  retryAfter: string | null;
};

type TaskFailureResult = {
  historyStatus: HistoryStatus;
  historyNote: string;
  refreshedActionableTasks: Task[];
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

function getWorkerLockPath(repoRoot: string, workflow: WorkflowConfig): string {
  const stateBase = basename(resolvePath(repoRoot, workflow.stateFile)).replace(/\.json$/i, "");
  return resolve(repoRoot, ".mahilo-orchestrator", "runtime", `${stateBase}.worker.lock`);
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

function acquireWorkerLock(repoRoot: string, workflow: WorkflowConfig): string {
  const lockPath = getWorkerLockPath(repoRoot, workflow);
  ensureDirectory(resolve(lockPath, ".."));

  while (true) {
    try {
      mkdirSync(lockPath);
      const owner: RepoLockOwner = {
        pid: process.pid,
        workflow: workflow.name,
        taskId: "orchestrator",
        acquiredAt: new Date().toISOString(),
      };
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify(owner, null, 2));
      return lockPath;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
      if (tryRemoveStaleLock(lockPath)) {
        continue;
      }
      const owner = readLockOwner(lockPath);
      throw new Error(
        `Workflow ${workflow.name} is already running${owner?.pid ? ` (pid ${owner.pid})` : ""}. Stop the existing worker before starting another.`,
      );
    }
  }
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
  return lastMessage.includes(`TASK_DONE ${task.id}`);
}

function didTaskBlock(task: Task, lastMessage: string): boolean {
  return lastMessage.includes(`TASK_BLOCKED ${task.id}`);
}

function extractBlockedReason(taskId: string, lastMessage: string): string {
  return (
    lastMessage
      .split("\n")
      .find((line) => line.includes(`TASK_BLOCKED ${taskId}`)) ?? `${taskId} blocked.`
  );
}

function compactReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim();
}

function maybePushBranch(repoRoot: string, branch: string, commitsSincePush: number, force = false) {
  if (!force && commitsSincePush <= 0) {
    return { pushed: false, error: null };
  }
  return pushBranch(repoRoot, branch);
}

function getRuntimeStatePath(repoRoot: string, workflow: WorkflowConfig): string {
  const stateBase = basename(resolvePath(repoRoot, workflow.stateFile)).replace(/\.json$/i, "");
  return resolve(repoRoot, ".mahilo-orchestrator", "runtime", `${stateBase}.runtime.json`);
}

function writeRuntimeState(
  repoRoot: string,
  workflow: WorkflowConfig,
  update: Partial<RuntimeState>,
): RuntimeState {
  const runtimePath = getRuntimeStatePath(repoRoot, workflow);
  ensureDirectory(resolve(runtimePath, ".."));
  const existing = existsSync(runtimePath)
    ? (JSON.parse(readFileSync(runtimePath, "utf8")) as RuntimeState)
    : null;
  const now = new Date().toISOString();
  const runtimeState: RuntimeState = {
    workflowName: workflow.name,
    workflowPath: workflow.workflowPath,
    pid: process.pid,
    currentBranch: getCurrentBranch(repoRoot),
    phase: existing?.phase ?? "starting",
    iteration: existing?.iteration ?? 0,
    activeTaskId: existing?.activeTaskId ?? null,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
    lastHeartbeatAt: now,
    lastNote: existing?.lastNote ?? null,
    lastError: existing?.lastError ?? null,
    lastExitReason: existing?.lastExitReason ?? null,
    consecutiveFailures: existing?.consecutiveFailures ?? 0,
    retryingTaskId: existing?.retryingTaskId ?? null,
    retryAfter: existing?.retryAfter ?? null,
    ...update,
    updatedAt: now,
    lastHeartbeatAt: now,
    currentBranch: getCurrentBranch(repoRoot),
    pid: process.pid,
  };
  writeFileSync(runtimePath, JSON.stringify(runtimeState, null, 2) + "\n");
  return runtimeState;
}

function readRuntimeState(repoRoot: string, workflow: WorkflowConfig): RuntimeState | null {
  const runtimePath = getRuntimeStatePath(repoRoot, workflow);
  if (!existsSync(runtimePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(runtimePath, "utf8")) as RuntimeState;
  } catch {
    return null;
  }
}

function updateRuntimeState(
  repoRoot: string,
  workflow: WorkflowConfig,
  phase: RuntimePhase,
  update: Partial<RuntimeState> = {},
) {
  return writeRuntimeState(repoRoot, workflow, { phase, ...update });
}

function clearTaskFailureState(state: OrchestratorState, taskId: string) {
  delete state.taskFailureCounts[taskId];
  delete state.taskRetryAfter[taskId];
}

function clearTaskWorkspaceRefreshState(state: OrchestratorState, taskId: string) {
  delete state.taskWorkspaceRefreshReasons[taskId];
}

function getTaskRetryAt(state: OrchestratorState, taskId: string): number | null {
  const raw = state.taskRetryAfter[taskId];
  if (!raw) {
    return null;
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function selectRunnableTask(
  actionable: Task[],
  state: OrchestratorState,
  taskUniverse: Task[],
): { task: Task | null; coolingDown: Array<{ task: Task; retryAfter: string }> } {
  const now = Date.now();
  const coolingDown: Array<{ task: Task; retryAfter: string }> = [];
  const runnable: Task[] = [];

  for (const task of actionable) {
    const retryAt = getTaskRetryAt(state, task.id);
    if (retryAt && retryAt > now) {
      coolingDown.push({ task, retryAfter: state.taskRetryAfter[task.id] });
      continue;
    }
    if (retryAt && retryAt <= now) {
      delete state.taskRetryAfter[task.id];
    }
    runnable.push(task);
  }

  coolingDown.sort((left, right) => Date.parse(left.retryAfter) - Date.parse(right.retryAfter));
  const activeTaskId =
    state.activeTaskId && runnable.some((task) => task.id === state.activeTaskId)
      ? state.activeTaskId
      : null;

  return {
    task: selectNextTask(runnable, activeTaskId, taskUniverse),
    coolingDown,
  };
}

function sleepMs(milliseconds: number) {
  if (milliseconds > 0) {
    Bun.sleepSync(milliseconds);
  }
}

function updateTaskStatusInSource(
  repoRoot: string,
  task: Task,
  nextStatus: TaskStatus,
  note?: string,
) {
  const filePath = resolvePath(repoRoot, task.filePath);
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const headingLine = `${"#".repeat(task.headingLevel)} ${task.heading}`;
  const startIndex = lines.findIndex((line) => line.trim() === headingLine);
  if (startIndex === -1) {
    throw new Error(`Could not find task heading ${headingLine} in ${task.filePath}.`);
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#+)\s+/);
    if (match && match[1].length <= task.headingLevel) {
      endIndex = index;
      break;
    }
  }

  let replaced = false;
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    if (/^- \*\*Status\*\*: `.*`$/.test(lines[index])) {
      lines[index] = `- **Status**: \`${nextStatus}\``;
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    throw new Error(`Could not find status line for ${task.id} in ${task.filePath}.`);
  }

  if (note) {
    const noteHeadingIndex = (() => {
      for (let index = startIndex + 1; index < endIndex; index += 1) {
        if (
          lines[index].trim() === "- **Notes**:" ||
          lines[index].trim() === "- **Progress Notes**:"
        ) {
          return index;
        }
      }
      return -1;
    })();

    const timestampedNote = `  - ${new Date().toISOString()}: ${compactReason(note)}`;
    if (noteHeadingIndex !== -1) {
      let insertAt = noteHeadingIndex + 1;
      while (insertAt < endIndex && /^  - /.test(lines[insertAt])) {
        insertAt += 1;
      }
      lines.splice(insertAt, 0, timestampedNote);
    } else {
      lines.splice(endIndex, 0, "- **Notes**:", timestampedNote);
    }
  }

  writeFileSync(filePath, lines.join("\n"));
}

function isCherryPickContentConflict(reason: string): boolean {
  return /could not apply|CONFLICT \(|merge conflict|cherry-pick failed/i.test(reason);
}

function prepareWorkspaceForTask(params: {
  repoRoot: string;
  workflow: WorkflowConfig;
  task: Task;
  state: OrchestratorState;
}): { workspace: WorkspaceHandle; note: string | null } {
  const { repoRoot, workflow, task, state } = params;
  const refreshReason = state.taskWorkspaceRefreshReasons[task.id];

  if (refreshReason) {
    removeWorkspace(repoRoot, workflow, task);
    clearTaskWorkspaceRefreshState(state, task.id);
    const workspace = ensureWorkspace(repoRoot, workflow, task);
    return {
      workspace,
      note: `Refreshed ${task.id} workspace from latest integration after conflict: ${refreshReason}`,
    };
  }

  const workspace = ensureWorkspace(repoRoot, workflow, task);
  if (workspace.kind !== "git_worktree") {
    return { workspace, note: null };
  }

  const integrationBranch = workflow.requiredBranch ?? getCurrentBranch(repoRoot);
  if (!integrationBranch) {
    return { workspace, note: null };
  }

  const integrationHead = getHeadCommit(repoRoot);
  const workspaceHead = getHeadCommit(workspace.path);
  if (!integrationHead || !workspaceHead || integrationHead === workspaceHead) {
    return { workspace, note: null };
  }

  let uniqueCommits: string[] = [];
  let pendingChanges: string[] = [];
  try {
    uniqueCommits = listUniqueCommits(workspace.path, integrationBranch);
    pendingChanges = getPendingChanges(workspace.path);
  } catch {
    return { workspace, note: null };
  }

  if (uniqueCommits.length > 0 || pendingChanges.length > 0) {
    return { workspace, note: null };
  }

  removeWorkspace(repoRoot, workflow, task);
  const refreshedWorkspace = ensureWorkspace(repoRoot, workflow, task);
  return {
    workspace: refreshedWorkspace,
    note: `Refreshed idle ${task.id} workspace to latest integration ${integrationHead}.`,
  };
}

function handleTaskFailure(params: {
  workflow: WorkflowConfig;
  task: Task;
  actionableTasks: Task[];
  state: OrchestratorState;
  reason: string;
}): TaskFailureResult {
  const { workflow, task, actionableTasks, state, reason } = params;
  const compact = compactReason(reason);

  if (isCherryPickContentConflict(compact)) {
    clearTaskFailureState(state, task.id);
    state.activeTaskId = null;
    state.taskWorkspaceRefreshReasons[task.id] = compact;
    const retryAfter = new Date(Date.now() + 5000).toISOString();
    state.taskRetryAfter[task.id] = retryAfter;
    return {
      historyStatus: "agent_error",
      historyNote: `${compact} Refreshing ${task.id} workspace from latest integration and retrying after ${retryAfter}.`,
      refreshedActionableTasks: actionableTasks,
    };
  }

  const retryLimit = Math.max(workflow.taskFailureRetryLimit, 1);
  const attempt = (state.taskFailureCounts[task.id] ?? 0) + 1;
  const cappedAttempt = Math.min(attempt, retryLimit);
  state.taskFailureCounts[task.id] = cappedAttempt;
  state.activeTaskId = null;

  const backoffSeconds = workflow.taskFailureBackoffSeconds * 2 ** (cappedAttempt - 1);
  const retryAfter = new Date(Date.now() + backoffSeconds * 1000).toISOString();
  state.taskRetryAfter[task.id] = retryAfter;
  const historyNote =
    attempt >= retryLimit
      ? `${compact} Reached retry limit ${retryLimit}; keeping ${task.id} pending and retrying after ${retryAfter}.`
      : `${compact} Retry ${cappedAttempt}/${retryLimit} after ${retryAfter}.`;
  return {
    historyStatus: "agent_error",
    historyNote,
    refreshedActionableTasks: actionableTasks,
  };
}

function summarizePendingChanges(pendingChanges: string[]): string {
  const preview = pendingChanges.slice(0, 5).map((line) => line.slice(3).trim() || line.trim());
  return `${preview.join(", ")}${pendingChanges.length > 5 ? ", ..." : ""}`;
}

function integrateTerminalTask(params: {
  repoRoot: string;
  workflow: WorkflowConfig;
  task: Task;
  terminalStatus: "completed" | "blocked";
  rootActionableTasks: Task[];
  state: OrchestratorState;
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
    const pendingChanges = getPendingChanges(repoRoot);
    if (pendingChanges.length > 0) {
      throw new Error(
        `Integration repo is dirty; refusing to integrate ${task.id} until it is clean. Pending paths: ${summarizePendingChanges(
          pendingChanges,
        )}`,
      );
    }

    const uniqueCommits = listUniqueCommits(workspace.path, integrationBranch);
    const statusToRecord: TaskStatus = terminalStatus === "completed" ? "done" : "blocked";
    const rootTask = findTaskById(rootActionableTasks, task.id) ?? task;
    let historyNote: string;

    if (uniqueCommits.length === 0) {
      historyNote = `${task.id} ${statusToRecord} with no code commits to integrate.`;
    } else {
      const cherryPickResult = cherryPickCommits(repoRoot, uniqueCommits);
      if (cherryPickResult.error) {
        throw new Error(`${task.id} integration failed: ${cherryPickResult.error}`);
      }

      state.commitsSincePush += cherryPickResult.commitCount;
      state.lastCommittedTaskId = task.id;
      state.lastCommitSha = cherryPickResult.lastCommitSha;
      const terminalLabel = terminalStatus === "completed" ? "completed" : "blocked";
      historyNote = `${task.id} ${terminalLabel} and integrated ${cherryPickResult.commitCount} commit${
        cherryPickResult.commitCount === 1 ? "" : "s"
      }${cherryPickResult.lastCommitSha ? ` as ${cherryPickResult.lastCommitSha}` : ""}.`;
    }

    updateTaskStatusInSource(
      repoRoot,
      rootTask,
      statusToRecord,
      terminalStatus === "completed"
        ? `${task.id} completed via orchestrator integration.`
        : `${task.id} blocked via orchestrator integration.`,
    );
    const trackerCommitResult = commitPendingChanges(
      repoRoot,
      `orchestrator: record ${task.id} ${statusToRecord}`,
    );
    if (trackerCommitResult.error) {
      throw new Error(`${task.id} tracker update failed: ${trackerCommitResult.error}`);
    }
    if (trackerCommitResult.committed) {
      state.commitsSincePush += 1;
      state.lastCommittedTaskId = task.id;
      state.lastCommitSha = trackerCommitResult.commitSha;
      historyNote = `${historyNote} Tracker updated${trackerCommitResult.commitSha ? ` as ${trackerCommitResult.commitSha}` : ""}.`;
    }

    const refreshedActionableTasks = loadTasks(repoRoot, workflow.taskSources);
    const refreshedTask = findTaskById(refreshedActionableTasks, task.id);

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

    if (refreshedTask?.status !== statusToRecord) {
      throw new Error(`${task.id} integrated successfully but root task status is not ${statusToRecord}.`);
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
    updateRuntimeState(repoRoot, workflow, "error", {
      activeTaskId: null,
      iteration: 0,
      lastError: `Workflow requires branch ${requiredBranch}, current branch is ${currentBranch ?? "(detached)"}.`,
      lastExitReason: "branch_mismatch",
      lastNote: "Branch guard prevented startup.",
    });
    console.error(
      `Workflow ${workflow.name} requires branch ${requiredBranch}, but current branch is ${currentBranch ?? "(detached)"}.`,
    );
    process.exit(1);
  }

  const workerLockPath = acquireWorkerLock(repoRoot, workflow);

  const state = loadState(repoRoot, workflow);
  const maxIterations = options.maxIterations ?? workflow.maxIterations;
  const infinite = maxIterations <= 0;

  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const currentRuntime = readRuntimeState(repoRoot, workflow);
    const completionPreserved =
      reason === "process_exit" &&
      (currentRuntime?.phase === "completed" || currentRuntime?.lastExitReason === "complete");

    if (completionPreserved) {
      releaseRepoLock(workerLockPath);
      return;
    }

    updateRuntimeState(repoRoot, workflow, "stopped", {
      activeTaskId: state.activeTaskId,
      iteration: state.iteration,
      lastExitReason: reason,
      lastNote: reason,
    });
    releaseRepoLock(workerLockPath);
  };

  process.on("SIGINT", () => {
    shutdown("signal:SIGINT");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown("signal:SIGTERM");
    process.exit(0);
  });
  process.on("exit", () => {
    if (!shuttingDown) {
      shutdown("process_exit");
    }
  });

  updateRuntimeState(repoRoot, workflow, "starting", {
    activeTaskId: state.activeTaskId,
    iteration: state.iteration,
    lastNote: "Orchestrator starting.",
    consecutiveFailures: 0,
    retryingTaskId: null,
    retryAfter: null,
    lastError: null,
    lastExitReason: null,
  });

  for (let loop = 0; infinite || loop < maxIterations; loop += 1) {
    updateRuntimeState(repoRoot, workflow, "selecting", {
      activeTaskId: state.activeTaskId,
      iteration: state.iteration,
      lastNote: "Selecting next runnable task.",
    });

    const { actionable, taskUniverse } = loadActionableTasks(repoRoot, options.workflowFile);
    const { task, coolingDown } = selectRunnableTask(actionable, state, taskUniverse);

    if (!task) {
      state.activeTaskId = null;
      const idleNote =
        coolingDown.length > 0
          ? `No ready tasks. Cooling down ${coolingDown[0].task.id} until ${coolingDown[0].retryAfter}.`
          : "No ready tasks.";
      appendProgress(repoRoot, workflow, [formatHistoryNote(null, "idle", idleNote)]);
      saveState(repoRoot, workflow, state);
      updateRuntimeState(repoRoot, workflow, "idle", {
        activeTaskId: null,
        iteration: state.iteration,
        lastNote: idleNote,
        retryingTaskId: coolingDown[0]?.task.id ?? null,
        retryAfter: coolingDown[0]?.retryAfter ?? null,
      });

      if (areAllTasksComplete(actionable)) {
        const integrationBranch = workflow.requiredBranch ?? getCurrentBranch(repoRoot);
        if (integrationBranch && workflow.autoCommitOnDone && state.commitsSincePush > 0) {
          const pushResult = maybePushBranch(repoRoot, integrationBranch, state.commitsSincePush, true);
          if (pushResult.error) {
            updateRuntimeState(repoRoot, workflow, "error", {
              lastError: `Final auto-push failed: ${pushResult.error}`,
              lastExitReason: "final_push_error",
            });
            console.error(`Final auto-push failed: ${pushResult.error}`);
            process.exit(1);
          }
          state.commitsSincePush = 0;
          saveState(repoRoot, workflow, state);
        }
        updateRuntimeState(repoRoot, workflow, "completed", {
          lastNote: workflow.completionPhrase,
          lastExitReason: "complete",
          retryingTaskId: null,
          retryAfter: null,
          consecutiveFailures: 0,
        });
        console.log(workflow.completionPhrase);
        return;
      }

      if (options.once) {
        return;
      }

      updateRuntimeState(repoRoot, workflow, "sleeping", {
        lastNote: idleNote,
        retryingTaskId: coolingDown[0]?.task.id ?? null,
        retryAfter: coolingDown[0]?.retryAfter ?? null,
      });
      sleepMs(workflow.pollIntervalSeconds * 1000);
      continue;
    }

    const workspacePreview = previewWorkspacePath(repoRoot, workflow, task);
    const prompt = buildTaskPrompt(workflow, task, workspacePreview);

    const nextIteration = state.iteration + 1;

    console.log(`
=== Iteration ${nextIteration}: ${task.id} ${task.title} ===`);
    console.log(`Workspace: ${workspacePreview}`);

    if (options.dryRun) {
      console.log("Dry run selected task summary:");
      console.log(`- Task: ${task.id}`);
      console.log(`- Status: ${task.status}`);
      console.log(`- Priority: ${task.priority}`);
      console.log(`- Depends on: ${task.dependsOn.join(", ") || "None"}`);
      console.log(`- Prompt preview: ${prompt.slice(0, 400)}${prompt.length > 400 ? "..." : ""}`);
      updateRuntimeState(repoRoot, workflow, "idle", {
        activeTaskId: task.id,
        iteration: state.iteration,
        lastNote: `Dry run previewed ${task.id}.`,
      });
      return;
    }

    state.iteration = nextIteration;
    state.activeTaskId = task.id;
    appendProgress(repoRoot, workflow, [
      formatHistoryNote(
        task.id,
        task.id === state.lastCommittedTaskId ? "continued" : "started",
        `Selected ${task.id} in ${workspacePreview === repoRoot ? "." : workspacePreview}.`,
      ),
    ]);
    saveState(repoRoot, workflow, state);
    updateRuntimeState(repoRoot, workflow, "running-task", {
      activeTaskId: task.id,
      iteration: state.iteration,
      lastNote: `Running ${task.id}.`,
      retryingTaskId: null,
      retryAfter: null,
    });
    let refreshedActionableTasks = actionable;
    let historyStatus: HistoryStatus = "continued";
    let historyNote = `Agent did not finish.`;
    let runResultLastMessage = "";

    try {
      const preparedWorkspace = prepareWorkspaceForTask({
        repoRoot,
        workflow,
        task,
        state,
      });
      if (preparedWorkspace.note) {
        appendProgress(repoRoot, workflow, [
          formatHistoryNote(task.id, "continued", preparedWorkspace.note),
        ]);
        saveState(repoRoot, workflow, state);
      }

      const runResult = runAgentForTask(
        repoRoot,
        workflow,
        task,
        preparedWorkspace.workspace.path,
        buildTaskPrompt(workflow, task, preparedWorkspace.workspace.path),
      );
      runResultLastMessage = runResult.lastMessage;
      historyNote = `Agent exited with code ${runResult.exitCode}.`;

      const workspaceActionableTasks = loadTasks(preparedWorkspace.workspace.path, workflow.taskSources);
      const workspaceTask = findTaskById(workspaceActionableTasks, task.id) ?? task;

      if (runResult.exitCode !== 0) {
        const failure = handleTaskFailure({
          workflow,
          task,
          actionableTasks: actionable,
          state,
          reason: runResult.error
            ? `Agent command failed: ${runResult.commandLine} (${runResult.error})`
            : `Agent command failed: ${runResult.commandLine}`,
        });
        historyStatus = failure.historyStatus;
        historyNote = failure.historyNote;
        refreshedActionableTasks = failure.refreshedActionableTasks;
      } else if (didTaskComplete(workspaceTask, runResult.lastMessage)) {
        historyStatus = "completed";
        state.activeTaskId = null;
        clearTaskFailureState(state, task.id);
        clearTaskWorkspaceRefreshState(state, task.id);
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
        clearTaskFailureState(state, task.id);
        clearTaskWorkspaceRefreshState(state, task.id);
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
        historyNote = `${task.id} did not emit a terminal marker and remains active.`;
        state.activeTaskId = task.id;
        clearTaskFailureState(state, task.id);
      }
    } catch (error) {
      const failure = handleTaskFailure({
        workflow,
        task,
        actionableTasks: actionable,
        state,
        reason: error instanceof Error ? error.message : String(error),
      });
      historyStatus = failure.historyStatus;
      historyNote = failure.historyNote;
      refreshedActionableTasks = failure.refreshedActionableTasks;
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
    updateRuntimeState(
      repoRoot,
      workflow,
      historyStatus === "agent_error" ? "sleeping" : historyStatus === "completed" && areAllTasksComplete(refreshedActionableTasks) ? "completed" : "idle",
      {
        activeTaskId: state.activeTaskId,
        iteration: state.iteration,
        lastNote: historyNote,
        lastError: historyStatus === "agent_error" ? historyNote : null,
        consecutiveFailures: historyStatus === "agent_error" ? state.taskFailureCounts[task.id] ?? 0 : 0,
        retryingTaskId: state.taskRetryAfter[task.id] ? task.id : null,
        retryAfter: state.taskRetryAfter[task.id] ?? null,
      },
    );

    if (
      runResultLastMessage.includes(workflow.completionPhrase) ||
      areAllTasksComplete(refreshedActionableTasks)
    ) {
      const integrationBranch = workflow.requiredBranch ?? getCurrentBranch(repoRoot);
      if (integrationBranch && workflow.autoCommitOnDone && state.commitsSincePush > 0) {
        const pushResult = maybePushBranch(repoRoot, integrationBranch, state.commitsSincePush, true);
        if (pushResult.error) {
          updateRuntimeState(repoRoot, workflow, "error", {
            lastError: `Final auto-push failed: ${pushResult.error}`,
            lastExitReason: "final_push_error",
          });
          console.error(`Final auto-push failed: ${pushResult.error}`);
          process.exit(1);
        }
        state.commitsSincePush = 0;
        saveState(repoRoot, workflow, state);
      }
      updateRuntimeState(repoRoot, workflow, "completed", {
        activeTaskId: null,
        iteration: state.iteration,
        lastNote: workflow.completionPhrase,
        lastExitReason: "complete",
        consecutiveFailures: 0,
        retryingTaskId: null,
        retryAfter: null,
      });
      console.log(workflow.completionPhrase);
      return;
    }

    if (options.once) {
      return;
    }

    updateRuntimeState(repoRoot, workflow, "sleeping", {
      activeTaskId: state.activeTaskId,
      iteration: state.iteration,
      lastNote: historyNote,
      retryingTaskId: state.taskRetryAfter[task.id] ? task.id : null,
      retryAfter: state.taskRetryAfter[task.id] ?? null,
    });
    sleepMs(workflow.pollIntervalSeconds * 1000);
  }

  updateRuntimeState(repoRoot, workflow, "stopped", {
    activeTaskId: state.activeTaskId,
    iteration: state.iteration,
    lastNote: `Reached max iterations (${maxIterations}).`,
    lastExitReason: "max_iterations_reached",
  });
  console.log(`Reached max iterations without seeing ${workflow.completionPhrase}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
