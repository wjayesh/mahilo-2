#!/usr/bin/env bun
import { relative, resolve } from "node:path";
import {
  appendProgress,
  areAllTasksComplete,
  buildTaskPrompt,
  ensureWorkspace,
  formatHistoryNote,
  loadState,
  loadTasks,
  loadWorkflow,
  mergeTaskUniverses,
  previewWorkspacePath,
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

  for (let attempt = 0; attempt < maxIterations; attempt += 1) {
    const actionableTasks = loadTasks(repoRoot, workflow.taskSources);
    const dependencyTasks = loadTasks(repoRoot, workflow.dependencySources);
    const taskUniverse = mergeTaskUniverses(actionableTasks, dependencyTasks);

    if (areAllTasksComplete(actionableTasks)) {
      appendProgress(repoRoot, workflow, [formatHistoryNote(null, "completed", "All tracked tasks are complete.")]);
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
        formatHistoryNote(null, "idle", `No ready tasks found. Remaining tasks: ${blockedOrWaiting || "none"}`),
      ]);
      saveState(repoRoot, workflow, state);
      console.log("No ready tasks found. Waiting for dependencies or review states to clear.");
      return;
    }

    const workspace = options.dryRun
      ? { path: previewWorkspacePath(repoRoot, workflow, task), kind: workflow.workspaceMode === "shared" ? "shared" : "git_worktree" as const }
      : ensureWorkspace(repoRoot, workflow, task);
    const prompt = buildTaskPrompt(workflow, task, workspace.path);
    const taskWasActive = state.activeTaskId === task.id;
    state.activeTaskId = task.id;
    appendProgress(repoRoot, workflow, [
      `## Iteration ${state.iteration}`,
      formatHistoryNote(task.id, taskWasActive ? "continued" : "started", `Dispatching ${task.id} from ${task.filePath} in ${relative(repoRoot, resolve(workspace.path)) || "."} (${workspace.kind}).`),
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
    reconcileWorkspace(repoRoot, workspace);
    const refreshedActionableTasks = loadTasks(repoRoot, workflow.taskSources);
    const refreshedTask = refreshedActionableTasks.find((candidate) => candidate.id === task.id);

    let historyStatus: "completed" | "blocked" | "agent_error" | "continued" = "continued";
    let historyNote = `Agent exited with code ${runResult.exitCode}.`;

    if (runResult.exitCode !== 0) {
      historyStatus = "agent_error";
      historyNote = `Agent command failed: ${runResult.commandLine}`;
    } else if (refreshedTask?.status === "done" || runResult.lastMessage.includes(`TASK_DONE ${task.id}`)) {
      historyStatus = "completed";
      historyNote = `${task.id} completed.`;
      state.activeTaskId = null;
    } else if (refreshedTask?.status === "blocked" || runResult.lastMessage.includes(`TASK_BLOCKED ${task.id}`)) {
      historyStatus = "blocked";
      historyNote = runResult.lastMessage.split("\n").find((line) => line.includes(`TASK_BLOCKED ${task.id}`)) ?? `${task.id} blocked.`;
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

    if (runResult.lastMessage.includes(workflow.completionPhrase) || areAllTasksComplete(refreshedActionableTasks)) {
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
