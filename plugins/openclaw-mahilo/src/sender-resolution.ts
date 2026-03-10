import type {
  MahiloAgentConnectionSummary,
  MahiloAgentRegistrationResult,
  MahiloContractClient,
  MahiloIdentitySummary
} from "./client";
import type { MahiloPluginConfig } from "./config";
import { DEFAULT_WEBHOOK_ROUTE_PATH } from "./webhook-route";

const DEFAULT_SENDER_CACHE_KEY = "mahilo_default_sender_connection";
const PREFERRED_FRAMEWORK = "openclaw";
const PREFERRED_LABEL = "default";

export interface SenderResolutionCache {
  getCachedContext(cacheKey: string, nowMs?: number): unknown | undefined;
  setCachedContext(cacheKey: string, value: unknown, nowMs?: number): void;
}

export interface MahiloSenderInspection {
  checkedAt: string;
  connections: MahiloAgentConnectionSummary[];
  identity: MahiloIdentitySummary | null;
}

export interface ResolvedMahiloSenderConnection {
  availableConnections: MahiloAgentConnectionSummary[];
  cacheKey?: string;
  connection: MahiloAgentConnectionSummary;
  connectionId: string;
  explicit?: boolean;
  reason: string;
  selectionReason?: string;
  source: "auto" | "cache" | "cached" | "explicit" | "live" | "preferred";
  username?: string;
}

export interface MahiloSetupSummary {
  availableConnections: MahiloAgentConnectionSummary[];
  checkedAt: string;
  configSummary: {
    baseUrl: string;
    callbackPath: string;
    callbackUrl?: string;
    promptContextEnabled: boolean;
    reviewMode: string;
  };
  connectivity: {
    errors: string[];
    identityOk: boolean;
    senderPingOk: boolean | null;
    senderResolved: boolean;
  };
  defaultBoundaries: {
    conservative: boolean;
    reviewMode: string;
    summary: string;
  };
  identity: MahiloIdentitySummary | null;
  notes: string[];
  sender: ResolvedMahiloSenderConnection | null;
}

export interface ResolveMahiloSenderConnectionOptions {
  cache?: SenderResolutionCache;
  explicitSenderConnectionId?: string;
  nowMs?: number;
}

export interface RunMahiloSetupOptions {
  ping?: boolean;
  preferredSenderConnectionId?: string;
}

const senderResolutionCaches = new WeakMap<object, SenderResolutionCache>();

export function attachMahiloSenderResolutionCache(
  client: MahiloContractClient,
  cache: SenderResolutionCache
): void {
  senderResolutionCaches.set(client as unknown as object, cache);
}

export class MahiloSenderResolver {
  private cachedInspection: MahiloSenderInspection | null = null;
  private cachedSelection: ResolvedMahiloSenderConnection | null = null;
  private preferredSenderConnectionId?: string;

  getPreferredSenderConnectionId(): string | undefined {
    return this.preferredSenderConnectionId;
  }

  async inspect(
    client: MahiloContractClient,
    options: {
      refresh?: boolean;
    } = {}
  ): Promise<MahiloSenderInspection> {
    if (!options.refresh && this.cachedInspection) {
      return this.cachedInspection;
    }

    const [identity, connections] = await Promise.all([
      readCurrentIdentity(client).catch(() => null),
      readAgentConnections(client)
    ]);

    const inspection: MahiloSenderInspection = {
      checkedAt: new Date().toISOString(),
      connections,
      identity
    };

    this.cachedInspection = inspection;
    return inspection;
  }

  rememberPreferredSender(connectionId?: string | null): void {
    const normalized = normalizeConnectionId(connectionId);
    this.preferredSenderConnectionId = normalized;
    if (
      this.cachedSelection &&
      normalized &&
      this.cachedSelection.connectionId !== normalized
    ) {
      this.cachedSelection = null;
    }
  }

  async resolve(
    client: MahiloContractClient,
    options: {
      explicitSenderConnectionId?: string;
      refresh?: boolean;
    } = {}
  ): Promise<ResolvedMahiloSenderConnection> {
    const inspection = await this.inspect(client, { refresh: options.refresh });
    const resolved = this.selectConnection(inspection, options.explicitSenderConnectionId);
    this.cachedSelection = resolved;
    return resolved;
  }

  async runSetup(
    client: MahiloContractClient,
    config: MahiloPluginConfig,
    options: RunMahiloSetupOptions = {}
  ): Promise<MahiloSetupSummary> {
    const inspection = await this.inspect(client, { refresh: true });
    const errors: string[] = [];
    const notes: string[] = [];

    let sender: ResolvedMahiloSenderConnection | null = null;
    try {
      sender = this.selectConnection(inspection, options.preferredSenderConnectionId);
      this.cachedSelection = sender;
    } catch (error) {
      errors.push(toErrorMessage(error));
    }

    let senderPingOk: boolean | null = null;
    if (sender && options.ping !== false) {
      try {
        await pingAgentConnection(client, sender.connectionId);
        senderPingOk = true;
      } catch (error) {
        senderPingOk = false;
        errors.push(
          `Connectivity check failed for sender ${sender.connectionId}: ${toErrorMessage(error)}`
        );
      }
    }

    if (!sender) {
      notes.push(
        "No Mahilo sender connection is attached to this plugin yet. Attach an existing agent connection or register one on the Mahilo server, then rerun mahilo setup."
      );
    }

    if (!config.promptContextEnabled) {
      notes.push(
        "Prompt context enrichment is currently disabled in plugin config. Setup completed, but Mahilo context injection will stay off until promptContextEnabled is turned back on."
      );
    }

    return {
      availableConnections: inspection.connections,
      checkedAt: inspection.checkedAt,
      configSummary: {
        baseUrl: config.baseUrl,
        callbackPath: config.callbackPath ?? DEFAULT_WEBHOOK_ROUTE_PATH,
        callbackUrl: config.callbackUrl,
        promptContextEnabled: config.promptContextEnabled,
        reviewMode: config.reviewMode
      },
      connectivity: {
        errors,
        identityOk: inspection.identity !== null,
        senderPingOk,
        senderResolved: sender !== null
      },
      defaultBoundaries: {
        conservative: isConservativeReviewMode(config.reviewMode),
        reviewMode: config.reviewMode,
        summary: buildBoundarySummary(config)
      },
      identity: inspection.identity,
      notes,
      sender
    };
  }

  private selectConnection(
    inspection: MahiloSenderInspection,
    explicitSenderConnectionId?: string
  ): ResolvedMahiloSenderConnection {
    const connections = inspection.connections;
    if (connections.length === 0) {
      throw new Error("Mahilo setup could not find any agent connections for the current identity.");
    }

    const explicitId = normalizeConnectionId(explicitSenderConnectionId);
    if (explicitId) {
      const explicitConnection = findConnectionById(connections, explicitId);
      if (!explicitConnection) {
        throw new Error(
          `Mahilo setup could not find sender connection ${explicitId} for the current identity.`
        );
      }
      this.preferredSenderConnectionId = explicitConnection.id;
      return buildResolvedConnection(
        inspection,
        explicitConnection,
        "explicit",
        "explicit sender override"
      );
    }

    const preferredId = normalizeConnectionId(this.preferredSenderConnectionId);
    if (preferredId) {
      const preferredConnection = findConnectionById(connections, preferredId);
      if (preferredConnection) {
        return buildResolvedConnection(
          inspection,
          preferredConnection,
          "preferred",
          "remembered setup choice"
        );
      }
    }

    const cachedId = normalizeConnectionId(this.cachedSelection?.connectionId);
    if (cachedId) {
      const cachedConnection = findConnectionById(connections, cachedId);
      if (cachedConnection) {
        return buildResolvedConnection(
          inspection,
          cachedConnection,
          "cached",
          "cached default sender"
        );
      }
    }

    const selection = pickDefaultSenderConnection(connections);
    if (!selection) {
      throw new Error("Mahilo setup could not derive a default sender connection.");
    }

    return buildResolvedConnection(inspection, selection.connection, "auto", selection.reason);
  }
}

export async function resolveMahiloSenderConnection(
  client: MahiloContractClient,
  options: ResolveMahiloSenderConnectionOptions = {}
): Promise<ResolvedMahiloSenderConnection> {
  const explicitSenderConnectionId = normalizeConnectionId(options.explicitSenderConnectionId);
  if (explicitSenderConnectionId) {
    const connection = createExplicitConnection(explicitSenderConnectionId);
    return {
      availableConnections: [],
      cacheKey: DEFAULT_SENDER_CACHE_KEY,
      connection,
      connectionId: explicitSenderConnectionId,
      explicit: true,
      reason: "explicit sender override",
      selectionReason: "explicit_override",
      source: "explicit"
    };
  }

  const cache =
    options.cache ?? senderResolutionCaches.get(client as unknown as object);
  const nowMs = options.nowMs ?? Date.now();
  const cached = cache?.getCachedContext(DEFAULT_SENDER_CACHE_KEY, nowMs);
  if (isResolvedMahiloSenderConnection(cached)) {
    return {
      ...cached,
      cacheKey: DEFAULT_SENDER_CACHE_KEY,
      explicit: false,
      source: "cache"
    };
  }

  const connections = await readAgentConnections(client);
  const selection = pickDefaultSenderConnection(connections);
  if (!selection) {
    throw new Error(
      "Mahilo could not resolve a default sender connection because no active agent connections were found."
    );
  }

  const identity = await readCurrentIdentity(client).catch(() => null);
  const resolved: ResolvedMahiloSenderConnection = {
    availableConnections: connections,
    cacheKey: DEFAULT_SENDER_CACHE_KEY,
    connection: selection.connection,
    connectionId: selection.connection.id,
    explicit: false,
    reason: describeAutomaticSelection(connections, selection.reason),
    selectionReason: selection.reason,
    source: "live",
    username: identity?.username
  };
  cache?.setCachedContext(DEFAULT_SENDER_CACHE_KEY, resolved, nowMs);
  return resolved;
}

export function pickDefaultSenderConnection(
  connections: MahiloAgentConnectionSummary[]
): { connection: MahiloAgentConnectionSummary; reason: string } | undefined {
  const activeConnections = filterActiveConnections(connections);
  if (activeConnections.length === 0) {
    return undefined;
  }

  const sortedConnections = activeConnections.slice().sort(compareConnections);
  const connection = sortedConnections[0];
  if (!connection) {
    return undefined;
  }

  if (connection.active && isDefaultConnection(connection)) {
    return { connection, reason: "server_default" };
  }
  if (isOpenClawFramework(connection.framework)) {
    return { connection, reason: "preferred_framework" };
  }
  if (isDefaultLabel(connection.label)) {
    return { connection, reason: "preferred_label" };
  }
  return { connection, reason: "lexical_fallback" };
}

function buildBoundarySummary(config: MahiloPluginConfig): string {
  if (isConservativeReviewMode(config.reviewMode)) {
    return `Conservative defaults are active. reviewMode=${config.reviewMode} keeps Mahilo sends behind confirmation instead of silent auto-send.`;
  }

  return `reviewMode=${config.reviewMode} is not conservative. Mahilo setup completed, but this configuration will allow more permissive behavior than the default ask flow.`;
}

function buildResolvedConnection(
  inspection: MahiloSenderInspection,
  connection: MahiloAgentConnectionSummary,
  source: ResolvedMahiloSenderConnection["source"],
  reason: string
): ResolvedMahiloSenderConnection {
  return {
    availableConnections: inspection.connections,
    connection,
    connectionId: connection.id,
    reason,
    selectionReason: reason,
    source,
    username: inspection.identity?.username
  };
}

function compareConnections(
  left: MahiloAgentConnectionSummary,
  right: MahiloAgentConnectionSummary
): number {
  if (left.active !== right.active) {
    return left.active ? -1 : 1;
  }

  const leftDefault = isDefaultConnection(left);
  const rightDefault = isDefaultConnection(right);
  if (leftDefault !== rightDefault) {
    return leftDefault ? -1 : 1;
  }

  const leftOpenClaw = isOpenClawFramework(left.framework);
  const rightOpenClaw = isOpenClawFramework(right.framework);
  if (leftOpenClaw !== rightOpenClaw) {
    return leftOpenClaw ? -1 : 1;
  }

  const leftPriority = left.priority ?? Number.NEGATIVE_INFINITY;
  const rightPriority = right.priority ?? Number.NEGATIVE_INFINITY;
  if (leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }

  const leftLabel = (left.label ?? left.id).toLowerCase();
  const rightLabel = (right.label ?? right.id).toLowerCase();
  if (leftLabel !== rightLabel) {
    return leftLabel.localeCompare(rightLabel);
  }

  return left.id.localeCompare(right.id);
}

function createExplicitConnection(connectionId: string): MahiloAgentConnectionSummary {
  return {
    active: true,
    id: connectionId,
    raw: { id: connectionId }
  };
}

function describeAutomaticSelection(
  connections: MahiloAgentConnectionSummary[],
  reason: string
): string {
  if (connections.length === 1) {
    return "only available sender connection";
  }

  if (reason === "server_default") {
    return "active default sender connection";
  }

  if (reason === "preferred_framework") {
    return "highest-ranked active OpenClaw connection";
  }

  if (reason === "preferred_label") {
    return "active connection labeled default";
  }

  return "deterministic lexical fallback across active sender connections";
}

function filterActiveConnections(
  connections: MahiloAgentConnectionSummary[]
): MahiloAgentConnectionSummary[] {
  const explicitlyActive = connections.filter((connection) => connection.active);
  if (explicitlyActive.length > 0) {
    return explicitlyActive;
  }

  return connections;
}

function findConnectionById(
  connections: MahiloAgentConnectionSummary[],
  connectionId: string
): MahiloAgentConnectionSummary | null {
  return connections.find((connection) => connection.id === connectionId) ?? null;
}

function isConservativeReviewMode(reviewMode: string): boolean {
  return reviewMode === "ask" || reviewMode === "manual";
}

function isDefaultConnection(connection: MahiloAgentConnectionSummary): boolean {
  return Boolean((connection.raw as Record<string, unknown> | undefined)?.is_default) || isDefaultLabel(connection.label);
}

function isDefaultLabel(label?: string): boolean {
  return (label ?? "").trim().toLowerCase() === PREFERRED_LABEL;
}

function isOpenClawFramework(framework?: string): boolean {
  return (framework ?? "").trim().toLowerCase() === PREFERRED_FRAMEWORK;
}

function isResolvedMahiloSenderConnection(
  value: unknown
): value is ResolvedMahiloSenderConnection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const root = value as Record<string, unknown>;
  return (
    typeof root.connectionId === "string" &&
    root.connectionId.length > 0 &&
    typeof root.reason === "string" &&
    Array.isArray(root.availableConnections)
  );
}

function normalizeConnectionId(value?: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

async function pingAgentConnection(
  client: MahiloContractClient,
  connectionId: string
): Promise<unknown> {
  const callable = client as MahiloContractClient & {
    pingAgentConnection?: (senderConnectionId: string) => Promise<unknown>;
  };
  if (typeof callable.pingAgentConnection === "function") {
    return callable.pingAgentConnection(connectionId);
  }

  return undefined;
}

export async function registerMahiloAgentConnection(
  client: MahiloContractClient,
  payload: {
    callbackSecret?: string;
    callbackUrl?: string;
    capabilities?: string[];
    description?: string;
    framework: string;
    label: string;
    mode?: "polling" | "webhook";
    publicKey?: string;
    publicKeyAlgorithm?: "ed25519" | "x25519";
    rotateSecret?: boolean;
    routingPriority?: number;
  }
): Promise<MahiloAgentRegistrationResult> {
  const typedClient = client as MahiloContractClient & {
    registerAgentConnection?: (input: typeof payload) => Promise<MahiloAgentRegistrationResult>;
  };
  if (typeof typedClient.registerAgentConnection !== "function") {
    throw new Error("Mahilo client does not support agent connection registration");
  }

  return typedClient.registerAgentConnection(payload);
}

async function readAgentConnections(
  client: MahiloContractClient
): Promise<MahiloAgentConnectionSummary[]> {
  const typedClient = client as MahiloContractClient & {
    listAgentConnections?: () => Promise<MahiloAgentConnectionSummary[]>;
    listOwnAgentConnections?: () => Promise<unknown>;
  };

  if (typeof typedClient.listAgentConnections === "function") {
    return typedClient.listAgentConnections();
  }

  const response = await typedClient.listOwnAgentConnections?.();
  return normalizeAgentConnections(response);
}

async function readCurrentIdentity(
  client: MahiloContractClient
): Promise<MahiloIdentitySummary | null> {
  const typedClient = client as MahiloContractClient & {
    getCurrentIdentity?: () => Promise<MahiloIdentitySummary>;
  };
  if (typeof typedClient.getCurrentIdentity !== "function") {
    return null;
  }

  return typedClient.getCurrentIdentity();
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Unknown Mahilo sender resolution error";
}
