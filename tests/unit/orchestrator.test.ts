import { describe, expect, it } from "vitest";
import { mergeTaskUniverses, parseTaskFile, parseWorkflowFile, selectNextTask } from "../../src/orchestrator";

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
---
# Workflow\nBody here.\n`);

    expect(workflow.name).toBe("sample");
    expect(workflow.maxIterations).toBe(5);
    expect(workflow.taskSources).toEqual(["docs/a.md"]);
    expect(workflow.dependencySources).toEqual(["docs/b.md"]);
    expect(workflow.instructionFiles).toEqual(["CLAUDE.md"]);
    expect(workflow.workspaceMode).toBe("shared");
    expect(workflow.workflowBody).toContain("Body here");
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
