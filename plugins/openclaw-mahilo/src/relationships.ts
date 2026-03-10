import {
  MahiloRequestError,
  type MahiloAgentConnectionSummary,
  type MahiloContractClient,
  type MahiloFriendRequestResult,
  type MahiloFriendshipSummary,
  type MahiloProductState
} from "./client";
import { listMahiloContacts, type MahiloContact } from "./tools";

export type MahiloRelationshipAction = "accept" | "decline" | "list" | "send_request";

const DEFAULT_RECENT_ACTIVITY_LIMIT = 6;
const MAX_RECENT_ACTIVITY_LIMIT = 20;

export interface ExecuteMahiloRelationshipActionInput {
  action?: string;
  activityLimit?: number;
  friendshipId?: string;
  username?: string;
}

export interface MahiloPendingFriendRequest {
  direction?: "received" | "sent";
  displayName?: string;
  friendshipId: string;
  label: string;
  since?: string;
  status?: string;
  username?: string;
  userId?: string;
}

export interface MahiloRelationshipError {
  code?: string;
  message: string;
  productState: MahiloProductState;
  retryable: boolean;
  technicalMessage?: string;
}

export interface MahiloRelationshipCounts {
  contacts: number;
  pendingIncoming: number;
  pendingOutgoing: number;
}

export type MahiloRecentActivityKind = "blocked_event" | "review";

export interface MahiloRecentActivitySelectors {
  action?: string;
  direction?: string;
  resource?: string;
}

export interface MahiloRecentActivityItem {
  createdAt?: string;
  decision?: string;
  direction?: string;
  kind: MahiloRecentActivityKind;
  messageId?: string;
  recipient?: string;
  reasonCode?: string;
  reviewId?: string;
  selectors?: MahiloRecentActivitySelectors;
  sender?: string;
  status?: string;
  summary: string;
}

export interface MahiloRecentActivityCounts {
  blockedEvents: number;
  reviews: number;
  total: number;
}

export interface MahiloRelationshipListOptions {
  activityLimit?: number;
}

export interface MahiloRelationshipActionResult {
  action: MahiloRelationshipAction;
  agentConnections?: MahiloAgentConnectionSummary[];
  contacts?: MahiloContact[];
  counts?: MahiloRelationshipCounts;
  error?: MahiloRelationshipError;
  pendingIncoming?: MahiloPendingFriendRequest[];
  pendingOutgoing?: MahiloPendingFriendRequest[];
  recentActivity?: MahiloRecentActivityItem[];
  recentActivityCounts?: MahiloRecentActivityCounts;
  request?: MahiloPendingFriendRequest;
  response?: MahiloFriendRequestResult;
  source: "mahilo_server";
  status: "error" | "success";
  summary: string;
  warnings?: string[];
}

interface PendingRequestDirectory {
  incoming: MahiloPendingFriendRequest[];
  outgoing: MahiloPendingFriendRequest[];
}

interface OptionalSectionResult<T> {
  error?: string;
  value?: T;
}

interface RecentActivityProbe {
  counts: MahiloRecentActivityCounts;
  items: MahiloRecentActivityItem[];
}

interface RelationshipErrorContext {
  request?: MahiloPendingFriendRequest;
  username?: string;
}

export async function executeMahiloRelationshipAction(
  client: MahiloContractClient,
  input: ExecuteMahiloRelationshipActionInput = {}
): Promise<MahiloRelationshipActionResult> {
  const action = normalizeRelationshipAction(input.action);
  if (!action) {
    return createLocalErrorResult(
      "list",
      "Use action=list, send_request, accept, or decline for Mahilo relationship management."
    );
  }

  switch (action) {
    case "list":
      return getMahiloRelationshipView(client, {
        activityLimit: input.activityLimit
      });
    case "send_request":
      return sendMahiloFriendRequest(client, input.username);
    case "accept":
      return actOnMahiloFriendRequest(client, action, input);
    case "decline":
      return actOnMahiloFriendRequest(client, action, input);
    default:
      return createLocalErrorResult(
        "list",
        "Use action=list, send_request, accept, or decline for Mahilo relationship management."
      );
  }
}

export async function getMahiloRelationshipView(
  client: MahiloContractClient,
  options: MahiloRelationshipListOptions = {}
): Promise<MahiloRelationshipActionResult> {
  try {
    const activityLimit = normalizeRecentActivityLimit(options?.activityLimit);
    const [contacts, pendingDirectory, agentConnectionsProbe, recentActivityProbe] = await Promise.all([
      listMahiloContacts(client),
      fetchPendingRequestDirectory(client),
      loadOptionalSection(async () => listOwnAgentConnectionsSorted(client)),
      loadOptionalSection(async () => fetchRecentActivity(client, activityLimit))
    ]);
    const counts: MahiloRelationshipCounts = {
      contacts: contacts.length,
      pendingIncoming: pendingDirectory.incoming.length,
      pendingOutgoing: pendingDirectory.outgoing.length
    };
    const warnings = [
      agentConnectionsProbe.error
        ? `Couldn't load sender connections: ${agentConnectionsProbe.error}`
        : undefined,
      recentActivityProbe.error
        ? `Couldn't load recent Mahilo activity: ${recentActivityProbe.error}`
        : undefined
    ].filter((warning): warning is string => Boolean(warning));

    return {
      action: "list",
      agentConnections: agentConnectionsProbe.value,
      contacts,
      counts,
      pendingIncoming: pendingDirectory.incoming,
      pendingOutgoing: pendingDirectory.outgoing,
      recentActivity: recentActivityProbe.value?.items,
      recentActivityCounts: recentActivityProbe.value?.counts,
      source: "mahilo_server",
      status: "success",
      summary: formatRelationshipDirectorySummary(counts, {
        activityCount: recentActivityProbe.value?.counts.total,
        activityUnavailable: Boolean(recentActivityProbe.error),
        agentConnectionCount: agentConnectionsProbe.value?.length
      }),
      warnings: warnings.length > 0 ? warnings : undefined
    };
  } catch (error) {
    return createRelationshipErrorResult("list", error);
  }
}

async function sendMahiloFriendRequest(
  client: MahiloContractClient,
  rawUsername?: string
): Promise<MahiloRelationshipActionResult> {
  const username = normalizeMahiloUsername(rawUsername);
  if (!username) {
    return createLocalErrorResult(
      "send_request",
      "Provide a Mahilo username to send a friend request."
    );
  }

  try {
    const response = await client.sendFriendRequest(username);
    const request = createRequestRecordFromMutation(username, response, "sent");

    return {
      action: "send_request",
      request,
      response,
      source: "mahilo_server",
      status: "success",
      summary:
        response.status === "accepted"
          ? `Mahilo connected you with ${formatUsername(username)}.`
          : `Sent a Mahilo friend request to ${formatUsername(username)}.`
    };
  } catch (error) {
    return createRelationshipErrorResult("send_request", error, { username });
  }
}

async function actOnMahiloFriendRequest(
  client: MahiloContractClient,
  action: "accept" | "decline",
  input: ExecuteMahiloRelationshipActionInput
): Promise<MahiloRelationshipActionResult> {
  const resolution = await resolvePendingRequestForAction(client, action, input);
  if ("result" in resolution) {
    return resolution.result;
  }

  try {
    const response =
      action === "accept"
        ? await client.acceptFriendRequest(resolution.request.friendshipId)
        : await client.rejectFriendRequest(resolution.request.friendshipId);
    const request = updateRequestRecordFromMutation(resolution.request, action, response);

    return {
      action,
      request,
      response,
      source: "mahilo_server",
      status: "success",
      summary: formatRelationshipMutationSummary(action, resolution.request)
    };
  } catch (error) {
    return createRelationshipErrorResult(action, error, { request: resolution.request });
  }
}

async function resolvePendingRequestForAction(
  client: MahiloContractClient,
  action: "accept" | "decline",
  input: ExecuteMahiloRelationshipActionInput
): Promise<{ request: MahiloPendingFriendRequest } | { result: MahiloRelationshipActionResult }> {
  const username = normalizeMahiloUsername(input.username);
  const friendshipId = readOptionalString(input.friendshipId);

  if (!username && !friendshipId) {
    return {
      result: createLocalErrorResult(
        action,
        `Provide a username or friendshipId to ${action} a pending Mahilo request.`
      )
    };
  }

  let pendingDirectory: PendingRequestDirectory;
  try {
    pendingDirectory = await fetchPendingRequestDirectory(client);
  } catch (error) {
    return {
      result: createRelationshipErrorResult(action, error, { username })
    };
  }

  const pendingRequests = [...pendingDirectory.incoming, ...pendingDirectory.outgoing];
  const matches = pendingRequests.filter((request) =>
    matchesPendingRequest(request, {
      friendshipId,
      username
    })
  );

  if (matches.length === 0) {
    if (username) {
      try {
        const contacts = await listMahiloContacts(client);
        if (
          contacts.some((contact) =>
            sameUsername(contact.metadata?.username, username) || sameUsername(contact.id, username)
          )
        ) {
          return {
            result: createRelationshipStateResult(action, "already_connected", { username })
          };
        }
      } catch (error) {
        return {
          result: createRelationshipErrorResult(action, error, { username })
        };
      }
    }

    return {
      result: createRelationshipStateResult(action, "not_found", {
        username
      })
    };
  }

  const request = pickPendingRequestForAction(matches, action);
  if (!request) {
    return {
      result: createCustomErrorResult(
        action,
        "request_pending",
        `The pending Mahilo request to ${formatTargetLabel(matches[0])} is outgoing. They need to accept it, or use decline to cancel it.`
      )
    };
  }

  return { request };
}

async function fetchPendingRequestDirectory(
  client: MahiloContractClient
): Promise<PendingRequestDirectory> {
  const friendships = await client.listFriendships({ status: "pending" });
  const pendingRequests = friendships
    .map(toPendingFriendRequest)
    .filter((candidate): candidate is MahiloPendingFriendRequest => candidate !== null)
    .sort(comparePendingRequests);

  return {
    incoming: pendingRequests.filter((request) => request.direction === "received"),
    outgoing: pendingRequests.filter((request) => request.direction !== "received")
  };
}

async function loadOptionalSection<T>(
  loader: () => Promise<T>
): Promise<OptionalSectionResult<T>> {
  try {
    return {
      value: await loader()
    };
  } catch (error) {
    return {
      error: toErrorMessage(error)
    };
  }
}

async function listOwnAgentConnectionsSorted(
  client: MahiloContractClient
): Promise<MahiloAgentConnectionSummary[]> {
  const connections = await client.listOwnAgentConnections();
  return [...connections].sort(compareAgentConnections);
}

function compareAgentConnections(
  left: MahiloAgentConnectionSummary,
  right: MahiloAgentConnectionSummary
): number {
  const activeDelta = Number(right.active) - Number(left.active);
  if (activeDelta !== 0) {
    return activeDelta;
  }

  const priorityDelta = (right.priority ?? 0) - (left.priority ?? 0);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const labelComparison = (left.label ?? "").localeCompare(right.label ?? "");
  if (labelComparison !== 0) {
    return labelComparison;
  }

  return left.id.localeCompare(right.id);
}

async function fetchRecentActivity(
  client: MahiloContractClient,
  limit: number
): Promise<RecentActivityProbe> {
  const [reviewsResponse, blockedEventsResponse] = await Promise.all([
    client.listReviews({
      limit,
      status: "review_required,approval_pending"
    }),
    client.listBlockedEvents(limit)
  ]);
  const items = [
    ...normalizeReviewActivityItems(reviewsResponse),
    ...normalizeBlockedEventActivityItems(blockedEventsResponse)
  ]
    .sort(compareRecentActivityItems)
    .slice(0, limit);

  return {
    counts: items.reduce<MahiloRecentActivityCounts>(
      (counts, item) => {
        if (item.kind === "blocked_event") {
          counts.blockedEvents += 1;
        } else {
          counts.reviews += 1;
        }

        counts.total += 1;
        return counts;
      },
      {
        blockedEvents: 0,
        reviews: 0,
        total: 0
      }
    ),
    items
  };
}

function normalizeReviewActivityItems(value: unknown): MahiloRecentActivityItem[] {
  return readCollection(value, ["reviews", "items", "results", "data"])
    .map(toReviewActivityItem)
    .filter((candidate): candidate is MahiloRecentActivityItem => candidate !== null);
}

function toReviewActivityItem(value: unknown): MahiloRecentActivityItem | null {
  const root = readObject(value);
  if (!root) {
    return null;
  }

  return {
    createdAt:
      readOptionalString(root.created_at) ??
      readOptionalString(root.createdAt) ??
      readOptionalString(root.timestamp),
    decision: readOptionalString(root.decision),
    direction:
      readOptionalString(root.queue_direction) ??
      readOptionalString(root.queueDirection) ??
      readOptionalString(root.direction),
    kind: "review",
    messageId:
      readOptionalString(root.message_id) ??
      readOptionalString(root.messageId),
    recipient: readOptionalString(root.recipient),
    reasonCode:
      readOptionalString(root.reason_code) ??
      readOptionalString(root.reasonCode),
    reviewId:
      readOptionalString(root.review_id) ??
      readOptionalString(root.reviewId) ??
      readOptionalString(root.id),
    selectors: readRecentActivitySelectors(root),
    status: readOptionalString(root.status),
    summary:
      readOptionalString(root.summary) ??
      `Mahilo review item${readOptionalString(root.status) ? ` (${readOptionalString(root.status)})` : ""}.`
  };
}

function normalizeBlockedEventActivityItems(value: unknown): MahiloRecentActivityItem[] {
  return readCollection(value, ["blocked_events", "items", "results", "data"])
    .map(toBlockedEventActivityItem)
    .filter((candidate): candidate is MahiloRecentActivityItem => candidate !== null);
}

function toBlockedEventActivityItem(value: unknown): MahiloRecentActivityItem | null {
  const root = readObject(value);
  if (!root) {
    return null;
  }

  return {
    createdAt:
      readOptionalString(root.timestamp) ??
      readOptionalString(root.created_at) ??
      readOptionalString(root.createdAt),
    decision: "deny",
    direction:
      readOptionalString(root.queue_direction) ??
      readOptionalString(root.queueDirection) ??
      readOptionalString(root.direction),
    kind: "blocked_event",
    messageId:
      readOptionalString(root.message_id) ??
      readOptionalString(root.messageId) ??
      readOptionalString(root.id),
    reasonCode:
      readOptionalString(root.reason_code) ??
      readOptionalString(root.reasonCode),
    selectors: readRecentActivitySelectors(root),
    sender: readOptionalString(root.sender),
    status: "blocked",
    summary: readOptionalString(root.reason) ?? "Message blocked by Mahilo policy."
  };
}

function readRecentActivitySelectors(
  root: Record<string, unknown>
): MahiloRecentActivitySelectors | undefined {
  const selectors = readObject(root.selectors);
  const action = readOptionalString(selectors?.action ?? root.action);
  const direction = readOptionalString(selectors?.direction ?? root.direction);
  const resource = readOptionalString(selectors?.resource ?? root.resource);

  if (!action && !direction && !resource) {
    return undefined;
  }

  return {
    action,
    direction,
    resource
  };
}

function compareRecentActivityItems(
  left: MahiloRecentActivityItem,
  right: MahiloRecentActivityItem
): number {
  const leftTime = toSortableTimestamp(left.createdAt);
  const rightTime = toSortableTimestamp(right.createdAt);
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  const leftSummary = left.summary.toLowerCase();
  const rightSummary = right.summary.toLowerCase();
  const summaryComparison = leftSummary.localeCompare(rightSummary);
  if (summaryComparison !== 0) {
    return summaryComparison;
  }

  return (left.messageId ?? left.reviewId ?? "").localeCompare(
    right.messageId ?? right.reviewId ?? ""
  );
}

function toSortableTimestamp(value: string | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function readCollection(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  const root = readObject(value);
  if (!root) {
    return [];
  }

  for (const key of keys) {
    const candidate = root[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function normalizeRecentActivityLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_RECENT_ACTIVITY_LIMIT;
  }

  return Math.min(
    MAX_RECENT_ACTIVITY_LIMIT,
    Math.max(1, Math.trunc(value ?? DEFAULT_RECENT_ACTIVITY_LIMIT))
  );
}

function normalizeRelationshipAction(value: string | undefined): MahiloRelationshipAction | undefined {
  const normalized = readOptionalString(value)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) {
    return "list";
  }

  switch (normalized) {
    case "accept":
    case "approve":
      return "accept";
    case "decline":
    case "reject":
    case "cancel":
    case "withdraw":
      return "decline";
    case "list":
    case "contacts":
    case "list_contacts":
    case "requests":
    case "review":
    case "review_requests":
      return "list";
    case "add":
    case "friend_request":
    case "request":
    case "send":
    case "send_request":
    case "send_friend_request":
      return "send_request";
    default:
      return undefined;
  }
}

function normalizeMahiloUsername(value: string | undefined): string | undefined {
  const normalized = readOptionalString(value);
  if (!normalized) {
    return undefined;
  }

  const username = normalized.replace(/^@+/, "");
  return username.length > 0 ? username : undefined;
}

function toPendingFriendRequest(
  friendship: MahiloFriendshipSummary
): MahiloPendingFriendRequest | null {
  if (!friendship.friendshipId) {
    return null;
  }

  const username = normalizeMahiloUsername(friendship.username);
  const label = readOptionalString(friendship.displayName) ?? username ?? friendship.friendshipId;

  return {
    direction: friendship.direction,
    displayName: readOptionalString(friendship.displayName),
    friendshipId: friendship.friendshipId,
    label,
    since: readOptionalString(friendship.since),
    status: readOptionalString(friendship.status),
    username,
    userId: readOptionalString(friendship.userId)
  };
}

function comparePendingRequests(
  left: MahiloPendingFriendRequest,
  right: MahiloPendingFriendRequest
): number {
  const labelComparison = left.label.localeCompare(right.label);
  if (labelComparison !== 0) {
    return labelComparison;
  }

  return left.friendshipId.localeCompare(right.friendshipId);
}

function matchesPendingRequest(
  request: MahiloPendingFriendRequest,
  target: { friendshipId?: string; username?: string }
): boolean {
  if (target.friendshipId && request.friendshipId === target.friendshipId) {
    return true;
  }

  if (target.username && sameUsername(request.username, target.username)) {
    return true;
  }

  return false;
}

function sameUsername(left: unknown, right: string | undefined): boolean {
  const normalizedLeft = normalizeMahiloUsername(typeof left === "string" ? left : undefined);
  const normalizedRight = normalizeMahiloUsername(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

function pickPendingRequestForAction(
  requests: MahiloPendingFriendRequest[],
  action: "accept" | "decline"
): MahiloPendingFriendRequest | undefined {
  if (action === "accept") {
    return requests.find((request) => request.direction === "received");
  }

  return (
    requests.find((request) => request.direction === "received") ??
    requests.find((request) => request.direction === "sent")
  );
}

function createRequestRecordFromMutation(
  username: string,
  response: MahiloFriendRequestResult,
  direction: "sent"
): MahiloPendingFriendRequest {
  return {
    direction,
    displayName: undefined,
    friendshipId: response.friendshipId ?? `pending:${username}`,
    label: username,
    since: undefined,
    status: response.status ?? "pending",
    username
  };
}

function updateRequestRecordFromMutation(
  request: MahiloPendingFriendRequest,
  action: "accept" | "decline",
  response: MahiloFriendRequestResult
): MahiloPendingFriendRequest {
  return {
    ...request,
    friendshipId: response.friendshipId ?? request.friendshipId,
    status:
      response.status ??
      (action === "accept" ? "accepted" : request.direction === "sent" ? "cancelled" : "declined")
  };
}

function formatRelationshipDirectorySummary(
  counts: MahiloRelationshipCounts,
  options: {
    activityCount?: number;
    activityUnavailable?: boolean;
    agentConnectionCount?: number;
  } = {}
): string {
  const parts: string[] = [];

  if (typeof options.agentConnectionCount === "number") {
    parts.push(
      `${options.agentConnectionCount} sender connection${options.agentConnectionCount === 1 ? "" : "s"}`
    );
  }

  parts.push(
    `${counts.contacts} contact${counts.contacts === 1 ? "" : "s"}`,
    `${counts.pendingIncoming} incoming request${counts.pendingIncoming === 1 ? "" : "s"}`,
    `${counts.pendingOutgoing} outgoing request${counts.pendingOutgoing === 1 ? "" : "s"}`
  );

  if (typeof options.activityCount === "number") {
    parts.push(
      options.activityCount === 0
        ? "no recent activity yet"
        : `${options.activityCount} recent activity item${options.activityCount === 1 ? "" : "s"}`
    );
  } else if (options.activityUnavailable) {
    parts.push("recent activity unavailable");
  }

  const summary = `Mahilo network: ${parts.join(", ")}.`;
  if (counts.contacts === 0 && counts.pendingIncoming === 0 && counts.pendingOutgoing === 0) {
    return `${summary} Add someone with action=send_request, then ask around once they connect an agent.`;
  }

  return summary;
}

function formatRelationshipMutationSummary(
  action: "accept" | "decline",
  request: MahiloPendingFriendRequest
): string {
  if (action === "accept") {
    return `Accepted the Mahilo request from ${formatTargetLabel(request)}.`;
  }

  if (request.direction === "sent") {
    return `Cancelled the pending Mahilo request to ${formatTargetLabel(request)}.`;
  }

  return `Declined the Mahilo request from ${formatTargetLabel(request)}.`;
}

function formatTargetLabel(request: MahiloPendingFriendRequest): string {
  return formatUsername(request.username) ?? request.label;
}

function formatUsername(username: string | undefined): string | undefined {
  return username ? `@${username}` : undefined;
}

function createRelationshipErrorResult(
  action: MahiloRelationshipAction,
  error: unknown,
  context: RelationshipErrorContext = {}
): MahiloRelationshipActionResult {
  if (error instanceof MahiloRequestError) {
    const summary = formatRelationshipErrorSummary(action, error.productState, context);

    return {
      action,
      error: {
        code: error.code,
        message: summary,
        productState: error.productState,
        retryable: error.retryable,
        technicalMessage: error.message
      },
      source: "mahilo_server",
      status: "error",
      summary
    };
  }

  return createCustomErrorResult(
    action,
    "unknown",
    toErrorMessage(error),
    toErrorMessage(error)
  );
}

function createRelationshipStateResult(
  action: MahiloRelationshipAction,
  productState: MahiloProductState,
  context: RelationshipErrorContext = {}
): MahiloRelationshipActionResult {
  const summary = formatRelationshipErrorSummary(action, productState, context);

  return {
    action,
    error: {
      message: summary,
      productState,
      retryable: false
    },
    source: "mahilo_server",
    status: "error",
    summary
  };
}

function createCustomErrorResult(
  action: MahiloRelationshipAction,
  productState: MahiloProductState,
  summary: string,
  technicalMessage?: string
): MahiloRelationshipActionResult {
  return {
    action,
    error: {
      message: summary,
      productState,
      retryable: productState === "transport_failure",
      technicalMessage
    },
    source: "mahilo_server",
    status: "error",
    summary
  };
}

function createLocalErrorResult(
  action: MahiloRelationshipAction,
  summary: string
): MahiloRelationshipActionResult {
  return createCustomErrorResult(action, "invalid_request", summary, summary);
}

function formatRelationshipErrorSummary(
  action: MahiloRelationshipAction,
  productState: MahiloProductState,
  context: RelationshipErrorContext
): string {
  const target =
    formatUsername(context.request?.username ?? context.username) ??
    context.request?.label;

  if (action === "list") {
    switch (productState) {
      case "transport_failure":
        return "Couldn't reach Mahilo right now. Check the server connection and try again.";
      case "not_found":
        return "Mahilo could not load the current relationship listing.";
      default:
        return "Mahilo couldn't load the current relationship listing.";
    }
  }

  switch (productState) {
    case "already_connected":
      return target
        ? `You're already connected with ${target} on Mahilo. Use action=list to check whether their agent is live before asking around.`
        : "You're already connected on Mahilo. Use action=list to check whether their agent is live before asking around.";
    case "blocked":
      return target
        ? `Mahilo blocked the relationship update for ${target}.`
        : "Mahilo blocked that relationship update.";
    case "invalid_request":
      if (action === "accept") {
        return "Provide a username or friendshipId to accept a pending Mahilo request.";
      }

      if (action === "decline") {
        return "Provide a username or friendshipId to decline a pending Mahilo request.";
      }

      return "Provide a Mahilo username to send a friend request.";
    case "not_found":
      if (action === "send_request") {
        return target
          ? `Could not find ${target} on Mahilo. Check the username. If they have not joined yet, ask them to set up Mahilo in OpenClaw, then send the request again.`
          : "Could not find that Mahilo user. Check the username. If they have not joined yet, ask them to set up Mahilo in OpenClaw, then send the request again.";
      }

      return target
        ? `No pending Mahilo request found for ${target}. Use action=list to review pending requests, then retry with the username or friendshipId shown there.`
        : "Could not find that pending Mahilo request. Use action=list to review pending requests, then retry with the username or friendshipId shown there.";
    case "request_pending":
      return target
        ? `There is already a pending Mahilo request with ${target}. Wait for it to be accepted, or use decline to cancel it before retrying.`
        : "There is already a pending Mahilo request. Wait for it to be accepted, or use decline to cancel it before retrying.";
    case "transport_failure":
      return "Couldn't reach Mahilo right now. Check the server connection and try again.";
    default:
      return target
        ? `Mahilo couldn't complete the relationship action for ${target}.`
        : "Mahilo couldn't complete the relationship action.";
  }
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Mahilo relationship action failed";
}
