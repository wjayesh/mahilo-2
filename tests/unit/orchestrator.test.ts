import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildTaskPrompt,
  mergeTaskUniverses,
  parseTaskFile,
  parseWorkflowFile,
  loadWorkflow,
  runGit,
  selectNextTask,
} from "../../src/orchestrator";
import {
  WORKSPACE_CONTEXT_DIR,
  getWorkspaceContextInstructionFiles,
  syncWorkspaceContextFiles,
} from "../../scripts/orchestrator";

describe("parseWorkflowFile", () => {
  it("parses front matter arrays and scalars", () => {
    const workflow = parseWorkflowFile(`---
name: sample
max_iterations: 5
task_sources:
  - docs/a.md
dependency_sources:
  - docs/b.md
instruction_files:
  - CLAUDE.md
workspace_mode: shared
auto_commit_on_done: true
auto_push_every_commits: 5
required_branch: autonomous/server-integration
task_failure_retry_limit: 4
task_failure_backoff_seconds: 45
runtime_stall_timeout_seconds: 1200
---
# Workflow\nBody here.\n`);

    expect(workflow.name).toBe("sample");
    expect(workflow.maxIterations).toBe(5);
    expect(workflow.taskSources).toEqual(["docs/a.md"]);
    expect(workflow.dependencySources).toEqual(["docs/b.md"]);
    expect(workflow.instructionFiles).toEqual(["CLAUDE.md"]);
    expect(workflow.workspaceMode).toBe("shared");
    expect(workflow.autoCommitOnDone).toBe(true);
    expect(workflow.autoPushEveryCommits).toBe(5);
    expect(workflow.requiredBranch).toBe("autonomous/server-integration");
    expect(workflow.taskFailureRetryLimit).toBe(4);
    expect(workflow.taskFailureBackoffSeconds).toBe(45);
    expect(workflow.runtimeStallTimeoutSeconds).toBe(1200);
    expect(workflow.workflowBody).toContain("Body here");
  });

  it("pins required_branch: current to the branch active at workflow load time", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mahilo-orchestrator-"));

    try {
      writeFileSync(
        join(repoRoot, "WORKFLOW.md"),
        `---
name: sample
required_branch: current
---
# Workflow
Body here.
`,
      );

      expect(runGit(["init"], repoRoot).status).toBe(0);
      expect(runGit(["checkout", "-b", "feature/orchestrator-branch-pin"], repoRoot).status).toBe(0);

      const workflow = loadWorkflow(repoRoot, "WORKFLOW.md");
      expect(workflow.requiredBranch).toBe("feature/orchestrator-branch-pin");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("task parsing and selection", () => {
  const taskDoc = `## Phase 0

### 0.1 First Task
- **ID**: \`TASK-001\`
- **Status**: \`pending\`
- **Priority**: P0
- **Depends on**: None

### 0.2 Second Task
- **ID**: \`TASK-002\`
- **Status**: \`pending\`
- **Priority**: P0
- **Depends on**: TASK-001

### 0.3 Third Task
- **ID**: \`TASK-003\`
- **Status**: \`in-progress\`
- **Priority**: P1
- **Depends on**: None
`;

  it("parses task metadata", () => {
    const tasks = parseTaskFile(taskDoc, "docs/sample.md");
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({
      id: "TASK-001",
      status: "pending",
      priority: "P0",
      dependsOn: [],
      filePath: "docs/sample.md",
    });
    expect(tasks[1].dependsOn).toEqual(["TASK-001"]);
  });

  it("prefers the active or in-progress task", () => {
    const tasks = parseTaskFile(taskDoc, "docs/sample.md");
    expect(selectNextTask(tasks, null)?.id).toBe("TASK-003");
    expect(selectNextTask(tasks, "TASK-001")?.id).toBe("TASK-001");
  });

  it("selects the next ready pending task when nothing is active", () => {
    const tasks = parseTaskFile(
      taskDoc.replace("- **Status**: `in-progress`", "- **Status**: `done`"),
      "docs/sample.md",
    );
    expect(selectNextTask(tasks, null)?.id).toBe("TASK-001");
  });

  it("uses dependency sources to unlock cross-doc tasks", () => {
    const pluginTasks = parseTaskFile(`### Plugin Task\n- **ID**: \`PLG-001\`\n- **Status**: \`pending\`\n- **Priority**: P0\n- **Depends on**: SRV-001\n`, "docs/plugin.md");
    const serverTasks = parseTaskFile(`### Server Task\n- **ID**: \`SRV-001\`\n- **Status**: \`done\`\n- **Priority**: P0\n- **Depends on**: None\n`, "docs/server.md");
    const universe = mergeTaskUniverses(pluginTasks, serverTasks);
    expect(selectNextTask(pluginTasks, null, universe)?.id).toBe("PLG-001");
  });
});

describe("workspace context sync", () => {
  it("uses mirrored instruction file paths when a workspace override is provided", () => {
    const workflow = parseWorkflowFile(`---
name: sample
instruction_files:
  - docs/context.md
---
# Workflow
Body here.
`);
    const [task] = parseTaskFile(
      `### Example Task
- **ID**: \`TASK-001\`
- **Status**: \`pending\`
- **Priority**: P0
- **Depends on**: None
`,
      "docs/tasks.md",
    );

    const prompt = buildTaskPrompt(workflow, task, "/tmp/mahilo-workspace", [
      `${WORKSPACE_CONTEXT_DIR}/docs/context.md`,
    ]);

    expect(prompt).toContain(`- ${WORKSPACE_CONTEXT_DIR}/docs/context.md`);
    expect(prompt).toContain("Instruction files to read first from the assigned workspace:");
  });

  it("mirrors workflow docs into ignored workspace context files and picks up newly added docs", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mahilo-orchestrator-context-"));

    try {
      mkdirSync(join(repoRoot, "docs"), { recursive: true });
      writeFileSync(
        join(repoRoot, "WORKFLOW.md"),
        `---
name: sample
task_sources:
  - docs/tasks.md
instruction_files:
  - docs/context.md
---
# Workflow
Body here.
`,
      );
      writeFileSync(
        join(repoRoot, "docs", "tasks.md"),
        `### Example Task
- **ID**: \`TASK-001\`
- **Status**: \`pending\`
- **Priority**: P0
- **Depends on**: None
`,
      );
      writeFileSync(join(repoRoot, "docs", "context.md"), "alpha\n");

      expect(runGit(["init"], repoRoot).status).toBe(0);

      const workflow = loadWorkflow(repoRoot, "WORKFLOW.md");
      syncWorkspaceContextFiles(repoRoot, workflow, repoRoot);

      const mirroredContextPath = join(repoRoot, WORKSPACE_CONTEXT_DIR, "docs", "context.md");
      expect(readFileSync(mirroredContextPath, "utf8")).toBe("alpha\n");
      expect(getWorkspaceContextInstructionFiles(repoRoot, workflow)).toEqual([
        `${WORKSPACE_CONTEXT_DIR}/docs/context.md`,
      ]);

      const excludePath = resolve(
        repoRoot,
        runGit(["rev-parse", "--git-path", "info/exclude"], repoRoot).stdout.trim(),
      );
      expect(readFileSync(excludePath, "utf8")).toContain(`${WORKSPACE_CONTEXT_DIR}/`);

      writeFileSync(
        join(repoRoot, "WORKFLOW.md"),
        `---
name: sample
task_sources:
  - docs/tasks.md
  - docs/new-tasks.md
dependency_sources:
  - docs/shared.md
instruction_files:
  - docs/context.md
  - docs/new-context.md
---
# Workflow
Body here.
`,
      );
      writeFileSync(join(repoRoot, "docs", "context.md"), "beta\n");
      writeFileSync(join(repoRoot, "docs", "new-context.md"), "gamma\n");
      writeFileSync(
        join(repoRoot, "docs", "new-tasks.md"),
        `### New Task
- **ID**: \`TASK-002\`
- **Status**: \`pending\`
- **Priority**: P1
- **Depends on**: None
`,
      );
      writeFileSync(join(repoRoot, "docs", "shared.md"), "shared\n");

      const refreshedWorkflow = loadWorkflow(repoRoot, "WORKFLOW.md");
      syncWorkspaceContextFiles(repoRoot, refreshedWorkflow, repoRoot);

      expect(readFileSync(mirroredContextPath, "utf8")).toBe("beta\n");
      expect(
        existsSync(join(repoRoot, WORKSPACE_CONTEXT_DIR, "docs", "new-context.md")),
      ).toBe(true);
      expect(existsSync(join(repoRoot, WORKSPACE_CONTEXT_DIR, "docs", "new-tasks.md"))).toBe(
        true,
      );
      expect(existsSync(join(repoRoot, WORKSPACE_CONTEXT_DIR, "docs", "shared.md"))).toBe(true);
      expect(getWorkspaceContextInstructionFiles(repoRoot, refreshedWorkflow)).toEqual([
        `${WORKSPACE_CONTEXT_DIR}/docs/context.md`,
        `${WORKSPACE_CONTEXT_DIR}/docs/new-context.md`,
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
