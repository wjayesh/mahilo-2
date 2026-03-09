import { CONTRACT_ENDPOINTS, MAHILO_CONTRACT_VERSION } from "./contract";

const DEFAULT_CLIENT_NAME = "openclaw-plugin";
const AGENTS_ENDPOINT = CONTRACT_ENDPOINTS.agents;
const AUTH_ME_ENDPOINT = "/api/v1/auth/me";
const AUTH_REGISTER_ENDPOINT = "/api/v1/auth/register";
const CONTACTS_ENDPOINT = CONTRACT_ENDPOINTS.contacts;
const FRIEND_REQUEST_ENDPOINT = CONTRACT_ENDPOINTS.friendRequest;
const FRIENDS_ENDPOINT = CONTRACT_ENDPOINTS.friends;

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
  capabilities?: string[];
  createdAt?: string;
  description?: string;
  framework?: string;
  id: string;
  label?: string;
  lastSeen?: string;
  priority?: number;
  publicKey?: string;
  publicKeyAlgorithm?: string;
  raw: unknown;
  status?: string;
}

export type MahiloFriendshipDirection = "received" | "sent";

export type MahiloFriendshipStatus = "accepted" | "blocked" | "pending";

export interface MahiloFriendshipSummary {
  direction?: MahiloFriendshipDirection;
  displayName?: string;
  friendshipId: string;
  interactionCount?: number;
  raw: unknown;
  roles: string[];
  since?: string;
  status?: MahiloFriendshipStatus | string;
  userId?: string;
  username?: string;
}

export interface MahiloFriendRequestResult {
  friendshipId?: string;
  message?: string;
  raw: unknown;
  status?: MahiloFriendshipStatus | string;
  success?: boolean;
}

export type MahiloFriendConnectionsState = "available" | "no_active_connections";

export interface MahiloFriendConnectionDirectory {
  connections: MahiloAgentConnectionSummary[];
  raw: unknown;
  state: MahiloFriendConnectionsState;
  username: string;
}

export type MahiloProductState =
  | "already_connected"
  | "blocked"
  | "invalid_request"
  | "no_active_connections"
  | "not_found"
  | "not_friends"
  | "request_pending"
  | "transport_failure"
  | "unknown";

export type MahiloRequestErrorKind = "http" | "network";

interface MahiloRequestErrorOptions {
  bodyText?: string;
  code?: string;
  details?: unknown;
  kind: MahiloRequestErrorKind;
  productState?: MahiloProductState;
  responseBody?: unknown;
  status?: number;
}

export class MahiloRequestError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly kind: MahiloRequestErrorKind;
  readonly productState: MahiloProductState;
  readonly responseBody?: unknown;
  readonly status?: number;
  readonly bodyText?: string;

  constructor(
    message: string,
    kindOrOptions: MahiloRequestErrorKind | MahiloRequestErrorOptions,
    status?: number,
    bodyText?: string
  ) {
    super(message);
    this.name = "MahiloRequestError";

    if (typeof kindOrOptions === "string") {
      this.kind = kindOrOptions;
      this.status = status;
      this.bodyText = bodyText;
      this.code = undefined;
      this.details = undefined;
      this.productState = mapProductState({
        kind: kindOrOptions,
        status
      });
      this.responseBody = undefined;
    } else {
      this.kind = kindOrOptions.kind;
      this.status = kindOrOptions.status;
      this.bodyText = kindOrOptions.bodyText;
      this.code = kindOrOptions.code;
      this.details = kindOrOptions.details;
      this.productState =
        kindOrOptions.productState ??
        mapProductState({
          code: kindOrOptions.code,
          kind: kindOrOptions.kind,
          status: kindOrOptions.status
        });
      this.responseBody = kindOrOptions.responseBody;
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

  async listOwnAgentConnections(): Promise<MahiloAgentConnectionSummary[]> {
    const response = await this.request(AGENTS_ENDPOINT, {
      method: "GET"
    });
    return normalizeAgentConnections(response);
  }

  async listAgentConnections(): Promise<MahiloAgentConnectionSummary[]> {
    return this.listOwnAgentConnections();
  }

  async listFriendships(params?: { status?: MahiloFriendshipStatus | string }): Promise<MahiloFriendshipSummary[]> {
    const search = new URLSearchParams();
    const normalizedStatus = normalizeOptionalString(params?.status);
    if (normalizedStatus) {
      search.set("status", normalizedStatus);
    }

    const endpoint =
      search.size > 0 ? `${FRIENDS_ENDPOINT}?${search.toString()}` : FRIENDS_ENDPOINT;
    const response = await this.request(endpoint, {
      method: "GET"
    });
    return normalizeFriendships(response);
  }

  async listFriends(params?: { status?: MahiloFriendshipStatus | string }): Promise<MahiloFriendshipSummary[]> {
    return this.listFriendships(params);
  }

  async sendFriendRequest(username: string): Promise<MahiloFriendRequestResult> {
    const normalizedUsername = normalizeRequiredString(username, "username");
    const response = await this.postJson(FRIEND_REQUEST_ENDPOINT, {
      username: normalizedUsername
    });
    return normalizeFriendRequestResult(response, {
      success: true
    });
  }

  async acceptFriendRequest(friendshipId: string): Promise<MahiloFriendRequestResult> {
    const normalizedFriendshipId = normalizeRequiredString(friendshipId, "friendshipId");
    const response = await this.postJson(
      `${FRIENDS_ENDPOINT}/${encodeURIComponent(normalizedFriendshipId)}/accept`,
      {}
    );
    return normalizeFriendRequestResult(response, {
      friendshipId: normalizedFriendshipId,
      success: true
    });
  }

  async rejectFriendRequest(friendshipId: string): Promise<MahiloFriendRequestResult> {
    const normalizedFriendshipId = normalizeRequiredString(friendshipId, "friendshipId");
    const response = await this.postJson(
      `${FRIENDS_ENDPOINT}/${encodeURIComponent(normalizedFriendshipId)}/reject`,
      {}
    );
    return normalizeFriendRequestResult(response, {
      friendshipId: normalizedFriendshipId,
      success: true
    });
  }

  async listFriendAgentConnections(username: string): Promise<MahiloAgentConnectionSummary[]> {
    const directory = await this.getFriendAgentConnections(username);
    return directory.connections;
  }

  async getFriendAgentConnections(username: string): Promise<MahiloFriendConnectionDirectory> {
    const normalizedUsername = normalizeRequiredString(username, "username");
    const response = await this.request(
      `${CONTACTS_ENDPOINT}/${encodeURIComponent(normalizedUsername)}/connections`,
      {
        method: "GET"
      }
    );
    const connections = normalizeAgentConnections(response);

    return {
      connections,
      raw: response,
      state: connections.length > 0 ? "available" : "no_active_connections",
      username: normalizedUsername
    };
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
      const parsedError = parseErrorPayload(bodyText);
      const detailText = parsedError?.error ?? bodyText;
      const detail = detailText.length > 0 ? `: ${detailText}` : "";
      throw new MahiloRequestError(
        `Mahilo request failed with status ${response.status}${detail}`,
        {
          bodyText: bodyText || undefined,
          code: parsedError?.code,
          details: parsedError?.details,
          kind: "http",
          responseBody: parsedError?.raw,
          status: response.status
        }
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
  return normalizeCollection(value, normalizeAgentConnection, [
    "agents",
    "connections",
    "items",
    "results",
    "data"
  ]);
}

function normalizeAgentConnection(value: unknown): MahiloAgentConnectionSummary | null {
  const root = readObject(value);
  if (!root) {
    return null;
  }

  const id = readFirstString(root, ["id", "connection_id", "connectionId", "agent_connection_id"]);
  if (!id) {
    return null;
  }

  return {
    active: readActiveFlag(root),
    callbackUrl: readFirstString(root, ["callback_url", "callbackUrl"]),
    capabilities: readStringArray(root.capabilities),
    createdAt: readFirstString(root, ["created_at", "createdAt"]),
    description: readFirstString(root, ["description"]),
    framework: readFirstString(root, ["framework", "client"]),
    id,
    label: readFirstString(root, ["label", "name", "connection_label"]),
    lastSeen: readFirstString(root, ["last_seen", "lastSeen"]),
    priority: readFirstNumber(root, ["routing_priority", "routingPriority", "priority"]),
    publicKey: readFirstString(root, ["public_key", "publicKey"]),
    publicKeyAlgorithm: readFirstString(root, ["public_key_alg", "publicKeyAlgorithm", "publicKeyAlg"]),
    raw: root,
    status: readFirstString(root, ["status", "state"])
  };
}

function normalizeFriendships(value: unknown): MahiloFriendshipSummary[] {
  return normalizeCollection(value, normalizeFriendship, [
    "friends",
    "friendships",
    "items",
    "results",
    "data"
  ]);
}

function normalizeFriendship(value: unknown): MahiloFriendshipSummary | null {
  const root = readObject(value);
  if (!root) {
    return null;
  }

  const friendshipId = readFirstString(root, ["friendship_id", "friendshipId", "id"]);
  if (!friendshipId) {
    return null;
  }

  const direction = readFirstString(root, ["direction"]);

  return {
    direction: isFriendshipDirection(direction) ? direction : undefined,
    displayName: readFirstString(root, ["display_name", "displayName", "name"]),
    friendshipId,
    interactionCount: readFirstNumber(root, ["interaction_count", "interactionCount"]),
    raw: root,
    roles: readStringArray(root.roles),
    since: readFirstString(root, ["since", "created_at", "createdAt"]),
    status: readFirstString(root, ["status", "state"]),
    userId: readFirstString(root, ["user_id", "userId"]),
    username: readFirstString(root, ["username", "handle"])
  };
}

function normalizeFriendRequestResult(
  value: unknown,
  fallback: Partial<Omit<MahiloFriendRequestResult, "raw">> = {}
): MahiloFriendRequestResult {
  const root = readObject(value);
  const status = root ? readFirstString(root, ["status", "state"]) : undefined;

  return {
    friendshipId:
      (root ? readFirstString(root, ["friendship_id", "friendshipId", "id"]) : undefined) ??
      fallback.friendshipId,
    message:
      (root ? readFirstString(root, ["message", "detail", "error"]) : undefined) ?? fallback.message,
    raw: value,
    status: status ?? fallback.status,
    success:
      (root ? readBoolean(root.success) : undefined) ??
      fallback.success ??
      (status === "accepted" || status === "pending")
  };
}

function normalizeIdentitySummary(value: unknown): MahiloIdentitySummary {
  const root = readObject(value);
  if (!root) {
    return { raw: value };
  }

  const record =
    readObject(root.data)
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

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
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

function readFirstNumber(
  root: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = readNumber(root[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }

  return normalized;
}

function isFriendshipDirection(value: string | undefined): value is MahiloFriendshipDirection {
  return value === "received" || value === "sent";
}

function normalizeCollection<T>(
  value: unknown,
  normalizeItem: (candidate: unknown) => T | null,
  containerKeys: readonly string[]
): T[] {
  if (Array.isArray(value)) {
    return value
      .map(normalizeItem)
      .filter((candidate): candidate is T => candidate !== null);
  }

  const root = readObject(value);
  if (!root) {
    return [];
  }

  for (const key of containerKeys) {
    const candidate = root[key];
    if (Array.isArray(candidate)) {
      return candidate
        .map(normalizeItem)
        .filter((item): item is T => item !== null);
    }
  }

  return [];
}

interface ParsedErrorPayload {
  code?: string;
  details?: unknown;
  error?: string;
  raw?: unknown;
}

function parseErrorPayload(bodyText: string): ParsedErrorPayload | undefined {
  if (bodyText.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const root = readObject(parsed);
    if (!root) {
      return { raw: parsed };
    }

    return {
      code: readFirstString(root, ["code"]),
      details: root.details,
      error: readFirstString(root, ["error", "message"]),
      raw: parsed
    };
  } catch {
    return undefined;
  }
}

function mapProductState(options: {
  code?: string;
  kind: MahiloRequestErrorKind;
  status?: number;
}): MahiloProductState {
  if (options.kind === "network") {
    return "transport_failure";
  }

  switch (options.code) {
    case "ALREADY_FRIENDS":
      return "already_connected";
    case "BLOCKED":
      return "blocked";
    case "INVALID_REQUEST":
    case "INVALID_ROLE":
    case "VALIDATION_ERROR":
      return "invalid_request";
    case "NOT_FRIENDS":
      return "not_friends";
    case "NOT_FOUND":
    case "USER_NOT_FOUND":
    case "GROUP_NOT_FOUND":
    case "CONNECTION_NOT_FOUND":
    case "SENDER_CONNECTION_NOT_FOUND":
    case "MESSAGE_NOT_FOUND":
    case "SOURCE_MESSAGE_NOT_FOUND":
      return "not_found";
    case "REQUEST_EXISTS":
      return "request_pending";
    default:
      break;
  }

  if (options.status === 400) {
    return "invalid_request";
  }

  if (options.status === 404) {
    return "not_found";
  }

  if (options.status === 409) {
    return "already_connected";
  }

  return "unknown";
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, candidate]) => candidate !== undefined));
}
