import { normalizeSelectorDirection } from "@mahilo/policy-core";
import {
  MahiloRequestError,
  type MahiloAgentConnectionSummary,
  type MahiloContractClient,
  type MahiloFriendConnectionDirectory,
  type MahiloFriendshipSummary
} from "./client";
import {
  extractDecision,
  extractResolutionId,
  normalizeDeclaredSelectors,
  type DeclaredSelectors,
  type PolicyDecision
} from "./policy-helpers";
import {
  fetchMahiloPromptContext,
  type FetchMahiloPromptContextOptions,
  type FetchMahiloPromptContextResult
} from "./prompt-context";
import { resolveMahiloSenderConnection } from "./sender-resolution";

export interface MahiloToolContext {
  agentSessionId?: string;
  senderConnectionId?: string;
}

export interface MahiloSendToolInput {
  context?: string;
  correlationId?: string;
  declaredSelectors?: Partial<DeclaredSelectors>;
  idempotencyKey?: string;
  message: string;
  payloadType?: string;
  recipient: string;
  recipientConnectionId?: string;
  routingHints?: Record<string, unknown>;
}

export interface TalkToGroupInput extends MahiloSendToolInput {
  groupId?: string;
}

export interface MahiloToolResult {
  decision: PolicyDecision;
  deduplicated?: boolean;
  messageId?: string;
  reason?: string;
  resolutionId?: string;
  response?: unknown;
  status: "denied" | "review_required" | "sent";
}

export interface MahiloContact {
  connectionId?: string;
  connectionState?: MahiloContactConnectionState;
  connections?: MahiloAgentConnectionSummary[];
  id: string;
  label: string;
  metadata?: Record<string, unknown>;
  type: "group" | "user";
}

export type MahiloContactConnectionState =
  | "available"
  | "blocked"
  | "no_active_connections"
  | "not_found"
  | "not_friends"
  | "request_pending"
  | "transport_failure"
  | "unknown";

export type ContactsProvider = () => Promise<MahiloContact[]>;

export interface GetMahiloContextInput {
  declaredSelectors?: Partial<DeclaredSelectors>;
  includeRecentInteractions?: boolean;
  interactionLimit?: number;
  recipient: string;
  recipientType?: "group" | "user";
  senderConnectionId?: string;
}

export interface GetMahiloContextOptions extends FetchMahiloPromptContextOptions {}

export type MahiloContextToolResult = FetchMahiloPromptContextResult;

export interface PreviewMahiloSendInput extends MahiloSendToolInput {
  recipientType?: "group" | "user";
}

export interface MahiloPreviewRecipientResult {
  decision?: PolicyDecision;
  deliveryMode?: string;
  recipient: string;
}

export interface MahiloPreviewResolvedRecipient {
  recipient: string;
  recipientConnectionId?: string;
  recipientType: "group" | "user";
}

export interface MahiloPreviewReview {
  required?: boolean;
  reviewId?: string;
}

export interface MahiloPreviewResult {
  agentGuidance?: string;
  decision: PolicyDecision;
  deliveryMode?: string;
  expiresAt?: string;
  reasonCode?: string;
  resolutionId?: string;
  resolutionSummary?: string;
  resolvedRecipient?: MahiloPreviewResolvedRecipient;
  response: unknown;
  review?: MahiloPreviewReview;
  serverSelectors: DeclaredSelectors;
  recipientResults: MahiloPreviewRecipientResult[];
}

export interface CreateMahiloOverrideInput {
  durationHours?: number;
  durationMinutes?: number;
  derivedFromMessageId?: string;
  effect: string;
  expiresAt?: string;
  idempotencyKey?: string;
  kind: string;
  maxUses?: number;
  priority?: number;
  recipient?: string;
  recipientType?: "group" | "user";
  reason: string;
  scope: string;
  selectors?: Partial<DeclaredSelectors>;
  senderConnectionId: string;
  sourceResolutionId?: string;
  targetId?: string;
  ttlSeconds?: number;
}

export interface MahiloOverrideResult {
  created?: boolean;
  kind?: string;
  policyId?: string;
  resolvedTargetId?: string;
  response: unknown;
  summary: string;
}

export type ReportedOutcome =
  | "blocked"
  | "partial_sent"
  | "review_approved"
  | "review_rejected"
  | "review_requested"
  | "send_failed"
  | "sent"
  | "withheld";

export interface MahiloRecipientOutcome {
  outcome: ReportedOutcome;
  recipient: string;
}

export interface MahiloSendOutcomeSummary {
  outcome: ReportedOutcome;
  recipientResults?: MahiloRecipientOutcome[];
  reason?: string;
  status: MahiloToolResult["status"];
}

export async function talkToAgent(
  client: MahiloContractClient,
  input: MahiloSendToolInput,
  context: MahiloToolContext
): Promise<MahiloToolResult> {
  return executeSendTool(client, "user", input, context);
}

export async function talkToGroup(
  client: MahiloContractClient,
  input: TalkToGroupInput,
  context: MahiloToolContext
): Promise<MahiloToolResult> {
  return executeSendTool(client, "group", input, context);
}

export async function listMahiloContacts(provider?: ContactsProvider): Promise<MahiloContact[]>;
export async function listMahiloContacts(
  client: MahiloContractClient,
  provider?: ContactsProvider
): Promise<MahiloContact[]>;
export async function listMahiloContacts(
  clientOrProvider?: MahiloContractClient | ContactsProvider,
  fallbackProvider?: ContactsProvider
): Promise<MahiloContact[]> {
  const client =
    typeof clientOrProvider === "function" || clientOrProvider === undefined
      ? undefined
      : clientOrProvider;
  const provider = typeof clientOrProvider === "function" ? clientOrProvider : fallbackProvider;

  if (client && hasMahiloSocialContactSupport(client)) {
    return listMahiloContactsFromServer(client);
  }

  if (!provider) {
    return [];
  }

  const contacts = await provider();
  return contacts.map((contact) => ({
    ...contact,
    label: contact.label.trim()
  }));
}

export async function getMahiloContext(
  client: MahiloContractClient,
  input: GetMahiloContextInput,
  options: GetMahiloContextOptions = {}
): Promise<MahiloContextToolResult> {
  const senderConnectionId =
    input.senderConnectionId ??
    (await resolveMahiloSenderConnection(client)).connectionId;

  return fetchMahiloPromptContext(
    client,
    {
      ...input,
      senderConnectionId
    },
    options
  );
}

export async function previewMahiloSend(
  client: MahiloContractClient,
  input: PreviewMahiloSendInput,
  context: MahiloToolContext
): Promise<MahiloPreviewResult> {
  const recipientType = input.recipientType ?? "user";
  const normalizedSelectors = normalizeDeclaredSelectors(input.declaredSelectors, "outbound");
  const response = await client.resolveDraft(
    buildSendPayload(recipientType, input, context, normalizedSelectors)
  );

  return summarizePreviewResponse(response, normalizedSelectors, input.recipient, recipientType);
}

export async function createMahiloOverride(
  client: MahiloContractClient,
  input: CreateMahiloOverrideInput
): Promise<MahiloOverrideResult> {
  const normalized = await normalizeOverrideRequest(client, input);
  const payload = compactObject({
    derived_from_message_id: input.derivedFromMessageId,
    effect: normalized.effect,
    expires_at: normalized.expiresAt,
    kind: normalized.kind,
    max_uses: normalized.maxUses,
    priority: input.priority,
    reason: input.reason,
    scope: normalized.scope,
    selectors: normalized.selectors,
    sender_connection_id: input.senderConnectionId,
    source_resolution_id: input.sourceResolutionId,
    target_id: normalized.targetId,
    ttl_seconds: normalized.ttlSeconds
  });
  const response = await client.createOverride(payload, input.idempotencyKey);
  const root = readObject(response);
  const created = readBoolean(root?.created);
  const kind = readString(root?.kind) ?? normalized.kind;
  const policyId = readString(root?.policy_id) ?? readString(root?.policyId);

  return {
    created,
    kind,
    policyId,
    resolvedTargetId: normalized.targetId,
    response,
    summary: formatOverrideSummary({
      created,
      effect: normalized.effect,
      expiresAt: normalized.expiresAt,
      kind,
      policyId,
      scope: normalized.scope,
      selectors: normalized.selectors,
      targetId: normalized.targetId,
      targetLabel: normalized.targetLabel,
      ttlSeconds: normalized.ttlSeconds
    })
  };
}

interface NormalizedOverrideRequest {
  effect: string;
  expiresAt?: string;
  kind: "one_time" | "persistent" | "temporary";
  maxUses?: number;
  scope: "global" | "group" | "role" | "user";
  selectors?: DeclaredSelectors;
  targetId?: string;
  targetLabel?: string;
  ttlSeconds?: number;
}

async function normalizeOverrideRequest(
  client: MahiloContractClient,
  input: CreateMahiloOverrideInput
): Promise<NormalizedOverrideRequest> {
  const effect = normalizeOverrideEffect(input.effect);
  const kind = normalizeOverrideKind(input.kind);
  const scope = normalizeOverrideScope(input.scope);

  if (!effect) {
    throw new Error("effect is required");
  }

  if (!kind) {
    throw new Error(
      "kind is required (use one_time, temporary, or persistent; aliases once/expiring/always are also accepted)"
    );
  }

  if (!scope) {
    throw new Error("scope is required (use global, user, group, or role)");
  }

  const selectors = input.selectors
    ? normalizeDeclaredSelectors(input.selectors, "outbound")
    : undefined;
  const expiresAt = readString(input.expiresAt);
  const ttlSeconds = resolveOverrideTtlSeconds(input);
  const maxUses = kind === "one_time" ? 1 : normalizeMaxUses(input.maxUses);

  validateOverrideLifecycle({
    expiresAt,
    kind,
    maxUses,
    ttlSeconds
  });

  const targetId =
    scope === "global"
      ? undefined
      : readString(input.targetId) ??
        (scope === "user"
          ? await resolveUserOverrideTargetId(client, {
              recipient: readString(input.recipient),
              recipientType: input.recipientType,
              selectors,
              senderConnectionId: input.senderConnectionId
            })
          : undefined);

  if (scope !== "global" && !targetId) {
    if (scope === "user") {
      throw new Error("user-scoped overrides require targetId or recipient");
    }

    throw new Error(`${scope}-scoped overrides require targetId`);
  }

  return {
    effect,
    expiresAt,
    kind,
    maxUses,
    scope,
    selectors,
    targetId,
    targetLabel: readString(input.recipient) ?? targetId,
    ttlSeconds
  };
}

function normalizeOverrideEffect(value: string | undefined): string | undefined {
  return readString(value)?.toLowerCase();
}

function normalizeOverrideKind(
  value: string | undefined
): "one_time" | "persistent" | "temporary" | undefined {
  const normalized = readString(value)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) {
    return undefined;
  }

  if (
    normalized === "one_time" ||
    normalized === "once" ||
    normalized === "single_use" ||
    normalized === "single"
  ) {
    return "one_time";
  }

  if (
    normalized === "temporary" ||
    normalized === "expiring" ||
    normalized === "expires" ||
    normalized === "temporary_rule"
  ) {
    return "temporary";
  }

  if (
    normalized === "persistent" ||
    normalized === "permanent" ||
    normalized === "always"
  ) {
    return "persistent";
  }

  return undefined;
}

function normalizeOverrideScope(
  value: string | undefined
): "global" | "group" | "role" | "user" | undefined {
  const normalized = readString(value)?.toLowerCase();
  if (
    normalized === "global" ||
    normalized === "group" ||
    normalized === "role" ||
    normalized === "user"
  ) {
    return normalized;
  }

  return undefined;
}

function normalizeMaxUses(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function resolveOverrideTtlSeconds(input: CreateMahiloOverrideInput): number | undefined {
  const ttlSeconds = normalizePositiveInteger(input.ttlSeconds);
  if (typeof ttlSeconds === "number") {
    return ttlSeconds;
  }

  const durationMinutes = normalizePositiveInteger(input.durationMinutes);
  if (typeof durationMinutes === "number") {
    return durationMinutes * 60;
  }

  const durationHours = normalizePositiveInteger(input.durationHours);
  if (typeof durationHours === "number") {
    return durationHours * 60 * 60;
  }

  return undefined;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function validateOverrideLifecycle(options: {
  expiresAt?: string;
  kind: "one_time" | "persistent" | "temporary";
  maxUses?: number;
  ttlSeconds?: number;
}): void {
  if (options.kind === "temporary" && !options.expiresAt && typeof options.ttlSeconds !== "number") {
    throw new Error(
      "temporary overrides require expiresAt, ttlSeconds, durationMinutes, or durationHours"
    );
  }

  if (
    options.kind === "persistent" &&
    (options.expiresAt || typeof options.ttlSeconds === "number" || typeof options.maxUses === "number")
  ) {
    throw new Error("persistent overrides cannot include expiry or maxUses");
  }
}

async function resolveUserOverrideTargetId(
  client: MahiloContractClient,
  options: {
    recipient?: string;
    recipientType?: "group" | "user";
    selectors?: DeclaredSelectors;
    senderConnectionId: string;
  }
): Promise<string | undefined> {
  if (!options.recipient) {
    return undefined;
  }

  if (options.recipientType === "group") {
    throw new Error("recipientType=group cannot be used for a user-scoped override");
  }

  const context = await fetchMahiloPromptContext(client, {
    declaredSelectors: options.selectors,
    includeRecentInteractions: false,
    interactionLimit: 1,
    recipient: options.recipient,
    recipientType: "user",
    senderConnectionId: options.senderConnectionId
  });

  const recipientId = context.context?.recipient.id;
  if (context.ok && recipientId) {
    return recipientId;
  }

  const detail = context.error ? `: ${context.error}` : "";
  throw new Error(
    `Could not resolve a Mahilo user ID for recipient ${options.recipient}${detail}. Pass targetId explicitly or fetch Mahilo context first.`
  );
}

function formatOverrideSummary(options: {
  created?: boolean;
  effect: string;
  expiresAt?: string;
  kind: string;
  policyId?: string;
  scope: string;
  selectors?: DeclaredSelectors;
  targetId?: string;
  targetLabel?: string;
  ttlSeconds?: number;
}): string {
  const status = options.created === false ? "Submitted" : "Created";
  const lifecycle = describeOverrideLifecycle(options.kind, options.expiresAt, options.ttlSeconds);
  const scope = describeOverrideScope(options.scope, options.targetLabel ?? options.targetId);
  const selectors = options.selectors
    ? ` covering ${options.selectors.direction}/${options.selectors.resource}/${options.selectors.action}`
    : "";
  const base = `${status} ${lifecycle} (${options.effect}) ${scope}${selectors}`;

  return options.policyId ? `${base} [${options.policyId}].` : `${base}.`;
}

function describeOverrideLifecycle(
  kind: string,
  expiresAt?: string,
  ttlSeconds?: number
): string {
  if (kind === "one_time") {
    if (expiresAt) {
      return `one-time override until ${expiresAt}`;
    }

    return "one-time override";
  }

  if (kind === "temporary") {
    if (expiresAt) {
      return `temporary rule until ${expiresAt}`;
    }

    if (typeof ttlSeconds === "number") {
      return `temporary rule for ${formatDuration(ttlSeconds)}`;
    }

    return "temporary rule";
  }

  return "persistent rule";
}

function describeOverrideScope(scope: string, targetLabel?: string): string {
  if (scope === "global") {
    return "globally";
  }

  if (!targetLabel) {
    return `for ${scope}`;
  }

  return `for ${scope} ${targetLabel}`;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds % (60 * 60 * 24) === 0) {
    const days = totalSeconds / (60 * 60 * 24);
    return `${days} day${days === 1 ? "" : "s"}`;
  }

  if (totalSeconds % (60 * 60) === 0) {
    const hours = totalSeconds / (60 * 60);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  if (totalSeconds % 60 === 0) {
    const minutes = totalSeconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
}

async function executeSendTool(
  client: MahiloContractClient,
  recipientType: "group" | "user",
  input: MahiloSendToolInput,
  context: MahiloToolContext
): Promise<MahiloToolResult> {
  const normalizedSelectors = normalizeDeclaredSelectors(input.declaredSelectors, "outbound");
  const sendPayload = buildSendPayload(recipientType, input, context, normalizedSelectors);

  const sendResponse = await client.sendMessage(sendPayload, input.idempotencyKey);
  const sendDecision = extractDecision(sendResponse);
  const resolutionId = extractResolutionId(sendResponse);
  const messageId = extractMessageId(sendResponse);
  const deduplicated = extractDeduplicated(sendResponse);
  const sendOutcomeSummary = summarizeMahiloSendOutcome(
    sendResponse,
    sendDecision,
    input.recipient
  );

  return {
    decision: sendDecision,
    deduplicated,
    messageId,
    reason: sendOutcomeSummary.reason,
    resolutionId,
    response: sendResponse,
    status: sendOutcomeSummary.status
  };
}

function buildSendPayload(
  recipientType: "group" | "user",
  input: MahiloSendToolInput,
  context: MahiloToolContext,
  normalizedSelectors: DeclaredSelectors
): Record<string, unknown> {
  return compactObject({
    agent_session_id: context.agentSessionId,
    context: input.context,
    correlation_id: input.correlationId,
    declared_selectors: normalizedSelectors,
    idempotency_key: input.idempotencyKey,
    message: input.message,
    payload_type: input.payloadType ?? "text/plain",
    recipient: input.recipient,
    recipient_connection_id: input.recipientConnectionId,
    recipient_type: recipientType,
    routing_hints: input.routingHints,
    sender_connection_id: context.senderConnectionId
  });
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};

  for (const [key, candidate] of Object.entries(value)) {
    if (candidate === undefined) {
      continue;
    }

    compacted[key] = candidate;
  }

  return compacted;
}

interface ResolvedMahiloFriendConnectionDirectory {
  connections: MahiloAgentConnectionSummary[];
  raw: unknown;
  state: MahiloContactConnectionState;
  username?: string;
}

function hasMahiloSocialContactSupport(
  client: MahiloContractClient
): client is MahiloContractClient & {
  getFriendAgentConnections: (username: string) => Promise<MahiloFriendConnectionDirectory>;
  listFriendships: (params?: { status?: string }) => Promise<MahiloFriendshipSummary[]>;
} {
  const typedClient = client as MahiloContractClient & {
    getFriendAgentConnections?: (username: string) => Promise<MahiloFriendConnectionDirectory>;
    listFriendships?: (params?: { status?: string }) => Promise<MahiloFriendshipSummary[]>;
  };

  return (
    typeof typedClient.listFriendships === "function" &&
    typeof typedClient.getFriendAgentConnections === "function"
  );
}

async function listMahiloContactsFromServer(
  client: MahiloContractClient & {
    getFriendAgentConnections: (username: string) => Promise<MahiloFriendConnectionDirectory>;
    listFriendships: (params?: { status?: string }) => Promise<MahiloFriendshipSummary[]>;
  }
): Promise<MahiloContact[]> {
  const friendships = await client.listFriendships({ status: "accepted" });
  const contacts = await Promise.all(
    friendships.map((friendship) => buildMahiloContactFromFriendship(client, friendship))
  );

  return contacts.sort(compareMahiloContacts);
}

async function buildMahiloContactFromFriendship(
  client: MahiloContractClient & {
    getFriendAgentConnections: (username: string) => Promise<MahiloFriendConnectionDirectory>;
  },
  friendship: MahiloFriendshipSummary
): Promise<MahiloContact> {
  const directory = await resolveFriendConnectionDirectory(client, friendship.username);
  const connections = sortMahiloConnections(directory.connections);
  const primaryConnection = pickPrimaryContactConnection(connections);
  const id = readString(friendship.username) ?? readString(friendship.userId) ?? friendship.friendshipId;
  const label = readString(friendship.displayName) ?? readString(friendship.username) ?? id;

  return {
    connectionId: primaryConnection?.id,
    connectionState: directory.state,
    connections,
    id,
    label,
    metadata: compactObject({
      connectionCount: connections.length,
      connectionState: directory.state,
      direction: friendship.direction,
      displayName: friendship.displayName,
      friendshipId: friendship.friendshipId,
      interactionCount: friendship.interactionCount,
      roles: friendship.roles.length > 0 ? friendship.roles : undefined,
      since: friendship.since,
      status: friendship.status,
      username: friendship.username,
      userId: friendship.userId
    }),
    type: "user"
  };
}

async function resolveFriendConnectionDirectory(
  client: MahiloContractClient & {
    getFriendAgentConnections: (username: string) => Promise<MahiloFriendConnectionDirectory>;
  },
  username?: string
): Promise<ResolvedMahiloFriendConnectionDirectory> {
  if (!username) {
    return {
      connections: [],
      raw: undefined,
      state: "not_found"
    };
  }

  try {
    const directory = await client.getFriendAgentConnections(username);
    return {
      connections: directory.connections,
      raw: directory.raw,
      state: directory.state,
      username: directory.username
    };
  } catch (error) {
    return {
      connections: [],
      raw: error,
      state: mapMahiloContactConnectionState(error),
      username
    };
  }
}

function pickPrimaryContactConnection(
  connections: MahiloAgentConnectionSummary[]
): MahiloAgentConnectionSummary | undefined {
  return sortMahiloConnections(connections)[0];
}

function sortMahiloConnections(
  connections: MahiloAgentConnectionSummary[]
): MahiloAgentConnectionSummary[] {
  return [...connections].sort((left, right) => {
    const priorityDelta = (right.priority ?? 0) - (left.priority ?? 0);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const leftLabel = left.label ?? "";
    const rightLabel = right.label ?? "";
    const labelComparison = leftLabel.localeCompare(rightLabel);
    if (labelComparison !== 0) {
      return labelComparison;
    }

    return left.id.localeCompare(right.id);
  });
}

function compareMahiloContacts(left: MahiloContact, right: MahiloContact): number {
  const labelComparison = left.label.localeCompare(right.label);
  if (labelComparison !== 0) {
    return labelComparison;
  }

  return left.id.localeCompare(right.id);
}

function mapMahiloContactConnectionState(error: unknown): MahiloContactConnectionState {
  if (error instanceof MahiloRequestError) {
    switch (error.productState) {
      case "blocked":
        return "blocked";
      case "not_found":
        return "not_found";
      case "not_friends":
        return "not_friends";
      case "request_pending":
        return "request_pending";
      case "transport_failure":
        return "transport_failure";
      default:
        return "unknown";
    }
  }

  return "unknown";
}

function extractMessageId(value: unknown): string | undefined {
  const root = readObject(value);
  if (!root) {
    return undefined;
  }

  if (typeof root.message_id === "string" && root.message_id.length > 0) {
    return root.message_id;
  }

  if (typeof root.id === "string" && root.id.length > 0) {
    return root.id;
  }

  const result = readObject(root.result);
  if (result && typeof result.message_id === "string" && result.message_id.length > 0) {
    return result.message_id;
  }

  return undefined;
}

function extractDeduplicated(value: unknown): boolean | undefined {
  const root = readObject(value);
  if (!root) {
    return undefined;
  }

  if (typeof root.deduplicated === "boolean") {
    return root.deduplicated;
  }

  const result = readObject(root.result);
  if (result && typeof result.deduplicated === "boolean") {
    return result.deduplicated;
  }

  return undefined;
}

function summarizePreviewResponse(
  response: unknown,
  fallbackSelectors: DeclaredSelectors,
  fallbackRecipient: string,
  fallbackRecipientType: "group" | "user"
): MahiloPreviewResult {
  const root = readObject(response);
  const result = root ? readObject(root.result) : undefined;
  const resolution = readObject(root?.resolution) ?? readObject(result?.resolution);
  const decision = extractDecision(response);
  const deliveryMode =
    readString(root?.delivery_mode) ??
    readString(result?.delivery_mode) ??
    readString(resolution?.delivery_mode);
  const reasonCode =
    readString(root?.reason_code) ??
    readString(result?.reason_code) ??
    readString(resolution?.reason_code);
  const resolutionSummary =
    readString(root?.resolution_summary) ??
    readString(result?.resolution_summary) ??
    readResolutionSummary(root) ??
    readResolutionSummary(result);
  const resolvedRecipient =
    readPreviewResolvedRecipient(root?.resolved_recipient, fallbackRecipient, fallbackRecipientType) ??
    readPreviewResolvedRecipient(result?.resolved_recipient, fallbackRecipient, fallbackRecipientType);
  const review = readPreviewReview(root?.review) ?? readPreviewReview(result?.review);
  const recipientResults = readPreviewRecipientResults(
    root?.recipient_results ?? result?.recipient_results,
    fallbackRecipient,
    decision,
    deliveryMode
  );

  return {
    agentGuidance: normalizeBoundaryLanguage(
      readString(root?.agent_guidance) ?? readString(result?.agent_guidance)
    ),
    decision,
    deliveryMode,
    expiresAt: readString(root?.expires_at) ?? readString(result?.expires_at),
    reasonCode,
    resolutionId: extractResolutionId(response),
    resolutionSummary,
    resolvedRecipient,
    response,
    review,
    serverSelectors: readPreviewSelectors(
      root?.server_selectors ?? result?.server_selectors,
      fallbackSelectors
    ),
    recipientResults
  };
}

function normalizeBoundaryLanguage(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.replace(
    /\bcreate an override\b/giu,
    "adjust boundaries"
  );
}

export function summarizeMahiloSendOutcome(
  response: unknown,
  fallbackDecision: PolicyDecision,
  fallbackRecipient: string
): MahiloSendOutcomeSummary {
  const root = readObject(response);
  const result = root ? readObject(root.result) : undefined;
  const inferredOutcome = inferOutcomeFromResponse(root, result, fallbackDecision);
  const recipientResults = readRecipientOutcomes(root, result, inferredOutcome, fallbackRecipient);
  const outcome = deriveAggregateOutcome(recipientResults, inferredOutcome);
  const reason = deriveOutcomeReason(outcome, root, result);

  return {
    outcome,
    reason,
    recipientResults,
    status: outcomeToToolStatus(outcome)
  };
}

function inferOutcomeFromResponse(
  root: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
  fallbackDecision: PolicyDecision
): ReportedOutcome {
  const status = readString(root?.status) ?? readString(result?.status);
  if (status === "review_required" || status === "approval_pending") {
    return "review_requested";
  }
  if (status === "rejected" || status === "blocked") {
    return "blocked";
  }
  if (status === "failed") {
    return "send_failed";
  }
  if (status === "partial_sent") {
    return "partial_sent";
  }

  const deliveryStatus = readString(root?.delivery_status) ?? readString(result?.delivery_status);
  if (deliveryStatus === "review_required" || deliveryStatus === "approval_pending") {
    return "review_requested";
  }
  if (deliveryStatus === "rejected") {
    return "blocked";
  }
  if (deliveryStatus === "failed") {
    return "send_failed";
  }

  const resolution = readObject(root?.resolution) ?? readObject(result?.resolution);
  const deliveryMode = readString(resolution?.delivery_mode);
  if (deliveryMode === "review_required" || deliveryMode === "hold_for_approval") {
    return "review_requested";
  }
  if (deliveryMode === "blocked") {
    return "blocked";
  }

  if (fallbackDecision === "ask") {
    return "review_requested";
  }
  if (fallbackDecision === "deny") {
    return "blocked";
  }

  return "sent";
}

function readRecipientOutcomes(
  root: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
  fallbackOutcome: ReportedOutcome,
  fallbackRecipient: string
): MahiloRecipientOutcome[] | undefined {
  const rawResults = Array.isArray(root?.recipient_results)
    ? root.recipient_results
    : Array.isArray(result?.recipient_results)
      ? result.recipient_results
      : [];

  const normalizedResults: MahiloRecipientOutcome[] = [];
  for (const rawResult of rawResults) {
    const recipientResult = readObject(rawResult);
    if (!recipientResult) {
      continue;
    }

    const recipient = readString(recipientResult.recipient);
    if (!recipient) {
      continue;
    }

    normalizedResults.push({
      outcome: inferRecipientOutcome(recipientResult, fallbackOutcome),
      recipient
    });
  }

  if (normalizedResults.length > 0) {
    return normalizedResults;
  }

  if (fallbackRecipient.length > 0) {
    return [
      {
        outcome: fallbackOutcome,
        recipient: fallbackRecipient
      }
    ];
  }

  return undefined;
}

function inferRecipientOutcome(
  recipientResult: Record<string, unknown>,
  fallbackOutcome: ReportedOutcome
): ReportedOutcome {
  const deliveryStatus = readString(recipientResult.delivery_status);
  if (deliveryStatus === "delivered") {
    return "sent";
  }
  if (deliveryStatus === "review_required" || deliveryStatus === "approval_pending") {
    return "review_requested";
  }
  if (deliveryStatus === "rejected") {
    return "blocked";
  }
  if (deliveryStatus === "failed") {
    return "send_failed";
  }

  const deliveryMode = readString(recipientResult.delivery_mode);
  if (deliveryMode === "review_required" || deliveryMode === "hold_for_approval") {
    return "review_requested";
  }
  if (deliveryMode === "blocked") {
    return "blocked";
  }

  const decision = extractDecision(recipientResult);
  if (decision === "ask") {
    return "review_requested";
  }
  if (decision === "deny") {
    return "blocked";
  }

  return fallbackOutcome;
}

function deriveAggregateOutcome(
  recipientResults: MahiloRecipientOutcome[] | undefined,
  fallbackOutcome: ReportedOutcome
): ReportedOutcome {
  if (!recipientResults || recipientResults.length === 0) {
    return fallbackOutcome;
  }

  const outcomes = new Set(recipientResults.map((result) => result.outcome));
  if (outcomes.size === 1) {
    return recipientResults[0].outcome;
  }

  if (outcomes.has("sent")) {
    return "partial_sent";
  }

  return fallbackOutcome;
}

function deriveOutcomeReason(
  outcome: ReportedOutcome,
  root: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined
): string | undefined {
  const summary =
    readResolutionSummary(root) ??
    readResolutionSummary(result) ??
    readString(root?.rejection_reason) ??
    readString(result?.rejection_reason);

  if (outcome === "review_requested") {
    return summary ?? "policy review required";
  }
  if (outcome === "blocked") {
    return summary ?? "request denied by policy";
  }
  if (outcome === "send_failed") {
    return summary ?? "message delivery failed";
  }

  return undefined;
}

function outcomeToToolStatus(outcome: ReportedOutcome): MahiloToolResult["status"] {
  if (outcome === "review_requested") {
    return "review_required";
  }

  if (
    outcome === "blocked" ||
    outcome === "review_rejected" ||
    outcome === "send_failed" ||
    outcome === "withheld"
  ) {
    return "denied";
  }

  return "sent";
}

function readResolutionSummary(value: Record<string, unknown> | undefined): string | undefined {
  const resolution = readObject(value?.resolution);
  if (!resolution) {
    return undefined;
  }

  return (
    readString(resolution.summary) ??
    readString(resolution.reason) ??
    readString(resolution.resolution_summary)
  );
}

function readPreviewResolvedRecipient(
  value: unknown,
  fallbackRecipient: string,
  fallbackRecipientType: "group" | "user"
): MahiloPreviewResolvedRecipient | undefined {
  const recipient = readObject(value);
  const resolvedRecipient =
    readString(recipient?.recipient) ??
    readString(recipient?.id) ??
    fallbackRecipient;

  if (!resolvedRecipient) {
    return undefined;
  }

  return {
    recipient: resolvedRecipient,
    recipientConnectionId:
      readString(recipient?.recipient_connection_id) ??
      readString(recipient?.recipientConnectionId),
    recipientType:
      readRecipientType(recipient?.recipient_type) ??
      readRecipientType(recipient?.recipientType) ??
      fallbackRecipientType
  };
}

function readPreviewReview(value: unknown): MahiloPreviewReview | undefined {
  const review = readObject(value);
  if (!review) {
    return undefined;
  }

  const normalized: MahiloPreviewReview = {};
  const required = readBoolean(review.required);
  const reviewId = readString(review.review_id) ?? readString(review.reviewId);

  if (typeof required === "boolean") {
    normalized.required = required;
  }

  if (reviewId) {
    normalized.reviewId = reviewId;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function readPreviewSelectors(
  value: unknown,
  fallbackSelectors: DeclaredSelectors
): DeclaredSelectors {
  const selectors = readObject(value);
  if (!selectors) {
    return fallbackSelectors;
  }

  return normalizeDeclaredSelectors(
    {
      action: readString(selectors.action),
      direction: readSelectorDirection(selectors.direction),
      resource: readString(selectors.resource)
    },
    fallbackSelectors.direction
  );
}

function readPreviewRecipientResults(
  value: unknown,
  fallbackRecipient: string,
  fallbackDecision: PolicyDecision,
  fallbackDeliveryMode?: string
): MahiloPreviewRecipientResult[] {
  const recipientResults: MahiloPreviewRecipientResult[] = [];
  const rawResults = Array.isArray(value) ? value : [];

  for (const rawResult of rawResults) {
    const recipientResult = readObject(rawResult);
    if (!recipientResult) {
      continue;
    }

    const recipient = readString(recipientResult.recipient);
    if (!recipient) {
      continue;
    }

    recipientResults.push({
      decision: extractDecision(recipientResult, fallbackDecision),
      deliveryMode: readString(recipientResult.delivery_mode),
      recipient
    });
  }

  if (recipientResults.length > 0) {
    return recipientResults;
  }

  if (!fallbackRecipient) {
    return [];
  }

  return [
    {
      decision: fallbackDecision,
      deliveryMode: fallbackDeliveryMode,
      recipient: fallbackRecipient
    }
  ];
}

function readRecipientType(value: unknown): "group" | "user" | undefined {
  return value === "group" || value === "user" ? value : undefined;
}

function readSelectorDirection(value: unknown): DeclaredSelectors["direction"] | undefined {
  return normalizeSelectorDirection(typeof value === "string" ? value : undefined);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
