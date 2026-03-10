import {
  MahiloRequestError,
  type MahiloContractClient,
  type MahiloFriendRequestResult,
  type MahiloFriendshipSummary,
  type MahiloProductState
} from "./client";
import { listMahiloContacts, type MahiloContact } from "./tools";

export type MahiloRelationshipAction = "accept" | "decline" | "list" | "send_request";

export interface ExecuteMahiloRelationshipActionInput {
  action?: string;
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

export interface MahiloRelationshipActionResult {
  action: MahiloRelationshipAction;
  contacts?: MahiloContact[];
  counts?: MahiloRelationshipCounts;
  error?: MahiloRelationshipError;
  pendingIncoming?: MahiloPendingFriendRequest[];
  pendingOutgoing?: MahiloPendingFriendRequest[];
  request?: MahiloPendingFriendRequest;
  response?: MahiloFriendRequestResult;
  source: "mahilo_server";
  status: "error" | "success";
  summary: string;
}

interface PendingRequestDirectory {
  incoming: MahiloPendingFriendRequest[];
  outgoing: MahiloPendingFriendRequest[];
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
      return listMahiloRelationships(client);
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

async function listMahiloRelationships(
  client: MahiloContractClient
): Promise<MahiloRelationshipActionResult> {
  try {
    const [contacts, pendingDirectory] = await Promise.all([
      listMahiloContacts(client),
      fetchPendingRequestDirectory(client)
    ]);
    const counts: MahiloRelationshipCounts = {
      contacts: contacts.length,
      pendingIncoming: pendingDirectory.incoming.length,
      pendingOutgoing: pendingDirectory.outgoing.length
    };

    return {
      action: "list",
      contacts,
      counts,
      pendingIncoming: pendingDirectory.incoming,
      pendingOutgoing: pendingDirectory.outgoing,
      source: "mahilo_server",
      status: "success",
      summary: formatRelationshipDirectorySummary(counts)
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

function formatRelationshipDirectorySummary(counts: MahiloRelationshipCounts): string {
  if (counts.contacts === 0 && counts.pendingIncoming === 0 && counts.pendingOutgoing === 0) {
    return "Mahilo network: no contacts or pending requests yet. Add someone with action=send_request, then ask around once they connect an agent."
  }

  const parts = [
    `${counts.contacts} contact${counts.contacts === 1 ? "" : "s"}`,
    `${counts.pendingIncoming} incoming request${counts.pendingIncoming === 1 ? "" : "s"}`,
    `${counts.pendingOutgoing} outgoing request${counts.pendingOutgoing === 1 ? "" : "s"}`
  ];

  return `Mahilo network: ${parts.join(", ")}.`;
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Mahilo relationship action failed";
}
