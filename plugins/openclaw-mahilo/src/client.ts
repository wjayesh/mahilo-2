import { CONTRACT_ENDPOINTS, MAHILO_CONTRACT_VERSION } from "./contract";

const AGENTS_ENDPOINT = "/api/v1/agents";
const AUTH_ME_ENDPOINT = "/api/v1/auth/me";
const AUTH_REGISTER_ENDPOINT = "/api/v1/auth/register";

export interface MahiloClientOptions {
  apiKey: string;
  baseUrl: string;
  contractVersion?: string;
  pluginVersion: string;
}

export interface RegisterMahiloIdentityInput {
  displayName?: string;
  username: string;
}

export interface MahiloIdentitySummary {
  displayName?: string;
  raw: unknown;
  userId?: string;
  username?: string;
  verified?: boolean;
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

export class MahiloRequestError extends Error {
  readonly bodyText?: string;
  readonly status: number;

  constructor(message: string, status: number, bodyText?: string) {
    super(message);
    this.name = "MahiloRequestError";
    this.bodyText = bodyText;
    this.status = status;
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

  async createOverride(payload: Record<string, unknown>): Promise<unknown> {
    return this.postJson(CONTRACT_ENDPOINTS.overrides, payload);
  }

  async decideReview(
    reviewId: string,
    payload: {
      approved: boolean;
      notes?: string;
      reason?: string;
    },
  ): Promise<unknown> {
    return this.postJson(`${CONTRACT_ENDPOINTS.reviews}/${encodeURIComponent(reviewId)}/decision`, payload);
  }

  async getCurrentIdentity(): Promise<MahiloIdentitySummary> {
    const response = await this.request(AUTH_ME_ENDPOINT, { method: "GET" });
    return normalizeIdentitySummary(response);
  }

  async getPromptContext(payload: Record<string, unknown>): Promise<unknown> {
    return this.postJson(CONTRACT_ENDPOINTS.promptContext, payload);
  }

  async listAgentConnections(): Promise<MahiloAgentConnectionSummary[]> {
    const response = await this.request(AGENTS_ENDPOINT, { method: "GET" });
    return normalizeAgentConnections(response);
  }

  async listBlockedEvents(limit = 20): Promise<unknown> {
    const search = new URLSearchParams({ limit: String(limit) });
    return this.request(`${CONTRACT_ENDPOINTS.reviews}/blocked-events?${search.toString()}`, { method: "GET" });
  }

  async listReviews(params?: {
    direction?: string;
    limit?: number;
    status?: string;
  }): Promise<unknown> {
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
      search.size > 0
        ? `${CONTRACT_ENDPOINTS.reviews}?${search.toString()}`
        : CONTRACT_ENDPOINTS.reviews;

    return this.request(endpoint, { method: "GET" });
  }

  async pingAgentConnection(connectionId: string): Promise<unknown> {
    return this.postJson(`${AGENTS_ENDPOINT}/${encodeURIComponent(connectionId)}/ping`, {});
  }

  async registerIdentity(payload: RegisterMahiloIdentityInput): Promise<unknown> {
    return this.postJson(
      AUTH_REGISTER_ENDPOINT,
      compactObject({
        display_name: payload.displayName,
        username: payload.username,
      }),
      undefined,
      { auth: false },
    );
  }

  async reportOutcome(payload: Record<string, unknown>): Promise<unknown> {
    return this.postJson(CONTRACT_ENDPOINTS.outcomes, payload);
  }

  async resolveDraft(
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<unknown> {
    return this.postJson(CONTRACT_ENDPOINTS.resolve, payload, idempotencyKey);
  }

  async sendMessage(payload: Record<string, unknown>, idempotencyKey?: string): Promise<unknown> {
    return this.postJson(CONTRACT_ENDPOINTS.send, payload, idempotencyKey);
  }

  private buildHeaders(
    idempotencyKey?: string,
    options: {
      auth?: boolean;
      contentType?: string;
    } = {},
  ): Headers {
    const headers = new Headers();
    headers.set("Accept", "application/json");
    headers.set("X-Mahilo-Plugin-Version", this.pluginVersion);
    headers.set("X-Mahilo-Plugin-Contract", this.contractVersion);

    const contentType = options.contentType ?? "application/json";
    if (contentType) {
      headers.set("Content-Type", contentType);
    }

    if (options.auth !== false) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }

    if (idempotencyKey) {
      headers.set("Idempotency-Key", idempotencyKey);
    }

    return headers;
  }

  private async postJson(
    endpoint: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
    options?: {
      auth?: boolean;
    },
  ): Promise<unknown> {
    return this.request(
      endpoint,
      {
        body: JSON.stringify(payload),
        headers: this.buildHeaders(idempotencyKey, { auth: options?.auth }),
        method: "POST",
      },
      { auth: options?.auth },
    );
  }

  private async request(
    endpoint: string,
    init: RequestInit,
    options?: {
      auth?: boolean;
    },
  ): Promise<unknown> {
    const response = await fetch(new URL(endpoint, `${this.baseUrl}/`), {
      ...init,
      headers:
        init.headers instanceof Headers
          ? init.headers
          : this.buildHeaders(undefined, { auth: options?.auth }),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new MahiloRequestError(
        `Mahilo request failed with status ${response.status}`,
        response.status,
        bodyText || undefined,
      );
    }

    if (bodyText.length === 0) {
      return {};
    }

    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      return { raw: bodyText };
    }
  }
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function findArrayRecord(root: Record<string, unknown>): Record<string, unknown>[] {
  const directArray = readRecordArray(root.data);
  if (directArray.length > 0) {
    return directArray;
  }

  const candidates = [
    root.agents,
    root.connections,
    root.items,
    root.results,
    root.records,
    root.data,
  ];

  for (const candidate of candidates) {
    const records = readRecordArray(candidate);
    if (records.length > 0) {
      return records;
    }
  }

  return [];
}

function normalizeAgentConnection(record: Record<string, unknown>): MahiloAgentConnectionSummary | null {
  const id =
    readString(record.id) ??
    readString(record.connection_id) ??
    readString(record.agent_id);
  if (!id) {
    return null;
  }

  const status = readString(record.status);
  const explicitActive = readBoolean(record.active) ?? readBoolean(record.is_active);
  const active =
    explicitActive ??
    !["archived", "deleted", "disabled", "inactive", "revoked"].includes(
      (status ?? "").toLowerCase(),
    );

  return {
    active,
    callbackUrl: readString(record.callback_url) ?? readString(record.callbackUrl),
    framework: readString(record.framework),
    id,
    label: readString(record.label) ?? readString(record.name),
    priority: readNumber(record.priority) ?? readNumber(record.rank),
    raw: record,
    status,
  };
}

function normalizeAgentConnections(response: unknown): MahiloAgentConnectionSummary[] {
  const root = readRecord(response);
  const records =
    root === null
      ? readRecordArray(response)
      : findArrayRecord(root);

  const unique = new Map<string, MahiloAgentConnectionSummary>();
  for (const record of records) {
    const connection = normalizeAgentConnection(record);
    if (connection) {
      unique.set(connection.id, connection);
    }
  }

  return [...unique.values()];
}

function normalizeIdentitySummary(response: unknown): MahiloIdentitySummary {
  const root = readRecord(response) ?? {};
  const candidate =
    readRecord(root.user) ??
    readRecord(root.identity) ??
    readRecord(root.data) ??
    root;

  return {
    displayName:
      readString(candidate.display_name) ??
      readString(candidate.displayName) ??
      readString(candidate.name),
    raw: response,
    userId:
      readString(candidate.user_id) ??
      readString(candidate.id),
    username:
      readString(candidate.username) ??
      readString(candidate.handle),
    verified: resolveIdentityVerified(candidate),
  };
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => readRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveIdentityVerified(record: Record<string, unknown>): boolean | undefined {
  const explicit =
    readBoolean(record.verified) ??
    readBoolean(record.is_verified);
  if (explicit !== undefined) {
    return explicit;
  }

  const verifiedAt =
    readString(record.verified_at) ??
    readString(record.verifiedAt);
  return verifiedAt ? true : undefined;
}
