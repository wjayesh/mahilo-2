import type { DeclaredSelectors, PolicyDecision } from "./policy-helpers";
import type { ReportedOutcome } from "./tools";
export interface DedupeState {
    has(messageId: string, nowMs?: number): boolean;
    markSeen(messageId: string, nowMs?: number): boolean;
    prune(nowMs?: number): number;
    size(): number;
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
export declare class InMemoryDedupeState implements DedupeState {
    private readonly entries;
    private readonly ttlMs;
    constructor(ttlMs?: number);
    has(messageId: string, nowMs?: number): boolean;
    markSeen(messageId: string, nowMs?: number): boolean;
    prune(nowMs?: number): number;
    size(): number;
}
export declare class InMemoryPluginState {
    private readonly connectionPairRoutes;
    private readonly contextCache;
    private readonly correlationRoutes;
    readonly dedupe: InMemoryDedupeState;
    private readonly groupRoutes;
    private readonly inboundRouteTtlMs;
    private readonly messageRoutes;
    private readonly participantRoutes;
    private readonly contextCacheTtlMs;
    private readonly learningSuggestionTtlMs;
    private readonly novelDecisionTtlMs;
    private readonly novelDecisionEntries;
    private readonly pendingLearningSuggestions;
    constructor(options?: {
        contextCacheTtlSeconds?: number;
        dedupeTtlMs?: number;
        inboundRouteTtlMs?: number;
        learningSuggestionTtlMs?: number;
        novelDecisionTtlMs?: number;
    });
    getCachedContext(cacheKey: string, nowMs?: number): unknown | undefined;
    setCachedContext(cacheKey: string, value: unknown, nowMs?: number): void;
    pruneContextCache(nowMs?: number): number;
    contextCacheSize(): number;
    rememberInboundRoute(route: MahiloInboundSessionRoute, nowMs?: number): void;
    resolveInboundRoute(lookup: MahiloInboundRouteLookup, nowMs?: number): MahiloInboundSessionRoute | undefined;
    pruneInboundRoutes(nowMs?: number): number;
    inboundRouteCount(nowMs?: number): number;
    markNovelDecision(signature: string, nowMs?: number): boolean;
    queueLearningSuggestion(sessionKey: string, suggestion: MahiloPendingLearningSuggestion, nowMs?: number): void;
    consumeLearningSuggestions(sessionKey: string, nowMs?: number): MahiloPendingLearningSuggestion[];
    pruneNovelDecisions(nowMs?: number): number;
    pruneLearningSuggestions(nowMs?: number): number;
    novelDecisionCount(nowMs?: number): number;
    pendingLearningSuggestionCount(nowMs?: number): number;
}
