#!/usr/bin/env bun
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { loadWorkflow, resolvePath, type WorkflowConfig } from "../src/orchestrator";

type Command = "run" | "start" | "stop" | "restart" | "status";

type CliOptions = {
  command: Command;
  workflowFile: string;
  name: string | null;
  restartDelaySeconds: number;
  maxRestartDelaySeconds: number;
};

type SupervisorState = {
  name: string;
  workflowFile: string;
  workflowName: string;
  pid: number;
  childPid: number | null;
  phase: "starting" | "running" | "backoff" | "completed" | "stopped" | "error";
  startedAt: string;
  updatedAt: string;
  restartCount: number;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastRuntimePhase: string | null;
  lastHeartbeatAt: string | null;
  lastNote: string | null;
  lastError: string | null;
};

type RuntimeState = {
  pid?: number;
  phase?: string;
  iteration?: number;
  activeTaskId?: string | null;
  updatedAt?: string;
  lastHeartbeatAt?: string;
  lastNote?: string | null;
  lastError?: string | null;
  lastExitReason?: string | null;
};

function parseArgs(argv: string[]): CliOptions {
  const first = argv[0];
  const command: Command =
    first === "run" || first === "start" || first === "stop" || first === "restart" || first === "status"
      ? first
      : "status";

  const options: CliOptions = {
    command,
    workflowFile: "WORKFLOW.md",
    name: null,
    restartDelaySeconds: 15,
    maxRestartDelaySeconds: 300,
  };

  const args = command === first ? argv.slice(1) : argv;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workflow" && args[index + 1]) {
      options.workflowFile = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--name" && args[index + 1]) {
      options.name = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--restart-delay" && args[index + 1]) {
      options.restartDelaySeconds = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--max-restart-delay" && args[index + 1]) {
      options.maxRestartDelaySeconds = Number(args[index + 1]);
      index += 1;
    }
  }

  return options;
}

async function sleepMs(milliseconds: number) {
  if (milliseconds > 0) {
    await Bun.sleep(milliseconds);
  }
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function deriveName(workflow: WorkflowConfig, explicitName: string | null): string {
  if (explicitName) {
    return sanitizeName(explicitName);
  }
  const stateBase = basename(resolvePath(process.cwd(), workflow.stateFile)).replace(/\.json$/i, "");
  return sanitizeName(stateBase);
}

function ensureProcessDirectory(repoRoot: string): string {
  const dir = resolve(repoRoot, ".mahilo-orchestrator", "supervisor");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getPidPath(repoRoot: string, name: string): string {
  return join(ensureProcessDirectory(repoRoot), `${name}.pid`);
}

function getSupervisorStatePath(repoRoot: string, name: string): string {
  return join(ensureProcessDirectory(repoRoot), `${name}.json`);
}

function getSupervisorLogPath(repoRoot: string, name: string): string {
  return join(resolve(repoRoot, ".mahilo-orchestrator"), `${name}-loop.log`);
}

function getRuntimeStatePath(repoRoot: string, workflow: WorkflowConfig): string {
  const stateBase = basename(resolvePath(repoRoot, workflow.stateFile)).replace(/\.json$/i, "");
  const runtimeDir = resolve(repoRoot, ".mahilo-orchestrator", "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  return join(runtimeDir, `${stateBase}.runtime.json`);
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeSupervisorState(repoRoot: string, name: string, update: Partial<SupervisorState>) {
  const statePath = getSupervisorStatePath(repoRoot, name);
  const existing = readJsonFile<SupervisorState>(statePath);
  const now = new Date().toISOString();
  const nextState: SupervisorState = {
    name,
    workflowFile: update.workflowFile ?? existing?.workflowFile ?? "WORKFLOW.md",
    workflowName: update.workflowName ?? existing?.workflowName ?? name,
    pid: process.pid,
    childPid: update.childPid ?? existing?.childPid ?? null,
    phase: update.phase ?? existing?.phase ?? "starting",
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
    restartCount: update.restartCount ?? existing?.restartCount ?? 0,
    lastExitCode: update.lastExitCode ?? existing?.lastExitCode ?? null,
    lastExitSignal: update.lastExitSignal ?? existing?.lastExitSignal ?? null,
    lastRuntimePhase: update.lastRuntimePhase ?? existing?.lastRuntimePhase ?? null,
    lastHeartbeatAt: update.lastHeartbeatAt ?? existing?.lastHeartbeatAt ?? null,
    lastNote: update.lastNote ?? existing?.lastNote ?? null,
    lastError: update.lastError ?? existing?.lastError ?? null,
  };
  writeFileSync(statePath, JSON.stringify(nextState, null, 2) + "\n");
  return nextState;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcess(pid: number, label: string) {
  if (!isProcessAlive(pid)) {
    return false;
  }
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleepMs(500);
    if (!isProcessAlive(pid)) {
      return true;
    }
  }
  process.kill(pid, "SIGKILL");
  return true;
}

function uniquePids(...values: Array<number | null | undefined>) {
  return [...new Set(values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)))];
}

function readPidFile(pidPath: string): number | null {
  if (!existsSync(pidPath)) {
    return null;
  }
  const raw = readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) ? pid : null;
}

async function ensureNoRunningSupervisor(repoRoot: string, workflow: WorkflowConfig, name: string) {
  const pidPath = getPidPath(repoRoot, name);
  const existingPid = readPidFile(pidPath);
  if (existingPid && isProcessAlive(existingPid)) {
    throw new Error(`Supervisor ${name} is already running with pid ${existingPid}.`);
  }
  if (existingPid) {
    rmSync(pidPath, { force: true });
  }

  const supervisorState = readJsonFile<SupervisorState>(getSupervisorStatePath(repoRoot, name));
  const runtimeState = readRuntimeState(repoRoot, workflow);
  for (const orphanPid of uniquePids(supervisorState?.childPid, runtimeState?.pid)) {
    await terminateProcess(orphanPid, `orphaned ${name} child`);
  }
}

function readRuntimeState(repoRoot: string, workflow: WorkflowConfig): RuntimeState | null {
  return readJsonFile<RuntimeState>(getRuntimeStatePath(repoRoot, workflow));
}

function runtimeIsStale(runtime: RuntimeState | null, stallTimeoutSeconds: number): boolean {
  if (!runtime?.lastHeartbeatAt) {
    return false;
  }
  const heartbeatMs = Date.parse(runtime.lastHeartbeatAt);
  if (!Number.isFinite(heartbeatMs)) {
    return false;
  }
  return Date.now() - heartbeatMs > stallTimeoutSeconds * 1000;
}

function printStatus(repoRoot: string, workflow: WorkflowConfig, name: string) {
  const pidPath = getPidPath(repoRoot, name);
  const supervisorState = readJsonFile<SupervisorState>(getSupervisorStatePath(repoRoot, name));
  const runtimeState = readRuntimeState(repoRoot, workflow);
  const pid = readPidFile(pidPath);
  const running = pid ? isProcessAlive(pid) : false;

  const payload = {
    name,
    workflow: workflow.workflowPath,
    supervisorPid: pid,
    running,
    supervisorState,
    runtimeState,
  };

  console.log(JSON.stringify(payload, null, 2));
}

async function runSupervisor(repoRoot: string, workflow: WorkflowConfig, name: string, options: CliOptions) {
  await ensureNoRunningSupervisor(repoRoot, workflow, name);
  const pidPath = getPidPath(repoRoot, name);
  const logPath = getSupervisorLogPath(repoRoot, name);
  writeFileSync(pidPath, `${process.pid}\n`);
  writeSupervisorState(repoRoot, name, {
    workflowFile: workflow.workflowPath,
    workflowName: workflow.name,
    phase: "starting",
    lastNote: "Supervisor starting.",
    lastError: null,
    restartCount: 0,
    childPid: null,
  });

  let stopping = false;
  let childPid: number | null = null;

  const stopChild = () => {
    if (childPid && isProcessAlive(childPid)) {
      process.kill(childPid, "SIGTERM");
    }
  };

  const shutdown = (reason: string) => {
    stopping = true;
    stopChild();
    writeSupervisorState(repoRoot, name, {
      workflowFile: workflow.workflowPath,
      workflowName: workflow.name,
      phase: "stopped",
      childPid,
      lastNote: reason,
      lastError: null,
    });
  };

  process.on("SIGINT", () => {
    shutdown("signal:SIGINT");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown("signal:SIGTERM");
    process.exit(0);
  });

  let restartCount = 0;

  try {
    while (!stopping) {
      const logStream = createWriteStream(logPath, { flags: "a" });
      const child = spawn(
        process.execPath,
        ["run", "scripts/orchestrator.ts", "--workflow", workflow.workflowPath],
        {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            MAHILO_SUPERVISOR_NAME: name,
          },
        },
      );

      childPid = child.pid ?? null;
      writeSupervisorState(repoRoot, name, {
        workflowFile: workflow.workflowPath,
        workflowName: workflow.name,
        phase: "running",
        childPid,
        restartCount,
        lastNote: childPid ? `Child running with pid ${childPid}.` : "Child running.",
        lastError: null,
      });

      child.stdout?.pipe(logStream, { end: false });
      child.stderr?.pipe(logStream, { end: false });

      let childExited = false;
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      child.on("exit", (code, signal) => {
        childExited = true;
        exitCode = code;
        exitSignal = signal;
      });

      let staleReason: string | null = null;
      while (!childExited && !stopping) {
        await sleepMs(15_000);
        const runtime = readRuntimeState(repoRoot, workflow);
        writeSupervisorState(repoRoot, name, {
          workflowFile: workflow.workflowPath,
          workflowName: workflow.name,
          phase: "running",
          childPid,
          restartCount,
          lastRuntimePhase: runtime?.phase ?? null,
          lastHeartbeatAt: runtime?.lastHeartbeatAt ?? null,
          lastNote: runtime?.lastNote ?? "Waiting for child heartbeat.",
          lastError: runtime?.lastError ?? null,
        });
        if (!childExited && runtimeIsStale(runtime, workflow.runtimeStallTimeoutSeconds)) {
          staleReason = `Runtime heartbeat older than ${workflow.runtimeStallTimeoutSeconds}s.`;
          stopChild();
          await sleepMs(5_000);
          if (childPid && isProcessAlive(childPid)) {
            process.kill(childPid, "SIGKILL");
          }
        }
      }

      logStream.end();
      childPid = null;

      if (stopping) {
        break;
      }

      const runtime = readRuntimeState(repoRoot, workflow);
      if (exitCode === 0 && runtime?.phase === "completed") {
        writeSupervisorState(repoRoot, name, {
          workflowFile: workflow.workflowPath,
          workflowName: workflow.name,
          phase: "completed",
          childPid: null,
          restartCount,
          lastExitCode: exitCode,
          lastExitSignal: exitSignal,
          lastRuntimePhase: runtime.phase ?? null,
          lastHeartbeatAt: runtime.lastHeartbeatAt ?? null,
          lastNote: runtime.lastNote ?? workflow.completionPhrase,
          lastError: null,
        });
        break;
      }

      restartCount += 1;
      const backoffSeconds = Math.min(
        options.maxRestartDelaySeconds,
        options.restartDelaySeconds * 2 ** Math.max(0, restartCount - 1),
      );
      writeSupervisorState(repoRoot, name, {
        workflowFile: workflow.workflowPath,
        workflowName: workflow.name,
        phase: "backoff",
        childPid: null,
        restartCount,
        lastExitCode: exitCode,
        lastExitSignal: exitSignal,
        lastRuntimePhase: runtime?.phase ?? null,
        lastHeartbeatAt: runtime?.lastHeartbeatAt ?? null,
        lastNote: staleReason ?? `Child exited with code ${exitCode ?? "null"}. Restarting in ${backoffSeconds}s.`,
        lastError: staleReason ?? runtime?.lastError ?? null,
      });
      await sleepMs(backoffSeconds * 1000);
    }
  } finally {
    rmSync(pidPath, { force: true });
    if (!stopping) {
      writeSupervisorState(repoRoot, name, {
        workflowFile: workflow.workflowPath,
        workflowName: workflow.name,
        phase: "stopped",
        childPid: null,
        restartCount,
        lastNote: "Supervisor stopped.",
      });
    }
  }
}

async function startDetached(repoRoot: string, workflow: WorkflowConfig, name: string, options: CliOptions) {
  await ensureNoRunningSupervisor(repoRoot, workflow, name);
  const child = spawn(
    process.execPath,
    [
      "run",
      "scripts/orchestrator-supervisor.ts",
      "run",
      "--workflow",
      workflow.workflowPath,
      "--name",
      name,
      "--restart-delay",
      String(options.restartDelaySeconds),
      "--max-restart-delay",
      String(options.maxRestartDelaySeconds),
    ],
    {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  console.log(`Started supervisor ${name} for ${workflow.workflowPath}.`);
}

async function stopSupervisor(repoRoot: string, workflow: WorkflowConfig, name: string) {
  const pidPath = getPidPath(repoRoot, name);
  const pid = readPidFile(pidPath);
  const supervisorState = readJsonFile<SupervisorState>(getSupervisorStatePath(repoRoot, name));
  const runtimeState = readRuntimeState(repoRoot, workflow);
  if (pid && isProcessAlive(pid)) {
    await terminateProcess(pid, `supervisor ${name}`);
    rmSync(pidPath, { force: true });
    console.log(`Stopped supervisor ${name} (${pid}).`);
  } else {
    rmSync(pidPath, { force: true });
    console.log(`Supervisor ${name} is not running.`);
  }

  for (const orphanPid of uniquePids(supervisorState?.childPid, runtimeState?.pid)) {
    if (pid && orphanPid === pid) {
      continue;
    }
    await terminateProcess(orphanPid, `child ${name}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const workflow = loadWorkflow(repoRoot, options.workflowFile);
  const name = deriveName(workflow, options.name);

  switch (options.command) {
    case "run":
      await runSupervisor(repoRoot, workflow, name, options);
      break;
    case "start":
      await startDetached(repoRoot, workflow, name, options);
      break;
    case "stop":
      await stopSupervisor(repoRoot, workflow, name);
      break;
    case "restart":
      await stopSupervisor(repoRoot, workflow, name);
      await sleepMs(2_000);
      await startDetached(repoRoot, workflow, name, options);
      break;
    case "status":
      printStatus(repoRoot, workflow, name);
      break;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
