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

interface MahiloHookSessionHint {
  agentId?: string;
  runId?: string;
  sessionKey: string;
  toolCallId?: string;
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

export interface MahiloAskAroundQuerySignal {
  correlationId: string;
  expectedReplyCount?: number;
  senderConnectionId?: string;
  target?: MahiloAskAroundTarget;
}

export interface MahiloProductSignalSenderBucket {
  queriesSent: number;
  senderConnectionId: string;
}

export interface MahiloProductSignalReplyOutcomeCounts {
  directReplies: number;
  noGroundedAnswers: number;
  trustedReplies: number;
  unattributedReplies: number;
}

export interface MahiloProductSignalResponseRate {
  contactsAsked: number;
  contactsReplied: number;
  contactReplyRate: number | null;
  queriesWithReplies: number;
  queryReplyRate: number | null;
}

export interface MahiloProductSignalsSnapshot {
  connectedContacts?: number;
  generatedAt: string;
  queriesBySenderConnection: MahiloProductSignalSenderBucket[];
  queriesSent: number;
  repliesReceived: number;
  replyOutcomeCounts: MahiloProductSignalReplyOutcomeCounts;
  responseRate: MahiloProductSignalResponseRate;
  summary: string;
  window: {
    days: number;
    endAt: string;
    startAt: string;
  };
}

const DEFAULT_DEDUPE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CONTEXT_CACHE_TTL_SECONDS = 60;
const DEFAULT_INBOUND_ROUTE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOOK_SESSION_HINT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_LEARNING_SUGGESTION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_NOVEL_DECISION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PRODUCT_SIGNAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAHILO_SHARED_PLUGIN_STATE_REGISTRY_KEY = Symbol.for(
  "mahilo.openclaw.shared-plugin-state-registry"
);

type MahiloSharedPluginStateRegistry = Map<string, InMemoryPluginState>;

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

function getSharedPluginStateRegistry(): MahiloSharedPluginStateRegistry {
  const globalScope = globalThis as typeof globalThis & {
    [MAHILO_SHARED_PLUGIN_STATE_REGISTRY_KEY]?: MahiloSharedPluginStateRegistry;
  };
  let registry = globalScope[MAHILO_SHARED_PLUGIN_STATE_REGISTRY_KEY];
  if (!registry) {
    registry = new Map<string, InMemoryPluginState>();
    globalScope[MAHILO_SHARED_PLUGIN_STATE_REGISTRY_KEY] = registry;
  }
  return registry;
}

export function getOrCreateSharedMahiloPluginState(
  sharedKey: string,
  createState: () => InMemoryPluginState
): InMemoryPluginState {
  const normalizedKey = sharedKey.trim();
  if (normalizedKey.length === 0) {
    return createState();
  }

  const registry = getSharedPluginStateRegistry();
  const existing = registry.get(normalizedKey);
  if (existing) {
    return existing;
  }

  const created = createState();
  registry.set(normalizedKey, created);
  return created;
}

export function resetSharedMahiloPluginStates(sharedKey?: string): void {
  const registry = getSharedPluginStateRegistry();
  if (typeof sharedKey !== "string") {
    registry.clear();
    return;
  }

  const normalizedKey = sharedKey.trim();
  if (normalizedKey.length === 0) {
    registry.clear();
    return;
  }

  registry.delete(normalizedKey);
}

export class InMemoryPluginState {
  private readonly askAroundQuerySignals = new Map<string, CacheEntry>();
  private readonly askAroundReplySignals = new Map<string, CacheEntry>();
  private readonly askAroundSessions = new Map<string, CacheEntry>();
  private readonly askAroundSessionTtlMs: number;
  private readonly connectionPairRoutes = new Map<string, CacheEntry>();
  private readonly contextCache = new Map<string, CacheEntry>();
  private readonly correlationRoutes = new Map<string, CacheEntry>();
  readonly dedupe: InMemoryDedupeState;
  private readonly groupRoutes = new Map<string, CacheEntry[]>();
  private readonly hookSessionHints = new Map<string, CacheEntry>();
  private readonly hookSessionHintTtlMs: number;
  private readonly inboundRouteTtlMs: number;
  private readonly messageRoutes = new Map<string, CacheEntry>();
  private readonly participantRoutes = new Map<string, CacheEntry>();
  private readonly contextCacheTtlMs: number;
  private readonly learningSuggestionTtlMs: number;
  private readonly novelDecisionTtlMs: number;
  private readonly productSignalTtlMs: number;
  private readonly novelDecisionEntries = new Map<string, number>();
  private readonly pendingLearningSuggestions = new Map<string, CacheEntry>();
  private lastActiveSessionEntry: { agentId?: string; sessionKey: string; updatedAt: number } | undefined;

  constructor(
    options: {
      askAroundSessionTtlMs?: number;
      contextCacheTtlSeconds?: number;
      dedupeTtlMs?: number;
      inboundRouteTtlMs?: number;
      learningSuggestionTtlMs?: number;
      novelDecisionTtlMs?: number;
      productSignalTtlMs?: number;
    } = {}
  ) {
    const contextCacheTtlSeconds = options.contextCacheTtlSeconds ?? DEFAULT_CONTEXT_CACHE_TTL_SECONDS;
    this.contextCacheTtlMs = Math.max(0, contextCacheTtlSeconds) * 1000;
    this.dedupe = new InMemoryDedupeState(options.dedupeTtlMs);
    this.inboundRouteTtlMs = Math.max(0, options.inboundRouteTtlMs ?? DEFAULT_INBOUND_ROUTE_TTL_MS);
    this.hookSessionHintTtlMs = Math.min(
      this.inboundRouteTtlMs,
      DEFAULT_HOOK_SESSION_HINT_TTL_MS
    );
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
    this.productSignalTtlMs = Math.max(
      0,
      options.productSignalTtlMs ?? DEFAULT_PRODUCT_SIGNAL_TTL_MS
    );
  }

  touchActiveSession(sessionKey: string, agentId?: string, nowMs: number = Date.now()): void {
    this.lastActiveSessionEntry = { agentId, sessionKey, updatedAt: nowMs };
  }

  getLastActiveSession(): { agentId?: string; sessionKey: string } | undefined {
    return this.lastActiveSessionEntry
      ? { agentId: this.lastActiveSessionEntry.agentId, sessionKey: this.lastActiveSessionEntry.sessionKey }
      : undefined;
  }

  rememberHookSessionHint(
    hint: MahiloHookSessionHint,
    nowMs: number = Date.now()
  ): void {
    const normalizedSessionKey = normalizeToken(hint.sessionKey);
    if (!normalizedSessionKey) {
      return;
    }

    const keys = [
      buildHookSessionHintKey("tool", hint.toolCallId),
      buildHookSessionHintKey("run", hint.runId)
    ].filter((value): value is string => Boolean(value));
    if (keys.length === 0) {
      return;
    }

    this.pruneHookSessionHints(nowMs);

    const value = {
      agentId: normalizeToken(hint.agentId),
      sessionKey: normalizedSessionKey
    };
    const expiresAt = nowMs + this.hookSessionHintTtlMs;

    for (const key of keys) {
      this.hookSessionHints.set(key, {
        expiresAt,
        value
      });
    }
  }

  resolveHookSessionHint(
    lookup: { runId?: string; toolCallId?: string },
    nowMs: number = Date.now()
  ): { agentId?: string; sessionKey: string } | undefined {
    this.pruneHookSessionHints(nowMs);

    const keys = [
      buildHookSessionHintKey("tool", lookup.toolCallId),
      buildHookSessionHintKey("run", lookup.runId)
    ];

    for (const key of keys) {
      if (!key) {
        continue;
      }

      const entry = this.hookSessionHints.get(key);
      if (!entry || entry.expiresAt <= nowMs) {
        this.hookSessionHints.delete(key);
        continue;
      }

      const value = entry.value as { agentId?: string; sessionKey: string };
      return {
        agentId: value.agentId,
        sessionKey: value.sessionKey
      };
    }

    return undefined;
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

  pruneHookSessionHints(nowMs: number = Date.now()): number {
    let removed = 0;

    for (const [key, entry] of this.hookSessionHints.entries()) {
      if (entry.expiresAt > nowMs) {
        continue;
      }

      this.hookSessionHints.delete(key);
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
    rememberAskAroundReplySignal(this.askAroundReplySignals, normalizedCorrelationId, classifiedReply, {
      nowMs,
      ttlMs: this.productSignalTtlMs
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

  recordAskAroundQuery(
    signal: MahiloAskAroundQuerySignal,
    nowMs: number = Date.now()
  ): void {
    const normalizedSignal = normalizeAskAroundQuerySignal(signal);
    if (!normalizedSignal) {
      return;
    }

    this.pruneProductSignals(nowMs);

    const existingEntry = this.askAroundQuerySignals.get(normalizedSignal.correlationId);
    const existingSignal =
      existingEntry && existingEntry.expiresAt > nowMs
        ? (existingEntry.value as StoredMahiloAskAroundQuerySignal)
        : undefined;

    this.askAroundQuerySignals.set(normalizedSignal.correlationId, {
      expiresAt: nowMs + this.productSignalTtlMs,
      value: {
        correlationId: normalizedSignal.correlationId,
        expectedReplyCount:
          normalizedSignal.expectedReplyCount ?? existingSignal?.expectedReplyCount,
        recordedAtMs: existingSignal?.recordedAtMs ?? nowMs,
        senderConnectionId:
          normalizedSignal.senderConnectionId ?? existingSignal?.senderConnectionId,
        target: normalizedSignal.target ?? existingSignal?.target
      } satisfies StoredMahiloAskAroundQuerySignal
    });
  }

  getProductSignalsSnapshot(
    options: {
      connectedContacts?: number;
      nowMs?: number;
      windowDays?: number;
    } = {}
  ): MahiloProductSignalsSnapshot {
    const nowMs = options.nowMs ?? Date.now();
    const windowDays = normalizePositiveInteger(options.windowDays) ?? 7;
    const windowStartMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

    this.pruneProductSignals(nowMs);

    const queries = [...this.askAroundQuerySignals.values()]
      .map((entry) => entry.value as StoredMahiloAskAroundQuerySignal)
      .filter((entry) => entry.recordedAtMs >= windowStartMs && entry.recordedAtMs <= nowMs);
    const replies = [...this.askAroundReplySignals.values()]
      .map((entry) => entry.value as StoredMahiloAskAroundReplySignal)
      .filter((entry) => entry.recordedAtMs >= windowStartMs && entry.recordedAtMs <= nowMs);

    const repliesByCorrelationId = new Map<string, StoredMahiloAskAroundReplySignal[]>();
    for (const reply of replies) {
      const bucket = repliesByCorrelationId.get(reply.correlationId) ?? [];
      bucket.push(reply);
      repliesByCorrelationId.set(reply.correlationId, bucket);
    }

    const queriesBySenderConnection = summarizeAskAroundQueriesBySenderConnection(queries);
    const queriesWithReplies = queries.filter((query) =>
      (repliesByCorrelationId.get(query.correlationId) ?? []).some((reply) =>
        isTrustedAskAroundReplyOutcome(reply.outcome)
      )
    ).length;

    let contactsAsked = 0;
    const uniqueRespondents = new Set<string>();
    const queryIds = new Set(queries.map((query) => query.correlationId));

    for (const query of queries) {
      if (typeof query.expectedReplyCount === "number" && query.expectedReplyCount > 0) {
        contactsAsked += query.expectedReplyCount;
      }
    }

    for (const reply of replies) {
      if (!queryIds.has(reply.correlationId) || !isTrustedAskAroundReplyOutcome(reply.outcome)) {
        continue;
      }

      const correlationQuery = queries.find((query) => query.correlationId === reply.correlationId);
      if (
        !correlationQuery ||
        typeof correlationQuery.expectedReplyCount !== "number" ||
        correlationQuery.expectedReplyCount <= 0
      ) {
        continue;
      }

      const respondentKey =
        normalizeAskAroundParticipantKey(reply.sender) ??
        normalizeAskAroundParticipantLabel(reply.sender) ??
        reply.messageId;
      uniqueRespondents.add(`${reply.correlationId}::${respondentKey}`);
    }

    const replyOutcomeCounts = countAskAroundReplySignalOutcomes(replies);
    const queryReplyRate = calculateRate(queriesWithReplies, queries.length);
    const contactReplyRate = calculateRate(uniqueRespondents.size, contactsAsked);

    const snapshot: MahiloProductSignalsSnapshot = {
      connectedContacts: normalizeNonNegativeInteger(options.connectedContacts),
      generatedAt: toIsoTimestamp(nowMs),
      queriesBySenderConnection,
      queriesSent: queries.length,
      repliesReceived: replies.length,
      replyOutcomeCounts,
      responseRate: {
        contactsAsked,
        contactsReplied: uniqueRespondents.size,
        contactReplyRate,
        queriesWithReplies,
        queryReplyRate
      },
      summary: "",
      window: {
        days: windowDays,
        endAt: toIsoTimestamp(nowMs),
        startAt: toIsoTimestamp(windowStartMs)
      }
    };

    snapshot.summary = formatProductSignalsSummary(snapshot);
    return snapshot;
  }

  pruneProductSignals(nowMs: number = Date.now()): number {
    let removed = 0;

    removed += pruneCacheMap(this.askAroundQuerySignals, nowMs);
    removed += pruneCacheMap(this.askAroundReplySignals, nowMs);

    return removed;
  }

  productSignalQueryCount(nowMs: number = Date.now()): number {
    this.pruneProductSignals(nowMs);
    return this.askAroundQuerySignals.size;
  }

  productSignalReplyCount(nowMs: number = Date.now()): number {
    this.pruneProductSignals(nowMs);
    return this.askAroundReplySignals.size;
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

interface StoredMahiloAskAroundQuerySignal extends MahiloAskAroundQuerySignal {
  recordedAtMs: number;
}

interface StoredMahiloAskAroundReplySignal {
  correlationId: string;
  messageId: string;
  outcome: MahiloAskAroundReplyOutcome;
  recordedAtMs: number;
  sender: string;
  senderConnectionId?: string;
}

function buildHookSessionHintKey(
  prefix: "run" | "tool",
  rawValue: string | undefined
): string | undefined {
  const normalized = normalizeToken(rawValue);
  return normalized ? `${prefix}:${normalized}` : undefined;
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

function normalizeAskAroundQuerySignal(
  signal: MahiloAskAroundQuerySignal
): MahiloAskAroundQuerySignal | undefined {
  const correlationId = normalizeToken(signal.correlationId);
  if (!correlationId) {
    return undefined;
  }

  return {
    correlationId,
    expectedReplyCount: normalizeNonNegativeInteger(signal.expectedReplyCount),
    senderConnectionId: normalizeToken(signal.senderConnectionId),
    target: normalizeAskAroundTarget(signal.target)
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

function rememberAskAroundReplySignal(
  map: Map<string, CacheEntry>,
  correlationId: string,
  reply: MahiloAskAroundReply,
  options: {
    nowMs: number;
    ttlMs: number;
  }
): void {
  const normalizedSignal = normalizeAskAroundReplySignal(correlationId, reply);
  if (!normalizedSignal) {
    return;
  }

  const existingEntry = map.get(normalizedSignal.messageId);
  const existingSignal =
    existingEntry && existingEntry.expiresAt > options.nowMs
      ? (existingEntry.value as StoredMahiloAskAroundReplySignal)
      : undefined;

  map.set(normalizedSignal.messageId, {
    expiresAt: options.nowMs + options.ttlMs,
    value: {
      ...normalizedSignal,
      outcome: normalizedSignal.outcome ?? existingSignal?.outcome ?? "direct_reply",
      recordedAtMs: existingSignal?.recordedAtMs ?? options.nowMs
    } satisfies StoredMahiloAskAroundReplySignal
  });
}

function normalizeAskAroundReplySignal(
  correlationId: string,
  reply: MahiloAskAroundReply
): Omit<StoredMahiloAskAroundReplySignal, "recordedAtMs"> | undefined {
  const normalizedCorrelationId = normalizeToken(correlationId);
  const normalizedReply = normalizeAskAroundReply(reply);
  if (
    !normalizedCorrelationId ||
    !normalizedReply ||
    !normalizedReply.outcome
  ) {
    return undefined;
  }

  return {
    correlationId: normalizedCorrelationId,
    messageId: normalizedReply.messageId,
    outcome: normalizedReply.outcome,
    sender: normalizedReply.sender,
    senderConnectionId: normalizedReply.senderConnectionId
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

function countAskAroundReplySignalOutcomes(
  replies: StoredMahiloAskAroundReplySignal[]
): MahiloProductSignalReplyOutcomeCounts {
  return replies.reduce<MahiloProductSignalReplyOutcomeCounts>(
    (counts, reply) => {
      switch (reply.outcome) {
        case "direct_reply":
          counts.directReplies += 1;
          counts.trustedReplies += 1;
          break;
        case "no_grounded_answer":
          counts.noGroundedAnswers += 1;
          counts.trustedReplies += 1;
          break;
        case "attribution_unverified":
          counts.unattributedReplies += 1;
          break;
      }

      return counts;
    },
    {
      directReplies: 0,
      noGroundedAnswers: 0,
      trustedReplies: 0,
      unattributedReplies: 0
    }
  );
}

function summarizeAskAroundQueriesBySenderConnection(
  queries: StoredMahiloAskAroundQuerySignal[]
): MahiloProductSignalSenderBucket[] {
  const counts = new Map<string, number>();

  for (const query of queries) {
    if (!query.senderConnectionId) {
      continue;
    }

    counts.set(query.senderConnectionId, (counts.get(query.senderConnectionId) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([senderConnectionId, queriesSent]) => ({
      queriesSent,
      senderConnectionId
    }))
    .sort((left, right) => {
      const queryDelta = right.queriesSent - left.queriesSent;
      return queryDelta !== 0
        ? queryDelta
        : left.senderConnectionId.localeCompare(right.senderConnectionId);
    });
}

function isTrustedAskAroundReplyOutcome(
  outcome: MahiloAskAroundReplyOutcome
): boolean {
  return outcome === "direct_reply" || outcome === "no_grounded_answer";
}

function calculateRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) {
    return null;
  }

  return Math.round((numerator / denominator) * 1000) / 1000;
}

function formatProductSignalsSummary(
  snapshot: MahiloProductSignalsSnapshot
): string {
  const parts = [
    `${snapshot.queriesSent} ask-around ${snapshot.queriesSent === 1 ? "query" : "queries"} sent`,
    `${snapshot.repliesReceived} ${snapshot.repliesReceived === 1 ? "reply" : "replies"} received`,
    typeof snapshot.connectedContacts === "number"
      ? `${snapshot.connectedContacts} connected ${snapshot.connectedContacts === 1 ? "contact" : "contacts"}`
      : undefined
  ].filter((value): value is string => Boolean(value));

  const rateSummary =
    snapshot.responseRate.queryReplyRate === null
      ? undefined
      : `${formatRatePercentage(snapshot.responseRate.queryReplyRate)} of sent queries got at least one trusted reply`;

  return `Mahilo product signals (last ${snapshot.window.days} days): ${parts.join(", ")}${rateSummary ? `, ${rateSummary}` : ""}.`;
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

function normalizePositiveInteger(value: number | undefined): number | undefined {
  const normalized = normalizeNonNegativeInteger(value);
  return typeof normalized === "number" && normalized > 0 ? normalized : undefined;
}

function formatRatePercentage(value: number): string {
  const percentage = Math.round(value * 100);
  return `${percentage}%`;
}

function toIsoTimestamp(value: number): string {
  return new Date(value).toISOString();
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

  if (localMatches.length === 1) {
    return localMatches[0];
  }

  return localMatches.length === 0 && groupedEntries.length === 1
    ? groupedEntries[0]
    : undefined;
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
