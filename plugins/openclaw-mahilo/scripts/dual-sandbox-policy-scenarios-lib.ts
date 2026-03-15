import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  readDualSandboxRelationshipRunFromRunRoot,
  redactRelationshipRunSummary,
  type DualSandboxRelationshipRunSummary,
} from "./dual-sandbox-relationships-lib";

export const DUAL_SANDBOX_POLICY_SCENARIOS_CONTRACT_VERSION = 1;
export const DUAL_SANDBOX_POLICY_SCENARIO_IDS = [
  "S2-allow",
  "S3-ask",
  "S4-deny",
  "S5-missing-llm-key",
] as const;

export type DualSandboxPolicyScenarioId =
  (typeof DUAL_SANDBOX_POLICY_SCENARIO_IDS)[number];

interface PolicyCreateResponse {
  policy_id?: string;
}

interface PreferenceResponse {
  default_llm_model?: string | null;
  default_llm_provider?: string | null;
}

interface ListedPolicy {
  action?: string | null;
  direction?: string;
  effect?: string;
  evaluator?: string;
  id?: string;
  priority?: number;
  resource?: string;
  scope?: string;
  source?: string;
  target_id?: string | null;
}

type ScenarioDecision = "allow" | "ask" | "deny";

interface ScenarioSeedInput {
  action: string;
  effect: ScenarioDecision;
  evaluator?: "structured" | "llm";
  expectedReasonCode: string;
  id: DualSandboxPolicyScenarioId;
  llmPrecondition?: DualSandboxMissingLLMPreconditionSummary;
  note: string;
  policyContent?: unknown;
  priority?: number;
  resource: string;
  sendFixture: DualSandboxPolicyScenarioSendFixtureSummary;
}

export interface DualSandboxPolicyScenarioOptions {
  fetchImpl?: typeof fetch;
  mahiloBaseUrl?: string;
  missingLLMModel?: string;
  missingLLMProvider?: string;
  now?: () => Date;
}

export interface DualSandboxPolicyScenarioSelectorSummary {
  action: string;
  direction: "outbound";
  resource: string;
}

export interface DualSandboxPolicyScenarioSendFixtureSummary {
  context: string | null;
  message: string;
  payload_type: "text/plain";
}

export interface DualSandboxPolicyScenarioTargetSummary {
  recipient_sandbox_id: "b";
  recipient_user_id: string;
  recipient_username: string;
}

export interface DualSandboxPolicyScenarioExpectedResolutionSummary {
  decision: ScenarioDecision;
  delivery_expected: boolean;
  reason_code: string;
  review_surface: "blocked_events" | "none" | "reviews";
  transport_expected: boolean;
}

export interface DualSandboxSeededPolicySummary {
  action: string | null;
  create_status_code: number;
  direction: string;
  effect: ScenarioDecision;
  evaluator: string;
  policy_id: string;
  priority: number;
  resource: string;
  scope: string;
  source: string;
  target_id: string | null;
}

export interface DualSandboxMissingLLMPreconditionSummary {
  default_harness_optional_live_model_configured: boolean;
  expected_reason_code: "policy.ask.llm.unavailable";
  local_credentials_expected: "absent" | "operator_must_clear";
  note: string;
  provider: string;
  provider_auth_copy_enabled: boolean;
  sender_preferences_source: "api_preferences";
  user_preference_model: string;
}

export interface DualSandboxPolicyScenarioEntrySummary {
  declared_selectors: DualSandboxPolicyScenarioSelectorSummary;
  expected_resolution: DualSandboxPolicyScenarioExpectedResolutionSummary;
  id: DualSandboxPolicyScenarioId;
  llm_precondition?: DualSandboxMissingLLMPreconditionSummary;
  note: string;
  seeded_policies: DualSandboxSeededPolicySummary[];
  send_fixture: DualSandboxPolicyScenarioSendFixtureSummary;
  target: DualSandboxPolicyScenarioTargetSummary;
}

export interface DualSandboxScenarioPreferenceSummary {
  default_llm_model: string;
  default_llm_provider: string;
  get_status_code: number;
  patch_status_code: number;
}

export interface DualSandboxPolicyScenariosSummary {
  contract_version: number;
  created_at: string;
  current_phase: "policy_scenarios";
  mahilo_base_url: string;
  manual_dashboard_required: false;
  scenario_ids: readonly DualSandboxPolicyScenarioId[];
  scenario_mapping: Record<
    DualSandboxPolicyScenarioId,
    DualSandboxPolicyScenarioEntrySummary
  >;
  seed_mode: "api";
  sender_preferences: DualSandboxScenarioPreferenceSummary;
}

export interface DualSandboxPolicyScenarioRunSummary
  extends DualSandboxRelationshipRunSummary {
  policy_scenarios: DualSandboxPolicyScenariosSummary;
}

const DEFAULT_MISSING_LLM_MODEL = "gpt-4o-mini";
const DEFAULT_MISSING_LLM_PROVIDER = "openai";
const POLICY_SUMMARY_FILE_NAME = "policy-summary.json";

export async function seedDualSandboxPolicyScenarios(
  summary: DualSandboxRelationshipRunSummary,
  options: DualSandboxPolicyScenarioOptions = {},
): Promise<DualSandboxPolicyScenarioRunSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const mahiloBaseUrl = normalizeBaseUrl(
    options.mahiloBaseUrl ?? summary.relationships.mahilo_base_url,
  );
  const missingLLMProvider = normalizeRequiredString(
    options.missingLLMProvider ?? DEFAULT_MISSING_LLM_PROVIDER,
    "missingLLMProvider",
  ).toLowerCase();
  const missingLLMModel = normalizeRequiredString(
    options.missingLLMModel ?? DEFAULT_MISSING_LLM_MODEL,
    "missingLLMModel",
  );
  const senderApiKey = summary.provisioning.sandboxes.a.api_key;
  const receiver = summary.relationships.participants.receiver;
  const allowTarget = buildScenarioTarget(receiver.user_id, receiver.username);
  const llmPrecondition = buildMissingLLMPrecondition(
    summary,
    missingLLMProvider,
    missingLLMModel,
  );

  const patchedPreferences = await requestJson<PreferenceResponse>(
    fetchImpl,
    mahiloBaseUrl,
    {
      bearerToken: senderApiKey,
      body: {
        default_llm_model: missingLLMModel,
        default_llm_provider: missingLLMProvider,
      },
      method: "PATCH",
      path: "/api/v1/preferences",
    },
  );
  const fetchedPreferences = await requestJson<PreferenceResponse>(
    fetchImpl,
    mahiloBaseUrl,
    {
      bearerToken: senderApiKey,
      method: "GET",
      path: "/api/v1/preferences",
    },
  );

  const preferenceProvider = readString(
    fetchedPreferences.json.default_llm_provider,
  );
  const preferenceModel = readString(fetchedPreferences.json.default_llm_model);
  if (
    preferenceProvider !== missingLLMProvider ||
    preferenceModel !== missingLLMModel
  ) {
    throw new Error(
      "Sender preferences did not persist the expected default local-policy LLM settings.",
    );
  }

  const askPolicy = await createScenarioPolicy(fetchImpl, mahiloBaseUrl, {
    action: "share",
    bearerToken: senderApiKey,
    effect: "ask",
    evaluator: "structured",
    policyContent: {
      intent: "manual_review",
      reason: "SBX-024 ask scenario",
    },
    priority: 90,
    resource: "calendar.event",
    targetUserId: receiver.user_id,
  });
  const denyPolicy = await createScenarioPolicy(fetchImpl, mahiloBaseUrl, {
    action: "share",
    bearerToken: senderApiKey,
    effect: "deny",
    evaluator: "structured",
    policyContent: {},
    priority: 91,
    resource: "location.current",
    targetUserId: receiver.user_id,
  });
  const missingLLMPolicy = await createScenarioPolicy(fetchImpl, mahiloBaseUrl, {
    action: "share",
    bearerToken: senderApiKey,
    effect: "deny",
    evaluator: "llm",
    policyContent:
      "Never share a person's direct email address without explicit consent.",
    priority: 92,
    resource: "contact.email",
    targetUserId: receiver.user_id,
  });
  const listedPolicies = await requestJson<ListedPolicy[]>(fetchImpl, mahiloBaseUrl, {
    bearerToken: senderApiKey,
    method: "GET",
    path: "/api/v1/policies",
  });
  const policiesById = buildListedPolicyMap(listedPolicies.json);

  const askPolicySummary = buildSeededPolicySummary(
    askPolicy,
    policiesById,
    "S3-ask",
  );
  const denyPolicySummary = buildSeededPolicySummary(
    denyPolicy,
    policiesById,
    "S4-deny",
  );
  const missingLLMPolicySummary = buildSeededPolicySummary(
    missingLLMPolicy,
    policiesById,
    "S5-missing-llm-key",
  );

  const scenarioMapping: Record<
    DualSandboxPolicyScenarioId,
    DualSandboxPolicyScenarioEntrySummary
  > = {
    "S2-allow": buildScenarioEntry({
      action: "share",
      effect: "allow",
      expectedReasonCode: "policy.allow.no_applicable",
      id: "S2-allow",
      note:
        "No scenario-specific policy is seeded for profile.basic/share, so the baseline sender/receiver pair should resolve locally to allow.",
      resource: "profile.basic",
      sendFixture: {
        context: null,
        message: "Share my display name with the receiver sandbox.",
        payload_type: "text/plain",
      },
    }, allowTarget, []),
    "S3-ask": buildScenarioEntry({
      action: "share",
      effect: "ask",
      expectedReasonCode: "policy.ask.user.structured",
      id: "S3-ask",
      note:
        "A user-scoped structured ask policy forces review without transport for calendar-event sharing to sandbox B.",
      resource: "calendar.event",
      sendFixture: {
        context: null,
        message: "Tell them I have a dentist appointment tomorrow at 3 PM.",
        payload_type: "text/plain",
      },
    }, allowTarget, [askPolicySummary]),
    "S4-deny": buildScenarioEntry({
      action: "share",
      effect: "deny",
      expectedReasonCode: "policy.deny.user.structured",
      id: "S4-deny",
      note:
        "A user-scoped structured deny policy blocks exact current-location sharing to sandbox B before transport.",
      resource: "location.current",
      sendFixture: {
        context: null,
        message: "Tell them I am at 500 Market Street right now.",
        payload_type: "text/plain",
      },
    }, allowTarget, [denyPolicySummary]),
    "S5-missing-llm-key": buildScenarioEntry({
      action: "share",
      effect: "ask",
      expectedReasonCode: "policy.ask.llm.unavailable",
      id: "S5-missing-llm-key",
      llmPrecondition,
      note:
        "An LLM-backed deny policy is seeded for contact.email/share, but the baseline harness leaves local provider credentials absent so local evaluation must degrade to ask.",
      resource: "contact.email",
      sendFixture: {
        context: null,
        message: "Send them my email address: sender@example.com.",
        payload_type: "text/plain",
      },
    }, allowTarget, [missingLLMPolicySummary]),
  };

  const policyScenarios: DualSandboxPolicyScenariosSummary = {
    contract_version: DUAL_SANDBOX_POLICY_SCENARIOS_CONTRACT_VERSION,
    created_at: createdAt,
    current_phase: "policy_scenarios",
    mahilo_base_url: mahiloBaseUrl,
    manual_dashboard_required: false,
    scenario_ids: DUAL_SANDBOX_POLICY_SCENARIO_IDS,
    scenario_mapping: scenarioMapping,
    seed_mode: "api",
    sender_preferences: {
      default_llm_model: missingLLMModel,
      default_llm_provider: missingLLMProvider,
      get_status_code: fetchedPreferences.status,
      patch_status_code: patchedPreferences.status,
    },
  };

  const seededSummary: DualSandboxPolicyScenarioRunSummary = {
    ...summary,
    policy_scenarios: policyScenarios,
    provisioning: {
      ...summary.provisioning,
      current_phase: "policy_scenarios",
    },
  };

  writeJsonFile(summary.paths.runtime_provisioning_path, seededSummary);
  writeJsonFile(
    summary.paths.artifact_bootstrap_summary_path,
    redactPolicyScenarioRunSummary(seededSummary),
  );
  writeJsonFile(
    join(summary.paths.provisioning_dir, POLICY_SUMMARY_FILE_NAME),
    policyScenarios,
  );

  return seededSummary;
}

export function redactPolicyScenarioRunSummary(
  summary: DualSandboxPolicyScenarioRunSummary,
): DualSandboxPolicyScenarioRunSummary {
  return {
    ...(redactRelationshipRunSummary(
      summary,
    ) as DualSandboxPolicyScenarioRunSummary),
    policy_scenarios: summary.policy_scenarios,
  };
}

export function readDualSandboxPolicyScenarioRunFromRunRoot(
  runRoot: string,
): DualSandboxPolicyScenarioRunSummary {
  const relationshipRun = readDualSandboxRelationshipRunFromRunRoot(runRoot);
  const runtimeProvisioningPath = relationshipRun.paths.runtime_provisioning_path;
  const parsed = readJsonFile<Partial<DualSandboxPolicyScenarioRunSummary>>(
    runtimeProvisioningPath,
  );

  assertPolicyScenarioRunSummary(parsed, runtimeProvisioningPath);
  return parsed;
}

function buildScenarioEntry(
  input: ScenarioSeedInput,
  target: DualSandboxPolicyScenarioTargetSummary,
  seededPolicies: DualSandboxSeededPolicySummary[],
): DualSandboxPolicyScenarioEntrySummary {
  return {
    declared_selectors: {
      action: input.action,
      direction: "outbound",
      resource: input.resource,
    },
    expected_resolution: {
      decision: input.effect,
      delivery_expected: input.effect === "allow",
      reason_code: input.expectedReasonCode,
      review_surface:
        input.effect === "ask"
          ? "reviews"
          : input.effect === "deny"
            ? "blocked_events"
            : "none",
      transport_expected: input.effect === "allow",
    },
    id: input.id,
    ...(input.llmPrecondition
      ? {
          llm_precondition: input.llmPrecondition,
        }
      : {}),
    note: input.note,
    seeded_policies: seededPolicies,
    send_fixture: input.sendFixture,
    target,
  };
}

function buildScenarioTarget(
  recipientUserId: string,
  recipientUsername: string,
): DualSandboxPolicyScenarioTargetSummary {
  return {
    recipient_sandbox_id: "b",
    recipient_user_id: recipientUserId,
    recipient_username: recipientUsername,
  };
}

function buildMissingLLMPrecondition(
  summary: DualSandboxRelationshipRunSummary,
  provider: string,
  model: string,
): DualSandboxMissingLLMPreconditionSummary {
  const optionalLiveModel = summary.proof_inputs.optional_live_model;
  const localCredentialsExpected = optionalLiveModel.configured
    ? "operator_must_clear"
    : "absent";

  return {
    default_harness_optional_live_model_configured:
      optionalLiveModel.configured,
    expected_reason_code: "policy.ask.llm.unavailable",
    local_credentials_expected: localCredentialsExpected,
    note:
      localCredentialsExpected === "absent"
        ? "The baseline deterministic harness leaves local model credentials unstaged by default."
        : "Optional live-model inputs are present on this run root. Clear local provider credentials before executing the baseline degraded-review scenario.",
    provider,
    provider_auth_copy_enabled:
      optionalLiveModel.provider_auth_copy.enabled,
    sender_preferences_source: "api_preferences",
    user_preference_model: model,
  };
}

async function createScenarioPolicy(
  fetchImpl: typeof fetch,
  mahiloBaseUrl: string,
  input: {
    action: string;
    bearerToken: string;
    effect: ScenarioDecision;
    evaluator: "structured" | "llm";
    policyContent: unknown;
    priority: number;
    resource: string;
    targetUserId: string;
  },
): Promise<{
  create_status_code: number;
  policy_id: string;
}> {
  const createResponse = await requestJson<PolicyCreateResponse>(
    fetchImpl,
    mahiloBaseUrl,
    {
      bearerToken: input.bearerToken,
      body: {
        action: input.action,
        direction: "outbound",
        effect: input.effect,
        evaluator: input.evaluator,
        policy_content: input.policyContent,
        priority: input.priority,
        resource: input.resource,
        scope: "user",
        target_id: input.targetUserId,
      },
      method: "POST",
      path: "/api/v1/policies",
    },
  );
  const policyId = readString(createResponse.json.policy_id);
  if (!policyId) {
    throw new Error(
      `POST /api/v1/policies did not return a policy_id for ${input.resource}.`,
    );
  }

  return {
    create_status_code: createResponse.status,
    policy_id: policyId,
  };
}

function buildListedPolicyMap(value: unknown): Map<string, ListedPolicy> {
  if (!Array.isArray(value)) {
    return new Map();
  }

  return new Map(
    value
      .map((entry) => {
        const record = readRecord(entry);
        const policyId = readString(record.id);
        if (!policyId) {
          return null;
        }

        return [policyId, record as ListedPolicy] as const;
      })
      .filter(
        (entry): entry is readonly [string, ListedPolicy] => entry !== null,
      ),
  );
}

function buildSeededPolicySummary(
  createdPolicy: {
    create_status_code: number;
    policy_id: string;
  },
  policiesById: Map<string, ListedPolicy>,
  scenarioId: DualSandboxPolicyScenarioId,
): DualSandboxSeededPolicySummary {
  const listedPolicy = policiesById.get(createdPolicy.policy_id);
  if (!listedPolicy) {
    throw new Error(
      `Seeded policy ${createdPolicy.policy_id} for ${scenarioId} was not returned by GET /api/v1/policies.`,
    );
  }

  const direction = readString(listedPolicy.direction);
  const effect = readString(listedPolicy.effect) as ScenarioDecision | null;
  const evaluator = readString(listedPolicy.evaluator);
  const resource = readString(listedPolicy.resource);
  const scope = readString(listedPolicy.scope);
  const source = readString(listedPolicy.source);
  const priority = listedPolicy.priority;

  if (
    !direction ||
    !effect ||
    !evaluator ||
    !resource ||
    !scope ||
    !source ||
    typeof priority !== "number" ||
    !Number.isFinite(priority)
  ) {
    throw new Error(
      `Seeded policy ${createdPolicy.policy_id} for ${scenarioId} is missing canonical fields in the policy list response.`,
    );
  }

  return {
    action: readString(listedPolicy.action),
    create_status_code: createdPolicy.create_status_code,
    direction,
    effect,
    evaluator,
    policy_id: createdPolicy.policy_id,
    priority,
    resource,
    scope,
    source,
    target_id: readString(listedPolicy.target_id),
  };
}

function assertPolicyScenarioRunSummary(
  parsed: Partial<DualSandboxPolicyScenarioRunSummary>,
  runtimeProvisioningPath: string,
): asserts parsed is DualSandboxPolicyScenarioRunSummary {
  const policyScenarios = readRecord(
    (parsed as Record<string, unknown>).policy_scenarios,
  );
  const senderPreferences = readRecord(policyScenarios.sender_preferences);
  const scenarioIds = policyScenarios.scenario_ids;
  const scenarioMapping = readRecord(policyScenarios.scenario_mapping);

  if (
    typeof policyScenarios.contract_version !== "number" ||
    !Number.isFinite(policyScenarios.contract_version) ||
    !readString(policyScenarios.created_at) ||
    policyScenarios.current_phase !== "policy_scenarios" ||
    !readString(policyScenarios.mahilo_base_url) ||
    policyScenarios.manual_dashboard_required !== false ||
    policyScenarios.seed_mode !== "api" ||
    !Array.isArray(scenarioIds) ||
    !readString(senderPreferences.default_llm_model) ||
    !readString(senderPreferences.default_llm_provider) ||
    typeof senderPreferences.get_status_code !== "number" ||
    !Number.isFinite(senderPreferences.get_status_code) ||
    typeof senderPreferences.patch_status_code !== "number" ||
    !Number.isFinite(senderPreferences.patch_status_code)
  ) {
    throw new Error(
      `File ${runtimeProvisioningPath} does not contain a valid dual-sandbox policy scenario summary.`,
    );
  }

  for (const scenarioId of DUAL_SANDBOX_POLICY_SCENARIO_IDS) {
    const scenario = readRecord(scenarioMapping[scenarioId]);
    const selectors = readRecord(scenario.declared_selectors);
    const expectedResolution = readRecord(scenario.expected_resolution);
    const sendFixture = readRecord(scenario.send_fixture);
    const target = readRecord(scenario.target);

    if (
      scenario.id !== scenarioId ||
      selectors.direction !== "outbound" ||
      !readString(selectors.action) ||
      !readString(selectors.resource) ||
      !readString(scenario.note) ||
      !readString(sendFixture.message) ||
      sendFixture.payload_type !== "text/plain" ||
      target.recipient_sandbox_id !== "b" ||
      !readString(target.recipient_user_id) ||
      !readString(target.recipient_username) ||
      !isScenarioDecision(expectedResolution.decision) ||
      !readString(expectedResolution.reason_code) ||
      typeof expectedResolution.delivery_expected !== "boolean" ||
      typeof expectedResolution.transport_expected !== "boolean" ||
      !isReviewSurface(expectedResolution.review_surface) ||
      !Array.isArray(scenario.seeded_policies)
    ) {
      throw new Error(
        `File ${runtimeProvisioningPath} does not contain a valid mapping for ${scenarioId}.`,
      );
    }
  }

  const policyArtifactPath = join(
    resolve(parsed.run_root ?? ""),
    "artifacts",
    "provisioning",
    POLICY_SUMMARY_FILE_NAME,
  );
  if (!existsSync(policyArtifactPath)) {
    throw new Error(
      `Expected policy scenario artifact at ${policyArtifactPath} referenced by ${runtimeProvisioningPath}.`,
    );
  }
}

function isReviewSurface(
  value: unknown,
): value is DualSandboxPolicyScenarioExpectedResolutionSummary["review_surface"] {
  return value === "none" || value === "reviews" || value === "blocked_events";
}

function isScenarioDecision(value: unknown): value is ScenarioDecision {
  return value === "allow" || value === "ask" || value === "deny";
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: {
    bearerToken?: string;
    body?: unknown;
    method: "GET" | "PATCH" | "POST";
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
  const normalized = normalizeRequiredString(baseUrl, "mahiloBaseUrl");
  return normalized.replace(/\/+$/, "");
}

function normalizeRequiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  return normalized;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}
