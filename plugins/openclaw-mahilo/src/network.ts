import { normalizePartialSelectorContext } from "@mahilo/policy-core";
import {
  MahiloRequestError,
  type MahiloContractClient,
  type MahiloGroupSummary,
  type MahiloProductState,
} from "./client";
import { type DeclaredSelectors } from "./policy-helpers";
import {
  executeMahiloRelationshipAction,
  type ExecuteMahiloRelationshipActionInput,
  type MahiloRelationshipAction,
  type MahiloRelationshipActionResult,
} from "./relationships";
import {
  listMahiloContacts,
  talkToAgent,
  talkToGroup,
  type MahiloContact,
  type MahiloContactConnectionState,
  type MahiloSendExecutionOptions,
  type MahiloToolContext,
} from "./tools-default-sender";

export type MahiloNetworkAction = MahiloRelationshipAction | "ask_around";

export interface ExecuteMahiloNetworkActionInput
  extends ExecuteMahiloRelationshipActionInput {
  correlationId?: string;
  declaredSelectors?: Partial<DeclaredSelectors>;
  group?: string;
  groupId?: string;
  groupName?: string;
  idempotencyKey?: string;
  message?: string;
  question?: string;
  role?: string;
  roles?: string[];
}

export interface MahiloNetworkError {
  code?: string;
  message: string;
  productState: MahiloProductState;
  retryable: boolean;
  technicalMessage?: string;
}

export type MahiloAskAroundDeliveryStatus =
  | "awaiting_reply"
  | "blocked"
  | "review_required"
  | "send_failed"
  | "skipped";

export type MahiloAskAroundReplyOutcome =
  | "attribution_unverified"
  | "direct_reply"
  | "no_grounded_answer";

export type MahiloAskAroundGapKind =
  | "blocked"
  | "empty_network"
  | "needs_agent_connection"
  | "not_in_network"
  | "not_on_mahilo"
  | "request_pending"
  | "transport_failure"
  | "unknown";

export interface MahiloAskAroundDelivery {
  connectionState?: MahiloContactConnectionState;
  decision?: "allow" | "ask" | "deny";
  messageId?: string;
  productState?: MahiloProductState;
  reason?: string;
  recipient: string;
  recipientLabel: string;
  recipientType: "group" | "user";
  roles?: string[];
  status: MahiloAskAroundDeliveryStatus;
}

export interface MahiloAskAroundReplyRecipient {
  messageId?: string;
  recipient: string;
  recipientLabel: string;
  recipientType: "group" | "user";
}

export interface MahiloAskAroundGap {
  count: number;
  kind: MahiloAskAroundGapKind;
  recipientLabels: string[];
  suggestedAction: string;
  summary: string;
}

export interface MahiloAskAroundCounts {
  awaitingReplies: number;
  blocked: number;
  reviewRequired: number;
  sendFailed: number;
  skipped: number;
}

export interface MahiloAskAroundTarget {
  contactCount?: number;
  groupId?: string;
  groupName?: string;
  kind: "all_contacts" | "group" | "roles";
  memberCount?: number;
  roles?: string[];
}

export interface MahiloAskAroundActionResult {
  action: "ask_around";
  correlationId?: string;
  counts?: MahiloAskAroundCounts;
  deliveries?: MahiloAskAroundDelivery[];
  error?: MahiloNetworkError;
  gaps: MahiloAskAroundGap[];
  question?: string;
  replyRecipients?: MahiloAskAroundReplyRecipient[];
  replyExpectation?: string;
  replyOutcomeKinds: MahiloAskAroundReplyOutcome[];
  senderConnectionId?: string;
  source: "mahilo_server";
  status: "error" | "success";
  summary: string;
  target?: MahiloAskAroundTarget;
}

export type MahiloNetworkActionResult =
  | MahiloAskAroundActionResult
  | MahiloRelationshipActionResult;

const DEFAULT_MAHILO_ASK_AROUND_REPLY_OUTCOME_KINDS: MahiloAskAroundReplyOutcome[] = [
  "direct_reply",
  "no_grounded_answer",
  "attribution_unverified"
];

const ASK_AROUND_GAP_ORDER: MahiloAskAroundGapKind[] = [
  "empty_network",
  "needs_agent_connection",
  "request_pending",
  "not_in_network",
  "not_on_mahilo",
  "blocked",
  "transport_failure",
  "unknown"
];

const EMPTY_NETWORK_SUGGESTED_ACTION =
  "Build your circle from this same tool: use action=send_request to invite one person you trust. Once they accept and finish Mahilo setup in OpenClaw, rerun this ask here for your first working reply.";
const NEEDS_AGENT_CONNECTION_SUGGESTED_ACTION =
  "Your circle is started. Ask them to finish Mahilo setup in OpenClaw, then rerun this ask here as soon as their agent is live.";
const NOT_IN_NETWORK_SUGGESTED_ACTION =
  "Build your circle from this same tool: use action=send_request, or accept their pending request here if they already invited you. Then rerun this ask once they show up as an accepted contact.";
const NOT_ON_MAHILO_SUGGESTED_ACTION =
  "Check the username. If they're new, ask them to run Mahilo setup in OpenClaw, then come back here and use action=send_request.";
const REQUEST_PENDING_SUGGESTED_ACTION =
  "Keep the invite loop moving from this same tool: use action=list to review the pending Mahilo request, accept it here if it's waiting on you, or wait for them to accept, then rerun this ask.";

export async function executeMahiloNetworkAction(
  client: MahiloContractClient,
  input: ExecuteMahiloNetworkActionInput = {},
  context: MahiloToolContext = {},
  options: MahiloSendExecutionOptions = {}
): Promise<MahiloNetworkActionResult> {
  const action = normalizeMahiloNetworkAction(input.action);
  if (!action) {
    return createNetworkErrorResult(
      "Use action=list, send_request, accept, decline, or ask_around for Mahilo network management.",
      "invalid_request"
    );
  }

  if (action === "ask_around") {
    return executeMahiloAskAroundAction(client, input, context, options);
  }

  return executeMahiloRelationshipAction(client, {
    action,
    activityLimit: input.activityLimit,
    friendshipId: input.friendshipId,
    username: input.username
  });
}

export function normalizeMahiloNetworkAction(
  value: string | undefined
): MahiloNetworkAction | undefined {
  const normalized = normalizeToken(value)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) {
    return "list";
  }

  switch (normalized) {
    case "ask":
    case "ask_around":
    case "ask_contacts":
    case "ask_friends":
    case "fanout":
    case "fan_out":
      return "ask_around";
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

async function executeMahiloAskAroundAction(
  client: MahiloContractClient,
  input: ExecuteMahiloNetworkActionInput,
  context: MahiloToolContext,
  options: MahiloSendExecutionOptions = {}
): Promise<MahiloAskAroundActionResult> {
  const question = normalizeToken(input.question) ?? normalizeToken(input.message);
  if (!question) {
    return createNetworkErrorResult(
      "Provide a question or message for Mahilo ask-around.",
      "invalid_request"
    );
  }

  const declaredSelectors = normalizePartialSelectorContext(input.declaredSelectors, {
    normalizeSeparators: true,
  });
  const correlationId = normalizeToken(input.correlationId) ?? createAskAroundCorrelationId();
  const roles = normalizeRoles(input.role, input.roles);
  const groupRef =
    normalizeToken(input.groupId) ??
    normalizeToken(input.groupName) ??
    normalizeToken(input.group);

  if (roles.length > 0 && groupRef) {
    return createNetworkErrorResult(
      "Use either roles or a specific group for Mahilo ask-around, not both at once.",
      "invalid_request"
    );
  }

  if (groupRef) {
    return executeMahiloGroupAskAround(client, {
      correlationId,
      declaredSelectors,
      groupId: normalizeToken(input.groupId),
      groupRef,
      idempotencyKey: normalizeToken(input.idempotencyKey),
      question
    }, context);
  }

  return executeMahiloContactAskAround(client, {
    correlationId,
    declaredSelectors,
    idempotencyKey: normalizeToken(input.idempotencyKey),
    question,
    roles
  }, context, options);
}

async function executeMahiloContactAskAround(
  client: MahiloContractClient,
  options: {
    correlationId: string;
    declaredSelectors?: Partial<DeclaredSelectors>;
    idempotencyKey?: string;
    question: string;
    roles: string[];
  },
  context: MahiloToolContext,
  sendOptions: MahiloSendExecutionOptions = {}
): Promise<MahiloAskAroundActionResult> {
  let contacts: MahiloContact[];
  try {
    contacts = await listMahiloContacts(client);
  } catch (error) {
    return createAskAroundErrorResult(error, "Mahilo couldn't load your contacts for ask-around.");
  }

  const matchingContacts =
    options.roles.length === 0
      ? contacts
      : contacts.filter((contact) => contactHasAnyRole(contact, options.roles));

  const target: MahiloAskAroundTarget = {
    contactCount: matchingContacts.length,
    kind: options.roles.length > 0 ? "roles" : "all_contacts",
    roles: options.roles.length > 0 ? options.roles : undefined
  };

  if (matchingContacts.length === 0) {
    const roleSummary = formatRoleList(options.roles);
    if (contacts.length === 0) {
      const counts = emptyAskAroundCounts();
      const gap = createAskAroundGap("empty_network", []);

      return {
        action: "ask_around",
        correlationId: options.correlationId,
        counts,
        deliveries: [],
        gaps: [gap],
        question: options.question,
        replyExpectation: formatReplyExpectation(counts, [gap]),
        replyOutcomeKinds: createAskAroundReplyOutcomeKinds(),
        senderConnectionId: context.senderConnectionId,
        source: "mahilo_server",
        status: "success",
        summary: `Mahilo ask-around: ${gap.summary}.`,
        target
      };
    }

    return {
      action: "ask_around",
      correlationId: options.correlationId,
      counts: emptyAskAroundCounts(),
      deliveries: [],
      gaps: [],
      question: options.question,
      replyExpectation:
        options.roles.length > 0
          ? `No contacts match roles ${roleSummary} yet. Add or tag the right Mahilo contacts, then try again.`
          : "No contacts are waiting to reply because your Mahilo network is still empty. Add a few people first, then ask around from this same tool.",
      replyOutcomeKinds: createAskAroundReplyOutcomeKinds(),
      senderConnectionId: context.senderConnectionId,
      source: "mahilo_server",
      status: "success",
      summary:
        options.roles.length > 0
          ? `Mahilo ask-around: no contacts matched roles ${roleSummary} yet. Add or tag the right Mahilo contacts, then try again.`
          : "Mahilo ask-around: no Mahilo contacts are available to ask yet. Add a few people to your Mahilo network, then ask around from this same tool.",
      target
    };
  }

  const deliveries = await Promise.all(
    matchingContacts.map((contact) =>
      askContact(client, contact, {
        correlationId: options.correlationId,
        declaredSelectors: options.declaredSelectors,
        idempotencyKey: options.idempotencyKey,
        question: options.question
      }, context, sendOptions)
    )
  );

  const counts = countAskAroundDeliveries(deliveries);
  const gaps = summarizeAskAroundGaps(deliveries);
  const replyExpectation = formatReplyExpectation(counts, gaps);

  return {
    action: "ask_around",
    correlationId: options.correlationId,
    counts,
    deliveries,
    gaps,
    question: options.question,
    replyRecipients: buildAskAroundReplyRecipients(deliveries),
    replyExpectation,
    replyOutcomeKinds: createAskAroundReplyOutcomeKinds(),
    senderConnectionId: context.senderConnectionId,
    source: "mahilo_server",
    status: "success",
    summary: formatContactAskAroundSummary(target, counts, matchingContacts.length, gaps),
    target
  };
}

async function executeMahiloGroupAskAround(
  client: MahiloContractClient,
  options: {
    correlationId: string;
    declaredSelectors?: Partial<DeclaredSelectors>;
    groupId?: string;
    groupRef: string;
    idempotencyKey?: string;
    question: string;
  },
  context: MahiloToolContext
): Promise<MahiloAskAroundActionResult> {
  const resolvedGroup = await resolveAskAroundGroup(client, options.groupRef, options.groupId);
  if ("error" in resolvedGroup) {
    return resolvedGroup.error;
  }

  try {
    const result = await talkToGroup(
      client,
      {
        correlationId: options.correlationId,
        declaredSelectors: options.declaredSelectors,
        groupId: resolvedGroup.group.groupId,
        idempotencyKey: deriveTargetIdempotencyKey(
          options.idempotencyKey,
          resolvedGroup.group.groupId
        ),
        message: options.question,
        recipient: resolvedGroup.group.groupId
      },
      context
    );

    const delivery = mapToolResultToAskAroundDelivery(
      result,
      {
        recipient: resolvedGroup.group.groupId,
        recipientLabel: resolvedGroup.group.name,
        recipientType: "group"
      }
    );
    const counts = countAskAroundDeliveries([delivery]);
    const target: MahiloAskAroundTarget = {
      groupId: resolvedGroup.group.groupId,
      groupName: resolvedGroup.group.name,
      kind: "group",
      memberCount: resolvedGroup.group.memberCount
    };

    return {
      action: "ask_around",
      correlationId: options.correlationId,
      counts,
      deliveries: [delivery],
      gaps: [],
      question: options.question,
      replyRecipients: buildAskAroundReplyRecipients([delivery]),
      replyExpectation: formatGroupReplyExpectation(delivery, resolvedGroup.group),
      replyOutcomeKinds: createAskAroundReplyOutcomeKinds(),
      senderConnectionId: context.senderConnectionId,
      source: "mahilo_server",
      status: "success",
      summary: formatGroupAskAroundSummary(delivery, resolvedGroup.group),
      target
    };
  } catch (error) {
    return createAskAroundErrorResult(
      error,
      `Mahilo couldn't ask group ${formatGroupLabel(resolvedGroup.group)} right now.`
    );
  }
}

async function askContact(
  client: MahiloContractClient,
  contact: MahiloContact,
  options: {
    correlationId: string;
    declaredSelectors?: Partial<DeclaredSelectors>;
    idempotencyKey?: string;
    question: string;
  },
  context: MahiloToolContext,
  sendOptions: MahiloSendExecutionOptions = {}
): Promise<MahiloAskAroundDelivery> {
  const username = readContactUsername(contact);
  const roles = readContactRoles(contact);
  const connectionState = contact.connectionState;

  if (!username) {
    return {
      connectionState,
      productState: "not_found",
      reason: "Mahilo could not resolve a username for this contact.",
      recipient: contact.id,
      recipientLabel: contact.label,
      recipientType: "user",
      roles: roles.length > 0 ? roles : undefined,
      status: "skipped"
    };
  }

  if (connectionState && connectionState !== "available") {
    return {
      connectionState,
      productState: mapContactStateToProductState(connectionState),
      reason: formatUnavailableContactReason(contact, connectionState),
      recipient: username,
      recipientLabel: contact.label,
      recipientType: "user",
      roles: roles.length > 0 ? roles : undefined,
      status: "skipped"
    };
  }

  try {
    const result = await talkToAgent(
      client,
      {
        correlationId: options.correlationId,
        declaredSelectors: options.declaredSelectors,
        idempotencyKey: deriveTargetIdempotencyKey(options.idempotencyKey, username),
        message: options.question,
        recipient: username
      },
      context,
      sendOptions
    );

    return mapToolResultToAskAroundDelivery(result, {
      connectionState,
      recipient: username,
      recipientLabel: contact.label,
      recipientType: "user",
      roles: roles.length > 0 ? roles : undefined
    });
  } catch (error) {
    return createRecipientSendFailure(contact, username, roles, connectionState, error);
  }
}

async function resolveAskAroundGroup(
  client: MahiloContractClient,
  groupRef: string,
  explicitGroupId?: string
): Promise<{ group: MahiloGroupSummary } | { error: MahiloAskAroundActionResult }> {
  const normalizedGroupId = normalizeToken(explicitGroupId);
  const normalizedGroupRef = normalizeToken(groupRef);
  if (!normalizedGroupRef) {
    return {
      error: createNetworkErrorResult(
        "Provide a Mahilo group name or groupId for ask-around.",
        "invalid_request"
      )
    };
  }

  if (!hasMahiloGroupSupport(client)) {
    if (!normalizedGroupId) {
      return {
        error: createNetworkErrorResult(
          "Mahilo group lookup is not available in this environment yet.",
          "invalid_request"
        )
      };
    }

    return {
      group: {
        groupId: normalizedGroupId,
        name: normalizedGroupRef,
        raw: normalizedGroupId
      }
    };
  }

  let groups: MahiloGroupSummary[];
  try {
    groups = await client.listGroups();
  } catch (error) {
    return {
      error: createAskAroundErrorResult(error, "Mahilo couldn't load your groups for ask-around.")
    };
  }

  const exactMatch = groups.find((group) => {
    if (normalizedGroupId && group.groupId === normalizedGroupId) {
      return true;
    }

    if (group.groupId === normalizedGroupRef) {
      return true;
    }

    return group.name.localeCompare(normalizedGroupRef, undefined, { sensitivity: "accent" }) === 0;
  });
  if (exactMatch) {
    return { group: exactMatch };
  }

  const canonicalGroupRef = canonicalizeAskAroundGroupReference(normalizedGroupRef);
  const fuzzyMatches =
    canonicalGroupRef
      ? groups.filter((group) =>
          canonicalizeAskAroundGroupReference(group.name) === canonicalGroupRef
        )
      : [];
  if (fuzzyMatches.length === 1) {
    return { group: fuzzyMatches[0]! };
  }

  if (fuzzyMatches.length > 1) {
    return {
      error: createNetworkErrorResult(
        `Mahilo found multiple groups matching ${formatQuotedLabel(normalizedGroupRef)}: ${formatQuotedGroupList(
          fuzzyMatches
        )}. Use the exact group name or groupId.`,
        "invalid_request"
      )
    };
  }

  return {
    error: createNetworkErrorResult(
      `Mahilo could not find group ${formatQuotedLabel(normalizedGroupRef)}.`,
      "not_found"
    )
  };
}

function hasMahiloGroupSupport(
  client: MahiloContractClient
): client is MahiloContractClient & {
  listGroups: () => Promise<MahiloGroupSummary[]>;
} {
  return typeof (client as MahiloContractClient & { listGroups?: unknown }).listGroups === "function";
}

const ASK_AROUND_GROUP_REFERENCE_STOP_WORDS = new Set([
  "a",
  "an",
  "chat",
  "channel",
  "circle",
  "crew",
  "group",
  "mahilo",
  "my",
  "our",
  "team",
  "the"
]);

function canonicalizeAskAroundGroupReference(value: string | undefined): string | undefined {
  const normalized = normalizeToken(value);
  if (!normalized) {
    return undefined;
  }

  const tokens = normalized
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .map((token) => normalizeAskAroundGroupReferenceToken(token))
    .filter((token): token is string => Boolean(token))
    .filter((token) => !ASK_AROUND_GROUP_REFERENCE_STOP_WORDS.has(token));

  return tokens.length > 0 ? tokens.join(" ") : undefined;
}

function normalizeAskAroundGroupReferenceToken(token: string): string | undefined {
  if (token.length === 0) {
    return undefined;
  }

  if (token.endsWith("ies") && token.length > 3) {
    return `${token.slice(0, -3)}y`;
  }

  if (token.endsWith("s") && token.length > 3 && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }

  return token;
}

function formatQuotedGroupList(groups: Pick<MahiloGroupSummary, "groupId" | "name">[]): string {
  return groups
    .map((group) => formatQuotedLabel(group.name || group.groupId))
    .join(", ");
}

function normalizeRoles(
  singleRole: string | undefined,
  roles: string[] | undefined
): string[] {
  const combined = [
    normalizeRoleToken(singleRole),
    ...(Array.isArray(roles) ? roles.map((role) => normalizeRoleToken(role)) : [])
  ];

  const uniqueRoles = new Set<string>();
  for (const role of combined) {
    if (role) {
      uniqueRoles.add(role);
    }
  }

  return [...uniqueRoles];
}

function normalizeRoleToken(value: string | undefined): string | undefined {
  const normalized = normalizeToken(value);
  if (!normalized) {
    return undefined;
  }

  return normalized.toLowerCase().replace(/[\s-]+/g, "_");
}

function readContactUsername(contact: MahiloContact): string | undefined {
  const metadataUsername =
    typeof contact.metadata?.username === "string" ? contact.metadata.username : undefined;
  const candidate = normalizeToken(metadataUsername) ?? normalizeToken(contact.id);
  return candidate ? candidate.replace(/^@+/, "") : undefined;
}

function readContactRoles(contact: MahiloContact): string[] {
  const roles = Array.isArray(contact.metadata?.roles) ? contact.metadata.roles : [];

  return roles
    .filter((role): role is string => typeof role === "string")
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
}

function contactHasAnyRole(contact: MahiloContact, expectedRoles: string[]): boolean {
  const contactRoles = new Set(
    readContactRoles(contact)
      .map((role) => normalizeRoleToken(role))
      .filter((role): role is string => Boolean(role))
  );

  return expectedRoles.some((role) => contactRoles.has(role));
}

function createAskAroundCorrelationId(): string {
  const randomId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.round(Math.random() * 1_000_000_000)}`;
  return `mahilo-ask-${randomId}`;
}

function deriveTargetIdempotencyKey(
  baseKey: string | undefined,
  target: string
): string | undefined {
  const normalizedBaseKey = normalizeToken(baseKey);
  if (!normalizedBaseKey) {
    return undefined;
  }

  const normalizedTarget = target.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
  return `${normalizedBaseKey}:${normalizedTarget}`;
}

function mapToolResultToAskAroundDelivery(
  result: {
    decision: "allow" | "ask" | "deny";
    messageId?: string;
    reason?: string;
    status: "denied" | "review_required" | "sent";
  },
  target: {
    connectionState?: MahiloContactConnectionState;
    recipient: string;
    recipientLabel: string;
    recipientType: "group" | "user";
    roles?: string[];
  }
): MahiloAskAroundDelivery {
  if (result.status === "sent") {
    return {
      connectionState: target.connectionState,
      decision: result.decision,
      messageId: result.messageId,
      reason: result.reason,
      recipient: target.recipient,
      recipientLabel: target.recipientLabel,
      recipientType: target.recipientType,
      roles: target.roles,
      status: "awaiting_reply"
    };
  }

  if (result.status === "review_required") {
    return {
      connectionState: target.connectionState,
      decision: result.decision,
      messageId: result.messageId,
      reason: result.reason ?? "Mahilo needs review before sending this ask.",
      recipient: target.recipient,
      recipientLabel: target.recipientLabel,
      recipientType: target.recipientType,
      roles: target.roles,
      status: "review_required"
    };
  }

  return {
    connectionState: target.connectionState,
    decision: result.decision,
    messageId: result.messageId,
    reason: result.reason ?? "Mahilo blocked this ask.",
    recipient: target.recipient,
    recipientLabel: target.recipientLabel,
    recipientType: target.recipientType,
    roles: target.roles,
    status: "blocked"
  };
}

function createRecipientSendFailure(
  contact: MahiloContact,
  username: string,
  roles: string[],
  connectionState: MahiloContactConnectionState | undefined,
  error: unknown
): MahiloAskAroundDelivery {
  if (error instanceof MahiloRequestError) {
    const status =
      error.productState === "transport_failure" ? "send_failed" : "skipped";

    return {
      connectionState,
      productState: error.productState,
      reason: formatAskAroundSendError(error, contact.label),
      recipient: username,
      recipientLabel: contact.label,
      recipientType: "user",
      roles: roles.length > 0 ? roles : undefined,
      status
    };
  }

  return {
    connectionState,
    productState: "unknown",
    reason: toErrorMessage(error),
    recipient: username,
    recipientLabel: contact.label,
    recipientType: "user",
    roles: roles.length > 0 ? roles : undefined,
    status: "send_failed"
  };
}

function countAskAroundDeliveries(
  deliveries: MahiloAskAroundDelivery[]
): MahiloAskAroundCounts {
  return deliveries.reduce<MahiloAskAroundCounts>(
    (counts, delivery) => {
      switch (delivery.status) {
        case "awaiting_reply":
          counts.awaitingReplies += 1;
          break;
        case "blocked":
          counts.blocked += 1;
          break;
        case "review_required":
          counts.reviewRequired += 1;
          break;
        case "send_failed":
          counts.sendFailed += 1;
          break;
        case "skipped":
          counts.skipped += 1;
          break;
      }

      return counts;
    },
    emptyAskAroundCounts()
  );
}

function buildAskAroundReplyRecipients(
  deliveries: MahiloAskAroundDelivery[],
): MahiloAskAroundReplyRecipient[] | undefined {
  const replyRecipients = deliveries
    .filter((delivery) => delivery.status === "awaiting_reply")
    .map((delivery) => ({
      messageId: delivery.messageId,
      recipient: delivery.recipient,
      recipientLabel: delivery.recipientLabel,
      recipientType: delivery.recipientType,
    }));

  return replyRecipients.length > 0 ? replyRecipients : undefined;
}

function summarizeAskAroundGaps(
  deliveries: MahiloAskAroundDelivery[]
): MahiloAskAroundGap[] {
  const buckets = new Map<MahiloAskAroundGapKind, string[]>();

  for (const delivery of deliveries) {
    const gapKind = classifyAskAroundGap(delivery);
    if (!gapKind) {
      continue;
    }

    const labels = buckets.get(gapKind) ?? [];
    const recipientLabel = normalizeToken(delivery.recipientLabel) ?? normalizeToken(delivery.recipient);
    if (recipientLabel && !labels.includes(recipientLabel)) {
      labels.push(recipientLabel);
    }
    buckets.set(gapKind, labels);
  }

  return ASK_AROUND_GAP_ORDER.flatMap((gapKind) => {
    const labels = buckets.get(gapKind);
    if (!labels || labels.length === 0) {
      return [];
    }

    return [createAskAroundGap(gapKind, labels)];
  });
}

function classifyAskAroundGap(
  delivery: MahiloAskAroundDelivery
): MahiloAskAroundGapKind | undefined {
  if (delivery.status === "awaiting_reply" || delivery.status === "review_required") {
    return undefined;
  }

  if (delivery.status === "blocked") {
    return "blocked";
  }

  const productState =
    delivery.productState ??
    (delivery.connectionState ? mapContactStateToProductState(delivery.connectionState) : undefined);

  switch (productState) {
    case "blocked":
      return "blocked";
    case "no_active_connections":
      return "needs_agent_connection";
    case "not_friends":
      return "not_in_network";
    case "not_found":
      return "not_on_mahilo";
    case "request_pending":
      return "request_pending";
    case "transport_failure":
      return "transport_failure";
    case "unknown":
      return "unknown";
    default:
      break;
  }

  if (delivery.status === "send_failed" || delivery.status === "skipped") {
    return "unknown";
  }

  return undefined;
}

function createAskAroundGap(
  kind: MahiloAskAroundGapKind,
  recipientLabels: string[]
): MahiloAskAroundGap {
  const labels = recipientLabels.slice();
  const subject = formatAskAroundGapSubject(labels);

  switch (kind) {
    case "blocked":
      return {
        count: labels.length,
        kind,
        recipientLabels: labels,
        suggestedAction: "Review the boundary decision before retrying this ask.",
        summary: `${subject.label} ${subject.plural ? "were" : "was"} blocked by Mahilo boundaries`
      };
    case "empty_network":
      return {
        count: 0,
        kind,
        recipientLabels: [],
        suggestedAction: EMPTY_NETWORK_SUGGESTED_ACTION,
        summary: "your Mahilo circle is still empty"
      };
    case "needs_agent_connection":
      return {
        count: labels.length,
        kind,
        recipientLabels: labels,
        suggestedAction: NEEDS_AGENT_CONNECTION_SUGGESTED_ACTION,
        summary: `${subject.label} ${subject.plural ? "are" : "is"} already in your Mahilo circle and still finishing setup`
      };
    case "not_in_network":
      return {
        count: labels.length,
        kind,
        recipientLabels: labels,
        suggestedAction: NOT_IN_NETWORK_SUGGESTED_ACTION,
        summary: `${subject.label} ${subject.plural ? "are" : "is"} not in your Mahilo network yet`
      };
    case "not_on_mahilo":
      return {
        count: labels.length,
        kind,
        recipientLabels: labels,
        suggestedAction: NOT_ON_MAHILO_SUGGESTED_ACTION,
        summary: `${subject.label} could not be found on Mahilo right now`
      };
    case "request_pending":
      return {
        count: labels.length,
        kind,
        recipientLabels: labels,
        suggestedAction: REQUEST_PENDING_SUGGESTED_ACTION,
        summary: `${subject.label} ${subject.plural ? "still have" : "still has"} pending Mahilo request${subject.plural ? "s" : ""}`
      };
    case "transport_failure":
      return {
        count: labels.length,
        kind,
        recipientLabels: labels,
        suggestedAction: "Retry in a bit; Mahilo could not reach those agent connections right now.",
        summary: `Mahilo could not reach ${subject.label} right now`
      };
    case "unknown":
    default:
      return {
        count: labels.length,
        kind: "unknown",
        recipientLabels: labels,
        suggestedAction: "Try again later.",
        summary: `${subject.label} ${subject.plural ? "are" : "is"} not available on Mahilo right now`
      };
  }
}

function emptyAskAroundCounts(): MahiloAskAroundCounts {
  return {
    awaitingReplies: 0,
    blocked: 0,
    reviewRequired: 0,
    sendFailed: 0,
    skipped: 0
  };
}

function formatContactAskAroundSummary(
  target: MahiloAskAroundTarget,
  counts: MahiloAskAroundCounts,
  contactCount: number,
  gaps: MahiloAskAroundGap[]
): string {
  const targetLabel =
    target.kind === "roles" && target.roles && target.roles.length > 0
      ? `contacts in roles ${formatRoleList(target.roles)}`
      : "your contacts";

  const parts = [
    counts.awaitingReplies > 0
      ? `asked ${counts.awaitingReplies} of ${contactCount} ${targetLabel}`
      : `couldn't ask ${formatAskAroundContactScope(target, contactCount)} right now`
  ];

  if (counts.reviewRequired > 0) {
    parts.push(`${counts.reviewRequired} waiting on review`);
  }

  parts.push(...gaps.map((gap) => gap.summary));

  return `Mahilo ask-around: ${parts.join(", ")}.`;
}

function formatGroupAskAroundSummary(
  delivery: MahiloAskAroundDelivery,
  group: MahiloGroupSummary
): string {
  const groupLabel = formatGroupLabel(group);
  switch (delivery.status) {
    case "awaiting_reply":
      return `Mahilo ask-around: asked group ${groupLabel}.`;
    case "review_required":
      return `Mahilo ask-around: group ${groupLabel} needs review before the question can go out.`;
    case "blocked":
      return `Mahilo ask-around: boundaries blocked asking group ${groupLabel}.`;
    case "skipped":
      return `Mahilo ask-around: group ${groupLabel} is not available right now.`;
    case "send_failed":
      return `Mahilo ask-around: couldn't send the question to group ${groupLabel}.`;
  }
}

function formatReplyExpectation(
  counts: MahiloAskAroundCounts,
  gaps: MahiloAskAroundGap[]
): string | undefined {
  if (counts.awaitingReplies > 0) {
    return 'Replies will show up in this thread with attribution and a running summary as your contacts respond. If someone does not have grounded info, Mahilo will show a clear "I don\'t know" instead of inventing an opinion. If someone stays silent, nothing is stuck.';
  }

  if (counts.reviewRequired > 0) {
    if (gaps.length === 0) {
      return "Mahilo is waiting on review before those asks can go out.";
    }

    return `Nothing is waiting on a reply yet. ${counts.reviewRequired} ask${counts.reviewRequired === 1 ? "" : "s"} still need review. ${formatAskAroundGapGuidance(gaps)}`;
  }

  if (gaps.length > 0) {
    return `Nothing is waiting on a reply. ${formatAskAroundGapGuidance(gaps)}`;
  }

  return undefined;
}

function formatGroupReplyExpectation(
  delivery: MahiloAskAroundDelivery,
  group: MahiloGroupSummary
): string | undefined {
  if (delivery.status === "awaiting_reply") {
    const memberCountSuffix =
      typeof group.memberCount === "number" && group.memberCount > 0
        ? ` (${group.memberCount} members)`
        : "";
    return `Replies will show up in this thread with attribution and a running summary as ${formatGroupLabel(group)}${memberCountSuffix} responds. If someone does not have grounded info, Mahilo will show a clear "I don't know" instead of inventing an opinion. If nobody replies, nothing is stuck.`;
  }

  if (delivery.status === "review_required") {
    return "Mahilo is waiting on review before the group ask can go out.";
  }

  return delivery.reason;
}

function formatRoleList(roles: string[]): string {
  return roles.map((role) => `"${role}"`).join(", ");
}

function formatGroupLabel(group: Pick<MahiloGroupSummary, "groupId" | "name">): string {
  return formatQuotedLabel(group.name || group.groupId);
}

function formatQuotedLabel(value: string): string {
  return `"${value}"`;
}

function formatAskAroundContactScope(
  target: MahiloAskAroundTarget,
  contactCount: number
): string {
  if (target.kind === "roles" && target.roles && target.roles.length > 0) {
    const contactLabel = contactCount === 1 ? "the 1 contact" : `the ${contactCount} contacts`;
    return `${contactLabel} in roles ${formatRoleList(target.roles)}`;
  }

  return contactCount === 1 ? "your 1 contact" : `your ${contactCount} contacts`;
}

function formatAskAroundGapSubject(
  recipientLabels: string[]
): { label: string; plural: boolean } {
  if (recipientLabels.length === 0) {
    return {
      label: "Those contacts",
      plural: true
    };
  }

  if (recipientLabels.length === 1) {
    return {
      label: recipientLabels[0]!,
      plural: false
    };
  }

  if (recipientLabels.length === 2) {
    return {
      label: `${recipientLabels[0]} and ${recipientLabels[1]}`,
      plural: true
    };
  }

  return {
    label: `${recipientLabels[0]} and ${recipientLabels.length - 1} others`,
    plural: true
  };
}

function formatAskAroundGapGuidance(gaps: MahiloAskAroundGap[]): string {
  return gaps
    .slice(0, 2)
    .map((gap) => `${capitalizeSentence(gap.summary)}. ${gap.suggestedAction}`)
    .join(" ");
}

function capitalizeSentence(value: string): string {
  if (value.length === 0) {
    return value;
  }

  return value[0]!.toUpperCase() + value.slice(1);
}

function formatUnavailableContactReason(
  contact: MahiloContact,
  connectionState: MahiloContactConnectionState
): string {
  switch (connectionState) {
    case "blocked":
      return `Mahilo boundaries blocked asking ${contact.label} right now.`;
    case "no_active_connections":
      return `${contact.label} is already in your Mahilo circle and still finishing setup. ${NEEDS_AGENT_CONNECTION_SUGGESTED_ACTION}`;
    case "not_found":
      return `${contact.label} could not be found on Mahilo right now. ${NOT_ON_MAHILO_SUGGESTED_ACTION}`;
    case "not_friends":
      return `${contact.label} is not in your Mahilo network yet. ${NOT_IN_NETWORK_SUGGESTED_ACTION}`;
    case "request_pending":
      return `${contact.label} still has a pending Mahilo request. ${REQUEST_PENDING_SUGGESTED_ACTION}`;
    case "transport_failure":
      return `Mahilo could not reach ${contact.label}'s agent connection right now. Try again in a bit.`;
    default:
      return `${contact.label} is not available for Mahilo ask-around right now.`;
  }
}

function formatAskAroundSendError(
  error: MahiloRequestError,
  recipientLabel: string
): string {
  switch (error.productState) {
    case "blocked":
      return `Mahilo boundaries blocked asking ${recipientLabel} right now.`;
    case "transport_failure":
      return `Mahilo could not reach ${recipientLabel}'s agent connection right now. Try again in a bit.`;
    case "no_active_connections":
      return `${recipientLabel} is already in your Mahilo circle and still finishing setup. ${NEEDS_AGENT_CONNECTION_SUGGESTED_ACTION}`;
    case "not_friends":
      return `${recipientLabel} is not in your Mahilo network yet. ${NOT_IN_NETWORK_SUGGESTED_ACTION}`;
    case "not_found":
      return `${recipientLabel} could not be found on Mahilo right now. ${NOT_ON_MAHILO_SUGGESTED_ACTION}`;
    case "request_pending":
      return `${recipientLabel} still has a pending Mahilo request. ${REQUEST_PENDING_SUGGESTED_ACTION}`;
    default:
      return `Mahilo couldn't deliver the ask to ${recipientLabel}.`;
  }
}

function mapContactStateToProductState(
  state: MahiloContactConnectionState
): MahiloProductState {
  switch (state) {
    case "blocked":
      return "blocked";
    case "no_active_connections":
      return "no_active_connections";
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

function createAskAroundErrorResult(
  error: unknown,
  fallbackSummary: string
): MahiloAskAroundActionResult {
  if (error instanceof MahiloRequestError) {
    const message =
      error.productState === "transport_failure"
        ? "Couldn't reach Mahilo right now. Check the server connection and try again."
        : fallbackSummary;

    return createNetworkErrorResult(message, error.productState, error.code, error.retryable, error.message);
  }

  return createNetworkErrorResult(
    fallbackSummary,
    "unknown",
    undefined,
    false,
    toErrorMessage(error)
  );
}

function createNetworkErrorResult(
  summary: string,
  productState: MahiloProductState,
  code?: string,
  retryable = false,
  technicalMessage?: string
): MahiloAskAroundActionResult {
  return {
    action: "ask_around",
    error: {
      code,
      message: summary,
      productState,
      retryable,
      technicalMessage
    },
    gaps: [],
    replyOutcomeKinds: createAskAroundReplyOutcomeKinds(),
    source: "mahilo_server",
    status: "error",
    summary
  };
}

function createAskAroundReplyOutcomeKinds(): MahiloAskAroundReplyOutcome[] {
  return DEFAULT_MAHILO_ASK_AROUND_REPLY_OUTCOME_KINDS.slice();
}

function normalizeToken(value: string | undefined): string | undefined {
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

  return "Mahilo ask-around failed";
}
