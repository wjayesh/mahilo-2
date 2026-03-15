import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { DualSandboxBootstrapSummary } from "./dual-sandbox-bootstrap-lib";

export const DUAL_SANDBOX_AUTH_ARTIFACT_CONTRACT_VERSION = 1;
export const DUAL_SANDBOX_PROVISIONING_CONTRACT_VERSION = 1;

type SandboxId = "a" | "b";

export interface DualSandboxProvisionUserInput {
  display_name: string;
  username: string;
}

export interface DualSandboxProvisionOptions {
  activeRouteProbePath?: string;
  adminApiKey: string;
  fetchImpl?: typeof fetch;
  mahiloBaseUrl?: string;
  now?: () => Date;
  sandboxUsers?: Partial<Record<SandboxId, Partial<DualSandboxProvisionUserInput>>>;
}

export interface DualSandboxRouteProbeSummary {
  path: string;
  review_count: number | null;
  status_code: number;
}

export interface DualSandboxProvisionedUserSummary {
  api_key: string;
  display_name: string;
  invite: {
    expires_at: string | null;
    max_uses: number;
    note: string | null;
    token_id: string;
  };
  plugin_route_probe: DualSandboxRouteProbeSummary;
  registration_source: string;
  registration_flow: "invite_token_register";
  status: string;
  user_id: string;
  username: string;
  verified: boolean;
}

export interface DualSandboxProvisioningAuthArtifact {
  api_key: string;
  contract_version: number;
  created_at: string;
  registration_flow: "invite_token_register";
  registration_source: string;
  status: string;
  user_id: string;
  username: string;
  verified: boolean;
}

export interface DualSandboxProvisioningSummary {
  contract_version: number;
  created_at: string;
  current_phase: "users";
  fallback_only: boolean;
  mahilo_base_url: string;
  plugin_protected_route_probe_path: string;
  provisioning_mode: "api";
  sandboxes: {
    a: DualSandboxProvisionedUserSummary;
    b: DualSandboxProvisionedUserSummary;
  };
}

export interface DualSandboxProvisionedRunSummary
  extends DualSandboxBootstrapSummary {
  provisioning: DualSandboxProvisioningSummary;
}

interface InviteTokenResponse {
  expires_at: string | null;
  invite_token: string;
  max_uses: number;
  note: string | null;
  token_id: string;
}

interface RegisterResponse {
  api_key: string;
  status: string;
  user_id: string;
  username: string;
  verified: boolean;
}

interface AuthMeResponse {
  registration_source: string;
  status: string;
  user_id: string;
  username: string;
  verified: boolean;
}

const DEFAULT_ACTIVE_ROUTE_PROBE_PATH = "/api/v1/plugin/reviews?limit=1";
const DEFAULT_SANDBOX_USERS = {
  a: {
    display_name: "Sandbox Sender",
    username: "sandboxsender",
  },
  b: {
    display_name: "Sandbox Receiver",
    username: "sandboxreceiver",
  },
} as const;
const REDACTED_SECRET = "<redacted>";

export async function provisionDualSandboxUsers(
  bootstrap: DualSandboxBootstrapSummary,
  options: DualSandboxProvisionOptions,
): Promise<DualSandboxProvisionedRunSummary> {
  const adminApiKey = normalizeRequiredString(
    options.adminApiKey,
    "adminApiKey",
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const mahiloBaseUrl = normalizeBaseUrl(
    options.mahiloBaseUrl ?? bootstrap.mahilo.base_url,
  );
  const activeRouteProbePath = normalizeRoutePath(
    options.activeRouteProbePath ?? DEFAULT_ACTIVE_ROUTE_PROBE_PATH,
  );
  const sandboxUsers = resolveSandboxUsers(options.sandboxUsers);
  const createdAt = now().toISOString();

  const sandboxA = await provisionSingleSandboxUser({
    activeRouteProbePath,
    adminApiKey,
    bootstrap,
    fetchImpl,
    input: sandboxUsers.a,
    mahiloBaseUrl,
    sandboxId: "a",
  });
  const sandboxB = await provisionSingleSandboxUser({
    activeRouteProbePath,
    adminApiKey,
    bootstrap,
    fetchImpl,
    input: sandboxUsers.b,
    mahiloBaseUrl,
    sandboxId: "b",
  });
  const sandboxAAuthArtifact = buildProvisioningAuthArtifact(
    sandboxA,
    createdAt,
  );
  const sandboxBAuthArtifact = buildProvisioningAuthArtifact(
    sandboxB,
    createdAt,
  );

  const runtimeSummary: DualSandboxProvisionedRunSummary = {
    ...bootstrap,
    provisioning: {
      contract_version: DUAL_SANDBOX_PROVISIONING_CONTRACT_VERSION,
      created_at: createdAt,
      current_phase: "users",
      fallback_only: false,
      mahilo_base_url: mahiloBaseUrl,
      plugin_protected_route_probe_path: activeRouteProbePath,
      provisioning_mode: "api",
      sandboxes: {
        a: sandboxA,
        b: sandboxB,
      },
    },
  };

  writeJsonFile(bootstrap.sandboxes.a.auth_path, sandboxAAuthArtifact);
  writeJsonFile(bootstrap.sandboxes.b.auth_path, sandboxBAuthArtifact);
  writeJsonFile(
    bootstrap.sandboxes.a.artifact_paths.auth_redacted_path,
    redactProvisioningAuthArtifact(sandboxAAuthArtifact),
  );
  writeJsonFile(
    bootstrap.sandboxes.b.artifact_paths.auth_redacted_path,
    redactProvisioningAuthArtifact(sandboxBAuthArtifact),
  );
  writeJsonFile(bootstrap.paths.runtime_provisioning_path, runtimeSummary);
  writeJsonFile(
    bootstrap.paths.artifact_bootstrap_summary_path,
    redactProvisionedRunSummary(runtimeSummary),
  );

  return runtimeSummary;
}

export function redactProvisionedRunSummary(
  summary: DualSandboxProvisionedRunSummary,
): DualSandboxProvisionedRunSummary {
  return {
    ...summary,
    provisioning: {
      ...summary.provisioning,
      sandboxes: {
        a: redactProvisionedUser(summary.provisioning.sandboxes.a),
        b: redactProvisionedUser(summary.provisioning.sandboxes.b),
      },
    },
  };
}

export function readDualSandboxBootstrapFromRunRoot(
  runRoot: string,
): DualSandboxBootstrapSummary {
  const { parsed, runtimeProvisioningPath } = readRuntimeProvisioningFile(
    runRoot,
  );
  assertBootstrapRunSummary(parsed, runtimeProvisioningPath);
  return parsed;
}

export function readDualSandboxProvisionedRunFromRunRoot(
  runRoot: string,
): DualSandboxProvisionedRunSummary {
  const { parsed, runtimeProvisioningPath } = readRuntimeProvisioningFile(
    runRoot,
  );
  assertProvisionedRunSummary(parsed, runtimeProvisioningPath);
  return parsed;
}

async function provisionSingleSandboxUser(input: {
  activeRouteProbePath: string;
  adminApiKey: string;
  bootstrap: DualSandboxBootstrapSummary;
  fetchImpl: typeof fetch;
  input: DualSandboxProvisionUserInput;
  mahiloBaseUrl: string;
  sandboxId: SandboxId;
}): Promise<DualSandboxProvisionedUserSummary> {
  const inviteNote = `SBX-021 ${input.bootstrap.run_id} sandbox-${input.sandboxId} invite`;
  const invite = await requestJson<InviteTokenResponse>(
    input.fetchImpl,
    input.mahiloBaseUrl,
    {
      bearerToken: input.adminApiKey,
      body: {
        max_uses: 1,
        note: inviteNote,
      },
      method: "POST",
      path: "/api/v1/admin/invite-tokens",
    },
  );
  const registeredUser = await requestJson<RegisterResponse>(
    input.fetchImpl,
    input.mahiloBaseUrl,
    {
      body: {
        display_name: input.input.display_name,
        invite_token: invite.json.invite_token,
        username: input.input.username,
      },
      method: "POST",
      path: "/api/v1/auth/register",
    },
  );

  if (!registeredUser.json.api_key) {
    throw new Error(
      `Sandbox ${input.sandboxId} registration succeeded without returning an api_key.`,
    );
  }

  if (registeredUser.json.status !== "active") {
    throw new Error(
      `Sandbox ${input.sandboxId} registration returned status ${registeredUser.json.status}; expected active.`,
    );
  }

  if (!registeredUser.json.verified) {
    throw new Error(
      `Sandbox ${input.sandboxId} registration did not produce a verified account.`,
    );
  }

  const accountState = await requestJson<AuthMeResponse>(
    input.fetchImpl,
    input.mahiloBaseUrl,
    {
      bearerToken: registeredUser.json.api_key,
      method: "GET",
      path: "/api/v1/auth/me",
    },
  );

  if (accountState.json.registration_source !== "invite") {
    throw new Error(
      `Sandbox ${input.sandboxId} registered via ${accountState.json.registration_source}; expected invite-backed registration.`,
    );
  }

  if (accountState.json.status !== "active" || !accountState.json.verified) {
    throw new Error(
      `Sandbox ${input.sandboxId} did not remain active after invite-backed registration.`,
    );
  }

  const routeProbe = await requestJson<{
    review_queue?: {
      count?: number;
    };
  }>(input.fetchImpl, input.mahiloBaseUrl, {
    bearerToken: registeredUser.json.api_key,
    method: "GET",
    path: input.activeRouteProbePath,
  });

  return {
    api_key: registeredUser.json.api_key,
    display_name: input.input.display_name,
    invite: {
      expires_at: invite.json.expires_at,
      max_uses: invite.json.max_uses,
      note: invite.json.note,
      token_id: invite.json.token_id,
    },
    plugin_route_probe: {
      path: input.activeRouteProbePath,
      review_count: readReviewCount(routeProbe.json),
      status_code: routeProbe.status,
    },
    registration_source: accountState.json.registration_source,
    registration_flow: "invite_token_register",
    status: accountState.json.status,
    user_id: accountState.json.user_id,
    username: accountState.json.username,
    verified: accountState.json.verified,
  };
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
  const response = await fetchImpl(new URL(options.path, `${baseUrl}/`).toString(), {
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
  });

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

function resolveSandboxUsers(
  overrides: DualSandboxProvisionOptions["sandboxUsers"],
): Record<SandboxId, DualSandboxProvisionUserInput> {
  const resolved = {
    a: resolveSandboxUser(DEFAULT_SANDBOX_USERS.a, overrides?.a, "a"),
    b: resolveSandboxUser(DEFAULT_SANDBOX_USERS.b, overrides?.b, "b"),
  } satisfies Record<SandboxId, DualSandboxProvisionUserInput>;

  if (resolved.a.username.toLowerCase() === resolved.b.username.toLowerCase()) {
    throw new Error(
      "Sandbox A and sandbox B usernames must be distinct for dual-sandbox provisioning.",
    );
  }

  return resolved;
}

function readRuntimeProvisioningFile(
  runRoot: string,
): {
  parsed: Partial<DualSandboxProvisionedRunSummary>;
  runtimeProvisioningPath: string;
} {
  const resolvedRunRoot = resolve(runRoot);
  const runtimeProvisioningPath = join(
    resolvedRunRoot,
    "runtime",
    "provisioning.json",
  );

  if (!existsSync(runtimeProvisioningPath)) {
    throw new Error(
      `Dual-sandbox bootstrap summary not found at ${runtimeProvisioningPath}. Run dual-sandbox-bootstrap.ts first.`,
    );
  }

  return {
    parsed: readJsonFile<Partial<DualSandboxProvisionedRunSummary>>(
      runtimeProvisioningPath,
    ),
    runtimeProvisioningPath,
  };
}

function assertBootstrapRunSummary(
  parsed: Partial<DualSandboxProvisionedRunSummary>,
  runtimeProvisioningPath: string,
): asserts parsed is DualSandboxBootstrapSummary {
  const parsedRecord = readRecord(parsed);
  const sandboxes = readRecord(parsedRecord.sandboxes);
  const sandboxA = readRecord(sandboxes.a);
  const sandboxAArtifacts = readRecord(sandboxA.artifact_paths);
  const sandboxB = readRecord(sandboxes.b);
  const sandboxBArtifacts = readRecord(sandboxB.artifact_paths);

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.run_root !== "string" ||
    typeof parsed.runtime_dir !== "string" ||
    typeof parsed.artifacts_dir !== "string" ||
    typeof parsed.paths !== "object" ||
    parsed.paths === null ||
    typeof parsed.paths.runtime_provisioning_path !== "string" ||
    !readString(sandboxA.auth_path) ||
    !readString(sandboxAArtifacts.auth_redacted_path) ||
    !readString(sandboxB.auth_path) ||
    !readString(sandboxBArtifacts.auth_redacted_path)
  ) {
    throw new Error(
      `File ${runtimeProvisioningPath} does not contain a valid dual-sandbox bootstrap summary.`,
    );
  }
}

function assertProvisionedRunSummary(
  parsed: Partial<DualSandboxProvisionedRunSummary>,
  runtimeProvisioningPath: string,
): asserts parsed is DualSandboxProvisionedRunSummary {
  assertBootstrapRunSummary(parsed, runtimeProvisioningPath);

  const provisioning = readRecord(
    (parsed as Record<string, unknown>).provisioning,
  );
  const sandboxes = readRecord(provisioning.sandboxes);
  const sandboxA = sandboxes.a;
  const sandboxB = sandboxes.b;

  if (
    typeof provisioning.contract_version !== "number" ||
    !Number.isFinite(provisioning.contract_version) ||
    !readString(provisioning.created_at) ||
    provisioning.current_phase !== "users" ||
    typeof provisioning.fallback_only !== "boolean" ||
    !readString(provisioning.mahilo_base_url) ||
    !readString(provisioning.plugin_protected_route_probe_path) ||
    provisioning.provisioning_mode !== "api"
  ) {
    throw new Error(
      `File ${runtimeProvisioningPath} does not contain a valid dual-sandbox provisioning summary.`,
    );
  }

  assertProvisionedSandboxUser(
    sandboxA,
    "a",
    runtimeProvisioningPath,
  );
  assertProvisionedSandboxUser(
    sandboxB,
    "b",
    runtimeProvisioningPath,
  );
  assertPersistedProvisioningAuthArtifact(
    parsed.sandboxes.a.auth_path,
    sandboxA,
    "a",
    runtimeProvisioningPath,
  );
  assertPersistedProvisioningAuthArtifact(
    parsed.sandboxes.b.auth_path,
    sandboxB,
    "b",
    runtimeProvisioningPath,
  );
}

function assertProvisionedSandboxUser(
  value: unknown,
  sandboxId: SandboxId,
  runtimeProvisioningPath: string,
): asserts value is DualSandboxProvisionedUserSummary {
  const record = readRecord(value);
  const invite = readRecord(record.invite);
  const routeProbe = readRecord(record.plugin_route_probe);

  if (
    !readString(record.api_key) ||
    !readString(record.display_name) ||
    (invite.expires_at !== null && !readString(invite.expires_at)) ||
    typeof invite.max_uses !== "number" ||
    !Number.isFinite(invite.max_uses) ||
    (invite.note !== null && !readString(invite.note)) ||
    !readString(invite.token_id) ||
    !readString(routeProbe.path) ||
    (routeProbe.review_count !== null &&
      (typeof routeProbe.review_count !== "number" ||
        !Number.isFinite(routeProbe.review_count))) ||
    typeof routeProbe.status_code !== "number" ||
    !Number.isFinite(routeProbe.status_code) ||
    !readString(record.registration_source) ||
    record.registration_flow !== "invite_token_register" ||
    !readString(record.status) ||
    !readString(record.user_id) ||
    !readString(record.username) ||
    typeof record.verified !== "boolean"
  ) {
    throw new Error(
      `File ${runtimeProvisioningPath} does not contain valid sandbox ${sandboxId} provisioning auth artifacts.`,
    );
  }
}

function assertPersistedProvisioningAuthArtifact(
  authArtifactPath: string,
  user: DualSandboxProvisionedUserSummary,
  sandboxId: SandboxId,
  runtimeProvisioningPath: string,
): void {
  if (!existsSync(authArtifactPath)) {
    throw new Error(
      `Expected sandbox ${sandboxId} auth artifact at ${authArtifactPath} referenced by ${runtimeProvisioningPath}.`,
    );
  }

  const authArtifact =
    readJsonFile<Partial<DualSandboxProvisioningAuthArtifact>>(authArtifactPath);

  if (
    authArtifact.api_key !== user.api_key ||
    authArtifact.contract_version !==
      DUAL_SANDBOX_AUTH_ARTIFACT_CONTRACT_VERSION ||
    !readString(authArtifact.created_at) ||
    authArtifact.registration_flow !== user.registration_flow ||
    authArtifact.registration_source !== user.registration_source ||
    authArtifact.status !== user.status ||
    authArtifact.user_id !== user.user_id ||
    authArtifact.username !== user.username ||
    authArtifact.verified !== user.verified
  ) {
    throw new Error(
      `Sandbox ${sandboxId} auth artifact at ${authArtifactPath} does not match ${runtimeProvisioningPath}.`,
    );
  }
}

function resolveSandboxUser(
  defaults: DualSandboxProvisionUserInput,
  override: Partial<DualSandboxProvisionUserInput> | undefined,
  sandboxId: SandboxId,
): DualSandboxProvisionUserInput {
  return {
    display_name: normalizeRequiredString(
      override?.display_name ?? defaults.display_name,
      `sandboxUsers.${sandboxId}.display_name`,
    ),
    username: normalizeRequiredString(
      override?.username ?? defaults.username,
      `sandboxUsers.${sandboxId}.username`,
    ),
  };
}

function redactProvisionedUser(
  user: DualSandboxProvisionedUserSummary,
): DualSandboxProvisionedUserSummary {
  return {
    ...user,
    api_key: REDACTED_SECRET,
  };
}

function buildProvisioningAuthArtifact(
  user: DualSandboxProvisionedUserSummary,
  createdAt: string,
): DualSandboxProvisioningAuthArtifact {
  return {
    api_key: user.api_key,
    contract_version: DUAL_SANDBOX_AUTH_ARTIFACT_CONTRACT_VERSION,
    created_at: createdAt,
    registration_flow: user.registration_flow,
    registration_source: user.registration_source,
    status: user.status,
    user_id: user.user_id,
    username: user.username,
    verified: user.verified,
  };
}

function redactProvisioningAuthArtifact(
  authArtifact: DualSandboxProvisioningAuthArtifact,
): DualSandboxProvisioningAuthArtifact {
  return {
    ...authArtifact,
    api_key: REDACTED_SECRET,
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

function readReviewCount(value: unknown): number | null {
  const reviewQueue = readRecord(readRecord(value).review_queue);
  const count = reviewQueue.count;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = normalizeRequiredString(baseUrl, "mahiloBaseUrl");
  return normalized.replace(/\/+$/, "");
}

function normalizeRoutePath(path: string): string {
  const normalized = normalizeRequiredString(
    path,
    "activeRouteProbePath",
  );
  if (!normalized.startsWith("/")) {
    throw new Error("activeRouteProbePath must start with '/'.");
  }

  return normalized;
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
  return typeof value === "string" && value.trim() ? value : null;
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
