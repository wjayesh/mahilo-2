import { CONTRACT_ENDPOINTS, MAHILO_CONTRACT_VERSION } from "./contract";

const DEFAULT_CLIENT_NAME = "openclaw-plugin";
const AGENTS_ENDPOINT = "/api/v1/agents";
const AUTH_ME_ENDPOINT = "/api/v1/auth/me";
const AUTH_REGISTER_ENDPOINT = "/api/v1/auth/register";

export interface MahiloClientOptions {
  apiKey: string;
  baseUrl: string;
  contractVersion?: string;
  pluginVersion: string;
}

export interface MahiloIdentitySummary {
  displayName?: string;
  raw: unknown;
  userId?: string;
  username?: string;
  verified?: boolean;
}

export interface RegisterMahiloIdentityInput {
  displayName?: string;
  username: string;
}

export interface MahiloAgentConnectionSummary {
  active: boolean;
  callbackUrl?: string;
  framework?: string;
  id: string;
  label?: string;
  priority?: number;
  raw: unknown;
  status?: string;
}

export type MahiloRequestErrorKind = "http" | "network";

export class MahiloRequestError extends Error {
  readonly retryable: boolean;
  readonly kind: MahiloRequestErrorKind;
  readonly status?: number;
  readonly bodyText?: string;

  constructor(
    message: string,
    kindOrOptions:
      | MahiloRequestErrorKind
      | { bodyText?: string; kind: MahiloRequestErrorKind; status?: number },
    status?: number,
    bodyText?: string
  ) {
    super(message);
    this.name = "MahiloRequestError";

    if (typeof kindOrOptions === "string") {
      this.kind = kindOrOptions;
      this.status = status;
      this.bodyText = bodyText;
    } else {
      this.kind = kindOrOptions.kind;
      this.status = kindOrOptions.status;
      this.bodyText = kindOrOptions.bodyText;
    }

    this.retryable =
      this.kind === "network" ||
      this.status === 408 ||
      this.status === 429 ||
      (this.status ?? 0) >= 500;
  }
}

export class MahiloContractClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly contractVersion: string;
  private readonly pluginVersion: string;

  constructor(options: MahiloClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.contractVersion = options.contractVersion ?? MAHILO_CONTRACT_VERSION;
    this.pluginVersion = options.pluginVersion;
  }

  async getPromptContext(payload: Record<string, unknown>) {
    return this.postJson(CONTRACT_ENDPOINTS.context, payload);
  }

  async resolveDraft(payload: Record<string, unknown>, idempotencyKey?: string) {
    return this.postJson(CONTRACT_ENDPOINTS.resolve, payload, idempotencyKey);
  }

  async sendMessage(payload: Record<string, unknown>, idempotencyKey?: string) {
    return this.postJson(CONTRACT_ENDPOINTS.sendMessage, payload, idempotencyKey);
  }

  async reportOutcome(payload: Record<string, unknown>, idempotencyKey?: string) {
    return this.postJson(CONTRACT_ENDPOINTS.outcomes, payload, idempotencyKey);
  }

  async createOverride(payload: Record<string, unknown>, idempotencyKey?: string) {
    return this.postJson(CONTRACT_ENDPOINTS.overrides, payload, idempotencyKey);
  }

  async listReviews(params?: { direction?: string; limit?: number; status?: string }) {
    const search = new URLSearchParams();
    if (typeof params?.direction === "string" && params.direction.trim().length > 0) {
      search.set("direction", params.direction.trim());
    }
    if (typeof params?.status === "string" && params.status.trim().length > 0) {
      search.set("status", params.status.trim());
    }
    if (typeof params?.limit === "number" && Number.isFinite(params.limit)) {
      search.set("limit", String(Math.max(1, Math.trunc(params.limit))));
    }

    const endpoint =
      search.size > 0 ? `${CONTRACT_ENDPOINTS.reviews}?${search.toString()}` : CONTRACT_ENDPOINTS.reviews;
    return this.request(endpoint, {
      method: "GET"
    });
  }

  async decideReview(reviewId: string, decision: Record<string, unknown>) {
    return this.postJson(`${CONTRACT_ENDPOINTS.reviews}/${encodeURIComponent(reviewId)}/decision`, decision);
  }

  async listBlockedEvents(limitOrOptions: number | { limit?: number } = 20) {
    const limit =
      typeof limitOrOptions === "number"
        ? limitOrOptions
        : typeof limitOrOptions.limit === "number"
          ? limitOrOptions.limit
          : 20;
    const search = new URLSearchParams({
      limit: String(Math.max(1, Math.trunc(limit)))
    });
    return this.request(`${CONTRACT_ENDPOINTS.blockedEvents}?${search.toString()}`, {
      method: "GET"
    });
  }

  async listOwnAgentConnections() {
    return this.request(AGENTS_ENDPOINT, {
      method: "GET"
    });
  }

  async listAgentConnections(): Promise<MahiloAgentConnectionSummary[]> {
    const response = await this.listOwnAgentConnections();
    return normalizeAgentConnections(response);
  }

  async getCurrentIdentity(): Promise<MahiloIdentitySummary> {
    const response = await this.request(AUTH_ME_ENDPOINT, {
      method: "GET"
    });
    return normalizeIdentitySummary(response);
  }

  async registerIdentity(payload: RegisterMahiloIdentityInput) {
    return this.postJson(AUTH_REGISTER_ENDPOINT, compactObject({
      display_name: payload.displayName,
      username: payload.username
    }));
  }

  async pingAgentConnection(connectionId: string) {
    return this.postJson(`${AGENTS_ENDPOINT}/${encodeURIComponent(connectionId)}/ping`, {});
  }

  private async postJson(
    endpoint: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string
  ) {
    return this.request(endpoint, {
      body: JSON.stringify(payload),
      headers: this.buildHeaders(idempotencyKey, true),
      method: "POST"
    });
  }

  private buildHeaders(idempotencyKey?: string, includeContentType = false): Headers {
    const headers = new Headers();
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${this.apiKey}`);
    headers.set("x-mahilo-client", DEFAULT_CLIENT_NAME);
    headers.set("x-mahilo-plugin-version", this.pluginVersion);
    headers.set("x-mahilo-contract-version", this.contractVersion);

    if (includeContentType) {
      headers.set("content-type", "application/json");
    }

    if (idempotencyKey) {
      headers.set("idempotency-key", idempotencyKey);
    }

    return headers;
  }

  private async request(endpoint: string, init: RequestInit) {
    const headers =
      init.headers instanceof Headers ? init.headers : this.mergeHeaders(this.buildHeaders(), init.headers);

    let response: Response;
    try {
      response = await fetch(new URL(endpoint, `${this.baseUrl}/`), {
        ...init,
        headers
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown network failure";
      throw new MahiloRequestError(`Mahilo request failed: ${message}`, "network");
    }

    const bodyText = await response.text();
    if (!response.ok) {
      const detail = bodyText.length > 0 ? `: ${bodyText}` : "";
      throw new MahiloRequestError(
        `Mahilo request failed with status ${response.status}${detail}`,
        "http",
        response.status,
        bodyText || undefined
      );
    }

    if (bodyText.length === 0) {
      return undefined;
    }

    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      return bodyText;
    }
  }

  private mergeHeaders(base: Headers, extra?: HeadersInit): Headers {
    if (!extra) {
      return base;
    }

    const merged = new Headers(base);
    const extraHeaders = new Headers(extra);
    extraHeaders.forEach((value, key) => {
      merged.set(key, value);
    });
    return merged;
  }
}

function normalizeAgentConnections(value: unknown): MahiloAgentConnectionSummary[] {
  if (Array.isArray(value)) {
    return value
      .map(normalizeAgentConnection)
      .filter((connection): connection is MahiloAgentConnectionSummary => connection !== null);
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  const root = value as Record<string, unknown>;
  for (const key of ["agents", "connections", "items", "results", "data"]) {
    const candidate = root[key];
    if (Array.isArray(candidate)) {
      return candidate
        .map(normalizeAgentConnection)
        .filter((connection): connection is MahiloAgentConnectionSummary => connection !== null);
    }
  }

  return [];
}

function normalizeAgentConnection(value: unknown): MahiloAgentConnectionSummary | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const root = value as Record<string, unknown>;
  const id = readFirstString(root, ["id", "connection_id", "connectionId", "agent_connection_id"]);
  if (!id) {
    return null;
  }

  return {
    active: readActiveFlag(root),
    callbackUrl: readFirstString(root, ["callback_url", "callbackUrl"]),
    framework: readFirstString(root, ["framework", "client"]),
    id,
    label: readFirstString(root, ["label", "name", "connection_label"]),
    priority: readNumber(root.priority),
    raw: root,
    status: readFirstString(root, ["status", "state"])
  };
}

function normalizeIdentitySummary(value: unknown): MahiloIdentitySummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { raw: value };
  }

  const root = value as Record<string, unknown>;
  const record =
    typeof root.data === "object" && root.data !== null && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root;

  return {
    displayName: readFirstString(record, ["display_name", "displayName", "name"]),
    raw: value,
    userId: readFirstString(record, ["user_id", "userId", "id"]),
    username: readFirstString(record, ["username", "handle"]),
    verified: typeof record.verified === "boolean" ? record.verified : undefined
  };
}

function readActiveFlag(root: Record<string, unknown>): boolean {
  for (const key of ["active", "is_active", "isActive", "connected", "isConnected"]) {
    if (typeof root[key] === "boolean") {
      return root[key] as boolean;
    }
  }

  const status = readFirstString(root, ["status", "state"])?.toLowerCase();
  return status === "active" || status === "connected" || status === "online" || status === "ready";
}

function readFirstString(
  root: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = root[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, candidate]) => candidate !== undefined));
}
