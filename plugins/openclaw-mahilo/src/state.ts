import type { DeclaredSelectors, PolicyDecision } from "./policy-helpers";
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
  private readonly connectionPairRoutes = new Map<string, CacheEntry>();
  private readonly contextCache = new Map<string, CacheEntry>();
  private readonly correlationRoutes = new Map<string, CacheEntry>();
  readonly dedupe: InMemoryDedupeState;
  private readonly groupRoutes = new Map<string, CacheEntry>();
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
      this.groupRoutes.set(normalizedRoute.groupId, entry);
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

    const candidates: Array<CacheEntry | undefined> = [
      normalizedLookup.inResponseToMessageId
        ? this.messageRoutes.get(normalizedLookup.inResponseToMessageId)
        : undefined,
      normalizedLookup.correlationId
        ? this.correlationRoutes.get(normalizedLookup.correlationId)
        : undefined,
      normalizedLookup.groupId
        ? this.groupRoutes.get(normalizedLookup.groupId)
        : undefined,
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
    removed += pruneCacheMap(this.groupRoutes, nowMs);
    removed += pruneCacheMap(this.connectionPairRoutes, nowMs);
    removed += pruneCacheMap(this.participantRoutes, nowMs);

    return removed;
  }

  inboundRouteCount(nowMs: number = Date.now()): number {
    this.pruneInboundRoutes(nowMs);

    return (
      this.correlationRoutes.size +
      this.messageRoutes.size +
      this.groupRoutes.size +
      this.connectionPairRoutes.size +
      this.participantRoutes.size
    );
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
