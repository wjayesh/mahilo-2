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

const DEFAULT_DEDUPE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CONTEXT_CACHE_TTL_SECONDS = 60;

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

  constructor(options: { contextCacheTtlSeconds?: number; dedupeTtlMs?: number } = {}) {
    const contextCacheTtlSeconds = options.contextCacheTtlSeconds ?? DEFAULT_CONTEXT_CACHE_TTL_SECONDS;
    this.contextCacheTtlMs = Math.max(0, contextCacheTtlSeconds) * 1000;
    this.dedupe = new InMemoryDedupeState(options.dedupeTtlMs);
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
}
