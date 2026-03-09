import type {
  MahiloAgentConnectionSummary,
  MahiloContractClient,
  MahiloIdentitySummary,
} from "./client";
import type { MahiloPluginConfig } from "./config";
import { DEFAULT_WEBHOOK_ROUTE_PATH } from "./webhook-route";

export interface MahiloSenderInspection {
  checkedAt: string;
  connections: MahiloAgentConnectionSummary[];
  identity: MahiloIdentitySummary | null;
}

export interface ResolvedMahiloSenderConnection {
  availableConnections: MahiloAgentConnectionSummary[];
  connection: MahiloAgentConnectionSummary;
  connectionId: string;
  reason: string;
  source: "auto" | "cached" | "explicit" | "preferred";
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

export interface RunMahiloSetupOptions {
  ping?: boolean;
  preferredSenderConnectionId?: string;
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
    } = {},
  ): Promise<MahiloSenderInspection> {
    if (!options.refresh && this.cachedInspection) {
      return this.cachedInspection;
    }

    const [identity, connections] = await Promise.all([
      client.getCurrentIdentity().catch(() => null),
      client.listAgentConnections(),
    ]);

    const inspection: MahiloSenderInspection = {
      checkedAt: new Date().toISOString(),
      connections,
      identity,
    };

    this.cachedInspection = inspection;
    return inspection;
  }

  rememberPreferredSender(connectionId?: string | null): void {
    const nextValue = normalizeConnectionId(connectionId);
    this.preferredSenderConnectionId = nextValue;
    if (
      this.cachedSelection &&
      nextValue &&
      this.cachedSelection.connectionId !== nextValue
    ) {
      this.cachedSelection = null;
    }
  }

  async resolve(
    client: MahiloContractClient,
    options: {
      explicitSenderConnectionId?: string;
      refresh?: boolean;
    } = {},
  ): Promise<ResolvedMahiloSenderConnection> {
    const inspection = await this.inspect(client, { refresh: options.refresh });
    const resolved = this.selectConnection(inspection, options.explicitSenderConnectionId);
    this.cachedSelection = resolved;
    return resolved;
  }

  async runSetup(
    client: MahiloContractClient,
    config: MahiloPluginConfig,
    options: RunMahiloSetupOptions = {},
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
        await client.pingAgentConnection(sender.connectionId);
        senderPingOk = true;
      } catch (error) {
        senderPingOk = false;
        errors.push(
          `Connectivity check failed for sender ${sender.connectionId}: ${toErrorMessage(error)}`,
        );
      }
    }

    if (!sender) {
      notes.push(
        "No Mahilo sender connection is attached to this plugin yet. Attach an existing agent connection or register one on the Mahilo server, then rerun mahilo setup.",
      );
    }

    if (!config.callbackUrl) {
      notes.push(
        `callbackUrl is not configured. Mahilo will use the webhook route path ${config.callbackPath ?? DEFAULT_WEBHOOK_ROUTE_PATH} inside OpenClaw, but the server still needs a reachable callback URL for agent registration.`,
      );
    }

    if (!config.promptContextEnabled) {
      notes.push(
        "Prompt context enrichment is currently disabled in plugin config. Setup completed, but Mahilo context injection will stay off until promptContextEnabled is turned back on.",
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
        reviewMode: config.reviewMode,
      },
      connectivity: {
        errors,
        identityOk: inspection.identity !== null,
        senderPingOk,
        senderResolved: sender !== null,
      },
      defaultBoundaries: {
        conservative: isConservativeReviewMode(config.reviewMode),
        reviewMode: config.reviewMode,
        summary: buildBoundarySummary(config),
      },
      identity: inspection.identity,
      notes,
      sender,
    };
  }

  private selectConnection(
    inspection: MahiloSenderInspection,
    explicitSenderConnectionId?: string,
  ): ResolvedMahiloSenderConnection {
    const explicitId = normalizeConnectionId(explicitSenderConnectionId);
    const preferredId = normalizeConnectionId(this.preferredSenderConnectionId);
    const cachedId = normalizeConnectionId(this.cachedSelection?.connectionId);
    const connections = inspection.connections;

    if (connections.length === 0) {
      throw new Error("Mahilo setup could not find any agent connections for the current identity.");
    }

    if (explicitId) {
      const explicit = findConnectionById(connections, explicitId);
      if (!explicit) {
        throw new Error(
          `Mahilo setup could not find sender connection ${explicitId} for the current identity.`,
        );
      }
      this.preferredSenderConnectionId = explicit.id;
      return buildResolvedConnection(inspection, explicit, "explicit", "explicit sender override");
    }

    if (preferredId) {
      const preferred = findConnectionById(connections, preferredId);
      if (preferred) {
        return buildResolvedConnection(inspection, preferred, "preferred", "remembered setup choice");
      }
    }

    if (cachedId) {
      const cached = findConnectionById(connections, cachedId);
      if (cached) {
        return buildResolvedConnection(inspection, cached, "cached", "cached default sender");
      }
    }

    const sorted = [...connections].sort(compareConnections);
    const selected = sorted[0];
    if (!selected) {
      throw new Error("Mahilo setup could not derive a default sender connection.");
    }

    return buildResolvedConnection(
      inspection,
      selected,
      "auto",
      describeAutomaticSelection(sorted, selected),
    );
  }
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
  reason: string,
): ResolvedMahiloSenderConnection {
  return {
    availableConnections: inspection.connections,
    connection,
    connectionId: connection.id,
    reason,
    source,
    username: inspection.identity?.username,
  };
}

function compareConnections(
  left: MahiloAgentConnectionSummary,
  right: MahiloAgentConnectionSummary,
): number {
  if (left.active !== right.active) {
    return left.active ? -1 : 1;
  }

  const leftDefault = isDefaultLabel(left.label);
  const rightDefault = isDefaultLabel(right.label);
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

function describeAutomaticSelection(
  sortedConnections: MahiloAgentConnectionSummary[],
  selected: MahiloAgentConnectionSummary,
): string {
  if (sortedConnections.length === 1) {
    return "only available sender connection";
  }

  if (isDefaultLabel(selected.label)) {
    return "connection labeled as default";
  }

  if (isOpenClawFramework(selected.framework)) {
    return "highest-priority active OpenClaw connection";
  }

  if (selected.active) {
    return "highest-priority active sender connection";
  }

  return "fallback sender connection ordering";
}

function findConnectionById(
  connections: MahiloAgentConnectionSummary[],
  connectionId: string,
): MahiloAgentConnectionSummary | null {
  return (
    connections.find((connection) => connection.id === connectionId) ??
    null
  );
}

function isConservativeReviewMode(reviewMode: string): boolean {
  return reviewMode === "ask" || reviewMode === "manual";
}

function isDefaultLabel(label?: string): boolean {
  return (label ?? "").trim().toLowerCase() === "default";
}

function isOpenClawFramework(framework?: string): boolean {
  return (framework ?? "").trim().toLowerCase() === "openclaw";
}

function normalizeConnectionId(value?: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Unknown Mahilo sender resolution error";
}
