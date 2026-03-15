import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DUAL_SANDBOX_ARTIFACT_CONTRACT_VERSION = 1;
export const DUAL_SANDBOX_BOOTSTRAP_CONTRACT_VERSION = 1;
export const DUAL_SANDBOX_SCENARIO_IDS = [
  "G1",
  "G2",
  "G3",
  "S1-send-receive",
  "S2-allow",
  "S3-ask",
  "S4-deny",
  "S5-missing-llm-key",
] as const;

export type DualSandboxScenarioId = (typeof DUAL_SANDBOX_SCENARIO_IDS)[number];

export interface DualSandboxBootstrapOptions {
  gatewayAPort?: number;
  gatewayBPort?: number;
  mahiloPort?: number;
  now?: () => Date;
  optionalLiveModel?: DualSandboxOptionalLiveModelOptions;
  pluginPath?: string;
  rootPath?: string;
  tempRootParent?: string;
}

export interface DualSandboxEnvSummary {
  MAHILO_OPENCLAW_RUNTIME_STATE_PATH: string;
  OPENCLAW_CONFIG_PATH: string;
  OPENCLAW_HOME: string;
}

export interface DualSandboxArtifactPathsSummary {
  agent_connections_path: string;
  auth_redacted_path: string;
  config_redacted_path: string;
  plugin_list_path: string;
  runtime_state_redacted_path: string;
  webhook_head_path: string;
}

export interface DualSandboxSummary {
  artifact_dir: string;
  artifact_paths: DualSandboxArtifactPathsSummary;
  auth_path: string;
  callback_url: string;
  env: DualSandboxEnvSummary;
  gateway_base_url: string;
  gateway_id: string;
  gateway_log_path: string;
  gateway_port: number;
  id: string;
  openclaw_agent_dir: string;
  openclaw_config_path: string;
  openclaw_home: string;
  openclaw_sessions_dir: string;
  provider_auth_profiles_path: string;
  runtime_dir: string;
  runtime_state_path: string;
}

export interface DualSandboxOptionalLiveModelOptions {
  apiKeyEnvVar?: string;
  authProfile?: string;
  copyProviderAuthFrom?: string;
  model?: string;
  provider?: string;
  timeoutMs?: number;
}

export interface DualSandboxOptionalLiveModelSummary {
  configured: boolean;
  local_policy_llm: {
    api_key_env_var?: string;
    auth_profile?: string;
    model?: string;
    provider?: string;
    timeout_ms: number;
  } | null;
  provider_auth_copy: {
    enabled: boolean;
  };
}

export interface DualSandboxProofInputsSummary {
  deterministic: {
    plugin_path: string;
    shared_mahilo_base_url: string;
  };
  optional_live_model: DualSandboxOptionalLiveModelSummary;
}

export interface DualSandboxBootstrapSummary {
  artifact_contract_version: number;
  artifacts_dir: string;
  bootstrap_contract_version: number;
  created_at: string;
  mahilo: {
    base_url: string;
    db_path: string;
    log_path: string;
  };
  paths: {
    artifact_bootstrap_summary_path: string;
    commands_log_path: string;
    logs_dir: string;
    operator_summary_path: string;
    provisioning_dir: string;
    run_context_path: string;
    runtime_provisioning_path: string;
    sandboxes_dir: string;
    scenario_root: string;
    scenarios: Record<DualSandboxScenarioId, string>;
    verification_summary_path: string;
  };
  ports: {
    gateway_a: number;
    gateway_b: number;
    mahilo: number;
  };
  proof_inputs: DualSandboxProofInputsSummary;
  run_id: string;
  run_root: string;
  runtime_dir: string;
  sandboxes: {
    a: DualSandboxSummary;
    b: DualSandboxSummary;
  };
}

interface ResolvedPorts {
  gatewayA: number;
  gatewayB: number;
  mahilo: number;
}

interface ResolvedOptionalLiveModelOptions {
  apiKeyEnvVar?: string;
  authProfile?: string;
  copyProviderAuthFrom?: string;
  model?: string;
  provider?: string;
  timeoutMs: number;
}

interface SandboxDescriptorInput {
  artifactsDir: string;
  gatewayId: string;
  gatewayLogName: string;
  gatewayPort: number;
  runtimeDir: string;
  sandboxId: string;
}

const DEFAULT_PORTS = {
  gatewayA: 19123,
  gatewayB: 19124,
  mahilo: 18080,
} as const;
const DEFAULT_LOCAL_POLICY_LLM_TIMEOUT_MS = 5000;
const DEFAULT_PLUGIN_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const EMPTY_RUNTIME_STATE = {
  servers: {},
  version: 1,
} as const;

const LOOPBACK_HOST = "127.0.0.1";
const WEBHOOK_PATH = "/mahilo/incoming";
const PROVIDER_AUTH_FILE_NAME = "auth-profiles.json";

export function createDualSandboxBootstrap(
  options: DualSandboxBootstrapOptions = {},
): DualSandboxBootstrapSummary {
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const runId = formatRunId(createdAt);
  const ports = resolvePorts(options);
  const pluginPath = resolvePluginPath(options.pluginPath);
  const optionalLiveModel = resolveOptionalLiveModelOptions(
    options.optionalLiveModel,
  );
  const runRoot = options.rootPath
    ? prepareExplicitRoot(options.rootPath)
    : createTempRoot(runId, options.tempRootParent);
  const runtimeDir = join(runRoot, "runtime");
  const artifactsDir = join(runRoot, "artifacts");
  const logsDir = join(artifactsDir, "logs");
  const provisioningDir = join(artifactsDir, "provisioning");
  const sandboxesDir = join(artifactsDir, "sandboxes");
  const scenarioRoot = join(artifactsDir, "scenarios");
  const runtimeProvisioningPath = join(runtimeDir, "provisioning.json");
  const artifactBootstrapSummaryPath = join(
    provisioningDir,
    "bootstrap-summary.json",
  );
  const commandsLogPath = join(artifactsDir, "commands.jsonl");
  const operatorSummaryPath = join(artifactsDir, "operator-summary.md");
  const runContextPath = join(artifactsDir, "run-context.json");
  const verificationSummaryPath = join(
    artifactsDir,
    "verification-summary.json",
  );
  const scenarioPaths = buildScenarioPaths(scenarioRoot);
  const mahiloDbPath = join(runtimeDir, "mahilo", "mahilo.db");
  const mahiloLogPath = join(logsDir, "mahilo.log");

  const sandboxA = buildSandboxSummary({
    artifactsDir,
    gatewayId: "gateway-a",
    gatewayLogName: "gateway-a.log",
    gatewayPort: ports.gatewayA,
    runtimeDir,
    sandboxId: "sandbox-a",
  });
  const sandboxB = buildSandboxSummary({
    artifactsDir,
    gatewayId: "gateway-b",
    gatewayLogName: "gateway-b.log",
    gatewayPort: ports.gatewayB,
    runtimeDir,
    sandboxId: "sandbox-b",
  });

  createDirectoryTree([
    runtimeDir,
    dirname(mahiloDbPath),
    sandboxA.runtime_dir,
    sandboxA.openclaw_home,
    sandboxA.openclaw_agent_dir,
    sandboxA.openclaw_sessions_dir,
    sandboxB.runtime_dir,
    sandboxB.openclaw_home,
    sandboxB.openclaw_agent_dir,
    sandboxB.openclaw_sessions_dir,
    artifactsDir,
    logsDir,
    provisioningDir,
    sandboxesDir,
    sandboxA.artifact_dir,
    sandboxB.artifact_dir,
    ...Object.values(scenarioPaths),
  ]);

  const sandboxAConfig = buildOpenClawConfig({
    callbackUrl: sandboxA.callback_url,
    gatewayPort: sandboxA.gateway_port,
    mahiloBaseUrl: formatLoopbackUrl(ports.mahilo),
    optionalLiveModel,
    pluginPath,
  });
  const sandboxBConfig = buildOpenClawConfig({
    callbackUrl: sandboxB.callback_url,
    gatewayPort: sandboxB.gateway_port,
    mahiloBaseUrl: formatLoopbackUrl(ports.mahilo),
    optionalLiveModel,
    pluginPath,
  });

  writeJsonFile(sandboxA.openclaw_config_path, sandboxAConfig);
  writeJsonFile(sandboxB.openclaw_config_path, sandboxBConfig);
  writeJsonFile(
    sandboxA.artifact_paths.config_redacted_path,
    redactOpenClawConfig(sandboxAConfig),
  );
  writeJsonFile(
    sandboxB.artifact_paths.config_redacted_path,
    redactOpenClawConfig(sandboxBConfig),
  );
  writeJsonFile(sandboxA.runtime_state_path, EMPTY_RUNTIME_STATE);
  writeJsonFile(sandboxB.runtime_state_path, EMPTY_RUNTIME_STATE);

  if (optionalLiveModel?.copyProviderAuthFrom) {
    copyFileSync(
      optionalLiveModel.copyProviderAuthFrom,
      sandboxA.provider_auth_profiles_path,
    );
    copyFileSync(
      optionalLiveModel.copyProviderAuthFrom,
      sandboxB.provider_auth_profiles_path,
    );
  }

  const summary: DualSandboxBootstrapSummary = {
    artifact_contract_version: DUAL_SANDBOX_ARTIFACT_CONTRACT_VERSION,
    artifacts_dir: artifactsDir,
    bootstrap_contract_version: DUAL_SANDBOX_BOOTSTRAP_CONTRACT_VERSION,
    created_at: createdAt,
    mahilo: {
      base_url: formatLoopbackUrl(ports.mahilo),
      db_path: mahiloDbPath,
      log_path: mahiloLogPath,
    },
    paths: {
      artifact_bootstrap_summary_path: artifactBootstrapSummaryPath,
      commands_log_path: commandsLogPath,
      logs_dir: logsDir,
      operator_summary_path: operatorSummaryPath,
      provisioning_dir: provisioningDir,
      run_context_path: runContextPath,
      runtime_provisioning_path: runtimeProvisioningPath,
      sandboxes_dir: sandboxesDir,
      scenario_root: scenarioRoot,
      scenarios: scenarioPaths,
      verification_summary_path: verificationSummaryPath,
    },
    ports: {
      gateway_a: ports.gatewayA,
      gateway_b: ports.gatewayB,
      mahilo: ports.mahilo,
    },
    proof_inputs: {
      deterministic: {
        plugin_path: pluginPath,
        shared_mahilo_base_url: formatLoopbackUrl(ports.mahilo),
      },
      optional_live_model: buildOptionalLiveModelSummary(optionalLiveModel),
    },
    run_id: runId,
    run_root: runRoot,
    runtime_dir: runtimeDir,
    sandboxes: {
      a: sandboxA,
      b: sandboxB,
    },
  };

  writeJsonFile(runtimeProvisioningPath, summary);
  writeJsonFile(artifactBootstrapSummaryPath, summary);

  return summary;
}

function buildSandboxSummary(
  input: SandboxDescriptorInput,
): DualSandboxSummary {
  const runtimeDir = join(input.runtimeDir, input.sandboxId);
  const openclawHome = join(runtimeDir, "openclaw-home");
  const openclawAgentDir = join(
    openclawHome,
    ".openclaw",
    "agents",
    "main",
    "agent",
  );
  const openclawSessionsDir = join(
    openclawHome,
    ".openclaw",
    "agents",
    "main",
    "sessions",
  );
  const gatewayBaseUrl = formatLoopbackUrl(input.gatewayPort);
  const artifactDir = join(input.artifactsDir, "sandboxes", input.sandboxId);

  return {
    artifact_dir: artifactDir,
    artifact_paths: {
      agent_connections_path: join(artifactDir, "agent-connections.json"),
      auth_redacted_path: join(artifactDir, "auth.redacted.json"),
      config_redacted_path: join(artifactDir, "config.redacted.json"),
      plugin_list_path: join(artifactDir, "plugin-list.json"),
      runtime_state_redacted_path: join(
        artifactDir,
        "runtime-state.redacted.json",
      ),
      webhook_head_path: join(artifactDir, "webhook-head.json"),
    },
    auth_path: join(runtimeDir, "auth.json"),
    callback_url: `${gatewayBaseUrl}${WEBHOOK_PATH}`,
    env: {
      MAHILO_OPENCLAW_RUNTIME_STATE_PATH: join(
        runtimeDir,
        "runtime-state.json",
      ),
      OPENCLAW_CONFIG_PATH: join(runtimeDir, "openclaw.config.json"),
      OPENCLAW_HOME: openclawHome,
    },
    gateway_base_url: gatewayBaseUrl,
    gateway_id: input.gatewayId,
    gateway_log_path: join(input.artifactsDir, "logs", input.gatewayLogName),
    gateway_port: input.gatewayPort,
    id: input.sandboxId,
    openclaw_agent_dir: openclawAgentDir,
    openclaw_config_path: join(runtimeDir, "openclaw.config.json"),
    openclaw_home: openclawHome,
    openclaw_sessions_dir: openclawSessionsDir,
    provider_auth_profiles_path: join(
      openclawAgentDir,
      PROVIDER_AUTH_FILE_NAME,
    ),
    runtime_dir: runtimeDir,
    runtime_state_path: join(runtimeDir, "runtime-state.json"),
  };
}

function buildOptionalLiveModelSummary(
  optionalLiveModel: ResolvedOptionalLiveModelOptions | undefined,
): DualSandboxOptionalLiveModelSummary {
  return {
    configured: optionalLiveModel !== undefined,
    local_policy_llm: optionalLiveModel
      ? {
          api_key_env_var: optionalLiveModel.apiKeyEnvVar,
          auth_profile: optionalLiveModel.authProfile,
          model: optionalLiveModel.model,
          provider: optionalLiveModel.provider,
          timeout_ms: optionalLiveModel.timeoutMs,
        }
      : null,
    provider_auth_copy: {
      enabled: optionalLiveModel?.copyProviderAuthFrom !== undefined,
    },
  };
}

function buildOpenClawConfig(input: {
  callbackUrl: string;
  gatewayPort: number;
  mahiloBaseUrl: string;
  optionalLiveModel?: ResolvedOptionalLiveModelOptions;
  pluginPath: string;
}): Record<string, unknown> {
  const pluginConfig: Record<string, unknown> = {
    baseUrl: input.mahiloBaseUrl,
    callbackUrl: input.callbackUrl,
  };

  if (input.optionalLiveModel) {
    pluginConfig.localPolicyLLM = {
      ...(input.optionalLiveModel.apiKeyEnvVar
        ? {
            apiKeyEnvVar: input.optionalLiveModel.apiKeyEnvVar,
          }
        : {}),
      ...(input.optionalLiveModel.authProfile
        ? {
            authProfile: input.optionalLiveModel.authProfile,
          }
        : {}),
      ...(input.optionalLiveModel.model
        ? {
            model: input.optionalLiveModel.model,
          }
        : {}),
      ...(input.optionalLiveModel.provider
        ? {
            provider: input.optionalLiveModel.provider,
          }
        : {}),
      timeout: input.optionalLiveModel.timeoutMs,
    };
  }

  return {
    gateway: {
      auth: {
        mode: "none",
      },
      bind: "loopback",
      http: {
        endpoints: {
          chatCompletions: {
            enabled: true,
          },
        },
      },
      mode: "local",
      port: input.gatewayPort,
    },
    plugins: {
      allow: ["mahilo"],
      enabled: true,
      entries: {
        mahilo: {
          config: pluginConfig,
          enabled: true,
        },
      },
      load: {
        paths: [input.pluginPath],
      },
    },
  };
}

function buildScenarioPaths(
  scenarioRoot: string,
): Record<DualSandboxScenarioId, string> {
  return Object.fromEntries(
    DUAL_SANDBOX_SCENARIO_IDS.map((scenarioId) => [
      scenarioId,
      join(scenarioRoot, scenarioId),
    ]),
  ) as Record<DualSandboxScenarioId, string>;
}

function createDirectoryTree(paths: string[]): void {
  for (const path of paths) {
    mkdirSync(path, {
      recursive: true,
    });
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), {
    recursive: true,
  });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolvePluginPath(pluginPath: string | undefined): string {
  const resolvedPath = resolve(pluginPath ?? DEFAULT_PLUGIN_PATH);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Plugin path does not exist: ${resolvedPath}`);
  }

  return resolvedPath;
}

function resolveOptionalLiveModelOptions(
  optionalLiveModel: DualSandboxOptionalLiveModelOptions | undefined,
): ResolvedOptionalLiveModelOptions | undefined {
  if (!optionalLiveModel) {
    return undefined;
  }

  const apiKeyEnvVar = normalizeOptionalEnvVar(
    optionalLiveModel.apiKeyEnvVar,
    "optionalLiveModel.apiKeyEnvVar",
  );
  const authProfile = normalizeOptionalString(optionalLiveModel.authProfile);
  const copyProviderAuthFrom = normalizeOptionalPath(
    optionalLiveModel.copyProviderAuthFrom,
  );
  const model = normalizeOptionalString(optionalLiveModel.model);
  const provider = normalizeOptionalString(
    optionalLiveModel.provider,
  )?.toLowerCase();
  const timeoutMs = normalizePositiveInteger(
    optionalLiveModel.timeoutMs,
    DEFAULT_LOCAL_POLICY_LLM_TIMEOUT_MS,
    "optionalLiveModel.timeoutMs",
  );

  if (copyProviderAuthFrom && !authProfile) {
    throw new Error(
      "optionalLiveModel.copyProviderAuthFrom requires optionalLiveModel.authProfile so live-model auth remains explicit.",
    );
  }

  if (
    !apiKeyEnvVar &&
    !authProfile &&
    !model &&
    !provider &&
    optionalLiveModel.timeoutMs === undefined
  ) {
    return undefined;
  }

  return {
    apiKeyEnvVar,
    authProfile,
    copyProviderAuthFrom,
    model,
    provider,
    timeoutMs,
  };
}

function createTempRoot(runId: string, tempRootParent?: string): string {
  const baseDirectory = resolve(tempRootParent ?? tmpdir());
  mkdirSync(baseDirectory, {
    recursive: true,
  });

  return mkdtempSync(join(baseDirectory, `mahilo-openclaw-harness.${runId}.`));
}

function prepareExplicitRoot(rootPath: string): string {
  const resolvedRoot = resolve(rootPath);
  if (existsSync(resolvedRoot)) {
    throw new Error(
      `Refusing to reuse existing sandbox root ${resolvedRoot}. Pass a fresh path instead.`,
    );
  }

  mkdirSync(dirname(resolvedRoot), {
    recursive: true,
  });
  mkdirSync(resolvedRoot, {
    recursive: false,
  });

  return resolvedRoot;
}

function resolvePorts(options: DualSandboxBootstrapOptions): ResolvedPorts {
  const mahilo = normalizePort(
    options.mahiloPort,
    DEFAULT_PORTS.mahilo,
    "mahilo",
  );
  const gatewayA = normalizePort(
    options.gatewayAPort,
    DEFAULT_PORTS.gatewayA,
    "gateway-a",
  );
  const gatewayB = normalizePort(
    options.gatewayBPort,
    DEFAULT_PORTS.gatewayB,
    "gateway-b",
  );

  assertDistinctPorts([
    ["mahilo", mahilo],
    ["gateway-a", gatewayA],
    ["gateway-b", gatewayB],
  ]);

  return {
    gatewayA,
    gatewayB,
    mahilo,
  };
}

function normalizePort(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${label} port must be an integer between 1 and 65535`);
  }

  return value;
}

function assertDistinctPorts(entries: Array<[string, number]>): void {
  const duplicates = new Map<number, string[]>();

  for (const [label, port] of entries) {
    const labels = duplicates.get(port) ?? [];
    labels.push(label);
    duplicates.set(port, labels);
  }

  const collisions = [...duplicates.entries()].filter(
    ([, labels]) => labels.length > 1,
  );

  if (collisions.length === 0) {
    return;
  }

  throw new Error(
    `Configured ports must be distinct. Collisions: ${collisions
      .map(([port, labels]) => `${port} (${labels.join(", ")})`)
      .join("; ")}`,
  );
}

function formatLoopbackUrl(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}`;
}

function formatRunId(createdAt: string): string {
  return createdAt.replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
}

function normalizeOptionalString(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalPath(path: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(path);
  if (!trimmed) {
    return undefined;
  }

  const resolvedPath = resolve(trimmed);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }

  return resolvedPath;
}

function normalizeOptionalEnvVar(
  value: string | undefined,
  label: string,
): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`${label} must be a valid env var name`);
  }

  return trimmed;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return value;
}

function redactOpenClawConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const gateway = readRecord(config.gateway);
  const plugins = readRecord(config.plugins);
  const entries = readRecord(plugins.entries);
  const mahilo = readRecord(entries.mahilo);
  const pluginConfig = readRecord(mahilo.config);
  const localPolicyLLM = pluginConfig.localPolicyLLM
    ? readRecord(pluginConfig.localPolicyLLM)
    : undefined;

  return {
    ...config,
    gateway,
    plugins: {
      ...plugins,
      entries: {
        ...entries,
        mahilo: {
          ...mahilo,
          config: {
            ...pluginConfig,
            ...(localPolicyLLM
              ? {
                  localPolicyLLM: {
                    ...localPolicyLLM,
                    ...(typeof localPolicyLLM.apiKey === "string"
                      ? {
                          apiKey: maskSecret(localPolicyLLM.apiKey),
                        }
                      : {}),
                  },
                }
              : {}),
            ...(typeof pluginConfig.apiKey === "string"
              ? {
                  apiKey: maskSecret(pluginConfig.apiKey),
                }
              : {}),
          },
        },
      },
    },
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "***";
  }

  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}
