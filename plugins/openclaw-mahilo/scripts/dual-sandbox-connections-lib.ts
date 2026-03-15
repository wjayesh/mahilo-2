import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { MahiloRuntimeBootstrapStore } from "../src/runtime-bootstrap";
import {
  readDualSandboxProvisionedRunFromRunRoot,
  type DualSandboxProvisionedRunSummary,
} from "./dual-sandbox-provision-lib";

export const DUAL_SANDBOX_CONNECTIONS_CONTRACT_VERSION = 1;

type SandboxId = "a" | "b";

interface AgentConnectionListItem {
  callback_url: string;
  framework: string;
  id: string;
  label: string;
  status: string;
}

interface AgentConnectionRegistrationResponse {
  callback_secret?: string;
  connection_id?: string;
  mode?: string;
  updated?: boolean;
}

export interface DualSandboxConnectOptions {
  fetchImpl?: typeof fetch;
  mahiloBaseUrl?: string;
  now?: () => Date;
}

export interface DualSandboxConnectedSandboxSummary {
  callback_url: string;
  connection_id: string;
  framework: string;
  get_agents_status_code: number;
  label: string;
  mode: "webhook";
  post_agents_status_code: number;
  runtime_bootstrap_path: string;
  status: string;
  updated_existing_connection: boolean;
}

export interface DualSandboxConnectionsSummary {
  contract_version: number;
  created_at: string;
  current_phase: "connections";
  mahilo_base_url: string;
  sandboxes: {
    a: DualSandboxConnectedSandboxSummary;
    b: DualSandboxConnectedSandboxSummary;
  };
}

export interface DualSandboxConnectedRunSummary extends DualSandboxProvisionedRunSummary {
  connections: DualSandboxConnectionsSummary;
}

const DEFAULT_CONNECTION_CAPABILITIES = ["chat"];
const DEFAULT_CONNECTION_DESCRIPTION_PREFIX = "Mahilo dual-sandbox harness";
const DEFAULT_CONNECTION_FRAMEWORK = "openclaw";
const DEFAULT_CONNECTION_LABEL = "default";
const REDACTED_SECRET = "<redacted>";

export async function connectDualSandboxGateways(
  summary: DualSandboxProvisionedRunSummary,
  options: DualSandboxConnectOptions = {},
): Promise<DualSandboxConnectedRunSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const mahiloBaseUrl = normalizeBaseUrl(
    options.mahiloBaseUrl ?? summary.provisioning.mahilo_base_url,
  );

  const sandboxA = await registerSandboxConnection({
    createdAt,
    fetchImpl,
    mahiloBaseUrl,
    runId: summary.run_id,
    sandboxId: "a",
    summary,
  });
  const sandboxB = await registerSandboxConnection({
    createdAt,
    fetchImpl,
    mahiloBaseUrl,
    runId: summary.run_id,
    sandboxId: "b",
    summary,
  });

  const connectedSummary: DualSandboxConnectedRunSummary = {
    ...summary,
    connections: {
      contract_version: DUAL_SANDBOX_CONNECTIONS_CONTRACT_VERSION,
      created_at: createdAt,
      current_phase: "connections",
      mahilo_base_url: mahiloBaseUrl,
      sandboxes: {
        a: sandboxA,
        b: sandboxB,
      },
    },
    provisioning: {
      ...summary.provisioning,
      current_phase: "connections",
    },
  };

  writeJsonFile(summary.paths.runtime_provisioning_path, connectedSummary);
  writeJsonFile(
    summary.paths.artifact_bootstrap_summary_path,
    redactConnectedRunSummary(connectedSummary),
  );

  return connectedSummary;
}

export function redactConnectedRunSummary(
  summary: DualSandboxConnectedRunSummary,
): DualSandboxConnectedRunSummary {
  return {
    ...summary,
    connections: summary.connections,
    provisioning: {
      ...summary.provisioning,
      sandboxes: {
        a: {
          ...summary.provisioning.sandboxes.a,
          api_key: REDACTED_SECRET,
        },
        b: {
          ...summary.provisioning.sandboxes.b,
          api_key: REDACTED_SECRET,
        },
      },
    },
  };
}

export function readDualSandboxConnectedRunFromRunRoot(
  runRoot: string,
): DualSandboxConnectedRunSummary {
  const provisionedRun = readDualSandboxProvisionedRunFromRunRoot(runRoot);
  const runtimeProvisioningPath =
    provisionedRun.paths.runtime_provisioning_path;
  const parsed = readJsonFile<Partial<DualSandboxConnectedRunSummary>>(
    runtimeProvisioningPath,
  );

  assertConnectedRunSummary(parsed, runtimeProvisioningPath);
  return parsed;
}

async function registerSandboxConnection(input: {
  createdAt: string;
  fetchImpl: typeof fetch;
  mahiloBaseUrl: string;
  runId: string;
  sandboxId: SandboxId;
  summary: DualSandboxProvisionedRunSummary;
}): Promise<DualSandboxConnectedSandboxSummary> {
  const sandboxSummary = input.summary.sandboxes[input.sandboxId];
  const sandboxProvisioning =
    input.summary.provisioning.sandboxes[input.sandboxId];
  const connectionDescription = [
    DEFAULT_CONNECTION_DESCRIPTION_PREFIX,
    input.runId,
    `sandbox-${input.sandboxId}`,
  ].join(" ");
  const registration = await requestJson<AgentConnectionRegistrationResponse>(
    input.fetchImpl,
    input.mahiloBaseUrl,
    {
      bearerToken: sandboxProvisioning.api_key,
      body: {
        callback_url: sandboxSummary.callback_url,
        capabilities: DEFAULT_CONNECTION_CAPABILITIES,
        description: connectionDescription,
        framework: DEFAULT_CONNECTION_FRAMEWORK,
        label: DEFAULT_CONNECTION_LABEL,
        mode: "webhook",
        rotate_secret: true,
      },
      method: "POST",
      path: "/api/v1/agents",
    },
  );

  const connectionId = readString(registration.json.connection_id);
  if (!connectionId) {
    throw new Error(
      `Sandbox ${input.sandboxId} agent registration did not return connection_id.`,
    );
  }

  if (registration.json.mode && registration.json.mode !== "webhook") {
    throw new Error(
      `Sandbox ${input.sandboxId} agent registration returned mode ${registration.json.mode}; expected webhook.`,
    );
  }

  const callbackSecret = readString(registration.json.callback_secret);
  if (!callbackSecret) {
    throw new Error(
      `Sandbox ${input.sandboxId} agent registration did not return callback_secret.`,
    );
  }

  const listedConnections = await requestJson<unknown[]>(
    input.fetchImpl,
    input.mahiloBaseUrl,
    {
      bearerToken: sandboxProvisioning.api_key,
      method: "GET",
      path: "/api/v1/agents",
    },
  );
  const activeOpenClawConnections = readActiveOpenClawConnections(
    listedConnections.json,
  );

  if (activeOpenClawConnections.length !== 1) {
    throw new Error(
      `Sandbox ${input.sandboxId} has ${activeOpenClawConnections.length} active OpenClaw connections; expected exactly 1.`,
    );
  }

  const [activeConnection] = activeOpenClawConnections;
  if (!activeConnection) {
    throw new Error(
      `Sandbox ${input.sandboxId} did not persist an active OpenClaw connection.`,
    );
  }

  if (activeConnection.id !== connectionId) {
    throw new Error(
      `Sandbox ${input.sandboxId} listed connection ${activeConnection.id}; expected ${connectionId}.`,
    );
  }

  if (activeConnection.callback_url !== sandboxSummary.callback_url) {
    throw new Error(
      `Sandbox ${input.sandboxId} listed callback URL ${activeConnection.callback_url}; expected ${sandboxSummary.callback_url}.`,
    );
  }

  const runtimeBootstrapStore = new MahiloRuntimeBootstrapStore({
    path: sandboxSummary.runtime_state_path,
  });
  runtimeBootstrapStore.write(input.mahiloBaseUrl, {
    apiKey: sandboxProvisioning.api_key,
    callbackConnectionId: connectionId,
    callbackSecret,
    callbackUrl: sandboxSummary.callback_url,
    username: sandboxProvisioning.username,
  });

  const runtimeDiagnostic = runtimeBootstrapStore.diagnose(input.mahiloBaseUrl);
  if (runtimeDiagnostic.kind !== "ok") {
    throw new Error(
      `Sandbox ${input.sandboxId} runtime bootstrap validation failed: ${runtimeDiagnostic.message}`,
    );
  }

  writeJsonFile(sandboxSummary.artifact_paths.agent_connections_path, {
    connections: listedConnections.json,
    recorded_at: input.createdAt,
    status_code: listedConnections.status,
  });
  writeJsonFile(
    sandboxSummary.artifact_paths.runtime_state_redacted_path,
    redactRuntimeStateArtifact(
      readJsonFile<Record<string, unknown>>(sandboxSummary.runtime_state_path),
    ),
  );

  return {
    callback_url: sandboxSummary.callback_url,
    connection_id: connectionId,
    framework: activeConnection.framework,
    get_agents_status_code: listedConnections.status,
    label: activeConnection.label,
    mode: "webhook",
    post_agents_status_code: registration.status,
    runtime_bootstrap_path: sandboxSummary.runtime_state_path,
    status: activeConnection.status,
    updated_existing_connection: registration.json.updated === true,
  };
}

function assertConnectedRunSummary(
  parsed: Partial<DualSandboxConnectedRunSummary>,
  runtimeProvisioningPath: string,
): asserts parsed is DualSandboxConnectedRunSummary {
  const record = readRecord(parsed);
  const connections = readRecord(record.connections);
  const sandboxes = readRecord(connections.sandboxes);
  const sandboxA = readRecord(sandboxes.a);
  const sandboxB = readRecord(sandboxes.b);

  if (
    typeof connections.contract_version !== "number" ||
    !Number.isFinite(connections.contract_version) ||
    !readString(connections.created_at) ||
    connections.current_phase !== "connections" ||
    !readString(connections.mahilo_base_url)
  ) {
    throw new Error(
      `File ${runtimeProvisioningPath} does not contain a valid dual-sandbox connection summary.`,
    );
  }

  assertConnectedSandbox(
    parsed,
    sandboxA,
    "a",
    runtimeProvisioningPath,
    connections.mahilo_base_url,
  );
  assertConnectedSandbox(
    parsed,
    sandboxB,
    "b",
    runtimeProvisioningPath,
    connections.mahilo_base_url,
  );
}

function assertConnectedSandbox(
  summary:
    | DualSandboxConnectedRunSummary
    | Partial<DualSandboxConnectedRunSummary>,
  sandbox: Record<string, unknown>,
  sandboxId: SandboxId,
  runtimeProvisioningPath: string,
  mahiloBaseUrl: unknown,
): void {
  const callbackUrl = readString(sandbox.callback_url);
  const connectionId = readString(sandbox.connection_id);
  const runtimeBootstrapPath = readString(sandbox.runtime_bootstrap_path);
  const framework = readString(sandbox.framework);
  const label = readString(sandbox.label);
  const status = readString(sandbox.status);
  const normalizedBaseUrl = readString(mahiloBaseUrl);

  if (
    !callbackUrl ||
    !connectionId ||
    !runtimeBootstrapPath ||
    !framework ||
    !label ||
    !status ||
    sandbox.mode !== "webhook" ||
    typeof sandbox.post_agents_status_code !== "number" ||
    !Number.isFinite(sandbox.post_agents_status_code) ||
    typeof sandbox.get_agents_status_code !== "number" ||
    !Number.isFinite(sandbox.get_agents_status_code) ||
    typeof sandbox.updated_existing_connection !== "boolean" ||
    !normalizedBaseUrl
  ) {
    throw new Error(
      `File ${runtimeProvisioningPath} does not contain valid sandbox ${sandboxId} connection details.`,
    );
  }

  if (!existsSync(runtimeBootstrapPath)) {
    throw new Error(
      `Expected sandbox ${sandboxId} runtime bootstrap at ${runtimeBootstrapPath} referenced by ${runtimeProvisioningPath}.`,
    );
  }

  const runtimeBootstrapStore = new MahiloRuntimeBootstrapStore({
    path: runtimeBootstrapPath,
  });
  const runtimeState = runtimeBootstrapStore.read(normalizedBaseUrl);
  if (!runtimeState) {
    throw new Error(
      `Sandbox ${sandboxId} runtime bootstrap at ${runtimeBootstrapPath} is missing the server entry for ${normalizedBaseUrl}.`,
    );
  }

  const expectedProvisioningSandbox =
    summary.provisioning?.sandboxes?.[sandboxId];
  const expectedApiKey = readString(expectedProvisioningSandbox?.api_key);
  const expectedUsername = readString(expectedProvisioningSandbox?.username);

  if (
    runtimeState.apiKey !== expectedApiKey ||
    runtimeState.username !== expectedUsername ||
    runtimeState.callbackConnectionId !== connectionId ||
    runtimeState.callbackUrl !== callbackUrl ||
    !runtimeState.callbackSecret
  ) {
    throw new Error(
      `Sandbox ${sandboxId} runtime bootstrap at ${runtimeBootstrapPath} does not match ${runtimeProvisioningPath}.`,
    );
  }

  const artifactPath =
    summary.sandboxes?.[sandboxId]?.artifact_paths?.runtime_state_redacted_path;
  if (!readString(artifactPath) || !existsSync(artifactPath)) {
    throw new Error(
      `Expected sandbox ${sandboxId} redacted runtime bootstrap artifact referenced by ${runtimeProvisioningPath}.`,
    );
  }
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: {
    bearerToken?: string;
    body?: unknown;
    method: "GET" | "POST";
    path: string;
  },
): Promise<{
  json: T;
  status: number;
}> {
  const response = await fetchImpl(
    new URL(options.path, `${baseUrl}/`).toString(),
    {
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: {
        ...(options.body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
            }),
        ...(options.bearerToken
          ? {
              Authorization: `Bearer ${options.bearerToken}`,
            }
          : {}),
      },
      method: options.method,
    },
  );

  const responseText = await response.text();
  const parsedJson = parseJsonResponse(responseText);

  if (!response.ok) {
    throw new Error(
      `${options.method} ${options.path} failed with ${response.status}: ${readErrorMessage(
        parsedJson,
        responseText,
      )}`,
    );
  }

  if (parsedJson === null) {
    throw new Error(
      `${options.method} ${options.path} returned an empty or non-JSON response.`,
    );
  }

  return {
    json: parsedJson as T,
    status: response.status,
  };
}

function readActiveOpenClawConnections(
  value: unknown,
): AgentConnectionListItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const record = readRecord(entry);
      const callbackUrl = readString(record.callback_url);
      const framework = readString(record.framework);
      const id = readString(record.id);
      const label = readString(record.label);
      const status = readString(record.status);

      if (!callbackUrl || !framework || !id || !label || !status) {
        return null;
      }

      return {
        callback_url: callbackUrl,
        framework,
        id,
        label,
        status,
      } satisfies AgentConnectionListItem;
    })
    .filter((entry): entry is AgentConnectionListItem => {
      return (
        entry !== null &&
        entry.framework === DEFAULT_CONNECTION_FRAMEWORK &&
        entry.status === "active"
      );
    });
}

function redactRuntimeStateArtifact(value: unknown): unknown {
  const root = readRecord(value);
  const servers = readRecord(root.servers);

  return {
    ...root,
    servers: Object.fromEntries(
      Object.entries(servers).map(([serverKey, serverValue]) => {
        const server = readRecord(serverValue);
        return [
          serverKey,
          {
            ...server,
            ...(readString(server.apiKey)
              ? {
                  apiKey: REDACTED_SECRET,
                }
              : {}),
            ...(readString(server.callbackSecret)
              ? {
                  callbackSecret: REDACTED_SECRET,
                }
              : {}),
          },
        ];
      }),
    ),
  };
}

function parseJsonResponse(responseText: string): unknown | null {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function readErrorMessage(parsedJson: unknown, responseText: string): string {
  if (typeof parsedJson === "object" && parsedJson !== null) {
    const message = readString((parsedJson as Record<string, unknown>).message);
    if (message) {
      return message;
    }

    const errorRecord = readRecord(
      (parsedJson as Record<string, unknown>).error,
    );
    const nestedMessage = readString(errorRecord.message);
    if (nestedMessage) {
      return nestedMessage;
    }

    const code = readString(errorRecord.code);
    if (code) {
      return code;
    }
  }

  return responseText.trim() || "Request failed";
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = readString(baseUrl);
  if (!normalized) {
    throw new Error("mahiloBaseUrl is required.");
  }

  return normalized.replace(/\/+$/, "");
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), {
    recursive: true,
  });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
