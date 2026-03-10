import type { DeclaredSelectors, PolicyDecision } from "./policy-helpers";
import type { MahiloAskAroundReplyOutcome, MahiloAskAroundTarget } from "./network";
import type { ReportedOutcome } from "./tools";

export interface DedupeState {
  has(messageId: string, nowMs?: number): boolean;
  markSeen(messageId: string, nowMs?: number): boolean;
  prune(nowMs?: number): number;
  size(): number;
}

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

export interface MahiloPendingLearningSuggestion {
  decision: PolicyDecision;
  fingerprint: string;
  messageId?: string;
  outcome: ReportedOutcome;
  reason?: string;
  recipient: string;
  recipientType?: "group" | "user";
  resolutionId?: string;
  selectors: DeclaredSelectors;
  senderConnectionId?: string;
  status: "denied" | "review_required" | "sent";
  toolName: string;
}

export interface MahiloInboundSessionRoute {
  agentId?: string;
  correlationId?: string;
  groupId?: string;
  localConnectionId?: string;
  outboundMessageId?: string;
  remoteConnectionId?: string;
  remoteParticipant?: string;
  sessionKey: string;
}

export interface MahiloInboundRouteLookup {
  correlationId?: string;
  groupId?: string;
  inResponseToMessageId?: string;
  localConnectionId?: string;
  remoteConnectionId?: string;
  remoteParticipant?: string;
}

export interface MahiloAskAroundReply {
  context?: string;
  deliveryId?: string;
  groupId?: string;
  groupName?: string;
  message: string;
  messageId: string;
  outcome?: MahiloAskAroundReplyOutcome;
  payloadType?: string;
  sender: string;
  senderAgent: string;
  senderConnectionId?: string;
  senderUserId?: string;
  timestamp?: string;
}

export interface MahiloAskAroundExpectedParticipant {
  label?: string;
  recipient: string;
}

export interface MahiloAskAroundSession {
  correlationId: string;
  expectedReplyCount?: number;
  expectedParticipants?: MahiloAskAroundExpectedParticipant[];
  question?: string;
  replies: MahiloAskAroundReply[];
  target?: MahiloAskAroundTarget;
}

export interface MahiloAskAroundSessionInput {
  correlationId: string;
  expectedReplyCount?: number;
  expectedParticipants?: MahiloAskAroundExpectedParticipant[];
  question?: string;
  replies?: MahiloAskAroundReply[];
  target?: MahiloAskAroundTarget;
}

const DEFAULT_DEDUPE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CONTEXT_CACHE_TTL_SECONDS = 60;
const DEFAULT_INBOUND_ROUTE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEARNING_SUGGESTION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_NOVEL_DECISION_TTL_MS = 24 * 60 * 60 * 1000;

export class InMemoryDedupeState implements DedupeState {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_DEDUPE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  has(messageId: string, nowMs: number = Date.now()): boolean {
    this.prune(nowMs);

    const expiresAt = this.entries.get(messageId);
    return typeof expiresAt === "number" && expiresAt > nowMs;
  }

  markSeen(messageId: string, nowMs: number = Date.now()): boolean {
    const isDuplicate = this.has(messageId, nowMs);
    if (isDuplicate) {
      return false;
    }

    this.entries.set(messageId, nowMs + this.ttlMs);
    return true;
  }

  prune(nowMs: number = Date.now()): number {
    let removed = 0;

    for (const [messageId, expiresAt] of this.entries.entries()) {
      if (expiresAt > nowMs) {
        continue;
      }

      this.entries.delete(messageId);
      removed += 1;
    }

    return removed;
  }

  size(): number {
    return this.entries.size;
  }
}

export class InMemoryPluginState {
  private readonly askAroundSessions = new Map<string, CacheEntry>();
  private readonly askAroundSessionTtlMs: number;
  private readonly connectionPairRoutes = new Map<string, CacheEntry>();
  private readonly contextCache = new Map<string, CacheEntry>();
  private readonly correlationRoutes = new Map<string, CacheEntry>();
  readonly dedupe: InMemoryDedupeState;
  private readonly groupRoutes = new Map<string, CacheEntry[]>();
  private readonly inboundRouteTtlMs: number;
  private readonly messageRoutes = new Map<string, CacheEntry>();
  private readonly participantRoutes = new Map<string, CacheEntry>();
  private readonly contextCacheTtlMs: number;
  private readonly learningSuggestionTtlMs: number;
  private readonly novelDecisionTtlMs: number;
  private readonly novelDecisionEntries = new Map<string, number>();
  private readonly pendingLearningSuggestions = new Map<string, CacheEntry>();

  constructor(
    options: {
      askAroundSessionTtlMs?: number;
      contextCacheTtlSeconds?: number;
      dedupeTtlMs?: number;
      inboundRouteTtlMs?: number;
      learningSuggestionTtlMs?: number;
      novelDecisionTtlMs?: number;
    } = {}
  ) {
    const contextCacheTtlSeconds = options.contextCacheTtlSeconds ?? DEFAULT_CONTEXT_CACHE_TTL_SECONDS;
    this.contextCacheTtlMs = Math.max(0, contextCacheTtlSeconds) * 1000;
    this.dedupe = new InMemoryDedupeState(options.dedupeTtlMs);
    this.inboundRouteTtlMs = Math.max(0, options.inboundRouteTtlMs ?? DEFAULT_INBOUND_ROUTE_TTL_MS);
    this.askAroundSessionTtlMs = Math.max(
      0,
      options.askAroundSessionTtlMs ?? this.inboundRouteTtlMs
    );
    this.learningSuggestionTtlMs = Math.max(
      0,
      options.learningSuggestionTtlMs ?? DEFAULT_LEARNING_SUGGESTION_TTL_MS
    );
    this.novelDecisionTtlMs = Math.max(
      0,
      options.novelDecisionTtlMs ?? DEFAULT_NOVEL_DECISION_TTL_MS
    );
  }

  getCachedContext(cacheKey: string, nowMs: number = Date.now()): unknown | undefined {
    this.pruneContextCache(nowMs);

    const entry = this.contextCache.get(cacheKey);
    if (!entry || entry.expiresAt <= nowMs) {
      return undefined;
    }

    return entry.value;
  }

  setCachedContext(cacheKey: string, value: unknown, nowMs: number = Date.now()): void {
    const expiresAt = nowMs + this.contextCacheTtlMs;
    this.contextCache.set(cacheKey, { expiresAt, value });
  }

  pruneContextCache(nowMs: number = Date.now()): number {
    let removed = 0;

    for (const [cacheKey, entry] of this.contextCache.entries()) {
      if (entry.expiresAt > nowMs) {
        continue;
      }

      this.contextCache.delete(cacheKey);
      removed += 1;
    }

    return removed;
  }

  contextCacheSize(): number {
    return this.contextCache.size;
  }

  rememberInboundRoute(route: MahiloInboundSessionRoute, nowMs: number = Date.now()): void {
    const normalizedRoute = normalizeInboundRoute(route);
    if (!normalizedRoute) {
      return;
    }

    this.pruneInboundRoutes(nowMs);

    const entry: CacheEntry = {
      expiresAt: nowMs + this.inboundRouteTtlMs,
      value: normalizedRoute
    };

    if (normalizedRoute.correlationId) {
      this.correlationRoutes.set(normalizedRoute.correlationId, entry);
    }

    if (normalizedRoute.outboundMessageId) {
      this.messageRoutes.set(normalizedRoute.outboundMessageId, entry);
    }

    if (normalizedRoute.groupId) {
      rememberGroupedInboundRoute(this.groupRoutes, normalizedRoute.groupId, entry, nowMs);
    }

    if (normalizedRoute.localConnectionId && normalizedRoute.remoteConnectionId) {
      this.connectionPairRoutes.set(
        buildInboundConnectionPairKey(
          normalizedRoute.localConnectionId,
          normalizedRoute.remoteConnectionId
        ),
        entry
      );
    }

    if (normalizedRoute.localConnectionId && normalizedRoute.remoteParticipant) {
      this.participantRoutes.set(
        buildInboundParticipantKey(
          normalizedRoute.localConnectionId,
          normalizedRoute.remoteParticipant
        ),
        entry
      );
    }
  }

  resolveInboundRoute(
    lookup: MahiloInboundRouteLookup,
    nowMs: number = Date.now()
  ): MahiloInboundSessionRoute | undefined {
    this.pruneInboundRoutes(nowMs);

    const normalizedLookup = normalizeInboundLookup(lookup);
    if (!normalizedLookup) {
      return undefined;
    }

    const groupedRoute =
      normalizedLookup.groupId
        ? resolveGroupedInboundRoute(
            this.groupRoutes,
            normalizedLookup.groupId,
            normalizedLookup.localConnectionId,
            nowMs
          )
        : undefined;
    const candidates: Array<CacheEntry | undefined> = [
      normalizedLookup.inResponseToMessageId
        ? this.messageRoutes.get(normalizedLookup.inResponseToMessageId)
        : undefined,
      normalizedLookup.correlationId
        ? this.correlationRoutes.get(normalizedLookup.correlationId)
        : undefined,
      groupedRoute,
      normalizedLookup.localConnectionId && normalizedLookup.remoteConnectionId
        ? this.connectionPairRoutes.get(
            buildInboundConnectionPairKey(
              normalizedLookup.localConnectionId,
              normalizedLookup.remoteConnectionId
            )
          )
        : undefined,
      normalizedLookup.localConnectionId && normalizedLookup.remoteParticipant
        ? this.participantRoutes.get(
            buildInboundParticipantKey(
              normalizedLookup.localConnectionId,
              normalizedLookup.remoteParticipant
            )
          )
        : undefined
    ];

    for (const entry of candidates) {
      if (!entry || entry.expiresAt <= nowMs) {
        continue;
      }

      return entry.value as MahiloInboundSessionRoute;
    }

    return undefined;
  }

  pruneInboundRoutes(nowMs: number = Date.now()): number {
    let removed = 0;

    removed += pruneCacheMap(this.correlationRoutes, nowMs);
    removed += pruneCacheMap(this.messageRoutes, nowMs);
    removed += pruneGroupedInboundRoutes(this.groupRoutes, nowMs);
    removed += pruneCacheMap(this.connectionPairRoutes, nowMs);
    removed += pruneCacheMap(this.participantRoutes, nowMs);

    return removed;
  }

  inboundRouteCount(nowMs: number = Date.now()): number {
    this.pruneInboundRoutes(nowMs);

    return (
      this.correlationRoutes.size +
      this.messageRoutes.size +
      countGroupedInboundRoutes(this.groupRoutes) +
      this.connectionPairRoutes.size +
      this.participantRoutes.size
    );
  }

  rememberAskAroundSession(
    session: MahiloAskAroundSessionInput,
    nowMs: number = Date.now()
  ): void {
    const normalizedSession = normalizeAskAroundSessionInput(session);
    if (!normalizedSession) {
      return;
    }

    this.pruneAskAroundSessions(nowMs);

    const existingEntry = this.askAroundSessions.get(normalizedSession.correlationId);
    const existingSession =
      existingEntry && existingEntry.expiresAt > nowMs
        ? (existingEntry.value as MahiloAskAroundSession)
        : undefined;

    this.askAroundSessions.set(normalizedSession.correlationId, {
      expiresAt: nowMs + this.askAroundSessionTtlMs,
      value: {
        correlationId: normalizedSession.correlationId,
        expectedReplyCount:
          normalizedSession.expectedReplyCount ?? existingSession?.expectedReplyCount,
        expectedParticipants: mergeAskAroundExpectedParticipants(
          existingSession?.expectedParticipants,
          normalizedSession.expectedParticipants
        ),
        question: normalizedSession.question ?? existingSession?.question,
        replies: mergeAskAroundReplies(
          existingSession?.replies ?? [],
          normalizedSession.replies
        ),
        target: normalizedSession.target ?? existingSession?.target
      }
    });
  }

  getAskAroundSession(
    correlationId: string,
    nowMs: number = Date.now()
  ): MahiloAskAroundSession | undefined {
    const normalizedCorrelationId = normalizeToken(correlationId);
    if (!normalizedCorrelationId) {
      return undefined;
    }

    this.pruneAskAroundSessions(nowMs);

    const entry = this.askAroundSessions.get(normalizedCorrelationId);
    if (!entry || entry.expiresAt <= nowMs) {
      this.askAroundSessions.delete(normalizedCorrelationId);
      return undefined;
    }

    return entry.value as MahiloAskAroundSession;
  }

  recordAskAroundReply(
    correlationId: string,
    reply: MahiloAskAroundReply,
    nowMs: number = Date.now()
  ): MahiloAskAroundSession | undefined {
    const normalizedCorrelationId = normalizeToken(correlationId);
    if (!normalizedCorrelationId) {
      return undefined;
    }

    this.pruneAskAroundSessions(nowMs);

    const entry = this.askAroundSessions.get(normalizedCorrelationId);
    if (!entry || entry.expiresAt <= nowMs) {
      this.askAroundSessions.delete(normalizedCorrelationId);
      return undefined;
    }

    const normalizedReply = normalizeAskAroundReply(reply);
    if (!normalizedReply) {
      return entry.value as MahiloAskAroundSession;
    }

    const session = entry.value as MahiloAskAroundSession;
    const classifiedReply = {
      ...normalizedReply,
      outcome: normalizedReply.outcome ?? classifyAskAroundReply(session, normalizedReply)
    } satisfies MahiloAskAroundReply;
    const updatedSession: MahiloAskAroundSession = {
      ...session,
      replies: mergeAskAroundReplies(session.replies, [classifiedReply])
    };

    this.askAroundSessions.set(normalizedCorrelationId, {
      expiresAt: nowMs + this.askAroundSessionTtlMs,
      value: updatedSession
    });

    return updatedSession;
  }

  pruneAskAroundSessions(nowMs: number = Date.now()): number {
    return pruneCacheMap(this.askAroundSessions, nowMs);
  }

  askAroundSessionCount(nowMs: number = Date.now()): number {
    this.pruneAskAroundSessions(nowMs);
    return this.askAroundSessions.size;
  }

  markNovelDecision(signature: string, nowMs: number = Date.now()): boolean {
    this.pruneNovelDecisions(nowMs);

    const normalized = signature.trim();
    if (normalized.length === 0) {
      return false;
    }

    const expiresAt = this.novelDecisionEntries.get(normalized);
    if (typeof expiresAt === "number" && expiresAt > nowMs) {
      return false;
    }

    this.novelDecisionEntries.set(normalized, nowMs + this.novelDecisionTtlMs);
    return true;
  }

  queueLearningSuggestion(
    sessionKey: string,
    suggestion: MahiloPendingLearningSuggestion,
    nowMs: number = Date.now()
  ): void {
    const normalizedSessionKey = sessionKey.trim();
    if (normalizedSessionKey.length === 0) {
      return;
    }

    this.pruneLearningSuggestions(nowMs);

    const existingEntry = this.pendingLearningSuggestions.get(normalizedSessionKey);
    const suggestions =
      existingEntry && existingEntry.expiresAt > nowMs
        ? ((existingEntry.value as MahiloPendingLearningSuggestion[]) ?? [])
        : [];

    if (suggestions.some((candidate) => candidate.fingerprint === suggestion.fingerprint)) {
      this.pendingLearningSuggestions.set(normalizedSessionKey, {
        expiresAt: nowMs + this.learningSuggestionTtlMs,
        value: suggestions
      });
      return;
    }

    this.pendingLearningSuggestions.set(normalizedSessionKey, {
      expiresAt: nowMs + this.learningSuggestionTtlMs,
      value: suggestions.concat(suggestion).slice(0, 3)
    });
  }

  consumeLearningSuggestions(
    sessionKey: string,
    nowMs: number = Date.now()
  ): MahiloPendingLearningSuggestion[] {
    this.pruneLearningSuggestions(nowMs);

    const normalizedSessionKey = sessionKey.trim();
    if (normalizedSessionKey.length === 0) {
      return [];
    }

    const entry = this.pendingLearningSuggestions.get(normalizedSessionKey);
    if (!entry || entry.expiresAt <= nowMs) {
      this.pendingLearningSuggestions.delete(normalizedSessionKey);
      return [];
    }

    this.pendingLearningSuggestions.delete(normalizedSessionKey);
    return (entry.value as MahiloPendingLearningSuggestion[]) ?? [];
  }

  pruneNovelDecisions(nowMs: number = Date.now()): number {
    let removed = 0;

    for (const [signature, expiresAt] of this.novelDecisionEntries.entries()) {
      if (expiresAt > nowMs) {
        continue;
      }

      this.novelDecisionEntries.delete(signature);
      removed += 1;
    }

    return removed;
  }

  pruneLearningSuggestions(nowMs: number = Date.now()): number {
    let removed = 0;

    for (const [sessionKey, entry] of this.pendingLearningSuggestions.entries()) {
      if (entry.expiresAt > nowMs) {
        continue;
      }

      this.pendingLearningSuggestions.delete(sessionKey);
      removed += 1;
    }

    return removed;
  }

  novelDecisionCount(nowMs: number = Date.now()): number {
    this.pruneNovelDecisions(nowMs);
    return this.novelDecisionEntries.size;
  }

  pendingLearningSuggestionCount(nowMs: number = Date.now()): number {
    this.pruneLearningSuggestions(nowMs);

    let total = 0;
    for (const entry of this.pendingLearningSuggestions.values()) {
      total += ((entry.value as MahiloPendingLearningSuggestion[]) ?? []).length;
    }

    return total;
  }
}

function normalizeInboundRoute(route: MahiloInboundSessionRoute): MahiloInboundSessionRoute | undefined {
  const sessionKey = normalizeToken(route.sessionKey);
  if (!sessionKey) {
    return undefined;
  }

  return {
    agentId: normalizeToken(route.agentId),
    correlationId: normalizeToken(route.correlationId),
    groupId: normalizeToken(route.groupId),
    localConnectionId: normalizeToken(route.localConnectionId),
    outboundMessageId: normalizeToken(route.outboundMessageId),
    remoteConnectionId: normalizeToken(route.remoteConnectionId),
    remoteParticipant: normalizeParticipant(route.remoteParticipant),
    sessionKey
  };
}

function normalizeInboundLookup(
  lookup: MahiloInboundRouteLookup
): MahiloInboundRouteLookup | undefined {
  const normalized: MahiloInboundRouteLookup = {
    correlationId: normalizeToken(lookup.correlationId),
    groupId: normalizeToken(lookup.groupId),
    inResponseToMessageId: normalizeToken(lookup.inResponseToMessageId),
    localConnectionId: normalizeToken(lookup.localConnectionId),
    remoteConnectionId: normalizeToken(lookup.remoteConnectionId),
    remoteParticipant: normalizeParticipant(lookup.remoteParticipant)
  };

  if (
    !normalized.correlationId &&
    !normalized.groupId &&
    !normalized.inResponseToMessageId &&
    !(normalized.localConnectionId && normalized.remoteConnectionId) &&
    !(normalized.localConnectionId && normalized.remoteParticipant)
  ) {
    return undefined;
  }

  return normalized;
}

function normalizeAskAroundSessionInput(
  session: MahiloAskAroundSessionInput
): MahiloAskAroundSession | undefined {
  const correlationId = normalizeToken(session.correlationId);
  if (!correlationId) {
    return undefined;
  }

  const replies = mergeAskAroundReplies([], session.replies);

  return {
    correlationId,
    expectedReplyCount: normalizeNonNegativeInteger(session.expectedReplyCount),
    expectedParticipants: normalizeAskAroundExpectedParticipants(
      session.expectedParticipants
    ),
    question: normalizeToken(session.question),
    replies,
    target: normalizeAskAroundTarget(session.target)
  };
}

function normalizeAskAroundTarget(
  target: MahiloAskAroundTarget | undefined
): MahiloAskAroundTarget | undefined {
  if (!target) {
    return undefined;
  }

  const kind =
    target.kind === "all_contacts" ||
    target.kind === "group" ||
    target.kind === "roles"
      ? target.kind
      : undefined;
  if (!kind) {
    return undefined;
  }

  const roles = normalizeStringArray(target.roles);

  return {
    contactCount: normalizeNonNegativeInteger(target.contactCount),
    groupId: normalizeToken(target.groupId),
    groupName: normalizeToken(target.groupName),
    kind,
    memberCount: normalizeNonNegativeInteger(target.memberCount),
    roles
  };
}

function normalizeAskAroundReply(
  reply: MahiloAskAroundReply
): MahiloAskAroundReply | undefined {
  const message = normalizeToken(reply.message);
  const messageId = normalizeToken(reply.messageId);
  const sender = normalizeToken(reply.sender);
  const senderAgent = normalizeToken(reply.senderAgent);
  if (!message || !messageId || !sender || !senderAgent) {
    return undefined;
  }

  return {
    context: normalizeToken(reply.context),
    deliveryId: normalizeToken(reply.deliveryId),
    groupId: normalizeToken(reply.groupId),
    groupName: normalizeToken(reply.groupName),
    message,
    messageId,
    outcome: normalizeAskAroundReplyOutcome(reply.outcome),
    payloadType: normalizeToken(reply.payloadType),
    sender,
    senderAgent,
    senderConnectionId: normalizeToken(reply.senderConnectionId),
    senderUserId: normalizeToken(reply.senderUserId),
    timestamp: normalizeToken(reply.timestamp)
  };
}

function mergeAskAroundReplies(
  existingReplies: MahiloAskAroundReply[],
  incomingReplies: MahiloAskAroundReply[] | undefined
): MahiloAskAroundReply[] {
  if (!incomingReplies || incomingReplies.length === 0) {
    return existingReplies.slice();
  }

  const mergedReplies = existingReplies.slice();
  const replyIndexes = new Map<string, number>();

  mergedReplies.forEach((reply, index) => {
    replyIndexes.set(reply.messageId, index);
  });

  for (const reply of incomingReplies) {
    const normalizedReply = normalizeAskAroundReply(reply);
    if (!normalizedReply) {
      continue;
    }

    const existingIndex = replyIndexes.get(normalizedReply.messageId);
    if (typeof existingIndex === "number") {
      const existingReply = mergedReplies[existingIndex]!;
      mergedReplies[existingIndex] = {
        ...existingReply,
        ...normalizedReply,
        outcome: normalizedReply.outcome ?? existingReply.outcome
      };
      continue;
    }

    replyIndexes.set(normalizedReply.messageId, mergedReplies.length);
    mergedReplies.push(normalizedReply);
  }

  return mergedReplies;
}

function normalizeAskAroundExpectedParticipants(
  participants: MahiloAskAroundExpectedParticipant[] | undefined
): MahiloAskAroundExpectedParticipant[] | undefined {
  if (!Array.isArray(participants) || participants.length === 0) {
    return undefined;
  }

  const normalizedParticipants = participants
    .map((participant) => normalizeAskAroundExpectedParticipant(participant))
    .filter((participant): participant is MahiloAskAroundExpectedParticipant => Boolean(participant));

  return normalizedParticipants.length > 0 ? normalizedParticipants : undefined;
}

function normalizeAskAroundExpectedParticipant(
  participant: MahiloAskAroundExpectedParticipant
): MahiloAskAroundExpectedParticipant | undefined {
  const recipient = normalizeToken(participant.recipient);
  if (!recipient) {
    return undefined;
  }

  return {
    label: normalizeToken(participant.label),
    recipient
  };
}

function mergeAskAroundExpectedParticipants(
  existingParticipants: MahiloAskAroundExpectedParticipant[] | undefined,
  incomingParticipants: MahiloAskAroundExpectedParticipant[] | undefined
): MahiloAskAroundExpectedParticipant[] | undefined {
  const mergedParticipants = [
    ...(existingParticipants ?? []),
    ...(incomingParticipants ?? [])
  ];
  if (mergedParticipants.length === 0) {
    return undefined;
  }

  const merged = new Map<string, MahiloAskAroundExpectedParticipant>();
  for (const participant of mergedParticipants) {
    const normalizedParticipant = normalizeAskAroundExpectedParticipant(participant);
    if (!normalizedParticipant) {
      continue;
    }

    const participantKey = normalizeAskAroundParticipantKey(normalizedParticipant.recipient);
    if (!participantKey) {
      continue;
    }

    const existing = merged.get(participantKey);
    merged.set(participantKey, {
      label: normalizedParticipant.label ?? existing?.label,
      recipient: normalizedParticipant.recipient
    });
  }

  const values = [...merged.values()];
  return values.length > 0 ? values : undefined;
}

function normalizeAskAroundReplyOutcome(
  value: MahiloAskAroundReplyOutcome | undefined
): MahiloAskAroundReplyOutcome | undefined {
  switch (value) {
    case "attribution_unverified":
    case "direct_reply":
    case "no_grounded_answer":
      return value;
    default:
      return undefined;
  }
}

function classifyAskAroundReply(
  session: MahiloAskAroundSession,
  reply: MahiloAskAroundReply
): MahiloAskAroundReplyOutcome {
  if (!isExpectedAskAroundParticipant(session.expectedParticipants, reply.sender)) {
    return "attribution_unverified";
  }

  return isExplicitNoGroundedAnswerReply(reply)
    ? "no_grounded_answer"
    : "direct_reply";
}

function isExpectedAskAroundParticipant(
  participants: MahiloAskAroundExpectedParticipant[] | undefined,
  sender: string
): boolean {
  if (!participants || participants.length === 0) {
    return true;
  }

  const normalizedSenderKey = normalizeAskAroundParticipantKey(sender);
  const normalizedSenderLabel = normalizeAskAroundParticipantLabel(sender);

  return participants.some((participant) => {
    const participantKey = normalizeAskAroundParticipantKey(participant.recipient);
    const participantLabel = normalizeAskAroundParticipantLabel(participant.label);
    return (
      (normalizedSenderKey && normalizedSenderKey === participantKey) ||
      (normalizedSenderLabel && normalizedSenderLabel === participantLabel)
    );
  });
}

function normalizeAskAroundParticipantKey(value: string | undefined): string | undefined {
  const normalized = normalizeToken(value);
  return normalized ? normalized.replace(/^@+/, "").toLowerCase() : undefined;
}

function normalizeAskAroundParticipantLabel(value: string | undefined): string | undefined {
  const normalized = normalizeToken(value);
  return normalized ? normalized.toLowerCase() : undefined;
}

function isExplicitNoGroundedAnswerReply(
  reply: Pick<MahiloAskAroundReply, "message" | "payloadType">
): boolean {
  const structuredOutcome = readStructuredAskAroundReplyOutcome(reply.message, reply.payloadType);
  if (structuredOutcome === "no_grounded_answer") {
    return true;
  }

  const normalizedMessage = normalizeAskAroundOutcomeMessage(reply.message);
  if (!normalizedMessage) {
    return false;
  }

  return (
    normalizedMessage === "i dont know" ||
    normalizedMessage === "i do not know" ||
    normalizedMessage === "no grounded answer" ||
    normalizedMessage === "no grounded answer available" ||
    normalizedMessage === "i do not have a grounded answer"
  );
}

function readStructuredAskAroundReplyOutcome(
  message: string,
  payloadType: string | undefined
): MahiloAskAroundReplyOutcome | undefined {
  const normalizedPayloadType = normalizeToken(payloadType)?.toLowerCase();
  if (
    normalizedPayloadType &&
    !normalizedPayloadType.includes("json") &&
    !message.trim().startsWith("{")
  ) {
    return undefined;
  }

  if (!normalizedPayloadType && !message.trim().startsWith("{")) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const root = parsed as Record<string, unknown>;
  const candidates = [
    root.outcome,
    root.answer_status,
    root.answerStatus,
    root.kind,
    root.status
  ];

  for (const candidate of candidates) {
    const normalized = normalizeAskAroundOutcomeToken(candidate);
    if (normalized === "no_grounded_answer" || normalized === "i_dont_know") {
      return "no_grounded_answer";
    }

    if (normalized === "direct_reply") {
      return "direct_reply";
    }
  }

  return undefined;
}

function normalizeAskAroundOutcomeToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[\s-]+/g, "_");

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAskAroundOutcomeMessage(value: string): string | undefined {
  const normalized = normalizeToken(value);
  if (!normalized) {
    return undefined;
  }

  return normalized
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

function normalizeToken(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeParticipant(value: string | undefined): string | undefined {
  const normalized = normalizeToken(value);
  return normalized ? normalized.toLowerCase() : undefined;
}

function buildInboundConnectionPairKey(localConnectionId: string, remoteConnectionId: string): string {
  return `${localConnectionId}::${remoteConnectionId}`;
}

function buildInboundParticipantKey(localConnectionId: string, remoteParticipant: string): string {
  return `${localConnectionId}::${remoteParticipant}`;
}

function normalizeNonNegativeInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : undefined;
}

function normalizeStringArray(values: string[] | undefined): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const normalized = values
    .map((value) => normalizeToken(value))
    .filter((value): value is string => Boolean(value));

  return normalized.length > 0 ? normalized : undefined;
}

function rememberGroupedInboundRoute(
  map: Map<string, CacheEntry[]>,
  groupId: string,
  entry: CacheEntry,
  nowMs: number
): void {
  const groupedEntries = pruneGroupedInboundRouteEntries(map.get(groupId), nowMs);
  const nextRoute = entry.value as MahiloInboundSessionRoute;
  const dedupedEntries = groupedEntries.filter(
    (candidate) =>
      !isSameGroupedInboundRouteIdentity(
        candidate.value as MahiloInboundSessionRoute,
        nextRoute
      )
  );

  map.set(groupId, [entry, ...dedupedEntries]);
}

function resolveGroupedInboundRoute(
  map: Map<string, CacheEntry[]>,
  groupId: string,
  localConnectionId: string | undefined,
  nowMs: number
): CacheEntry | undefined {
  const groupedEntries = pruneGroupedInboundRouteEntries(map.get(groupId), nowMs);
  if (groupedEntries.length === 0) {
    map.delete(groupId);
    return undefined;
  }

  map.set(groupId, groupedEntries);

  const localMatches =
    localConnectionId
      ? groupedEntries.filter(
          (entry) =>
            (entry.value as MahiloInboundSessionRoute).localConnectionId ===
            localConnectionId
        )
      : groupedEntries;

  return localMatches.length === 1 ? localMatches[0] : undefined;
}

function pruneGroupedInboundRoutes(
  map: Map<string, CacheEntry[]>,
  nowMs: number
): number {
  let removed = 0;

  for (const [groupId, entries] of map.entries()) {
    const groupedEntries = pruneGroupedInboundRouteEntries(entries, nowMs);
    removed += entries.length - groupedEntries.length;

    if (groupedEntries.length === 0) {
      map.delete(groupId);
      continue;
    }

    if (groupedEntries.length !== entries.length) {
      map.set(groupId, groupedEntries);
    }
  }

  return removed;
}

function countGroupedInboundRoutes(map: Map<string, CacheEntry[]>): number {
  let count = 0;
  for (const entries of map.values()) {
    count += entries.length;
  }

  return count;
}

function pruneGroupedInboundRouteEntries(
  entries: CacheEntry[] | undefined,
  nowMs: number
): CacheEntry[] {
  if (!entries || entries.length === 0) {
    return [];
  }

  return entries.filter((entry) => entry.expiresAt > nowMs);
}

function isSameGroupedInboundRouteIdentity(
  left: MahiloInboundSessionRoute,
  right: MahiloInboundSessionRoute
): boolean {
  return (
    left.sessionKey === right.sessionKey &&
    left.correlationId === right.correlationId &&
    left.localConnectionId === right.localConnectionId &&
    left.outboundMessageId === right.outboundMessageId
  );
}

function pruneCacheMap(map: Map<string, CacheEntry>, nowMs: number): number {
  let removed = 0;

  for (const [key, entry] of map.entries()) {
    if (entry.expiresAt > nowMs) {
      continue;
    }

    map.delete(key);
    removed += 1;
  }

  return removed;
}
