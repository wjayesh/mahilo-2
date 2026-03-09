import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type TaskStatus = "pending" | "in-progress" | "blocked" | "review" | "done";

export type TaskPriority = `P${number}` | "unscored";

export type WorkflowConfig = {
  name: string;
  taskSources: string[];
  dependencySources: string[];
  instructionFiles: string[];
  progressFile: string;
  stateFile: string;
  workspaceRoot: string;
  workspaceMode: "shared" | "git_worktree";
  agentCommand: string;
  agentArgs: string[];
  maxIterations: number;
  pollIntervalSeconds: number;
  completionPhrase: string;
  requiredBranch: string | null;
  autoCommitOnDone: boolean;
  autoPushEveryCommits: number;
  taskFailureRetryLimit: number;
  taskFailureBackoffSeconds: number;
  runtimeStallTimeoutSeconds: number;
  workflowBody: string;
  workflowPath: string;
};

export type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dependsOn: string[];
  filePath: string;
  heading: string;
  headingLevel: number;
  sectionBody: string;
  order: number;
  sortIndex: number;
};

export type WorkspaceHandle = {
  path: string;
  kind: "shared" | "git_worktree";
  branchName: string | null;
};

export type OrchestratorState = {
  workflowPath: string;
  iteration: number;
  activeTaskId: string | null;
  commitsSincePush: number;
  lastCommittedTaskId: string | null;
  lastCommitSha: string | null;
  taskFailureCounts: Record<string, number>;
  taskRetryAfter: Record<string, string>;
  history: Array<{
    iteration: number;
    taskId: string | null;
    timestamp: string;
    status: "started" | "continued" | "completed" | "blocked" | "idle" | "agent_error";
    note: string;
  }>;
};

type FrontMatterValue = string | number | string[];

const DEFAULT_WORKFLOW: Omit<WorkflowConfig, "workflowBody" | "workflowPath"> = {
  name: "mahilo-autonomous-development",
  taskSources: ["docs/prd-server-policy-platform.md", "docs/prd-openclaw-plugin-migration.md"],
  dependencySources: [],
  instructionFiles: ["CLAUDE.md", "docs/openclaw-plugin-server-contract.md"],
  progressFile: ".mahilo-orchestrator/progress.md",
  stateFile: ".mahilo-orchestrator/state.json",
  workspaceRoot: ".mahilo-orchestrator/workspaces",
  workspaceMode: "git_worktree",
  agentCommand: "codex",
  agentArgs: ["exec"],
  maxIterations: 50,
  pollIntervalSeconds: 3,
  completionPhrase: "COMPLETE",
  requiredBranch: null,
  autoCommitOnDone: true,
  autoPushEveryCommits: 3,
  taskFailureRetryLimit: 3,
  taskFailureBackoffSeconds: 30,
  runtimeStallTimeoutSeconds: 1800,
};

const STATUS_VALUES = new Set<TaskStatus>(["pending", "in-progress", "blocked", "review", "done"]);

function parseScalarValue(value: string): string | number {
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function runGit(args: string[], cwd: string) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function gitError(result: ReturnType<typeof runGit>, fallback: string): string {
  return result.stderr?.trim() || result.stdout?.trim() || fallback;
}

export function parseWorkflowFile(content: string, workflowPath = "WORKFLOW.md"): WorkflowConfig {
  let frontMatter: Record<string, FrontMatterValue> = {};
  let workflowBody = content.trim();

  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end === -1) {
      throw new Error(
        `Workflow file ${workflowPath} starts a front matter block but never closes it.`,
      );
    }

    const rawFrontMatter = content.slice(4, end).split("\n");
    workflowBody = content.slice(end + 4).trim();

    let currentKey: string | null = null;

    for (const rawLine of rawFrontMatter) {
      const line = rawLine.replace(/\r$/, "");
      if (!line.trim() || /^\s*#/.test(line)) {
        continue;
      }

      const listItemMatch = line.match(/^\s+-\s+(.*)$/);
      if (listItemMatch) {
        if (!currentKey) {
          throw new Error(`Found a list item before a key in ${workflowPath}: ${line}`);
        }
        const current = frontMatter[currentKey];
        if (!Array.isArray(current)) {
          throw new Error(
            `Key ${currentKey} must be declared before adding list items in ${workflowPath}.`,
          );
        }
        current.push(String(parseScalarValue(listItemMatch[1])));
        continue;
      }

      const keyMatch = line.match(/^([A-Za-z0-9_]+):(?:\s+(.*))?$/);
      if (!keyMatch) {
        throw new Error(`Unsupported front matter syntax in ${workflowPath}: ${line}`);
      }

      const [, key, rawValue] = keyMatch;
      currentKey = key;
      frontMatter[key] = rawValue === undefined || rawValue === "" ? [] : parseScalarValue(rawValue);
    }
  }

  return {
    name: typeof frontMatter.name === "string" ? frontMatter.name : DEFAULT_WORKFLOW.name,
    taskSources: Array.isArray(frontMatter.task_sources)
      ? frontMatter.task_sources
      : DEFAULT_WORKFLOW.taskSources,
    dependencySources: Array.isArray(frontMatter.dependency_sources)
      ? frontMatter.dependency_sources
      : DEFAULT_WORKFLOW.dependencySources,
    instructionFiles: Array.isArray(frontMatter.instruction_files)
      ? frontMatter.instruction_files
      : DEFAULT_WORKFLOW.instructionFiles,
    progressFile:
      typeof frontMatter.progress_file === "string"
        ? frontMatter.progress_file
        : DEFAULT_WORKFLOW.progressFile,
    stateFile:
      typeof frontMatter.state_file === "string"
        ? frontMatter.state_file
        : DEFAULT_WORKFLOW.stateFile,
    workspaceRoot:
      typeof frontMatter.workspace_root === "string"
        ? frontMatter.workspace_root
        : DEFAULT_WORKFLOW.workspaceRoot,
    workspaceMode:
      frontMatter.workspace_mode === "shared" || frontMatter.workspace_mode === "git_worktree"
        ? frontMatter.workspace_mode
        : DEFAULT_WORKFLOW.workspaceMode,
    agentCommand:
      typeof frontMatter.agent_command === "string"
        ? frontMatter.agent_command
        : DEFAULT_WORKFLOW.agentCommand,
    agentArgs: Array.isArray(frontMatter.agent_args)
      ? frontMatter.agent_args
      : DEFAULT_WORKFLOW.agentArgs,
    maxIterations:
      typeof frontMatter.max_iterations === "number"
        ? frontMatter.max_iterations
        : DEFAULT_WORKFLOW.maxIterations,
    pollIntervalSeconds:
      typeof frontMatter.poll_interval_seconds === "number"
        ? frontMatter.poll_interval_seconds
        : DEFAULT_WORKFLOW.pollIntervalSeconds,
    completionPhrase:
      typeof frontMatter.completion_phrase === "string"
        ? frontMatter.completion_phrase
        : DEFAULT_WORKFLOW.completionPhrase,
    requiredBranch:
      typeof frontMatter.required_branch === "string"
        ? frontMatter.required_branch
        : DEFAULT_WORKFLOW.requiredBranch,
    autoCommitOnDone:
      typeof frontMatter.auto_commit_on_done === "string"
        ? frontMatter.auto_commit_on_done.toLowerCase() === "true"
        : DEFAULT_WORKFLOW.autoCommitOnDone,
    autoPushEveryCommits:
      typeof frontMatter.auto_push_every_commits === "number"
        ? frontMatter.auto_push_every_commits
        : DEFAULT_WORKFLOW.autoPushEveryCommits,
    taskFailureRetryLimit:
      typeof frontMatter.task_failure_retry_limit === "number"
        ? frontMatter.task_failure_retry_limit
        : DEFAULT_WORKFLOW.taskFailureRetryLimit,
    taskFailureBackoffSeconds:
      typeof frontMatter.task_failure_backoff_seconds === "number"
        ? frontMatter.task_failure_backoff_seconds
        : DEFAULT_WORKFLOW.taskFailureBackoffSeconds,
    runtimeStallTimeoutSeconds:
      typeof frontMatter.runtime_stall_timeout_seconds === "number"
        ? frontMatter.runtime_stall_timeout_seconds
        : DEFAULT_WORKFLOW.runtimeStallTimeoutSeconds,
    workflowBody,
    workflowPath,
  };
}

function normalizeStatus(rawStatus: string | null): TaskStatus {
  const normalized = (rawStatus ?? "pending").trim().toLowerCase() as TaskStatus;
  return STATUS_VALUES.has(normalized) ? normalized : "pending";
}

function normalizePriority(rawPriority: string | null): TaskPriority {
  if (!rawPriority) {
    return "unscored";
  }
  const normalized = rawPriority.trim().toUpperCase();
  return /^P\d+$/.test(normalized) ? (normalized as TaskPriority) : "unscored";
}

function parseDependsOn(rawDependsOn: string | null): string[] {
  if (!rawDependsOn) {
    return [];
  }
  const cleaned = rawDependsOn.replace(/`/g, "").trim();
  if (!cleaned || /^none$/i.test(cleaned)) {
    return [];
  }
  return cleaned
    .split(",")
    .map((dependency) => dependency.trim())
    .filter(Boolean);
}

export function parseTaskFile(content: string, filePath: string): Task[] {
  const lines = content.split(/\r?\n/);
  const tasks: Task[] = [];
  let currentHeading: { title: string; level: number; lineIndex: number } | null = null;

  const flushTask = (endIndex: number) => {
    if (!currentHeading) {
      return;
    }

    const sectionLines = lines.slice(currentHeading.lineIndex + 1, endIndex);
    const sectionBody = sectionLines.join("\n").trim();
    const idMatch = sectionBody.match(/-\s+\*\*ID\*\*:\s+`([^`]+)`/);

    if (idMatch) {
      const statusMatch = sectionBody.match(/-\s+\*\*Status\*\*:\s+`?([^`\n]+)`?/);
      const priorityMatch = sectionBody.match(/-\s+\*\*Priority\*\*:\s+`?([^`\n]+)`?/);
      const dependsOnMatch = sectionBody.match(/-\s+\*\*Depends on\*\*:\s+([^\n]+)/);

      tasks.push({
        id: idMatch[1].trim(),
        title: currentHeading.title,
        status: normalizeStatus(statusMatch?.[1] ?? null),
        priority: normalizePriority(priorityMatch?.[1] ?? null),
        dependsOn: parseDependsOn(dependsOnMatch?.[1] ?? null),
        filePath,
        heading: currentHeading.title,
        headingLevel: currentHeading.level,
        sectionBody,
        order: tasks.length,
        sortIndex: tasks.length,
      });
    }

    currentHeading = null;
  };

  lines.forEach((line, index) => {
    const headingMatch = line.match(/^(#{3,4})\s+(.+)$/);
    if (!headingMatch) {
      return;
    }

    flushTask(index);
    currentHeading = {
      title: headingMatch[2].trim(),
      level: headingMatch[1].length,
      lineIndex: index,
    };
  });

  flushTask(lines.length);
  return tasks;
}

export function resolvePath(repoRoot: string, maybeRelativePath: string): string {
  return isAbsolute(maybeRelativePath) ? maybeRelativePath : resolve(repoRoot, maybeRelativePath);
}

export function loadTasks(repoRoot: string, taskSources: string[]): Task[] {
  let nextSortIndex = 0;

  return taskSources.flatMap((taskSource) => {
    const absolutePath = resolvePath(repoRoot, taskSource);
    const content = readFileSync(absolutePath, "utf8");
    return parseTaskFile(content, taskSource).map((task) => ({
      ...task,
      sortIndex: nextSortIndex++,
    }));
  });
}

export function mergeTaskUniverses(...taskLists: Task[][]): Task[] {
  const seen = new Set<string>();
  const merged: Task[] = [];

  for (const taskList of taskLists) {
    for (const task of taskList) {
      if (seen.has(task.id)) {
        continue;
      }
      seen.add(task.id);
      merged.push(task);
    }
  }

  return merged;
}

function priorityRank(priority: TaskPriority): number {
  return priority === "unscored" ? 999 : Number(priority.slice(1));
}

function isReady(task: Task, taskMap: Map<string, Task>): boolean {
  return task.dependsOn.every((dependencyId) => taskMap.get(dependencyId)?.status === "done");
}

export function selectNextTask(
  tasks: Task[],
  activeTaskId: string | null,
  dependencyUniverse: Task[] = tasks,
): Task | null {
  const taskMap = new Map(dependencyUniverse.map((task) => [task.id, task]));

  if (activeTaskId) {
    const activeTask = tasks.find((task) => task.id === activeTaskId);
    if (activeTask && activeTask.status !== "done") {
      return activeTask;
    }
  }

  const inProgressTask = tasks.find((task) => task.status === "in-progress");
  if (inProgressTask) {
    return inProgressTask;
  }

  const readyTasks = tasks.filter((task) => task.status === "pending" && isReady(task, taskMap));
  readyTasks.sort((left, right) => {
    const priorityDifference = priorityRank(left.priority) - priorityRank(right.priority);
    return priorityDifference !== 0 ? priorityDifference : left.sortIndex - right.sortIndex;
  });

  return readyTasks[0] ?? null;
}

export function areAllTasksComplete(tasks: Task[]): boolean {
  return tasks.length > 0 && tasks.every((task) => task.status === "done");
}

export function loadWorkflow(repoRoot: string, workflowFile = "WORKFLOW.md"): WorkflowConfig {
  const workflowPath = resolvePath(repoRoot, workflowFile);
  const content = readFileSync(workflowPath, "utf8");
  return parseWorkflowFile(content, relative(repoRoot, workflowPath) || workflowFile);
}

export function ensureDirectory(path: string) {
  mkdirSync(path, { recursive: true });
}

export function loadState(repoRoot: string, config: WorkflowConfig): OrchestratorState {
  const statePath = resolvePath(repoRoot, config.stateFile);
  if (!existsSync(statePath)) {
    ensureDirectory(dirname(statePath));
    const initialState: OrchestratorState = {
      workflowPath: config.workflowPath,
      iteration: 0,
      activeTaskId: null,
      commitsSincePush: 0,
      lastCommittedTaskId: null,
      lastCommitSha: null,
      taskFailureCounts: {},
      taskRetryAfter: {},
      history: [],
    };
    writeFileSync(statePath, JSON.stringify(initialState, null, 2) + "\n");
    return initialState;
  }

  const state = JSON.parse(readFileSync(statePath, "utf8")) as OrchestratorState;
  return {
    workflowPath: state.workflowPath ?? config.workflowPath,
    iteration: state.iteration ?? 0,
    activeTaskId: state.activeTaskId ?? null,
    commitsSincePush: state.commitsSincePush ?? 0,
    lastCommittedTaskId: state.lastCommittedTaskId ?? null,
    lastCommitSha: state.lastCommitSha ?? null,
    taskFailureCounts:
      state.taskFailureCounts && typeof state.taskFailureCounts === "object"
        ? state.taskFailureCounts
        : {},
    taskRetryAfter:
      state.taskRetryAfter && typeof state.taskRetryAfter === "object"
        ? state.taskRetryAfter
        : {},
    history: Array.isArray(state.history) ? state.history : [],
  };
}

export function saveState(repoRoot: string, config: WorkflowConfig, state: OrchestratorState) {
  const statePath = resolvePath(repoRoot, config.stateFile);
  ensureDirectory(dirname(statePath));
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

export function appendProgress(repoRoot: string, config: WorkflowConfig, lines: string[]) {
  const progressPath = resolvePath(repoRoot, config.progressFile);
  ensureDirectory(dirname(progressPath));
  const existing = existsSync(progressPath)
    ? readFileSync(progressPath, "utf8")
    : `# ${config.name} Progress\n\n`;
  writeFileSync(progressPath, existing + lines.join("\n") + "\n");
}

export function getCurrentBranch(repoRoot: string): string | null {
  const result = runGit(["branch", "--show-current"], repoRoot);
  if (result.status !== 0) {
    return null;
  }

  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : null;
}

function sanitizeBranchName(taskId: string): string {
  return `orchestrator-${taskId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
}

function sanitizePathSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

export function previewWorkspacePath(repoRoot: string, config: WorkflowConfig, task: Task): string {
  if (config.workspaceMode === "shared") {
    return repoRoot;
  }
  return join(resolvePath(repoRoot, config.workspaceRoot), sanitizePathSegment(task.id));
}

export function ensureWorkspace(repoRoot: string, config: WorkflowConfig, task: Task): WorkspaceHandle {
  if (config.workspaceMode === "shared") {
    return { path: repoRoot, kind: "shared", branchName: getCurrentBranch(repoRoot) };
  }

  const workspacePath = previewWorkspacePath(repoRoot, config, task);
  const branchName = sanitizeBranchName(task.id);
  ensureDirectory(dirname(workspacePath));

  if (!existsSync(workspacePath)) {
    const baseRef = config.requiredBranch ?? "HEAD";
    const result = runGit(["worktree", "add", "-B", branchName, workspacePath, baseRef], repoRoot);
    if (result.status !== 0) {
      throw new Error(`Failed to create git worktree for ${task.id}: ${gitError(result, "git worktree add failed")}`);
    }
  }

  return { path: workspacePath, kind: "git_worktree", branchName };
}

export function buildTaskPrompt(config: WorkflowConfig, task: Task, workspacePath: string): string {
  const instructionList = config.instructionFiles.map((file) => `- ${file}`).join("\n");
  const workspaceNote = workspacePath === process.cwd() ? "shared repo workspace" : workspacePath;

  return [
    `Workflow: ${config.name}`,
    `Task ID: ${task.id}`,
    `Task Title: ${task.title}`,
    `Task File: ${task.filePath}`,
    `Task Priority: ${task.priority}`,
    `Workspace: ${workspaceNote}`,
    "",
    config.workflowBody,
    "",
    "Instruction files to read first:",
    instructionList,
    "",
    "Task section to implement:",
    `### ${task.heading}`,
    task.sectionBody,
    "",
    "Execution rules:",
    `1. Work only on the assigned task (${task.id}) and any strictly necessary dependencies inside the same repo.`,
    `2. Update the task status in ${task.filePath} to \`in-progress\` or \`done\` as appropriate.`,
    "3. Do not edit the orchestrator progress/state files directly; the orchestrator records runtime progress for you.",
    "4. Run the most relevant tests or validation commands for the files you changed when feasible.",
    `5. If the task is fully complete, say \`TASK_DONE ${task.id}\` in the final message.`,
    `6. If the task is blocked, say \`TASK_BLOCKED ${task.id}: <reason>\` in the final message.`,
    `7. If all tracked tasks are complete, say \`${config.completionPhrase}\` in the final message.`,
  ].join("\n");
}

export type AgentRunResult = {
  exitCode: number;
  lastMessage: string;
  commandLine: string;
  error: string | null;
};

export type RepoCommitResult = {
  committed: boolean;
  commitSha: string | null;
  error: string | null;
};

export type RepoPushResult = {
  pushed: boolean;
  error: string | null;
};

export type CherryPickResult = {
  applied: boolean;
  commitCount: number;
  lastCommitSha: string | null;
  error: string | null;
};

export function getHeadCommit(repoPath: string): string | null {
  const result = runGit(["rev-parse", "--short", "HEAD"], repoPath);
  if (result.status !== 0) {
    return null;
  }
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

export function listUniqueCommits(repoPath: string, baseRef: string): string[] {
  const cherryResult = runGit(["cherry", baseRef, "HEAD"], repoPath);
  if (cherryResult.status !== 0) {
    throw new Error(
      `Failed to inspect task branch commit equivalence: ${gitError(cherryResult, "git cherry failed")}`,
    );
  }

  const unapplied = new Set(
    cherryResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("+ "))
      .map((line) => line.slice(2).trim()),
  );

  if (unapplied.size === 0) {
    return [];
  }

  const revListResult = runGit(["rev-list", "--reverse", `${baseRef}..HEAD`], repoPath);
  if (revListResult.status !== 0) {
    throw new Error(
      `Failed to list task branch commits: ${gitError(revListResult, "git rev-list failed")}`,
    );
  }

  return revListResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((commit) => unapplied.has(commit));
}

export function commitPendingChanges(repoPath: string, message: string): RepoCommitResult {
  const addResult = runGit(["add", "-A"], repoPath);
  if (addResult.status !== 0) {
    return { committed: false, commitSha: null, error: gitError(addResult, "git add failed") };
  }

  let pendingChanges: string[];
  try {
    pendingChanges = getPendingChanges(repoPath);
  } catch (error) {
    return {
      committed: false,
      commitSha: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (pendingChanges.length === 0) {
    return { committed: false, commitSha: null, error: null };
  }

  const commitResult = runGit(["commit", "-m", message], repoPath);
  if (commitResult.status !== 0) {
    return { committed: false, commitSha: null, error: gitError(commitResult, "git commit failed") };
  }

  return {
    committed: true,
    commitSha: getHeadCommit(repoPath),
    error: null,
  };
}

export function getPendingChanges(repoPath: string): string[] {
  const statusResult = runGit(["status", "--porcelain"], repoPath);
  if (statusResult.status !== 0) {
    throw new Error(gitError(statusResult, "git status failed"));
  }

  return statusResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export function cherryPickCommits(repoRoot: string, commits: string[]): CherryPickResult {
  if (commits.length === 0) {
    return { applied: false, commitCount: 0, lastCommitSha: null, error: null };
  }

  let appliedCount = 0;
  let lastCommitSha: string | null = null;

  for (const commit of commits) {
    const cherryPickResult = runGit(["cherry-pick", "-x", commit], repoRoot);
    if (cherryPickResult.status !== 0) {
      const errorText = gitError(cherryPickResult, `git cherry-pick failed for ${commit}`);
      if (/previous cherry-pick is now empty|nothing to commit/i.test(errorText)) {
        runGit(["cherry-pick", "--skip"], repoRoot);
        continue;
      }
      runGit(["cherry-pick", "--abort"], repoRoot);
      return {
        applied: appliedCount > 0,
        commitCount: appliedCount,
        lastCommitSha,
        error: errorText,
      };
    }

    appliedCount += 1;
    lastCommitSha = getHeadCommit(repoRoot);
  }

  return {
    applied: appliedCount > 0,
    commitCount: appliedCount,
    lastCommitSha,
    error: null,
  };
}

export function pushBranch(repoRoot: string, branch: string): RepoPushResult {
  const pushResult = runGit(["push", "origin", branch], repoRoot);
  if (pushResult.status !== 0) {
    return { pushed: false, error: gitError(pushResult, `git push failed for ${branch}`) };
  }

  return { pushed: true, error: null };
}

export function runAgentForTask(
  repoRoot: string,
  config: WorkflowConfig,
  task: Task,
  workspacePath: string,
  prompt: string,
): AgentRunResult {
  const stateRoot = dirname(resolvePath(repoRoot, config.stateFile));
  ensureDirectory(stateRoot);
  const lastMessagePath = join(stateRoot, `${sanitizePathSegment(task.id)}-last-message.txt`);
  const args = [...config.agentArgs, "-C", workspacePath, "-o", lastMessagePath, "-"];

  const child = spawnSync(config.agentCommand, args, {
    cwd: repoRoot,
    input: prompt,
    stdio: ["pipe", "inherit", "inherit"],
    encoding: "utf8",
    env: {
      ...process.env,
      MAHILO_TASK_ID: task.id,
      MAHILO_TASK_FILE: task.filePath,
      MAHILO_WORKFLOW: config.name,
    },
  });

  return {
    exitCode: child.status ?? 1,
    lastMessage: existsSync(lastMessagePath) ? readFileSync(lastMessagePath, "utf8") : "",
    commandLine: [config.agentCommand, ...args].join(" "),
    error: child.error ? child.error.message : null,
  };
}

export function formatHistoryNote(
  taskId: string | null,
  status: OrchestratorState["history"][number]["status"],
  note: string,
) {
  return `- ${new Date().toISOString()} | ${taskId ?? "none"} | ${status} | ${note}`;
}
