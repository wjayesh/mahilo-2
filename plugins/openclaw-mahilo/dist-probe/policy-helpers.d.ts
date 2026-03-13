import type { ReviewMode } from "./config";
export type PolicyDecision = "allow" | "ask" | "deny";
export type SelectorDirection = "inbound" | "outbound";
export interface DeclaredSelectors {
    action: string;
    direction: SelectorDirection;
    resource: string;
}
export interface LocalPolicyGuardInput {
    message: string;
    selectors: DeclaredSelectors;
}
export interface LocalPolicyGuardResult {
    decision: PolicyDecision;
    reason?: string;
}
export declare function normalizeDeclaredSelectors(selectors: Partial<DeclaredSelectors> | undefined, fallbackDirection?: SelectorDirection): DeclaredSelectors;
export declare function extractDecision(value: unknown, fallback?: PolicyDecision): PolicyDecision;
export declare function extractResolutionId(value: unknown): string | undefined;
export declare function mergePolicyDecisions(...decisions: PolicyDecision[]): PolicyDecision;
export declare function decisionNeedsReview(decision: PolicyDecision): boolean;
export declare function decisionBlocksSend(decision: PolicyDecision): boolean;
export declare function shouldSendForDecision(decision: PolicyDecision, reviewMode?: ReviewMode): boolean;
export declare function toToolStatus(decision: PolicyDecision, reviewMode?: ReviewMode): "denied" | "review_required" | "sent";
export declare function applyLocalPolicyGuard(input: LocalPolicyGuardInput): LocalPolicyGuardResult;
