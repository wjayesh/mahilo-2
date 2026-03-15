#!/usr/bin/env bun
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ScenarioStatus = "passed" | "failed";
type OptionalStatus = "passed" | "failed" | "skipped";

interface HarnessOptions {
  adminApiKey: string;
  agentModel?: string;
  authProfilesPath?: string;
  gatewayAPort: number;
  gatewayBPort: number;
  keepProcesses: boolean;
  mahiloPort: number;
  openclawDir: string;
  pluginDir: string;
  rootPath?: string;
}

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  label: string;
  logPath: string;
}

interface CreatedUser {
  api_key: string;
  user_id: string;
  username: string;
}

interface AgentConnection {
  callback_secret?: string | null;
  callback_url?: string | null;
  id?: string | null;
  label?: string | null;
  status?: string | null;
}

interface ToolInvokeResponse {
  raw: string;
  parsed: unknown;
}

interface ScenarioResult {
  evidence: string[];
  expected: string;
  message: string;
  notes: string[];
  status: ScenarioStatus;
}

interface OptionalAgentTurnResult {
  evidence: string[];
  model: string | null;
  notes: string[];
  receiverDelivered: boolean | null;
  status: OptionalStatus;
  toolCallDetected: boolean | null;
}

interface HarnessSummary {
  root: string;
  baseUrl: string;
  ports: {
    gateway_a: number;
    gateway_b: number;
    mahilo: number;
  };
  users: {
    receiver: {
      connection_id: string;
      username: string;
    };
    sender: {
      connection_id: string;
      username: string;
    };
  };
  pluginChecks: {
    gateway_a: {
      pluginListed: boolean;
      webhookReachable: boolean;
    };
    gateway_b: {
      pluginListed: boolean;
      webhookReachable: boolean;
    };
  };
  deterministic: {
    allow: ScenarioResult;
    ask: ScenarioResult;
    deny: ScenarioResult;
    missing_llm: ScenarioResult;
  };
  agent_turn: OptionalAgentTurnResult;
  artifacts: {
    logs: {
      gateway_a: string;
      gateway_b: string;
      mahilo: string;
    };
    receiverSessionsDir: string;
    senderSessionsDir: string;
    summaryPath: string;
  };
}

interface GatewayPaths {
  configPath: string;
  homePath: string;
  runtimeStatePath: string;
  sessionsDir: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_OPENCLAW_DIR = "/Users/wjayesh/apps/myclawd";
const DEFAULT_AGENT_AUTH_PROFILES = resolve(
  homedir(),
  ".openclaw",
  "agents",
  "main",
  "agent",
  "auth-profiles.json",
);
const DEFAULT_ROOT_PREFIX = "mahilo-dual-openclaw-harness-";
const OPENCLAW_PLUGIN_MANIFEST_ID = "openclaw-mahilo";

function parseArgs(argv: string[]): HarnessOptions {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) continue;
    if (current === "--help" || current === "-h") {
      printHelpAndExit(0);
    }
    if (current === "--keep-processes") {
      values.set("keep-processes", "true");
      continue;
    }
    if (!current.startsWith("--")) {
      throw new Error(`Unexpected argument: ${current}`);
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${current}`);
    }
    values.set(current.slice(2), next);
    index += 1;
  }

  return {
    adminApiKey: readOptionalString(values, "admin-api-key") ?? "mahilo-admin-test",
    agentModel: readOptionalString(values, "agent-model"),
    authProfilesPath: readOptionalPath(values, "auth-profiles"),
    gatewayAPort: parsePort(values.get("gateway-a-port"), 19123, "--gateway-a-port"),
    gatewayBPort: parsePort(values.get("gateway-b-port"), 19124, "--gateway-b-port"),
    keepProcesses: values.get("keep-processes") === "true",
    mahiloPort: parsePort(values.get("mahilo-port"), 18080, "--mahilo-port"),
    openclawDir: readOptionalPath(values, "openclaw-dir") ?? DEFAULT_OPENCLAW_DIR,
    pluginDir: readOptionalPath(values, "plugin-dir") ?? resolve(REPO_ROOT, "plugins", "openclaw-mahilo"),
    rootPath: readOptionalPath(values, "root"),
  };
}

function printHelpAndExit(code: number): never {
  console.log(
    [
      "Usage:",
      "  bun run plugins/openclaw-mahilo/scripts/dual-openclaw-harness.ts \\",
      "    [--root /tmp/mahilo-dual-openclaw-run] \\",
      "    [--plugin-dir /Users/wjayesh/apps/mahilo-2/plugins/openclaw-mahilo] \\",
      "    [--openclaw-dir /Users/wjayesh/apps/myclawd] \\",
      "    [--mahilo-port 18080] \\",
      "    [--gateway-a-port 19123] \\",
      "    [--gateway-b-port 19124] \\",
      "    [--admin-api-key mahilo-admin-test] \\",
      "    [--agent-model anthropic/claude-opus-4-6] \\",
      "    [--auth-profiles /Users/wjayesh/.openclaw/agents/main/agent/auth-profiles.json] \\",
      "    [--keep-processes]",
      "",
      "This is the minimal end-to-end Mahilo/OpenClaw harness:",
      "- builds the local Mahilo plugin",
      "- starts one Mahilo server and two OpenClaw gateways",
      "- creates two Mahilo users via the admin API",
      "- lets each gateway auto-attach its default sender on startup",
      "- friends the two users",
      "- runs allow / ask / deny / missing-local-LLM send checks",
      "- optionally runs one prompt-driven agent turn when --agent-model is provided",
      "- writes one summary JSON under the run root",
    ].join("\n"),
  );
  process.exit(code);
}

function readOptionalString(values: Map<string, string>, key: string): string | undefined {
  const value = values.get(key)?.trim();
  return value ? value : undefined;
}

function readOptionalPath(values: Map<string, string>, key: string): string | undefined {
  const value = readOptionalString(values, key);
  return value ? resolve(value) : undefined;
}

function parsePort(rawValue: string | undefined, fallback: number, flagName: string): number {
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${flagName} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function ensureFreshRoot(rootPath?: string): string {
  if (!rootPath) {
    return mkdtempSync(join(tmpdir(), DEFAULT_ROOT_PREFIX));
  }
  const resolvedRoot = resolve(rootPath);
  if (existsSync(resolvedRoot)) {
    throw new Error(`Refusing to reuse existing run root ${resolvedRoot}. Pass a fresh path instead.`);
  }
  mkdirSync(dirname(resolvedRoot), { recursive: true });
  mkdirSync(resolvedRoot, { recursive: false });
  return resolvedRoot;
}

async function sleep(milliseconds: number): Promise<void> {
  await Bun.sleep(milliseconds);
}

async function readResponseBody(response: Response): Promise<string> {
  const text = await response.text();
  return text;
}

async function requestJson<T>(
  url: string,
  options: {
    bearer?: string;
    body?: unknown;
    headers?: Record<string, string>;
    method?: "GET" | "POST" | "PATCH" | "DELETE" | "HEAD";
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (options.bearer) {
    headers.set("authorization", `Bearer ${options.bearer}`);
  }
  const response = await fetch(url, {
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    headers,
    method: options.method ?? "GET",
    signal: options.signal,
  });

  const raw = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} failed with ${response.status}: ${raw}`);
  }

  if (raw.trim().length === 0) {
    return {} as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${url}: ${error instanceof Error ? error.message : String(error)}\n${raw}`);
  }
}

async function requestText(
  url: string,
  options: {
    bearer?: string;
    body?: unknown;
    headers?: Record<string, string>;
    method?: "GET" | "POST" | "PATCH" | "DELETE" | "HEAD";
  } = {},
): Promise<string> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (options.bearer) {
    headers.set("authorization", `Bearer ${options.bearer}`);
  }
  const response = await fetch(url, {
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    headers,
    method: options.method ?? "GET",
  });
  const raw = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} failed with ${response.status}: ${raw}`);
  }
  return raw;
}

async function waitForHttp(
  url: string,
  options: {
    expectedStatus?: number;
    method?: "GET" | "HEAD";
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: options.method ?? "GET" });
      if (response.status === (options.expectedStatus ?? 200)) {
        return;
      }
    } catch {}
    await sleep(500);
  }

  throw new Error(`Timed out waiting for ${options.method ?? "GET"} ${url}`);
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if ((code ?? 1) !== 0) {
        rejectPromise(
          new Error(
            `${command} ${args.join(" ")} exited with code ${code ?? 1}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }
      resolvePromise({
        code: code ?? 0,
        stderr,
        stdout,
      });
    });
  });
}

function spawnLoggedProcess(
  label: string,
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
    logPath: string;
  },
): ManagedProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logHeader = `\n=== ${label} ${new Date().toISOString()} ===\n$ ${command} ${args.join(" ")}\n`;
  writeFileSync(options.logPath, logHeader, { flag: "a" });

  child.stdout.on("data", (chunk) => {
    writeFileSync(options.logPath, chunk.toString(), { flag: "a" });
  });
  child.stderr.on("data", (chunk) => {
    writeFileSync(options.logPath, chunk.toString(), { flag: "a" });
  });

  return {
    child,
    label,
    logPath: options.logPath,
  };
}

async function stopProcess(processRef: ManagedProcess): Promise<void> {
  if (processRef.child.exitCode !== null) {
    return;
  }

  const pids = collectProcessTreePids(processRef.child.pid);
  for (const pid of [...pids].reverse()) {
    safeKill(pid, "SIGTERM");
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (pids.every((pid) => !isPidAlive(pid))) {
      return;
    }
    await sleep(250);
  }

  for (const pid of [...pids].reverse()) {
    safeKill(pid, "SIGKILL");
  }
}

function collectProcessTreePids(rootPid: number): number[] {
  const seen = new Set<number>();
  const queue = [rootPid];

  while (queue.length > 0) {
    const pid = queue.shift();
    if (!pid || seen.has(pid)) {
      continue;
    }
    seen.add(pid);

    const result = spawnSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
    });
    if (result.status !== 0 || !result.stdout) {
      continue;
    }

    for (const line of result.stdout.split("\n")) {
      const childPid = Number.parseInt(line.trim(), 10);
      if (Number.isInteger(childPid) && childPid > 0 && !seen.has(childPid)) {
        queue.push(childPid);
      }
    }
  }

  return [...seen];
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {}
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createGatewayPaths(root: string, id: "sender" | "receiver"): GatewayPaths {
  const base = resolve(root, id);
  const homePath = resolve(base, "home");
  const configPath = resolve(base, "openclaw.config.json");
  const runtimeStatePath = resolve(base, "mahilo-runtime.json");
  const sessionsDir = resolve(homePath, ".openclaw", "agents", "main", "sessions");
  mkdirSync(resolve(homePath, ".openclaw", "agents", "main", "agent"), { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  return {
    configPath,
    homePath,
    runtimeStatePath,
    sessionsDir,
  };
}

function maybeCopyAuthProfiles(gateway: GatewayPaths, authProfilesPath: string | undefined): boolean {
  if (!authProfilesPath || !existsSync(authProfilesPath)) {
    return false;
  }

  const destination = resolve(
    gateway.homePath,
    ".openclaw",
    "agents",
    "main",
    "agent",
    "auth-profiles.json",
  );
  copyFileSync(authProfilesPath, destination);
  return true;
}

function writeGatewayConfig(
  gateway: GatewayPaths,
  options: {
    apiKey: string;
    baseUrl: string;
    pluginDir: string;
    port: number;
  },
): void {
  writeJson(gateway.configPath, {
    gateway: {
      auth: { mode: "none" },
      bind: "loopback",
      http: {
        endpoints: {
          chatCompletions: {
            enabled: true,
          },
        },
      },
      mode: "local",
      port: options.port,
    },
    plugins: {
      allow: [OPENCLAW_PLUGIN_MANIFEST_ID],
      enabled: true,
      load: {
        paths: [options.pluginDir],
      },
      entries: {
        [OPENCLAW_PLUGIN_MANIFEST_ID]: {
          config: {
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            inboundSessionKey: "main",
          },
          enabled: true,
        },
      },
    },
  });
}

async function buildPlugin(pluginDir: string): Promise<void> {
  await runCommand("bun", ["run", "build"], { cwd: pluginDir });
}

async function createAdminUser(baseUrl: string, adminApiKey: string, username: string, displayName: string): Promise<CreatedUser> {
  return await requestJson<CreatedUser>(`${baseUrl}/api/v1/admin/users`, {
    bearer: adminApiKey,
    body: {
      display_name: displayName,
      username,
    },
    method: "POST",
  });
}

async function waitForAgentConnection(baseUrl: string, apiKey: string): Promise<Required<Pick<AgentConnection, "callback_url" | "id">>> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 30_000) {
    const response = await requestJson<AgentConnection[] | { connections?: AgentConnection[] }>(`${baseUrl}/api/v1/agents`, {
      bearer: apiKey,
    });
    const connections = Array.isArray(response) ? response : response.connections ?? [];
    const connection = connections.find((entry) => entry.status === "active" || !entry.status);
    if (connection?.callback_url && connection.id) {
      return {
        callback_url: connection.callback_url,
        id: connection.id,
      };
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for agent connection on ${baseUrl}`);
}

async function createFriendship(baseUrl: string, sender: CreatedUser, receiver: CreatedUser): Promise<string> {
  const requestResult = await requestJson<{ friendship_id: string; status: string }>(`${baseUrl}/api/v1/friends/request`, {
    bearer: sender.api_key,
    body: { username: receiver.username },
    method: "POST",
  });

  if (requestResult.status === "accepted") {
    return requestResult.friendship_id;
  }

  const acceptResult = await requestJson<{ friendship_id: string; status: string }>(
    `${baseUrl}/api/v1/friends/${requestResult.friendship_id}/accept`,
    {
      bearer: receiver.api_key,
      body: {},
      method: "POST",
    },
  );

  if (acceptResult.status !== "accepted") {
    throw new Error(`Friendship ${acceptResult.friendship_id} did not reach accepted status.`);
  }

  return acceptResult.friendship_id;
}

async function clearPolicies(baseUrl: string, apiKey: string): Promise<void> {
  const list = await requestJson<Array<{ id?: string | null }> | { policies?: Array<{ id?: string | null }> }>(
    `${baseUrl}/api/v1/policies`,
    {
      bearer: apiKey,
    },
  );
  const policies = Array.isArray(list) ? list : list.policies ?? [];

  for (const policy of policies) {
    if (!policy.id) continue;
    await requestJson(`${baseUrl}/api/v1/policies/${policy.id}`, {
      bearer: apiKey,
      method: "DELETE",
    });
  }
}

async function createUserPolicy(
  baseUrl: string,
  apiKey: string,
  input: {
    effect: "allow" | "ask" | "deny";
    evaluator: "structured" | "llm";
    policyContent: unknown;
    priority?: number;
    targetUserId: string;
  },
): Promise<string> {
  const response = await requestJson<{ policy_id: string }>(`${baseUrl}/api/v1/policies`, {
    bearer: apiKey,
    body: {
      action: "share",
      direction: "outbound",
      effect: input.effect,
      evaluator: input.evaluator,
      policy_content: input.policyContent,
      priority: input.priority ?? 100,
      resource: "message.general",
      scope: "user",
      target_id: input.targetUserId,
    },
    method: "POST",
  });

  return response.policy_id;
}

async function invokeTool(
  port: number,
  tool: string,
  args: Record<string, unknown>,
  sessionKey = "main",
): Promise<ToolInvokeResponse> {
  const raw = await requestText(`http://127.0.0.1:${port}/tools/invoke`, {
    body: {
      args,
      sessionKey,
      tool,
    },
    method: "POST",
  });

  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {}

  return {
    parsed,
    raw,
  };
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function waitForMessageInSessions(
  sessionsDir: string,
  needle: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const file of listJsonlFiles(sessionsDir)) {
      const content = readFileSafe(file);
      if (content.includes(needle)) {
        return true;
      }
    }
    await sleep(500);
  }
  return false;
}

async function confirmNoMessageInSessions(
  sessionsDir: string,
  needle: string,
  settleMs = 5_000,
): Promise<boolean> {
  const found = await waitForMessageInSessions(sessionsDir, needle, settleMs);
  return !found;
}

function listJsonlFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => resolve(directory, entry))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function waitForReceiverLogLine(logPath: string, expectedSubstring: string, timeoutMs = 15_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (readFileSafe(logPath).includes(expectedSubstring)) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function readLatestReviews(baseUrl: string, apiKey: string): Promise<Array<Record<string, unknown>>> {
  const response = await requestJson<{ reviews?: Array<Record<string, unknown>> }>(
    `${baseUrl}/api/v1/plugin/reviews?limit=20`,
    {
      bearer: apiKey,
    },
  );
  return response.reviews ?? [];
}

async function readLatestBlockedEvents(baseUrl: string, apiKey: string): Promise<Array<Record<string, unknown>>> {
  const response = await requestJson<{ blocked_events?: Array<Record<string, unknown>> }>(
    `${baseUrl}/api/v1/plugin/events/blocked?limit=20&include_payload_excerpt=true`,
    {
      bearer: apiKey,
    },
  );
  return response.blocked_events ?? [];
}

function findReviewByMessage(reviews: Array<Record<string, unknown>>, needle: string): Record<string, unknown> | null {
  return (
    reviews.find((review) => stringify(review.message_preview ?? "").includes(needle)) ??
    null
  );
}

function findBlockedEventByMessage(
  blockedEvents: Array<Record<string, unknown>>,
  needle: string,
): Record<string, unknown> | null {
  return (
    blockedEvents.find((event) => stringify(event.stored_payload_excerpt ?? "").includes(needle)) ??
    null
  );
}

function hasSubstring(value: unknown, substring: string): boolean {
  return stringify(value).includes(substring);
}

async function runAllowScenario(input: {
  baseUrl: string;
  receiverLogPath: string;
  receiverSessionsDir: string;
  receiverUsername: string;
  senderApiKey: string;
  senderPort: number;
}): Promise<ScenarioResult> {
  const message = "HARNESS_ALLOW: Gokarna trip confirmed for April 4. Bring sunscreen.";
  await clearPolicies(input.baseUrl, input.senderApiKey);

  const toolResult = await invokeTool(input.senderPort, "send_message", {
    message,
    target: input.receiverUsername,
  });

  const deliveredToReceiver = await waitForMessageInSessions(input.receiverSessionsDir, message);
  const logEvidence = await waitForReceiverLogLine(
    input.receiverLogPath,
    "No exact route for inbound message",
    5_000,
  );

  const notes = [toolResult.raw];
  const evidence = [];
  if (deliveredToReceiver) {
    evidence.push("receiver-session");
  }
  if (logEvidence) {
    evidence.push("receiver-log");
  }

  const status =
    hasSubstring(toolResult.parsed, "Message sent through Mahilo.") &&
    (deliveredToReceiver || logEvidence)
      ? "passed"
      : "failed";

  return {
    evidence,
    expected: "message is sent and reaches receiver OpenClaw",
    message,
    notes,
    status,
  };
}

async function runAskScenario(input: {
  baseUrl: string;
  receiverSessionsDir: string;
  receiverUserId: string;
  receiverUsername: string;
  senderApiKey: string;
  senderPort: number;
}): Promise<ScenarioResult> {
  const message = "HARNESS_ASK: Share the hotel booking details with Alice.";
  await clearPolicies(input.baseUrl, input.senderApiKey);
  await createUserPolicy(input.baseUrl, input.senderApiKey, {
    effect: "ask",
    evaluator: "structured",
    policyContent: {},
    targetUserId: input.receiverUserId,
  });

  const toolResult = await invokeTool(input.senderPort, "send_message", {
    message,
    target: input.receiverUsername,
  });
  const receiverStayedQuiet = await confirmNoMessageInSessions(input.receiverSessionsDir, message);
  const reviews = await readLatestReviews(input.baseUrl, input.senderApiKey);
  const review = findReviewByMessage(reviews, "HARNESS_ASK");

  return {
    evidence: review ? ["review-queue"] : [],
    expected: "message is held for review and never reaches receiver",
    message,
    notes: [toolResult.raw, review ? stringify(review) : "no matching review found"],
    status:
      hasSubstring(toolResult.parsed, "review") &&
      receiverStayedQuiet &&
      review !== null
        ? "passed"
        : "failed",
  };
}

async function runDenyScenario(input: {
  baseUrl: string;
  receiverSessionsDir: string;
  receiverUserId: string;
  receiverUsername: string;
  senderApiKey: string;
  senderPort: number;
}): Promise<ScenarioResult> {
  const message = "HARNESS_DENY: Share the hotel confirmation number with Alice.";
  await clearPolicies(input.baseUrl, input.senderApiKey);
  await createUserPolicy(input.baseUrl, input.senderApiKey, {
    effect: "deny",
    evaluator: "structured",
    policyContent: {},
    targetUserId: input.receiverUserId,
  });

  const toolResult = await invokeTool(input.senderPort, "send_message", {
    message,
    target: input.receiverUsername,
  });
  const receiverStayedQuiet = await confirmNoMessageInSessions(input.receiverSessionsDir, message);
  const blockedEvents = await readLatestBlockedEvents(input.baseUrl, input.senderApiKey);
  const blockedEvent = findBlockedEventByMessage(blockedEvents, "HARNESS_DENY");

  return {
    evidence: blockedEvent ? ["blocked-events"] : [],
    expected: "message is blocked and never reaches receiver",
    message,
    notes: [toolResult.raw, blockedEvent ? stringify(blockedEvent) : "no matching blocked event found"],
    status:
      hasSubstring(toolResult.parsed, "blocked") &&
      receiverStayedQuiet &&
      blockedEvent !== null
        ? "passed"
        : "failed",
  };
}

async function runMissingLlmScenario(input: {
  baseUrl: string;
  receiverSessionsDir: string;
  receiverUserId: string;
  receiverUsername: string;
  senderApiKey: string;
  senderPort: number;
}): Promise<ScenarioResult> {
  const message = "HARNESS_LLM: Share my Gokarna itinerary and hotel details with Alice.";
  await clearPolicies(input.baseUrl, input.senderApiKey);
  await createUserPolicy(input.baseUrl, input.senderApiKey, {
    effect: "deny",
    evaluator: "llm",
    policyContent: "Always deny sharing travel itinerary details with this recipient.",
    targetUserId: input.receiverUserId,
  });

  const toolResult = await invokeTool(input.senderPort, "send_message", {
    message,
    target: input.receiverUsername,
  });
  const receiverStayedQuiet = await confirmNoMessageInSessions(input.receiverSessionsDir, message);
  const reviews = await readLatestReviews(input.baseUrl, input.senderApiKey);
  const review = findReviewByMessage(reviews, "HARNESS_LLM");
  const reasonCode = review ? stringify(review.reason_code ?? "") : "";

  return {
    evidence: review ? ["review-queue"] : [],
    expected: "missing local LLM credentials degrade the send into review_required",
    message,
    notes: [toolResult.raw, review ? stringify(review) : "no matching review found"],
    status:
      hasSubstring(toolResult.parsed, "review") &&
      receiverStayedQuiet &&
      review !== null &&
      reasonCode.includes("policy.ask.llm.unavailable")
        ? "passed"
        : "failed",
  };
}

function resolveAuthProfilesPath(input: string | undefined): string | undefined {
  if (input && existsSync(input)) {
    return input;
  }
  if (existsSync(DEFAULT_AGENT_AUTH_PROFILES)) {
    return DEFAULT_AGENT_AUTH_PROFILES;
  }
  return undefined;
}

async function runAgentTurn(input: {
  agentModel?: string;
  authProfilesCopied: boolean;
  receiverLogPath: string;
  receiverSessionsDir: string;
  senderPort: number;
  senderSessionsDir: string;
}): Promise<OptionalAgentTurnResult> {
  if (!input.agentModel) {
    return {
      evidence: [],
      model: null,
      notes: ["agent turn skipped: no --agent-model provided"],
      receiverDelivered: null,
      status: "skipped",
      toolCallDetected: null,
    };
  }

  if (!input.authProfilesCopied) {
    return {
      evidence: [],
      model: input.agentModel,
      notes: ["agent turn skipped: auth-profiles.json not available"],
      receiverDelivered: null,
      status: "skipped",
      toolCallDetected: null,
    };
  }

  const sessionKey = "mahilo_agent_turn_sender";
  const promptOne = "Remember that Alice and I are planning a Gokarna trip for April 4 to April 7. Reply briefly.";
  const promptTwo = "Tell Alice that the Gokarna trip is booked and ask her to bring sunscreen.";

  const baseRequest = {
    model: input.agentModel,
    stream: false,
  };

  const firstResponse = await requestJson(
    `http://127.0.0.1:${input.senderPort}/v1/chat/completions`,
    {
      body: {
        ...baseRequest,
        messages: [{ content: promptOne, role: "user" }],
      },
      headers: {
        "x-openclaw-session-key": sessionKey,
      },
      method: "POST",
    },
  );

  const secondResponse = await requestJson(
    `http://127.0.0.1:${input.senderPort}/v1/chat/completions`,
    {
      body: {
        ...baseRequest,
        messages: [{ content: promptTwo, role: "user" }],
      },
      headers: {
        "x-openclaw-session-key": sessionKey,
      },
      method: "POST",
    },
  );

  const transcriptContainsSendMessage = await waitForMessageInSessions(
    input.senderSessionsDir,
    '"name":"send_message"',
    20_000,
  );
  const receiverObservedPromptTurn = await waitForReceiverLogLine(
    input.receiverLogPath,
    "Routed inbound message",
    10_000,
  );

  return {
    evidence: [
      transcriptContainsSendMessage ? "sender-transcript" : "no-sender-transcript-proof",
      receiverObservedPromptTurn ? "receiver-log" : "no-receiver-log-proof",
    ],
    model: input.agentModel,
    notes: [stringify(firstResponse), stringify(secondResponse)],
    receiverDelivered: receiverObservedPromptTurn,
    status:
      transcriptContainsSendMessage && receiverObservedPromptTurn ? "passed" : "failed",
    toolCallDetected: transcriptContainsSendMessage,
  };
}

async function verifyPluginListed(openclawDir: string, gateway: GatewayPaths): Promise<boolean> {
  const result = await runCommand(
    "node",
    ["scripts/run-node.mjs", "plugins", "list", "--json"],
    {
      cwd: openclawDir,
      env: {
        OPENCLAW_CONFIG_PATH: gateway.configPath,
        OPENCLAW_HOME: gateway.homePath,
      },
    },
  );
  return result.stdout.includes("mahilo") || result.stdout.includes("openclaw-mahilo");
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  const root = ensureFreshRoot(options.rootPath);
  const baseUrl = `http://127.0.0.1:${options.mahiloPort}`;
  const logDir = resolve(root, "logs");
  mkdirSync(logDir, { recursive: true });

  const senderGateway = createGatewayPaths(root, "sender");
  const receiverGateway = createGatewayPaths(root, "receiver");
  const resolvedAuthProfiles = resolveAuthProfilesPath(options.authProfilesPath);
  const authProfilesCopiedSender = maybeCopyAuthProfiles(senderGateway, resolvedAuthProfiles);
  const authProfilesCopiedReceiver = maybeCopyAuthProfiles(receiverGateway, resolvedAuthProfiles);

  const mahiloLogPath = resolve(logDir, "mahilo.log");
  const senderLogPath = resolve(logDir, "sender-gateway.log");
  const receiverLogPath = resolve(logDir, "receiver-gateway.log");
  const summaryPath = resolve(root, "summary.json");

  const managed: ManagedProcess[] = [];

  try {
    await buildPlugin(options.pluginDir);

    const mahilo = spawnLoggedProcess(
      "mahilo",
      "bun",
      ["run", "src/index.ts"],
      {
        cwd: REPO_ROOT,
        env: {
          ADMIN_API_KEY: options.adminApiKey,
          ALLOW_PRIVATE_IPS: "true",
          DATABASE_URL: resolve(root, "mahilo.db"),
          HOST: "127.0.0.1",
          PORT: String(options.mahiloPort),
          SECRET_KEY: "mahilo-harness-secret",
          TRUSTED_MODE: "false",
        },
        logPath: mahiloLogPath,
      },
    );
    managed.push(mahilo);

    await waitForHttp(`${baseUrl}/health`);

    const sender = await createAdminUser(baseUrl, options.adminApiKey, "sandboxsender", "Sandbox Sender");
    const receiver = await createAdminUser(baseUrl, options.adminApiKey, "sandboxreceiver", "Sandbox Receiver");

    writeGatewayConfig(senderGateway, {
      apiKey: sender.api_key,
      baseUrl,
      pluginDir: options.pluginDir,
      port: options.gatewayAPort,
    });
    writeGatewayConfig(receiverGateway, {
      apiKey: receiver.api_key,
      baseUrl,
      pluginDir: options.pluginDir,
      port: options.gatewayBPort,
    });

    const gatewayEnv = {
      ANTHROPIC_API_KEY: "",
      MAHILO_OPENCLAW_RUNTIME_STATE_PATH: senderGateway.runtimeStatePath,
      OPENAI_API_KEY: "",
      OPENCLAW_CONFIG_PATH: senderGateway.configPath,
      OPENCLAW_HOME: senderGateway.homePath,
    };
    const senderProcess = spawnLoggedProcess(
      "gateway-a",
      "node",
      [
        "scripts/run-node.mjs",
        "gateway",
        "run",
        "--port",
        String(options.gatewayAPort),
        "--auth",
        "none",
        "--bind",
        "loopback",
        "--verbose",
      ],
      {
        cwd: options.openclawDir,
        env: gatewayEnv,
        logPath: senderLogPath,
      },
    );
    managed.push(senderProcess);

    const receiverProcess = spawnLoggedProcess(
      "gateway-b",
      "node",
      [
        "scripts/run-node.mjs",
        "gateway",
        "run",
        "--port",
        String(options.gatewayBPort),
        "--auth",
        "none",
        "--bind",
        "loopback",
        "--verbose",
      ],
      {
        cwd: options.openclawDir,
        env: {
          ANTHROPIC_API_KEY: "",
          MAHILO_OPENCLAW_RUNTIME_STATE_PATH: receiverGateway.runtimeStatePath,
          OPENAI_API_KEY: "",
          OPENCLAW_CONFIG_PATH: receiverGateway.configPath,
          OPENCLAW_HOME: receiverGateway.homePath,
        },
        logPath: receiverLogPath,
      },
    );
    managed.push(receiverProcess);

    await waitForHttp(`http://127.0.0.1:${options.gatewayAPort}/mahilo/incoming`, { method: "HEAD" });
    await waitForHttp(`http://127.0.0.1:${options.gatewayBPort}/mahilo/incoming`, { method: "HEAD" });

    const senderPluginListed = await verifyPluginListed(options.openclawDir, senderGateway);
    const receiverPluginListed = await verifyPluginListed(options.openclawDir, receiverGateway);
    if (!senderPluginListed || !receiverPluginListed) {
      throw new Error("Mahilo plugin was not listed on both gateways.");
    }

    const senderConnection = await waitForAgentConnection(baseUrl, sender.api_key);
    const receiverConnection = await waitForAgentConnection(baseUrl, receiver.api_key);
    await createFriendship(baseUrl, sender, receiver);

    const allow = await runAllowScenario({
      baseUrl,
      receiverLogPath,
      receiverSessionsDir: receiverGateway.sessionsDir,
      receiverUsername: receiver.username,
      senderApiKey: sender.api_key,
      senderPort: options.gatewayAPort,
    });
    const ask = await runAskScenario({
      baseUrl,
      receiverSessionsDir: receiverGateway.sessionsDir,
      receiverUserId: receiver.user_id,
      receiverUsername: receiver.username,
      senderApiKey: sender.api_key,
      senderPort: options.gatewayAPort,
    });
    const deny = await runDenyScenario({
      baseUrl,
      receiverSessionsDir: receiverGateway.sessionsDir,
      receiverUserId: receiver.user_id,
      receiverUsername: receiver.username,
      senderApiKey: sender.api_key,
      senderPort: options.gatewayAPort,
    });
    const missingLlm = await runMissingLlmScenario({
      baseUrl,
      receiverSessionsDir: receiverGateway.sessionsDir,
      receiverUserId: receiver.user_id,
      receiverUsername: receiver.username,
      senderApiKey: sender.api_key,
      senderPort: options.gatewayAPort,
    });

    const agentTurn = await runAgentTurn({
      agentModel: options.agentModel,
      authProfilesCopied: authProfilesCopiedSender && authProfilesCopiedReceiver,
      receiverLogPath,
      receiverSessionsDir: receiverGateway.sessionsDir,
      senderPort: options.gatewayAPort,
      senderSessionsDir: senderGateway.sessionsDir,
    });

    const summary: HarnessSummary = {
      agent_turn: agentTurn,
      artifacts: {
        logs: {
          gateway_a: senderLogPath,
          gateway_b: receiverLogPath,
          mahilo: mahiloLogPath,
        },
        receiverSessionsDir: receiverGateway.sessionsDir,
        senderSessionsDir: senderGateway.sessionsDir,
        summaryPath,
      },
      baseUrl,
      deterministic: {
        allow,
        ask,
        deny,
        missing_llm: missingLlm,
      },
      pluginChecks: {
        gateway_a: {
          pluginListed: senderPluginListed,
          webhookReachable: true,
        },
        gateway_b: {
          pluginListed: receiverPluginListed,
          webhookReachable: true,
        },
      },
      ports: {
        gateway_a: options.gatewayAPort,
        gateway_b: options.gatewayBPort,
        mahilo: options.mahiloPort,
      },
      root,
      users: {
        receiver: {
          connection_id: receiverConnection.id,
          username: receiver.username,
        },
        sender: {
          connection_id: senderConnection.id,
          username: sender.username,
        },
      },
    };

    writeJson(summaryPath, summary);
    console.log(JSON.stringify(summary, null, 2));

    const deterministicPassed =
      allow.status === "passed" &&
      ask.status === "passed" &&
      deny.status === "passed" &&
      missingLlm.status === "passed";
    const agentTurnRequired = Boolean(options.agentModel);
    const agentTurnPassed =
      agentTurn.status === "passed" ||
      (!agentTurnRequired && agentTurn.status === "skipped");

    if (!options.keepProcesses) {
      for (const processRef of managed.reverse()) {
        await stopProcess(processRef);
      }
    }

    if (!deterministicPassed || !agentTurnPassed) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (!options.keepProcesses) {
      for (const processRef of managed.reverse()) {
        await stopProcess(processRef);
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    writeJson(summaryPath, {
      error: message,
      root,
    });
    console.error(message);
    process.exit(1);
  }
}

void main();
