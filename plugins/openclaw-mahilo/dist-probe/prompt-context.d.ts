import type { MahiloContractClient } from "./client";
import { type DeclaredSelectors, type PolicyDecision } from "./policy-helpers";
export interface PromptContextCache {
    getCachedContext(cacheKey: string, nowMs?: number): unknown | undefined;
    setCachedContext(cacheKey: string, value: unknown, nowMs?: number): void;
}
export interface FetchMahiloPromptContextInput {
    declaredSelectors?: Partial<DeclaredSelectors>;
    includeRecentInteractions?: boolean;
    interactionLimit?: number;
    recipient: string;
    recipientType?: "group" | "user";
    senderConnectionId: string;
}
export interface FetchMahiloPromptContextOptions {
    cache?: PromptContextCache;
    maxRecentInteractions?: number;
    nowMs?: number;
}
export interface CompactPromptRecipient {
    id?: string;
    label: string;
    relationship?: string;
    roles: string[];
}
export interface CompactPromptGuidance {
    decision: PolicyDecision;
    reasonCode?: string;
    summary?: string;
}
export interface CompactPromptInteraction {
    decision?: PolicyDecision;
    direction?: string;
    summary?: string;
    timestamp?: string;
}
export interface CompactMahiloPromptContext {
    guidance: CompactPromptGuidance;
    recipient: CompactPromptRecipient;
    recentInteractions: CompactPromptInteraction[];
    selectors: DeclaredSelectors;
}
export interface FetchMahiloPromptContextResult {
    cacheKey: string;
    context?: CompactMahiloPromptContext;
    error?: string;
    injection: string;
    ok: boolean;
    source: "cache" | "fallback" | "live";
}
export interface FormatPromptInjectionOptions {
    maxRecentInteractions?: number;
}
export declare function fetchMahiloPromptContext(client: MahiloContractClient, input: FetchMahiloPromptContextInput, options?: FetchMahiloPromptContextOptions): Promise<FetchMahiloPromptContextResult>;
export declare function formatMahiloPromptInjection(context: CompactMahiloPromptContext, options?: FormatPromptInjectionOptions): string;
