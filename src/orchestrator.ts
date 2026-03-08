import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
};

export type OrchestratorState = {
  workflowPath: string;
  iteration: number;
  activeTaskId: string | null;
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
};

const STATUS_VALUES = new Set<TaskStatus>(["pending", "in-progress", "blocked", "review", "done"]);
const SNAPSHOT_EXCLUDES = new Set([".git", ".mahilo-orchestrator", "node_modules", "dist", "coverage"]);

function parseScalarValue(value: string): string | number {
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function syncDirectory(sourceDir: string, targetDir: string, excludes: Set<string>, deleteMissing: boolean) {
  ensureDirectory(targetDir);

  const sourceEntries = readdirSync(sourceDir, { withFileTypes: true }).filter((entry) => !excludes.has(entry.name));
  const sourceNames = new Set(sourceEntries.map((entry) => entry.name));

  if (deleteMissing) {
    const targetEntries = readdirSync(targetDir, { withFileTypes: true }).filter((entry) => !excludes.has(entry.name));
    for (const targetEntry of targetEntries) {
      if (!sourceNames.has(targetEntry.name)) {
        rmSync(join(targetDir, targetEntry.name), { recursive: true, force: true });
      }
    }
  }

  for (const entry of sourceEntries) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    const sourceIsDirectory = entry.isDirectory();
    const targetExists = existsSync(targetPath);

    if (sourceIsDirectory) {
      if (targetExists && !statSync(targetPath).isDirectory()) {
        rmSync(targetPath, { recursive: true, force: true });
      }
      syncDirectory(sourcePath, targetPath, excludes, deleteMissing);
      continue;
    }

    if (targetExists && statSync(targetPath).isDirectory()) {
      rmSync(targetPath, { recursive: true, force: true });
    }

    ensureDirectory(dirname(targetPath));
    copyFileSync(sourcePath, targetPath);
  }
}

function runGit(args: string[], cwd: string) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function syncRepoSnapshotToWorkspace(repoRoot: string, workspacePath: string) {
  syncDirectory(repoRoot, workspacePath, SNAPSHOT_EXCLUDES, true);
}

function syncWorkspaceChangesToRepo(repoRoot: string, workspacePath: string) {
  const statusResult = runGit(["status", "--porcelain", "-uall"], workspacePath);
  if (statusResult.status !== 0) {
    throw new Error(`Failed to inspect worktree changes: ${statusResult.stderr || statusResult.stdout}`);
  }

  for (const rawLine of statusResult.stdout.split(/\r?\n/)) {
    if (!rawLine.trim()) {
      continue;
    }

    const statusCode = rawLine.slice(0, 2);
    const payload = rawLine.slice(3).trim();

    if (payload.includes(" -> ")) {
      const [oldPath, newPath] = payload.split(" -> ").map((part) => part.trim());
      rmSync(join(repoRoot, oldPath), { recursive: true, force: true });
      const sourcePath = join(workspacePath, newPath);
      if (existsSync(sourcePath)) {
        ensureDirectory(dirname(join(repoRoot, newPath)));
        copyFileSync(sourcePath, join(repoRoot, newPath));
      }
      continue;
    }

    if (statusCode.includes("D")) {
      rmSync(join(repoRoot, payload), { recursive: true, force: true });
      continue;
    }

    const sourcePath = join(workspacePath, payload);
    if (!existsSync(sourcePath)) {
      continue;
    }
    ensureDirectory(dirname(join(repoRoot, payload)));
    copyFileSync(sourcePath, join(repoRoot, payload));
  }
}

export function parseWorkflowFile(content: string, workflowPath = "WORKFLOW.md"): WorkflowConfig {
  let frontMatter: Record<string, FrontMatterValue> = {};
  let workflowBody = content.trim();

  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end === -1) {
      throw new Error(`Workflow file ${workflowPath} starts a front matter block but never closes it.`);
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
          throw new Error(`Key ${currentKey} must be declared before adding list items in ${workflowPath}.`);
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
      typeof frontMatter.state_file === "string" ? frontMatter.state_file : DEFAULT_WORKFLOW.stateFile,
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
    agentArgs: Array.isArray(frontMatter.agent_args) ? frontMatter.agent_args : DEFAULT_WORKFLOW.agentArgs,
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
  const match = rawPriority.trim().match(/P\d+/i);
  return match ? (match[0].toUpperCase() as TaskPriority) : "unscored";
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

export function selectNextTask(tasks: Task[], activeTaskId: string | null, dependencyUniverse: Task[] = tasks): Task | null {
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
  const existing = existsSync(progressPath) ? readFileSync(progressPath, "utf8") : `# ${config.name} Progress\n\n`;
  writeFileSync(progressPath, existing + lines.join("\n") + "\n");
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
    return { path: repoRoot, kind: "shared" };
  }

  const workspacePath = previewWorkspacePath(repoRoot, config, task);
  ensureDirectory(dirname(workspacePath));

  if (!existsSync(workspacePath)) {
    const branchName = sanitizeBranchName(task.id);
    const result = spawnSync("git", ["worktree", "add", "-B", branchName, workspacePath, "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    if (result.status !== 0) {
      throw new Error(`Failed to create git worktree for ${task.id}: ${result.stderr || result.stdout}`);
    }
  }

  syncRepoSnapshotToWorkspace(repoRoot, workspacePath);
  return { path: workspacePath, kind: "git_worktree" };
}

export function reconcileWorkspace(repoRoot: string, workspace: WorkspaceHandle) {
  if (workspace.kind !== "git_worktree") {
    return;
  }
  syncWorkspaceChangesToRepo(repoRoot, workspace.path);
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
};

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
  };
}

export function formatHistoryNote(
  taskId: string | null,
  status: OrchestratorState["history"][number]["status"],
  note: string,
) {
  return `- ${new Date().toISOString()} | ${taskId ?? "none"} | ${status} | ${note}`;
}
