import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { DualSandboxBootstrapSummary } from "./dual-sandbox-bootstrap-lib";

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

  const parsed = readJsonFile<Partial<DualSandboxBootstrapSummary>>(
    runtimeProvisioningPath,
  );
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.run_root !== "string" ||
    typeof parsed.runtime_dir !== "string" ||
    typeof parsed.artifacts_dir !== "string" ||
    typeof parsed.paths !== "object" ||
    parsed.paths === null ||
    typeof parsed.paths.runtime_provisioning_path !== "string"
  ) {
    throw new Error(
      `File ${runtimeProvisioningPath} does not contain a valid dual-sandbox bootstrap summary.`,
    );
  }

  return parsed as DualSandboxBootstrapSummary;
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
  const inviteNote = `SBX-020 ${input.bootstrap.run_id} sandbox-${input.sandboxId} invite`;
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
