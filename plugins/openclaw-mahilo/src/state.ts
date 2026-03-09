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
  resolutionId?: string;
  selectors: DeclaredSelectors;
  senderConnectionId?: string;
  status: "denied" | "review_required" | "sent";
  toolName: string;
}

const DEFAULT_DEDUPE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CONTEXT_CACHE_TTL_SECONDS = 60;
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
  private readonly contextCache = new Map<string, CacheEntry>();
  readonly dedupe: InMemoryDedupeState;
  private readonly contextCacheTtlMs: number;
  private readonly learningSuggestionTtlMs: number;
  private readonly novelDecisionTtlMs: number;
  private readonly novelDecisionEntries = new Map<string, number>();
  private readonly pendingLearningSuggestions = new Map<string, CacheEntry>();

  constructor(
    options: {
      contextCacheTtlSeconds?: number;
      dedupeTtlMs?: number;
      learningSuggestionTtlMs?: number;
      novelDecisionTtlMs?: number;
    } = {}
  ) {
    const contextCacheTtlSeconds = options.contextCacheTtlSeconds ?? DEFAULT_CONTEXT_CACHE_TTL_SECONDS;
    this.contextCacheTtlMs = Math.max(0, contextCacheTtlSeconds) * 1000;
    this.dedupe = new InMemoryDedupeState(options.dedupeTtlMs);
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
