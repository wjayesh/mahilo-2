import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  type WriteStream,
  writeFileSync,
} from "node:fs";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  DualSandboxBootstrapSummary,
} from "./dual-sandbox-bootstrap-lib";

export type DualSandboxProcessId = "mahilo" | "gateway_a" | "gateway_b";

type ReadinessMethod = "GET" | "HEAD";
type EnvMap = Record<string, string | undefined>;

export interface DualSandboxProcessLaunchSpec {
  args: string[];
  command: string;
  cwd: string;
  env: EnvMap;
}

export interface DualSandboxProcessLaunchOverride {
  args?: string[];
  command?: string;
  cwd?: string;
  env?: EnvMap;
}

export interface DualSandboxProcessPlanOptions {
  adminApiKey?: string;
  gatewayAEnv?: EnvMap;
  gatewayBEnv?: EnvMap;
  launchOverrides?: Partial<
    Record<DualSandboxProcessId, DualSandboxProcessLaunchOverride>
  >;
  mahiloEnv?: EnvMap;
  openClawCheckoutPath?: string;
}

export interface DualSandboxReadinessOptions {
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

export interface DualSandboxStartProcessOptions
  extends DualSandboxReadinessOptions {
  portAvailabilityTimeoutMs?: number;
  waitForReadiness?: boolean;
}

export interface DualSandboxStopOptions {
  killPollAttempts?: number;
  killPollIntervalMs?: number;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  waitForPortReleaseMs?: number;
}

export interface DualSandboxCleanupOptions extends DualSandboxStopOptions {
  removeRunRoot?: boolean;
}

export interface DualSandboxStartOptions
  extends DualSandboxProcessPlanOptions,
    DualSandboxStartProcessOptions,
    DualSandboxStopOptions {}

export interface DualSandboxProcessReadinessResult {
  attempt_count: number;
  checked_at: string;
  duration_ms: number;
  method: ReadinessMethod;
  process_id: DualSandboxProcessId;
  response_json: unknown | null;
  status_code: number;
  url: string;
}

export interface DualSandboxProcessStopResult {
  forced_kill: boolean;
  signal_sent: "SIGTERM" | "SIGKILL" | null;
  stopped_at: string;
}

export interface DualSandboxProcessPlanEntry {
  id: DualSandboxProcessId;
  label: string;
  launch: DualSandboxProcessLaunchSpec;
  log_path: string;
  port: number;
  readiness: {
    artifact_path: string;
    expected_json_status?: string;
    method: ReadinessMethod;
    url: string;
  };
}

export interface DualSandboxProcessPlan {
  gateway_a: DualSandboxProcessPlanEntry;
  gateway_b: DualSandboxProcessPlanEntry;
  mahilo: DualSandboxProcessPlanEntry;
}

export interface DualSandboxProcessHandles {
  gateway_a: DualSandboxManagedProcess;
  gateway_b: DualSandboxManagedProcess;
  mahilo: DualSandboxManagedProcess;
}

export interface DualSandboxReadinessSummary {
  gateway_a: DualSandboxProcessReadinessResult;
  gateway_b: DualSandboxProcessReadinessResult;
  mahilo: DualSandboxProcessReadinessResult;
}

export interface DualSandboxRuntimeController {
  bootstrap: DualSandboxBootstrapSummary;
  plan: DualSandboxProcessPlan;
  processes: DualSandboxProcessHandles;
  readiness: DualSandboxReadinessSummary;
  cleanup: (options?: DualSandboxCleanupOptions) => Promise<void>;
  stop: (
    options?: DualSandboxStopOptions,
  ) => Promise<Partial<Record<DualSandboxProcessId, DualSandboxProcessStopResult>>>;
}

interface ReadinessObservation {
  error?: string;
  responseJson?: unknown | null;
  statusCode?: number;
}

const DEFAULT_KILL_POLL_ATTEMPTS = 10;
const DEFAULT_KILL_POLL_INTERVAL_MS = 500;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_PORT_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_READINESS_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const LOOPBACK_HOST = "127.0.0.1";
const MAHILO_HEALTH_ARTIFACT_NAME = "mahilo-health.json";
const PROCESS_READINESS_ARTIFACT_NAME = "process-readiness.json";
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

export class DualSandboxManagedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly entry: DualSandboxProcessPlanEntry;
  readonly pid: number;

  exit_code: number | null = null;
  exit_signal: NodeJS.Signals | null = null;
  ready_at: string | null = null;
  readiness: DualSandboxProcessReadinessResult | null = null;
  spawn_error: string | null = null;
  stop_result: DualSandboxProcessStopResult | null = null;

  private readonly exitPromise: Promise<void>;
  private readonly logStream: WriteStream;

  constructor(
    entry: DualSandboxProcessPlanEntry,
    child: ChildProcessWithoutNullStreams,
    logStream: WriteStream,
  ) {
    const pid = child.pid;
    if (!pid) {
      throw new Error(
        `Failed to start ${entry.label}: child pid was unavailable.`,
      );
    }

    this.child = child;
    this.entry = entry;
    this.logStream = logStream;
    this.pid = pid;

    this.exitPromise = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        this.exit_code = code;
        this.exit_signal = signal;
        resolve();
      });
    });

    child.once("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.spawn_error = message;
      this.logStream.write(`[process-error] ${message}\n`);
    });
  }

  async stop(
    options: DualSandboxStopOptions = {},
  ): Promise<DualSandboxProcessStopResult> {
    return stopManagedProcess(this, options);
  }

  async waitForReadiness(
    options: DualSandboxReadinessOptions = {},
  ): Promise<DualSandboxProcessReadinessResult> {
    if (this.readiness) {
      return this.readiness;
    }

    const readiness = await waitForProcessReadinessInternal(
      this.entry,
      options,
      this,
    );
    this.readiness = readiness;
    this.ready_at = readiness.checked_at;
    return readiness;
  }

  async waitForExit(timeoutMs: number): Promise<void> {
    const sleepImpl = defaultSleep;
    const deadline = Date.now() + timeoutMs;

    while (isProcessAlive(this.pid) && Date.now() < deadline) {
      await sleepImpl(50);
    }

    if (!isProcessAlive(this.pid)) {
      await Promise.race([this.exitPromise, sleepImpl(50)]);
      return;
    }

    await Promise.race([this.exitPromise, sleepImpl(timeoutMs)]);
  }

  async closeLogs(): Promise<void> {
    if (this.logStream.destroyed) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.logStream.end(() => resolve());
    });
  }
}

export function createDualSandboxProcessPlan(
  bootstrap: DualSandboxBootstrapSummary,
  options: DualSandboxProcessPlanOptions = {},
): DualSandboxProcessPlan {
  const launchOverrides = options.launchOverrides ?? {};
  const needsDefaultGatewayCommand =
    usesDefaultLaunchCommand(launchOverrides.gateway_a) ||
    usesDefaultLaunchCommand(launchOverrides.gateway_b);
  const openClawCheckoutPath = needsDefaultGatewayCommand
    ? resolveOpenClawCheckoutPath(options.openClawCheckoutPath)
    : null;

  if (
    openClawCheckoutPath &&
    (usesDefaultLaunchCommand(launchOverrides.gateway_a) ||
      usesDefaultLaunchCommand(launchOverrides.gateway_b))
  ) {
    assertPluginBuildAvailable(bootstrap.proof_inputs.deterministic.plugin_path);
  }

  const mahiloLaunch = mergeLaunchSpec(
    buildDefaultMahiloLaunch(bootstrap, options),
    launchOverrides.mahilo,
  );
  const gatewayALaunch = mergeLaunchSpec(
    openClawCheckoutPath
      ? buildDefaultGatewayLaunch(
          bootstrap.sandboxes.a,
          openClawCheckoutPath,
          options.gatewayAEnv,
        )
      : emptyLaunchSpec(),
    launchOverrides.gateway_a,
  );
  const gatewayBLaunch = mergeLaunchSpec(
    openClawCheckoutPath
      ? buildDefaultGatewayLaunch(
          bootstrap.sandboxes.b,
          openClawCheckoutPath,
          options.gatewayBEnv,
        )
      : emptyLaunchSpec(),
    launchOverrides.gateway_b,
  );

  assertLaunchSpecComplete(mahiloLaunch, "Mahilo server");
  assertLaunchSpecComplete(gatewayALaunch, "OpenClaw gateway A");
  assertLaunchSpecComplete(gatewayBLaunch, "OpenClaw gateway B");

  return {
    mahilo: {
      id: "mahilo",
      label: "Mahilo server",
      launch: mahiloLaunch,
      log_path: bootstrap.mahilo.log_path,
      port: bootstrap.ports.mahilo,
      readiness: {
        artifact_path: join(
          bootstrap.paths.provisioning_dir,
          MAHILO_HEALTH_ARTIFACT_NAME,
        ),
        expected_json_status: "healthy",
        method: "GET",
        url: `${bootstrap.mahilo.base_url}/health`,
      },
    },
    gateway_a: {
      id: "gateway_a",
      label: "OpenClaw gateway A",
      launch: gatewayALaunch,
      log_path: bootstrap.sandboxes.a.gateway_log_path,
      port: bootstrap.sandboxes.a.gateway_port,
      readiness: {
        artifact_path: bootstrap.sandboxes.a.artifact_paths.webhook_head_path,
        method: "HEAD",
        url: bootstrap.sandboxes.a.callback_url,
      },
    },
    gateway_b: {
      id: "gateway_b",
      label: "OpenClaw gateway B",
      launch: gatewayBLaunch,
      log_path: bootstrap.sandboxes.b.gateway_log_path,
      port: bootstrap.sandboxes.b.gateway_port,
      readiness: {
        artifact_path: bootstrap.sandboxes.b.artifact_paths.webhook_head_path,
        method: "HEAD",
        url: bootstrap.sandboxes.b.callback_url,
      },
    },
  };
}

export async function startProcess(
  entry: DualSandboxProcessPlanEntry,
  options: DualSandboxStartProcessOptions & DualSandboxStopOptions = {},
): Promise<DualSandboxManagedProcess> {
  await waitForPortAvailable(
    entry.port,
    `${entry.label} port ${entry.port}`,
    {
      pollIntervalMs: options.pollIntervalMs,
      sleepImpl: options.sleepImpl,
      timeoutMs:
        options.portAvailabilityTimeoutMs ?? DEFAULT_PORT_WAIT_TIMEOUT_MS,
    },
  );

  mkdirSync(dirname(entry.log_path), {
    recursive: true,
  });

  const logStream = createWriteStream(entry.log_path, {
    flags: "a",
  });
  const child = spawn(entry.launch.command, entry.launch.args, {
    cwd: entry.launch.cwd,
    env: sanitizeEnv({
      ...process.env,
      ...entry.launch.env,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const processHandle = new DualSandboxManagedProcess(entry, child, logStream);

  child.stdout.pipe(logStream, {
    end: false,
  });
  child.stderr.pipe(logStream, {
    end: false,
  });

  if (options.waitForReadiness === false) {
    return processHandle;
  }

  try {
    await processHandle.waitForReadiness(options);
    return processHandle;
  } catch (error) {
    await processHandle.stop(options);
    throw error;
  }
}

export async function waitForProcessReadiness(
  entry: DualSandboxProcessPlanEntry,
  options: DualSandboxReadinessOptions = {},
): Promise<DualSandboxProcessReadinessResult> {
  return waitForProcessReadinessInternal(entry, options);
}

export async function waitForDualSandboxReadiness(
  bootstrap: DualSandboxBootstrapSummary,
  plan: DualSandboxProcessPlan,
  options: DualSandboxReadinessOptions = {},
): Promise<DualSandboxReadinessSummary> {
  const [mahilo, gatewayA, gatewayB] = await Promise.all([
    waitForProcessReadiness(plan.mahilo, options),
    waitForProcessReadiness(plan.gateway_a, options),
    waitForProcessReadiness(plan.gateway_b, options),
  ]);

  const readiness = {
    gateway_a: gatewayA,
    gateway_b: gatewayB,
    mahilo,
  } satisfies DualSandboxReadinessSummary;
  writeProcessReadinessSummary(bootstrap, readiness);

  return readiness;
}

export async function stopDualSandboxProcesses(
  processes: Partial<DualSandboxProcessHandles>,
  options: DualSandboxStopOptions = {},
): Promise<Partial<Record<DualSandboxProcessId, DualSandboxProcessStopResult>>> {
  const results: Partial<
    Record<DualSandboxProcessId, DualSandboxProcessStopResult>
  > = {};

  const stopOrder: Array<[DualSandboxProcessId, DualSandboxManagedProcess | undefined]> =
    [
      ["gateway_b", processes.gateway_b],
      ["gateway_a", processes.gateway_a],
      ["mahilo", processes.mahilo],
    ];

  for (const [id, processHandle] of stopOrder) {
    if (!processHandle) {
      continue;
    }

    results[id] = await processHandle.stop(options);
  }

  return results;
}

export async function startDualSandboxProcesses(
  bootstrap: DualSandboxBootstrapSummary,
  options: DualSandboxStartOptions = {},
): Promise<DualSandboxRuntimeController> {
  const plan = createDualSandboxProcessPlan(bootstrap, options);
  const started: Partial<DualSandboxProcessHandles> = {};

  try {
    started.mahilo = await startProcess(plan.mahilo, options);
    started.gateway_a = await startProcess(plan.gateway_a, options);
    started.gateway_b = await startProcess(plan.gateway_b, options);

    const processes = started as DualSandboxProcessHandles;
    const readiness = {
      gateway_a:
        processes.gateway_a.readiness ??
        (await processes.gateway_a.waitForReadiness(options)),
      gateway_b:
        processes.gateway_b.readiness ??
        (await processes.gateway_b.waitForReadiness(options)),
      mahilo:
        processes.mahilo.readiness ??
        (await processes.mahilo.waitForReadiness(options)),
    } satisfies DualSandboxReadinessSummary;
    writeProcessReadinessSummary(bootstrap, readiness);

    return {
      bootstrap,
      plan,
      processes,
      readiness,
      stop: async (stopOptions = {}) =>
        stopDualSandboxProcesses(processes, stopOptions),
      cleanup: async (cleanupOptions = {}) => {
        await stopDualSandboxProcesses(processes, cleanupOptions);
        if (cleanupOptions.removeRunRoot) {
          rmSync(bootstrap.run_root, {
            force: true,
            recursive: true,
          });
        }
      },
    };
  } catch (error) {
    await stopDualSandboxProcesses(started, options);
    throw error;
  }
}

function emptyLaunchSpec(): DualSandboxProcessLaunchSpec {
  return {
    args: [],
    command: "",
    cwd: "",
    env: {},
  };
}

function usesDefaultLaunchCommand(
  override: DualSandboxProcessLaunchOverride | undefined,
): boolean {
  return !override?.command && !override?.args && !override?.cwd;
}

function mergeLaunchSpec(
  base: DualSandboxProcessLaunchSpec,
  override: DualSandboxProcessLaunchOverride | undefined,
): DualSandboxProcessLaunchSpec {
  return {
    args: override?.args ?? base.args,
    command: override?.command ?? base.command,
    cwd: override?.cwd ?? base.cwd,
    env: {
      ...base.env,
      ...override?.env,
    },
  };
}

function assertLaunchSpecComplete(
  launch: DualSandboxProcessLaunchSpec,
  label: string,
): void {
  if (!launch.command) {
    throw new Error(
      `${label} launch command is missing. Pass a launch override or configure the default OpenClaw checkout path.`,
    );
  }

  if (!launch.cwd) {
    throw new Error(`${label} launch cwd is missing.`);
  }
}

function buildDefaultMahiloLaunch(
  bootstrap: DualSandboxBootstrapSummary,
  options: DualSandboxProcessPlanOptions,
): DualSandboxProcessLaunchSpec {
  return {
    args: ["run", "src/index.ts"],
    command: process.execPath,
    cwd: REPO_ROOT,
    env: {
      DATABASE_URL: bootstrap.mahilo.db_path,
      HOST: LOOPBACK_HOST,
      ...(options.adminApiKey
        ? {
            ADMIN_API_KEY: options.adminApiKey,
          }
        : {}),
      PORT: String(bootstrap.ports.mahilo),
      ...options.mahiloEnv,
    },
  };
}

function buildDefaultGatewayLaunch(
  sandbox: DualSandboxBootstrapSummary["sandboxes"]["a"],
  openClawCheckoutPath: string,
  extraEnv: EnvMap | undefined,
): DualSandboxProcessLaunchSpec {
  return {
    args: [
      "--dir",
      openClawCheckoutPath,
      "openclaw",
      "gateway",
      "run",
      "--port",
      String(sandbox.gateway_port),
      "--auth",
      "none",
      "--bind",
      "loopback",
      "--verbose",
    ],
    command: "pnpm",
    cwd: REPO_ROOT,
    env: {
      ...sandbox.env,
      ...extraEnv,
    },
  };
}

function resolveOpenClawCheckoutPath(
  explicitPath: string | undefined,
): string {
  const candidates = [
    explicitPath,
    process.env.MAHILO_OPENCLAW_CHECKOUT_PATH,
    process.env.OPENCLAW_CHECKOUT_PATH,
    resolve(REPO_ROOT, "../myclawd"),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const resolvedPath = resolve(candidate);
    if (existsSync(resolvedPath)) {
      return resolvedPath;
    }
  }

  throw new Error(
    "OpenClaw checkout path not found. Pass openClawCheckoutPath, set MAHILO_OPENCLAW_CHECKOUT_PATH, or override gateway launch commands.",
  );
}

function assertPluginBuildAvailable(pluginPath: string): void {
  const runtimeEntryPath = join(resolve(pluginPath), "dist", "index.js");
  if (existsSync(runtimeEntryPath)) {
    return;
  }

  throw new Error(
    `Built Mahilo plugin runtime not found at ${runtimeEntryPath}. Run \`bun run build\` in ${resolve(
      pluginPath,
    )} before starting gateways.`,
  );
}

async function waitForProcessReadinessInternal(
  entry: DualSandboxProcessPlanEntry,
  options: DualSandboxReadinessOptions,
  processHandle?: DualSandboxManagedProcess,
): Promise<DualSandboxProcessReadinessResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_READINESS_REQUEST_TIMEOUT_MS;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const startedAt = Date.now();
  let attemptCount = 0;
  let lastObservation: ReadinessObservation = {};

  while (Date.now() - startedAt <= timeoutMs) {
    if (processHandle && !isProcessAlive(processHandle.pid)) {
      await processHandle.waitForExit(pollIntervalMs);
      throw new Error(
        `${entry.label} exited before readiness passed (pid=${processHandle.pid}, code=${formatNullableNumber(
          processHandle.exit_code,
        )}, signal=${processHandle.exit_signal ?? "null"}${
          processHandle.spawn_error
            ? `, error=${processHandle.spawn_error}`
            : ""
        }). See ${entry.log_path}.`,
      );
    }

    attemptCount += 1;

    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        entry.readiness.url,
        {
          method: entry.readiness.method,
        },
        requestTimeoutMs,
      );
      const responseJson =
        entry.readiness.method === "HEAD"
          ? null
          : await readJsonResponse(response);

      lastObservation = {
        responseJson,
        statusCode: response.status,
      };

      if (isReadyResponse(entry, response.status, responseJson)) {
        const readiness: DualSandboxProcessReadinessResult = {
          attempt_count: attemptCount,
          checked_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          method: entry.readiness.method,
          process_id: entry.id,
          response_json: responseJson,
          status_code: response.status,
          url: entry.readiness.url,
        };

        writeJsonFile(entry.readiness.artifact_path, readiness);
        return readiness;
      }
    } catch (error) {
      lastObservation = {
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (Date.now() - startedAt >= timeoutMs) {
      break;
    }

    await sleepImpl(pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for ${entry.label} readiness at ${entry.readiness.url} after ${timeoutMs}ms. ${formatReadinessObservation(
      lastObservation,
    )} See ${entry.log_path}.`,
  );
}

function isReadyResponse(
  entry: DualSandboxProcessPlanEntry,
  statusCode: number,
  responseJson: unknown,
): boolean {
  if (statusCode < 200 || statusCode >= 300) {
    return false;
  }

  if (!entry.readiness.expected_json_status) {
    return true;
  }

  const status = readOptionalString((responseJson as Record<string, unknown>)?.status);
  return status === entry.readiness.expected_json_status;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response: Response): Promise<unknown | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function stopManagedProcess(
  processHandle: DualSandboxManagedProcess,
  options: DualSandboxStopOptions = {},
): Promise<DualSandboxProcessStopResult> {
  if (processHandle.stop_result) {
    return processHandle.stop_result;
  }

  const killPollAttempts =
    options.killPollAttempts ?? DEFAULT_KILL_POLL_ATTEMPTS;
  const killPollIntervalMs =
    options.killPollIntervalMs ?? DEFAULT_KILL_POLL_INTERVAL_MS;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const waitForPortReleaseMs =
    options.waitForPortReleaseMs ?? DEFAULT_PORT_WAIT_TIMEOUT_MS;
  let forcedKill = false;
  let signalSent: "SIGTERM" | "SIGKILL" | null = null;

  if (isProcessAlive(processHandle.pid)) {
    signalSent = "SIGTERM";
    try {
      process.kill(processHandle.pid, "SIGTERM");
    } catch {
      signalSent = null;
    }

    for (let attempt = 0; attempt < killPollAttempts; attempt += 1) {
      await sleepImpl(killPollIntervalMs);
      if (!isProcessAlive(processHandle.pid)) {
        break;
      }
    }

    if (isProcessAlive(processHandle.pid)) {
      forcedKill = true;
      signalSent = "SIGKILL";
      try {
        process.kill(processHandle.pid, "SIGKILL");
      } catch {
        signalSent = "SIGTERM";
      }
    }
  }

  await processHandle.waitForExit(waitForPortReleaseMs);
  await waitForPortAvailable(
    processHandle.entry.port,
    `${processHandle.entry.label} shutdown port ${processHandle.entry.port}`,
    {
      pollIntervalMs: killPollIntervalMs,
      sleepImpl,
      timeoutMs: waitForPortReleaseMs,
    },
  );
  await processHandle.closeLogs();

  const stopResult: DualSandboxProcessStopResult = {
    forced_kill: forcedKill,
    signal_sent: signalSent,
    stopped_at: new Date().toISOString(),
  };
  processHandle.stop_result = stopResult;
  return stopResult;
}

function writeProcessReadinessSummary(
  bootstrap: DualSandboxBootstrapSummary,
  readiness: DualSandboxReadinessSummary,
): void {
  writeJsonFile(
    join(bootstrap.paths.provisioning_dir, PROCESS_READINESS_ARTIFACT_NAME),
    {
      checked_at: new Date().toISOString(),
      ...readiness,
    },
  );
}

async function waitForPortAvailable(
  port: number,
  label: string,
  options: {
    pollIntervalMs?: number;
    sleepImpl?: (milliseconds: number) => Promise<void>;
    timeoutMs: number;
  },
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= options.timeoutMs) {
    if (await canBindPort(port)) {
      return;
    }

    if (Date.now() - startedAt >= options.timeoutMs) {
      break;
    }

    await sleepImpl(pollIntervalMs);
  }

  throw new Error(
    `${label} did not become available within ${options.timeoutMs}ms.`,
  );
}

async function canBindPort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolveResult) => {
    const server = createServer();
    let settled = false;

    server.once("error", () => {
      if (settled) {
        return;
      }

      settled = true;
      resolveResult(false);
    });

    server.listen(port, LOOPBACK_HOST, () => {
      server.close(() => {
        if (settled) {
          return;
        }

        settled = true;
        resolveResult(true);
      });
    });
  });
}

function sanitizeEnv(env: EnvMap): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), {
    recursive: true,
  });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function formatReadinessObservation(observation: ReadinessObservation): string {
  if (observation.error) {
    return `Last error: ${observation.error}.`;
  }

  if (observation.statusCode !== undefined) {
    const suffix =
      observation.responseJson !== undefined
        ? ` Response: ${JSON.stringify(observation.responseJson)}.`
        : "";
    return `Last status: ${observation.statusCode}.${suffix}`;
  }

  return "No readiness response was observed.";
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatNullableNumber(value: number | null): string {
  return value === null ? "null" : String(value);
}

async function defaultSleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
