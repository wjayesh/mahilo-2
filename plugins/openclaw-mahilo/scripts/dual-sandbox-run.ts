import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DUAL_SANDBOX_SCENARIO_IDS,
  createDualSandboxBootstrap,
  type DualSandboxBootstrapOptions,
  type DualSandboxBootstrapSummary,
  type DualSandboxScenarioId,
} from "./dual-sandbox-bootstrap-lib";
import {
  connectDualSandboxGateways,
  type DualSandboxConnectedRunSummary,
  type DualSandboxConnectOptions,
} from "./dual-sandbox-connections-lib";
import {
  createDualSandboxProcessPlan,
  startProcess,
  stopDualSandboxProcesses,
  type DualSandboxManagedProcess,
  type DualSandboxProcessId,
  type DualSandboxProcessPlan,
  type DualSandboxProcessPlanEntry,
  type DualSandboxProcessPlanOptions,
  type DualSandboxProcessStopResult,
} from "./dual-sandbox-lifecycle-lib";
import {
  seedDualSandboxPolicyScenarios,
  type DualSandboxPolicyScenarioOptions,
  type DualSandboxPolicyScenarioRunSummary,
} from "./dual-sandbox-policy-scenarios-lib";
import {
  provisionDualSandboxUsers,
  type DualSandboxProvisionOptions,
  type DualSandboxProvisionedRunSummary,
} from "./dual-sandbox-provision-lib";
import {
  setupDualSandboxRelationships,
  type DualSandboxRelationshipOptions,
  type DualSandboxRelationshipRunSummary,
} from "./dual-sandbox-relationships-lib";

const DEFAULT_ADMIN_API_KEY = "sandbox-admin-key";
const DEFAULT_AGENT_TURN_MODEL = "gpt-4o-mini";
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PLUGIN_ROOT, "..", "..");
const REQUIRED_PLUGIN_STRINGS = [
  "mahilo",
  "ask_network",
  "manage_network",
  "send_message",
  "set_boundaries",
] as const;

type HarnessStatus = "passed" | "failed" | "pending" | "skipped_optional";

type SandboxId = "a" | "b";

interface ParsedCliArgs extends DualSandboxRunOptions {}

export interface DualSandboxRunOptions extends DualSandboxBootstrapOptions {
  adminApiKey?: string;
  entryCommand?: string[];
  openClawCheckoutPath?: string;
  skipAgentTurn?: boolean;
}

export interface DualSandboxEvidenceEntry {
  path: string;
  related_ids?: Record<string, string | null>;
  role: string;
  source_kind: "artifact" | "command" | "gateway_session" | "runtime";
}

export interface DualSandboxScenarioResultRecord {
  correlation: {
    blocked_event_id: string | null;
    message_id: string | null;
    resolution_id: string | null;
    review_id: string | null;
  };
  expected_outcome: string;
  finished_at: string | null;
  id: DualSandboxScenarioId;
  observed_outcome: string | null;
  profile: "baseline";
  reason_codes: string[];
  started_at: string | null;
  status: HarnessStatus;
  summary: string;
}

export interface DualSandboxSmokeCheckRecord {
  evidence: DualSandboxEvidenceEntry[];
  finished_at: string | null;
  id: "deterministic-smoke" | "plugin-load" | "agent-turn-smoke";
  profile: "baseline" | "optional";
  started_at: string | null;
  status: HarnessStatus;
  summary: string;
}

export interface DualSandboxRunContextRecord {
  artifact_contract_version: number;
  artifacts_dir: string;
  base_urls: {
    gateway_a: string;
    gateway_b: string;
    mahilo: string;
  };
  created_at: string;
  entry_command: string[];
  finished_at: string | null;
  openclaw: {
    checkout_path: string | null;
    plugin_path: string;
  };
  paths: {
    commands_log: string;
    operator_summary: string;
    run_context: string;
    verification_summary: string;
  };
  ports: DualSandboxBootstrapSummary["ports"];
  proof_profile: {
    deterministic_smoke: true;
    optional_agent_turn: boolean;
  };
  provisioning_mode: "api";
  run_id: string;
  run_root: string;
  runtime_dir: string;
  status: "failed" | "passed" | "running";
  trusted_mode: false;
  updated_at: string;
  workspace_root: string;
  error?: {
    message: string;
    stage: string;
  };
  process_launches?: Record<
    DualSandboxProcessId,
    {
      args: string[];
      command: string;
      cwd: string;
      env: Record<string, string | undefined>;
    }
  >;
}

export interface DualSandboxVerificationSummary {
  artifact_contract_version: number;
  error: {
    message: string;
    stage: string;
  } | null;
  overall: {
    agent_turn_smoke: HarnessStatus;
    deterministic_smoke: HarnessStatus;
    runner: "failed" | "passed";
  };
  run_id: string;
  scenarios: DualSandboxScenarioResultRecord[];
  smoke_checks: DualSandboxSmokeCheckRecord[];
}

export interface DualSandboxRunResult {
  bootstrap: DualSandboxBootstrapSummary;
  exit_code: 0 | 1;
  operator_summary_path: string;
  run_root: string;
  verification_summary_path: string;
}

export interface DualSandboxRunnerDeps {
  buildPlugin: (input: {
    bootstrap: DualSandboxBootstrapSummary;
    logger: JsonLinesLogger;
  }) => Promise<void>;
  connect: (
    summary: DualSandboxProvisionedRunSummary,
    options: DualSandboxConnectOptions,
  ) => Promise<DualSandboxConnectedRunSummary>;
  createBootstrap: (
    options: DualSandboxBootstrapOptions,
  ) => DualSandboxBootstrapSummary;
  createProcessPlan: (
    bootstrap: DualSandboxBootstrapSummary,
    options: DualSandboxProcessPlanOptions,
  ) => DualSandboxProcessPlan;
  provision: (
    summary: DualSandboxBootstrapSummary,
    options: DualSandboxProvisionOptions,
  ) => Promise<DualSandboxProvisionedRunSummary>;
  runAgentTurnSmoke: (input: {
    bootstrap: DualSandboxPolicyScenarioRunSummary;
    fetchImpl: typeof fetch;
    logger: JsonLinesLogger;
    skipAgentTurn: boolean;
  }) => Promise<DualSandboxSmokeCheckRecord>;
  runDeterministicSmoke: (input: {
    bootstrap: DualSandboxPolicyScenarioRunSummary;
    fetchImpl: typeof fetch;
    logger: JsonLinesLogger;
  }) => Promise<DualSandboxSmokeCheckRecord>;
  seedPolicyScenarios: (
    summary: DualSandboxRelationshipRunSummary,
    options: DualSandboxPolicyScenarioOptions,
  ) => Promise<DualSandboxPolicyScenarioRunSummary>;
  setupRelationships: (
    summary: DualSandboxConnectedRunSummary,
    options: DualSandboxRelationshipOptions,
  ) => Promise<DualSandboxRelationshipRunSummary>;
  startProcess: (
    entry: DualSandboxProcessPlanEntry,
    options?: Parameters<typeof startProcess>[1],
  ) => Promise<DualSandboxManagedProcess>;
  stopProcesses: (
    processes: Partial<Record<DualSandboxProcessId, DualSandboxManagedProcess>>,
    options?: Parameters<typeof stopDualSandboxProcesses>[1],
  ) => Promise<
    Partial<Record<DualSandboxProcessId, DualSandboxProcessStopResult>>
  >;
  verifyPluginLoad: (input: {
    bootstrap: DualSandboxBootstrapSummary;
    logger: JsonLinesLogger;
    openClawCheckoutPath?: string;
  }) => Promise<DualSandboxSmokeCheckRecord>;
}

const DEFAULT_DEPS: DualSandboxRunnerDeps = {
  buildPlugin: defaultBuildPlugin,
  connect: connectDualSandboxGateways,
  createBootstrap: createDualSandboxBootstrap,
  createProcessPlan: createDualSandboxProcessPlan,
  provision: provisionDualSandboxUsers,
  runAgentTurnSmoke: defaultRunAgentTurnSmoke,
  runDeterministicSmoke: defaultRunDeterministicSmoke,
  seedPolicyScenarios: seedDualSandboxPolicyScenarios,
  setupRelationships: setupDualSandboxRelationships,
  startProcess,
  stopProcesses: stopDualSandboxProcesses,
  verifyPluginLoad: defaultVerifyPluginLoad,
};

class JsonLinesLogger {
  constructor(private readonly filePath: string) {}

  append(record: Record<string, unknown>): void {
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }
}

export async function runDualSandboxHarness(
  options: DualSandboxRunOptions = {},
  deps: Partial<DualSandboxRunnerDeps> = {},
): Promise<DualSandboxRunResult> {
  const mergedDeps: DualSandboxRunnerDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };
  const bootstrap = mergedDeps.createBootstrap({
    gatewayAPort: options.gatewayAPort,
    gatewayBPort: options.gatewayBPort,
    mahiloPort: options.mahiloPort,
    now: options.now,
    optionalLiveModel: options.optionalLiveModel,
    pluginPath: options.pluginPath,
    rootPath: options.rootPath,
    tempRootParent: options.tempRootParent,
  });
  const logger = new JsonLinesLogger(bootstrap.paths.commands_log_path);
  const adminApiKey =
    normalizeOptionalString(options.adminApiKey) ??
    normalizeOptionalString(process.env.ADMIN_API_KEY) ??
    DEFAULT_ADMIN_API_KEY;
  const fetchImpl = createLoggingFetch(logger, fetch, bootstrap.run_root);
  const entryCommand = options.entryCommand ?? readDefaultEntryCommand();
  const initialContext = buildRunContextRecord(bootstrap, {
    entryCommand,
    openClawCheckoutPath:
      normalizeOptionalString(options.openClawCheckoutPath) ?? null,
    status: "running",
  });
  const scenarioResults = initializeScenarioResults(bootstrap);
  const smokeChecks: DualSandboxSmokeCheckRecord[] = [];
  const processPlanOptions: DualSandboxProcessPlanOptions = {
    adminApiKey,
    mahiloEnv: {
      TRUSTED_MODE: "false",
    },
    openClawCheckoutPath: normalizeOptionalString(options.openClawCheckoutPath),
  };
  const startOptions = {
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    timeoutMs: DEFAULT_READINESS_TIMEOUT_MS,
  } satisfies Parameters<typeof startProcess>[1];

  let processPlan: DualSandboxProcessPlan | null = null;
  let startedProcesses: Partial<
    Record<DualSandboxProcessId, DualSandboxManagedProcess>
  > = {};
  let baselineError: {
    message: string;
    stage: string;
  } | null = null;
  let optionalAgentTurnError: {
    message: string;
    stage: string;
  } | null = null;
  let deterministicSmokeStatus: HarnessStatus = "pending";
  let agentTurnSmokeStatus: HarnessStatus = "pending";
  let currentStage = "bootstrap";

  writeJsonFile(bootstrap.paths.run_context_path, initialContext);

  try {
    logger.append({
      kind: "stage",
      stage: "bootstrap",
      started_at: bootstrap.created_at,
      status: "passed",
    });

    currentStage = "build_plugin";
    await mergedDeps.buildPlugin({
      bootstrap,
      logger,
    });

    currentStage = "create_process_plan";
    processPlan = mergedDeps.createProcessPlan(bootstrap, processPlanOptions);
    writeJsonFile(
      bootstrap.paths.run_context_path,
      buildRunContextRecord(bootstrap, {
        entryCommand,
        openClawCheckoutPath:
          normalizeOptionalString(options.openClawCheckoutPath) ?? null,
        processPlan,
        status: "running",
      }),
    );

    currentStage = "start_mahilo";
    startedProcesses.mahilo = await startManagedProcess(
      mergedDeps,
      logger,
      processPlan.mahilo,
      startOptions,
      bootstrap.run_root,
    );

    currentStage = "provision";
    const provisioned = await mergedDeps.provision(bootstrap, {
      adminApiKey,
      fetchImpl,
      mahiloBaseUrl: bootstrap.mahilo.base_url,
      now: options.now,
    });
    currentStage = "connect";
    const connected = await mergedDeps.connect(provisioned, {
      fetchImpl,
      mahiloBaseUrl: bootstrap.mahilo.base_url,
      now: options.now,
    });
    currentStage = "relationships";
    const relationships = await mergedDeps.setupRelationships(connected, {
      fetchImpl,
      mahiloBaseUrl: bootstrap.mahilo.base_url,
      now: options.now,
    });
    currentStage = "policy_scenarios";
    const policySummary = await mergedDeps.seedPolicyScenarios(relationships, {
      fetchImpl,
      mahiloBaseUrl: bootstrap.mahilo.base_url,
      now: options.now,
    });

    hydratePendingScenarioResults(bootstrap, scenarioResults, policySummary);

    currentStage = "start_gateway_a";
    startedProcesses.gateway_a = await startManagedProcess(
      mergedDeps,
      logger,
      processPlan.gateway_a,
      startOptions,
      bootstrap.run_root,
    );
    currentStage = "start_gateway_b";
    startedProcesses.gateway_b = await startManagedProcess(
      mergedDeps,
      logger,
      processPlan.gateway_b,
      startOptions,
      bootstrap.run_root,
    );

    currentStage = "verify_plugin_load";
    const pluginLoadCheck = await mergedDeps.verifyPluginLoad({
      bootstrap,
      logger,
      openClawCheckoutPath: normalizeOptionalString(
        options.openClawCheckoutPath,
      ),
    });
    smokeChecks.push(pluginLoadCheck);
    updateScenarioResult(
      bootstrap,
      scenarioResults,
      "G1",
      buildScenarioResultRecord({
        expectedOutcome:
          "Mahilo plugin loads in both sandboxes and /mahilo/incoming responds on both gateways.",
        id: "G1",
        observedOutcome:
          pluginLoadCheck.status === "passed"
            ? "Plugin list and webhook readiness verified on both gateways."
            : pluginLoadCheck.summary,
        reasonCodes: [],
        startedAt: pluginLoadCheck.started_at,
        status: pluginLoadCheck.status,
        summary: pluginLoadCheck.summary,
      }),
      pluginLoadCheck.evidence,
    );

    updateScenarioResult(
      bootstrap,
      scenarioResults,
      "G2",
      buildScenarioResultRecord({
        expectedOutcome:
          "Runtime bootstrap, Mahilo registration, and webhook readiness are aligned for both sandboxes.",
        id: "G2",
        observedOutcome:
          "Runtime-state artifacts, agent registrations, and webhook readiness all point at the expected Mahilo identities.",
        reasonCodes: [],
        status: "passed",
        summary:
          "Runtime bootstrap and Mahilo registration artifacts are present for both sandboxes.",
      }),
      [
        buildEvidenceEntry(
          bootstrap,
          bootstrap.sandboxes.a.artifact_paths.runtime_state_redacted_path,
          "runtime_state_sandbox_a",
          "artifact",
        ),
        buildEvidenceEntry(
          bootstrap,
          bootstrap.sandboxes.b.artifact_paths.runtime_state_redacted_path,
          "runtime_state_sandbox_b",
          "artifact",
        ),
        buildEvidenceEntry(
          bootstrap,
          bootstrap.sandboxes.a.artifact_paths.agent_connections_path,
          "agent_connections_sandbox_a",
          "artifact",
        ),
        buildEvidenceEntry(
          bootstrap,
          bootstrap.sandboxes.b.artifact_paths.agent_connections_path,
          "agent_connections_sandbox_b",
          "artifact",
        ),
        buildEvidenceEntry(
          bootstrap,
          join(bootstrap.paths.provisioning_dir, "process-readiness.json"),
          "process_readiness",
          "artifact",
        ),
      ],
    );

    currentStage = "deterministic_smoke";
    const deterministicSmoke = await mergedDeps.runDeterministicSmoke({
      bootstrap: policySummary,
      fetchImpl,
      logger,
    });
    smokeChecks.push(deterministicSmoke);
    deterministicSmokeStatus = deterministicSmoke.status;

    updateScenarioResult(
      bootstrap,
      scenarioResults,
      "G3",
      buildScenarioResultRecord({
        expectedOutcome:
          "The sender and receiver are accepted contacts and both gateways can inspect that network state before later send checks run.",
        id: "G3",
        observedOutcome:
          deterministicSmoke.status === "passed"
            ? "Friendship setup is accepted and both gateways can list their Mahilo network."
            : deterministicSmoke.summary,
        reasonCodes: [],
        startedAt: deterministicSmoke.started_at,
        status: deterministicSmoke.status,
        summary: `${
          readJsonFieldAsString(
            join(bootstrap.paths.provisioning_dir, "friendship-summary.json"),
            ["friendship", "accept", "status"],
          ) === "accepted"
            ? "Friendship accepted. "
            : ""
        }${deterministicSmoke.summary}`,
      }),
      [
        buildEvidenceEntry(
          bootstrap,
          join(bootstrap.paths.provisioning_dir, "friendship-summary.json"),
          "friendship_summary",
          "artifact",
        ),
        ...deterministicSmoke.evidence,
      ],
    );

    try {
      currentStage = "agent_turn_smoke";
      const agentTurnSmoke = await mergedDeps.runAgentTurnSmoke({
        bootstrap: policySummary,
        fetchImpl,
        logger,
        skipAgentTurn: options.skipAgentTurn === true,
      });
      smokeChecks.push(agentTurnSmoke);
      agentTurnSmokeStatus = agentTurnSmoke.status;
    } catch (error) {
      optionalAgentTurnError = {
        message: toErrorMessage(error),
        stage: "agent_turn_smoke",
      };
      const failedSmoke = buildSmokeCheckRecord({
        id: "agent-turn-smoke",
        profile: "optional",
        status: "failed",
        summary: optionalAgentTurnError.message,
      });
      smokeChecks.push(failedSmoke);
      agentTurnSmokeStatus = "failed";
      logger.append({
        error: optionalAgentTurnError.message,
        kind: "stage",
        stage: "agent_turn_smoke",
        status: "failed",
      });
    }
  } catch (error) {
    baselineError = {
      message: toErrorMessage(error),
      stage: currentStage,
    };
    logger.append({
      error: baselineError.message,
      kind: "stage",
      stage: baselineError.stage,
      status: "failed",
    });
  } finally {
    const stopResults = await mergedDeps.stopProcesses(startedProcesses, {
      killPollAttempts: 10,
      killPollIntervalMs: 500,
      waitForPortReleaseMs: 5_000,
    });

    for (const [processId, stopResult] of Object.entries(stopResults)) {
      logger.append({
        kind: "process_stop",
        process_id: processId,
        result: stopResult,
        status: "passed",
      });
    }

    const verificationSummary: DualSandboxVerificationSummary = {
      artifact_contract_version: bootstrap.artifact_contract_version,
      error: baselineError,
      overall: {
        agent_turn_smoke:
          baselineError !== null
            ? "pending"
            : optionalAgentTurnError
              ? "failed"
              : agentTurnSmokeStatus,
        deterministic_smoke:
          baselineError !== null ? "failed" : deterministicSmokeStatus,
        runner: baselineError ? "failed" : "passed",
      },
      run_id: bootstrap.run_id,
      scenarios: [...scenarioResults.values()],
      smoke_checks: smokeChecks,
    };

    writeJsonFile(
      bootstrap.paths.verification_summary_path,
      verificationSummary,
    );
    writeFileSync(
      bootstrap.paths.operator_summary_path,
      buildOperatorSummary({
        agentTurnSmokeStatus:
          optionalAgentTurnError?.stage === "agent_turn_smoke"
            ? "failed"
            : agentTurnSmokeStatus,
        baselineError,
        bootstrap,
        deterministicSmokeStatus,
        optionalAgentTurnError,
      }),
      "utf8",
    );
    writeJsonFile(
      bootstrap.paths.run_context_path,
      buildRunContextRecord(bootstrap, {
        entryCommand,
        error: baselineError,
        finishedAt: new Date().toISOString(),
        openClawCheckoutPath:
          normalizeOptionalString(options.openClawCheckoutPath) ?? null,
        processPlan,
        status: baselineError ? "failed" : "passed",
      }),
    );
  }

  return {
    bootstrap,
    exit_code: baselineError ? 1 : 0,
    operator_summary_path: bootstrap.paths.operator_summary_path,
    run_root: bootstrap.run_root,
    verification_summary_path: bootstrap.paths.verification_summary_path,
  };
}

function initializeScenarioResults(
  bootstrap: DualSandboxBootstrapSummary,
): Map<DualSandboxScenarioId, DualSandboxScenarioResultRecord> {
  const results = new Map<
    DualSandboxScenarioId,
    DualSandboxScenarioResultRecord
  >();

  for (const scenarioId of DUAL_SANDBOX_SCENARIO_IDS) {
    const result = buildScenarioResultRecord({
      expectedOutcome: readScenarioExpectation(scenarioId),
      id: scenarioId,
      observedOutcome: null,
      reasonCodes: [],
      status: "pending",
      summary: readPendingScenarioSummary(scenarioId),
    });
    results.set(scenarioId, result);
    writeScenarioArtifacts(bootstrap, result, []);
  }

  return results;
}

function hydratePendingScenarioResults(
  bootstrap: DualSandboxBootstrapSummary,
  scenarioResults: Map<DualSandboxScenarioId, DualSandboxScenarioResultRecord>,
  policySummary: DualSandboxPolicyScenarioRunSummary,
): void {
  const policySummaryPath = join(
    bootstrap.paths.provisioning_dir,
    "policy-summary.json",
  );

  for (const scenarioId of [
    "S2-allow",
    "S3-ask",
    "S4-deny",
    "S5-missing-llm-key",
  ] as const) {
    const scenario =
      policySummary.policy_scenarios.scenario_mapping[scenarioId];
    if (!scenario) {
      continue;
    }

    updateScenarioResult(
      bootstrap,
      scenarioResults,
      scenarioId,
      buildScenarioResultRecord({
        expectedOutcome: `${scenario.expected_resolution.decision} (${scenario.expected_resolution.reason_code})`,
        id: scenarioId,
        observedOutcome: null,
        reasonCodes: [scenario.expected_resolution.reason_code],
        status: "pending",
        summary:
          "Fixture seeded. Direct send execution is intentionally deferred to SBX-031 so this runner stays focused on orchestration and smoke-proofing.",
      }),
      [
        buildEvidenceEntry(
          bootstrap,
          policySummaryPath,
          "policy_summary",
          "artifact",
        ),
      ],
    );
  }
}

function updateScenarioResult(
  bootstrap: DualSandboxBootstrapSummary,
  scenarioResults: Map<DualSandboxScenarioId, DualSandboxScenarioResultRecord>,
  scenarioId: DualSandboxScenarioId,
  result: DualSandboxScenarioResultRecord,
  evidence: DualSandboxEvidenceEntry[],
): void {
  scenarioResults.set(scenarioId, result);
  writeScenarioArtifacts(bootstrap, result, evidence);
}

function writeScenarioArtifacts(
  bootstrap: DualSandboxBootstrapSummary,
  result: DualSandboxScenarioResultRecord,
  evidence: DualSandboxEvidenceEntry[],
): void {
  const scenarioDir = bootstrap.paths.scenarios[result.id];
  writeJsonFile(join(scenarioDir, "result.json"), result);
  writeJsonFile(join(scenarioDir, "evidence-index.json"), {
    entries: evidence,
    scenario_id: result.id,
  });
}

function buildScenarioResultRecord(input: {
  expectedOutcome: string;
  id: DualSandboxScenarioId;
  observedOutcome: string | null;
  reasonCodes: string[];
  startedAt?: string | null;
  status: HarnessStatus;
  summary: string;
}): DualSandboxScenarioResultRecord {
  const finishedAt =
    input.status === "pending" ? null : new Date().toISOString();

  return {
    correlation: {
      blocked_event_id: null,
      message_id: null,
      resolution_id: null,
      review_id: null,
    },
    expected_outcome: input.expectedOutcome,
    finished_at: finishedAt,
    id: input.id,
    observed_outcome: input.observedOutcome,
    profile: "baseline",
    reason_codes: input.reasonCodes,
    started_at: input.startedAt ?? null,
    status: input.status,
    summary: input.summary,
  };
}

function buildSmokeCheckRecord(input: {
  evidence?: DualSandboxEvidenceEntry[];
  finishedAt?: string | null;
  id: DualSandboxSmokeCheckRecord["id"];
  profile: DualSandboxSmokeCheckRecord["profile"];
  startedAt?: string | null;
  status: HarnessStatus;
  summary: string;
}): DualSandboxSmokeCheckRecord {
  return {
    evidence: input.evidence ?? [],
    finished_at:
      input.finishedAt ??
      (input.status === "pending" ? null : new Date().toISOString()),
    id: input.id,
    profile: input.profile,
    started_at: input.startedAt ?? null,
    status: input.status,
    summary: input.summary,
  };
}

function buildRunContextRecord(
  bootstrap: DualSandboxBootstrapSummary,
  input: {
    entryCommand: string[];
    error?: {
      message: string;
      stage: string;
    } | null;
    finishedAt?: string;
    openClawCheckoutPath: string | null;
    processPlan?: DualSandboxProcessPlan | null;
    status: DualSandboxRunContextRecord["status"];
  },
): DualSandboxRunContextRecord {
  return {
    artifact_contract_version: bootstrap.artifact_contract_version,
    artifacts_dir: bootstrap.artifacts_dir,
    base_urls: {
      gateway_a: bootstrap.sandboxes.a.gateway_base_url,
      gateway_b: bootstrap.sandboxes.b.gateway_base_url,
      mahilo: bootstrap.mahilo.base_url,
    },
    created_at: bootstrap.created_at,
    entry_command: input.entryCommand,
    finished_at: input.finishedAt ?? null,
    openclaw: {
      checkout_path: input.openClawCheckoutPath,
      plugin_path: bootstrap.proof_inputs.deterministic.plugin_path,
    },
    paths: {
      commands_log: bootstrap.paths.commands_log_path,
      operator_summary: bootstrap.paths.operator_summary_path,
      run_context: bootstrap.paths.run_context_path,
      verification_summary: bootstrap.paths.verification_summary_path,
    },
    ports: bootstrap.ports,
    proof_profile: {
      deterministic_smoke: true,
      optional_agent_turn:
        bootstrap.proof_inputs.optional_live_model.configured,
    },
    provisioning_mode: "api",
    run_id: bootstrap.run_id,
    run_root: bootstrap.run_root,
    runtime_dir: bootstrap.runtime_dir,
    status: input.status,
    trusted_mode: false,
    updated_at: new Date().toISOString(),
    workspace_root: REPO_ROOT,
    ...(input.error
      ? {
          error: input.error,
        }
      : {}),
    ...(input.processPlan
      ? {
          process_launches: {
            gateway_a: serializeLaunch(input.processPlan.gateway_a),
            gateway_b: serializeLaunch(input.processPlan.gateway_b),
            mahilo: serializeLaunch(input.processPlan.mahilo),
          },
        }
      : {}),
  };
}

function serializeLaunch(entry: DualSandboxProcessPlanEntry) {
  return {
    args: entry.launch.args,
    command: entry.launch.command,
    cwd: entry.launch.cwd,
    env: redactRecord(entry.launch.env),
  };
}

async function startManagedProcess(
  deps: DualSandboxRunnerDeps,
  logger: JsonLinesLogger,
  entry: DualSandboxProcessPlanEntry,
  options: Parameters<typeof startProcess>[1],
  runRoot: string,
): Promise<DualSandboxManagedProcess> {
  logger.append({
    args: entry.launch.args,
    command: entry.launch.command,
    cwd: entry.launch.cwd,
    env: redactRecord(entry.launch.env),
    kind: "process_start",
    process_id: entry.id,
    readiness_url: entry.readiness.url,
    status: "running",
  });

  const processHandle = await deps.startProcess(entry, options);

  logger.append({
    kind: "process_start",
    pid: processHandle.pid,
    process_id: entry.id,
    readiness: processHandle.readiness,
    readiness_artifact: relative(runRoot, entry.readiness.artifact_path),
    status: "passed",
  });

  return processHandle;
}

async function defaultBuildPlugin(input: {
  bootstrap: DualSandboxBootstrapSummary;
  logger: JsonLinesLogger;
}): Promise<void> {
  const combinedOutputPath = join(
    input.bootstrap.paths.logs_dir,
    "plugin-build.log",
  );
  const result = await runCommand({
    args: ["run", "build"],
    command: process.execPath,
    combinedOutputPath,
    cwd: PLUGIN_ROOT,
    env: {},
    logger: input.logger,
    runRoot: input.bootstrap.run_root,
    stepId: "build_plugin",
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Mahilo OpenClaw plugin build failed with exit code ${result.exitCode}. See ${combinedOutputPath}.`,
    );
  }
}

async function defaultVerifyPluginLoad(input: {
  bootstrap: DualSandboxBootstrapSummary;
  logger: JsonLinesLogger;
  openClawCheckoutPath?: string;
}): Promise<DualSandboxSmokeCheckRecord> {
  const startedAt = new Date().toISOString();
  const openClawCheckoutPath = resolveOpenClawCheckoutPath(
    input.openClawCheckoutPath,
  );
  const evidence: DualSandboxEvidenceEntry[] = [];

  for (const sandboxId of ["a", "b"] as const) {
    const sandbox = input.bootstrap.sandboxes[sandboxId];
    const stderrPath = join(sandbox.artifact_dir, "plugin-list.stderr.log");
    const result = await runCommand({
      args: [
        "--dir",
        openClawCheckoutPath,
        "openclaw",
        "plugins",
        "list",
        "--json",
      ],
      command: "pnpm",
      cwd: REPO_ROOT,
      env: sandbox.env,
      logger: input.logger,
      runRoot: input.bootstrap.run_root,
      stderrPath,
      stepId: `plugin_list_sandbox_${sandboxId}`,
      stdoutPath: sandbox.artifact_paths.plugin_list_path,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `OpenClaw plugin list failed for sandbox ${sandboxId}. See ${stderrPath}.`,
      );
    }

    const parsed = parseJsonFile(sandbox.artifact_paths.plugin_list_path);
    const strings = collectStringValues(parsed).map((value) =>
      value.toLowerCase(),
    );
    const missing = REQUIRED_PLUGIN_STRINGS.filter(
      (value) => !strings.includes(value.toLowerCase()),
    );
    if (missing.length > 0) {
      throw new Error(
        `Sandbox ${sandboxId} plugin list did not expose expected Mahilo strings: ${missing.join(", ")}.`,
      );
    }

    evidence.push(
      buildEvidenceEntry(
        input.bootstrap,
        sandbox.artifact_paths.plugin_list_path,
        `plugin_list_sandbox_${sandboxId}`,
        "artifact",
      ),
    );
    evidence.push(
      buildEvidenceEntry(
        input.bootstrap,
        sandbox.artifact_paths.webhook_head_path,
        `webhook_head_sandbox_${sandboxId}`,
        "artifact",
      ),
    );
  }

  return buildSmokeCheckRecord({
    evidence,
    finishedAt: new Date().toISOString(),
    id: "plugin-load",
    profile: "baseline",
    startedAt,
    status: "passed",
    summary:
      "Both OpenClaw sandboxes list the Mahilo plugin with the expected tool names and both /mahilo/incoming routes answered readiness checks.",
  });
}

async function defaultRunDeterministicSmoke(input: {
  bootstrap: DualSandboxPolicyScenarioRunSummary;
  fetchImpl: typeof fetch;
  logger: JsonLinesLogger;
}): Promise<DualSandboxSmokeCheckRecord> {
  const startedAt = new Date().toISOString();
  const evidence: DualSandboxEvidenceEntry[] = [];

  for (const sandboxId of ["a", "b"] as const) {
    const sandbox = input.bootstrap.sandboxes[sandboxId];
    const outputPath = join(sandbox.artifact_dir, "manage-network-list.json");
    await invokeGatewayJson({
      body: {
        args: {
          action: "list",
        },
        sessionKey: "main",
        tool: "manage_network",
      },
      fetchImpl: input.fetchImpl,
      logger: input.logger,
      runRoot: input.bootstrap.run_root,
      stepId: `deterministic_manage_network_${sandboxId}`,
      url: `${sandbox.gateway_base_url}/tools/invoke`,
      writePath: outputPath,
    });

    evidence.push(
      buildEvidenceEntry(
        input.bootstrap,
        outputPath,
        `manage_network_sandbox_${sandboxId}`,
        "artifact",
      ),
    );
  }

  return buildSmokeCheckRecord({
    evidence,
    finishedAt: new Date().toISOString(),
    id: "deterministic-smoke",
    profile: "baseline",
    startedAt,
    status: "passed",
    summary:
      "Direct no-model manage_network list succeeded on both sandboxes after friendship setup.",
  });
}

async function defaultRunAgentTurnSmoke(input: {
  bootstrap: DualSandboxPolicyScenarioRunSummary;
  fetchImpl: typeof fetch;
  logger: JsonLinesLogger;
  skipAgentTurn: boolean;
}): Promise<DualSandboxSmokeCheckRecord> {
  if (input.skipAgentTurn) {
    return buildSmokeCheckRecord({
      id: "agent-turn-smoke",
      profile: "optional",
      startedAt: null,
      status: "skipped_optional",
      summary:
        "Optional agent-turn smoke was skipped because --skip-agent-turn true was supplied.",
    });
  }

  const model =
    input.bootstrap.proof_inputs.optional_live_model.local_policy_llm?.model ??
    DEFAULT_AGENT_TURN_MODEL;
  if (!input.bootstrap.proof_inputs.optional_live_model.configured) {
    return buildSmokeCheckRecord({
      id: "agent-turn-smoke",
      profile: "optional",
      startedAt: null,
      status: "skipped_optional",
      summary:
        "Optional live-model inputs were not configured, so the prompt-driven OpenClaw smoke was skipped.",
    });
  }

  const startedAt = new Date().toISOString();
  const optionalDir = join(input.bootstrap.artifacts_dir, "optional");
  mkdirSync(optionalDir, {
    recursive: true,
  });

  const sessionKey = `agent-turn-${input.bootstrap.run_id}`;
  const responsePath = join(optionalDir, "agent-turn-response.json");
  const transcriptSearchPath = join(
    optionalDir,
    "agent-turn-transcript-search.json",
  );
  const sessionSnapshot = snapshotDirectory(
    input.bootstrap.sandboxes.a.openclaw_sessions_dir,
  );

  await invokeGatewayJson({
    body: {
      messages: [
        {
          content:
            "Use the manage_network tool to list my Mahilo contacts, then tell me in one sentence how many accepted contacts I have.",
          role: "user",
        },
      ],
      model,
      stream: false,
    },
    fetchImpl: input.fetchImpl,
    headers: {
      "x-openclaw-session-key": sessionKey,
    },
    logger: input.logger,
    runRoot: input.bootstrap.run_root,
    stepId: "agent_turn_chat_completions",
    url: `${input.bootstrap.sandboxes.a.gateway_base_url}/v1/chat/completions`,
    writePath: responsePath,
  });

  const transcriptMatches = findTranscriptMatches(
    input.bootstrap.sandboxes.a.openclaw_sessions_dir,
    sessionSnapshot,
    ["manage_network", "toolCall", "toolResult"],
  );
  writeJsonFile(transcriptSearchPath, {
    matches: transcriptMatches,
    session_key: sessionKey,
  });

  if (transcriptMatches.length === 0) {
    throw new Error(
      `OpenClaw session transcripts under ${input.bootstrap.sandboxes.a.openclaw_sessions_dir} did not record a manage_network tool call after the prompt-driven smoke.`,
    );
  }

  return buildSmokeCheckRecord({
    evidence: [
      buildEvidenceEntry(
        input.bootstrap,
        responsePath,
        "agent_turn_response",
        "artifact",
      ),
      buildEvidenceEntry(
        input.bootstrap,
        transcriptSearchPath,
        "agent_turn_transcript_search",
        "gateway_session",
      ),
    ],
    finishedAt: new Date().toISOString(),
    id: "agent-turn-smoke",
    profile: "optional",
    startedAt,
    status: "passed",
    summary:
      "Prompt-driven OpenClaw chat completion completed and sender session transcripts recorded a manage_network tool call/result.",
  });
}

async function invokeGatewayJson(input: {
  body: unknown;
  fetchImpl: typeof fetch;
  headers?: Record<string, string>;
  logger: JsonLinesLogger;
  runRoot: string;
  stepId: string;
  url: string;
  writePath: string;
}): Promise<unknown> {
  input.logger.append({
    kind: "gateway_request",
    method: "POST",
    request_body: redactUnknown(input.body),
    stage: input.stepId,
    status: "running",
    url: input.url,
  });

  const response = await input.fetchImpl(input.url, {
    body: JSON.stringify(input.body),
    headers: {
      "Content-Type": "application/json",
      ...input.headers,
    },
    method: "POST",
  });
  const responseText = await response.text();
  const parsed = safeParseJson(responseText);

  writeJsonFile(input.writePath, {
    body: parsed ?? responseText,
    recorded_at: new Date().toISOString(),
    request: redactUnknown(input.body),
    status_code: response.status,
  });

  input.logger.append({
    kind: "gateway_request",
    method: "POST",
    response_status: response.status,
    response_write_path: relative(input.runRoot, input.writePath),
    stage: input.stepId,
    status: response.ok ? "passed" : "failed",
    url: input.url,
  });

  if (!response.ok) {
    throw new Error(
      `POST ${input.url} failed with ${response.status}: ${truncateString(
        typeof parsed === "string" ? parsed : responseText,
        300,
      )}`,
    );
  }

  return parsed ?? responseText;
}

async function runCommand(input: {
  args: string[];
  command: string;
  combinedOutputPath?: string;
  cwd: string;
  env: Record<string, string | undefined>;
  logger: JsonLinesLogger;
  runRoot: string;
  stderrPath?: string;
  stepId: string;
  stdoutPath?: string;
}): Promise<{
  exitCode: number;
}> {
  input.logger.append({
    args: input.args,
    command: input.command,
    cwd: input.cwd,
    env: redactRecord(input.env),
    kind: "command",
    stage: input.stepId,
    status: "running",
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...input.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
  });

  const exitCode = await new Promise<number>(
    (resolvePromise, rejectPromise) => {
      child.once("error", (error) => {
        rejectPromise(error);
      });
      child.once("close", (code) => {
        resolvePromise(code ?? 1);
      });
    },
  );

  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");
  if (input.stdoutPath) {
    writeTextFile(input.stdoutPath, stdout);
  }
  if (input.stderrPath) {
    writeTextFile(input.stderrPath, stderr);
  }
  if (input.combinedOutputPath) {
    writeTextFile(
      input.combinedOutputPath,
      [stdout, stderr].filter((value) => value.length > 0).join(""),
    );
  }

  input.logger.append({
    exit_code: exitCode,
    kind: "command",
    stage: input.stepId,
    status: exitCode === 0 ? "passed" : "failed",
    stdout_path: input.stdoutPath
      ? relative(input.runRoot, input.stdoutPath)
      : null,
    stderr_path: input.stderrPath
      ? relative(input.runRoot, input.stderrPath)
      : null,
    combined_output_path: input.combinedOutputPath
      ? relative(input.runRoot, input.combinedOutputPath)
      : null,
  });

  return {
    exitCode,
  };
}

function createLoggingFetch(
  logger: JsonLinesLogger,
  delegate: typeof fetch,
  runRoot: string,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    const method =
      init?.method ??
      (typeof input === "object" && "method" in input
        ? (input.method ?? "GET")
        : "GET");
    const body = readFetchBody(init?.body);

    logger.append({
      kind: "http",
      method,
      request_body: body === undefined ? null : redactUnknown(body),
      status: "running",
      url: `${url.pathname}${url.search}`,
    });

    try {
      const response = await delegate(input as RequestInfo | URL, init);
      logger.append({
        kind: "http",
        method,
        response_status: response.status,
        run_root: runRoot,
        status: response.ok ? "passed" : "failed",
        url: `${url.pathname}${url.search}`,
      });
      return response;
    } catch (error) {
      logger.append({
        error: toErrorMessage(error),
        kind: "http",
        method,
        status: "failed",
        url: `${url.pathname}${url.search}`,
      });
      throw error;
    }
  };
}

function buildOperatorSummary(input: {
  agentTurnSmokeStatus: HarnessStatus;
  baselineError: {
    message: string;
    stage: string;
  } | null;
  bootstrap: DualSandboxBootstrapSummary;
  deterministicSmokeStatus: HarnessStatus;
  optionalAgentTurnError: {
    message: string;
    stage: string;
  } | null;
}): string {
  const lines = [
    "# Dual-Sandbox Harness Run",
    "",
    `Run root: \`${input.bootstrap.run_root}\``,
    `Verification summary: \`${input.bootstrap.paths.verification_summary_path}\``,
    `Commands log: \`${input.bootstrap.paths.commands_log_path}\``,
    `Logs directory: \`${input.bootstrap.paths.logs_dir}\``,
    "",
    `Runner status: ${input.baselineError ? "failed" : "passed"}`,
    `Deterministic smoke: ${input.deterministicSmokeStatus}`,
    `Optional agent-turn smoke: ${input.agentTurnSmokeStatus}`,
  ];

  if (input.baselineError) {
    lines.push("");
    lines.push(`Baseline failure stage: \`${input.baselineError.stage}\``);
    lines.push(`Baseline failure: ${input.baselineError.message}`);
  }

  if (input.optionalAgentTurnError) {
    lines.push("");
    lines.push(
      `Optional agent-turn failure: ${input.optionalAgentTurnError.message}`,
    );
  }

  lines.push("");
  lines.push(
    "Notes: This runner now proves the rerunnable bootstrap, provisioning, plugin-load verification, and smoke checks. The direct send/review/block matrix rows stay explicitly seeded but pending follow-on scenario execution work.",
  );

  return `${lines.join("\n")}\n`;
}

function buildEvidenceEntry(
  bootstrap: DualSandboxBootstrapSummary,
  absolutePath: string,
  role: string,
  sourceKind: DualSandboxEvidenceEntry["source_kind"],
  relatedIds?: Record<string, string | null>,
): DualSandboxEvidenceEntry {
  return {
    path: relative(bootstrap.run_root, absolutePath),
    related_ids: relatedIds,
    role,
    source_kind: sourceKind,
  };
}

function findTranscriptMatches(
  rootPath: string,
  beforeSnapshot: Map<string, string>,
  needles: string[],
): Array<{
  excerpt: string;
  path: string;
}> {
  if (!existsSync(rootPath)) {
    return [];
  }

  const matches: Array<{
    excerpt: string;
    path: string;
  }> = [];
  const queue = [rootPath];

  while (queue.length > 0) {
    const currentPath = queue.pop();
    if (!currentPath) {
      continue;
    }

    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const resolvedPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        queue.push(resolvedPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const currentSignature = buildFileSignature(resolvedPath);
      if (beforeSnapshot.get(resolvedPath) === currentSignature) {
        continue;
      }

      let content = "";
      try {
        content = readFileSync(resolvedPath, "utf8");
      } catch {
        continue;
      }

      if (needles.every((needle) => content.includes(needle))) {
        matches.push({
          excerpt: truncateString(content, 500),
          path: resolvedPath,
        });
      }
    }
  }

  return matches;
}

function snapshotDirectory(rootPath: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  if (!existsSync(rootPath)) {
    return snapshot;
  }

  const queue = [rootPath];
  while (queue.length > 0) {
    const currentPath = queue.pop();
    if (!currentPath) {
      continue;
    }

    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const resolvedPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        queue.push(resolvedPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      snapshot.set(resolvedPath, buildFileSignature(resolvedPath));
    }
  }

  return snapshot;
}

function buildFileSignature(filePath: string): string {
  const stats = statSync(filePath);
  return `${stats.size}:${stats.mtimeMs}`;
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), {
    recursive: true,
  });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeTextFile(filePath: string, value: string): void {
  mkdirSync(dirname(filePath), {
    recursive: true,
  });
  writeFileSync(filePath, value, "utf8");
}

function parseJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringValues(entry));
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((entry) => collectStringValues(entry));
  }
  return [];
}

function safeParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isSecretLikeKey(key)) {
        result[key] = "<redacted>";
        continue;
      }
      result[key] = redactUnknown(entry);
    }
    return result;
  }
  return value;
}

function redactRecord(
  value: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSecretLikeKey(key) ? "<redacted>" : entry;
  }
  return result;
}

function isSecretLikeKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("api") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower === "authorization"
  );
}

function readFetchBody(body: BodyInit | null | undefined): unknown {
  if (typeof body === "string") {
    return safeParseJson(body) ?? body;
  }
  return undefined;
}

function resolveOpenClawCheckoutPath(explicitPath?: string): string {
  const candidates = [
    explicitPath,
    process.env.MAHILO_OPENCLAW_CHECKOUT_PATH,
    process.env.OPENCLAW_CHECKOUT_PATH,
    resolve(REPO_ROOT, "../myclawd"),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeOptionalString(candidate);
    if (!normalized) {
      continue;
    }
    const resolvedPath = resolve(normalized);
    if (existsSync(resolvedPath)) {
      return resolvedPath;
    }
  }

  throw new Error(
    "OpenClaw checkout path not found. Pass --openclaw-checkout-path or set MAHILO_OPENCLAW_CHECKOUT_PATH.",
  );
}

function normalizeOptionalString(
  value: string | undefined | null,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readScenarioExpectation(scenarioId: DualSandboxScenarioId): string {
  switch (scenarioId) {
    case "G1":
      return "Plugin load and webhook reachability are proven for both gateways.";
    case "G2":
      return "Runtime bootstrap and Mahilo registration artifacts match both gateways.";
    case "G3":
      return "The sender and receiver are accepted contacts before any send scenarios run.";
    case "S1-send-receive":
      return "A baseline direct send reaches sandbox B.";
    case "S2-allow":
      return "A locally allowed policy path resumes transport.";
    case "S3-ask":
      return "A local ask decision creates review evidence without transport.";
    case "S4-deny":
      return "A local deny decision creates blocked-event evidence without transport.";
    case "S5-missing-llm-key":
      return "Missing local LLM credentials degrade to ask instead of allowing.";
  }
}

function readPendingScenarioSummary(scenarioId: DualSandboxScenarioId): string {
  if (scenarioId === "G1" || scenarioId === "G2" || scenarioId === "G3") {
    return "Pending execution.";
  }

  return "Fixture and artifact slots are prepared. Direct send matrix execution is reserved for follow-on scenario tasks.";
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function readJsonFieldAsString(
  filePath: string,
  pathSegments: string[],
): string | null {
  if (!existsSync(filePath)) {
    return null;
  }

  let current = parseJsonFile(filePath);
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === "string" ? current : null;
}

function parseArgs(argv: string[]): ParsedCliArgs {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) {
      continue;
    }

    if (current === "--help" || current === "-h") {
      printHelpAndExit(0);
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

  if (values.has("root") && values.has("root-parent")) {
    throw new Error("Use either --root or --root-parent, not both.");
  }

  return {
    adminApiKey: readOptionalString(values, "admin-api-key"),
    entryCommand: undefined,
    gatewayAPort: parseOptionalPort(
      values.get("gateway-a-port"),
      "--gateway-a-port",
    ),
    gatewayBPort: parseOptionalPort(
      values.get("gateway-b-port"),
      "--gateway-b-port",
    ),
    mahiloPort: parseOptionalPort(values.get("mahilo-port"), "--mahilo-port"),
    openClawCheckoutPath: readOptionalPath(values, "openclaw-checkout-path"),
    optionalLiveModel: parseOptionalLiveModelArgs(values),
    pluginPath: readOptionalPath(values, "plugin-path"),
    rootPath: readOptionalPath(values, "root"),
    skipAgentTurn: parseOptionalBoolean(
      values.get("skip-agent-turn"),
      "--skip-agent-turn",
    ),
    tempRootParent: readOptionalPath(values, "root-parent"),
  };
}

function readOptionalString(
  values: Map<string, string>,
  key: string,
): string | undefined {
  return normalizeOptionalString(values.get(key));
}

function readOptionalPath(
  values: Map<string, string>,
  key: string,
): string | undefined {
  const value = normalizeOptionalString(values.get(key));
  return value ? resolve(value) : undefined;
}

function parseOptionalPort(
  rawValue: string | undefined,
  flagName: string,
): number | undefined {
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${flagName} must be an integer between 1 and 65535`);
  }

  return parsed;
}

function parseOptionalPositiveInteger(
  rawValue: string | undefined,
  flagName: string,
): number | undefined {
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }

  return parsed;
}

function parseOptionalBoolean(
  rawValue: string | undefined,
  flagName: string,
): boolean | undefined {
  if (!rawValue) {
    return undefined;
  }
  if (rawValue === "true") {
    return true;
  }
  if (rawValue === "false") {
    return false;
  }
  throw new Error(`${flagName} must be either true or false`);
}

function parseOptionalLiveModelArgs(
  values: Map<string, string>,
): ParsedCliArgs["optionalLiveModel"] {
  const apiKeyEnvVar = readOptionalString(values, "live-model-api-key-env-var");
  const authProfile = readOptionalString(values, "live-model-auth-profile");
  const copyProviderAuthFrom = readOptionalPath(
    values,
    "copy-provider-auth-from",
  );
  const model = readOptionalString(values, "live-model-model");
  const provider = readOptionalString(values, "live-model-provider");
  const timeoutMs = parseOptionalPositiveInteger(
    values.get("live-model-timeout-ms"),
    "--live-model-timeout-ms",
  );

  if (
    !apiKeyEnvVar &&
    !authProfile &&
    !copyProviderAuthFrom &&
    !model &&
    !provider &&
    timeoutMs === undefined
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

function readDefaultEntryCommand(): string[] {
  if (typeof Bun !== "undefined") {
    return [...Bun.argv];
  }

  return [...process.argv];
}

function printHelpAndExit(code: number): never {
  console.log(
    [
      "Usage:",
      "  bun run plugins/openclaw-mahilo/scripts/dual-sandbox-run.ts \\",
      "    [--root <fresh-root-path>] \\",
      "    [--root-parent <fresh-root-parent>] \\",
      "    [--plugin-path <local-plugin-path>] \\",
      "    [--openclaw-checkout-path </path/to/myclawd>] \\",
      "    [--admin-api-key <sandbox-admin-key>] \\",
      "    [--mahilo-port <18080>] \\",
      "    [--gateway-a-port <19123>] \\",
      "    [--gateway-b-port <19124>] \\",
      "    [--skip-agent-turn <true|false>] \\",
      "    [--live-model-provider <provider>] \\",
      "    [--live-model-model <model>] \\",
      "    [--live-model-auth-profile <profile>] \\",
      "    [--live-model-api-key-env-var <ENV_VAR>] \\",
      "    [--live-model-timeout-ms <5000>] \\",
      "    [--copy-provider-auth-from <auth-profiles.json>]",
      "",
      "Creates one fresh dual-sandbox harness root, builds the local Mahilo",
      "plugin, starts Mahilo plus both gateways, provisions the two sandbox",
      "users and callback connections, verifies plugin load and webhook",
      "reachability, runs deterministic smoke checks, optionally runs one",
      "prompt-driven agent smoke, always stops processes, and writes",
      "operator-summary.md plus verification-summary.json under the run root.",
    ].join("\n"),
  );
  process.exit(code);
}

async function main() {
  const result = await runDualSandboxHarness(
    parseArgs(readDefaultEntryCommand().slice(2)),
  );
  const lines = [
    `Run root: ${result.run_root}`,
    `Verification summary: ${result.verification_summary_path}`,
    `Operator summary: ${result.operator_summary_path}`,
    `Exit code: ${result.exit_code}`,
  ];

  const writer = result.exit_code === 0 ? console.log : console.error;
  writer(lines.join("\n"));
  process.exit(result.exit_code);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(toErrorMessage(error));
    process.exit(1);
  });
}
