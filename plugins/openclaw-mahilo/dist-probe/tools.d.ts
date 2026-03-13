import type { ReviewMode } from "./config";
import type { MahiloContractClient } from "./client";
import { type DeclaredSelectors, type LocalPolicyGuardResult, type PolicyDecision } from "./policy-helpers";
import { type FetchMahiloPromptContextInput, type FetchMahiloPromptContextOptions, type FetchMahiloPromptContextResult } from "./prompt-context";
export interface MahiloToolContext {
    agentSessionId?: string;
    reviewMode?: ReviewMode;
    senderConnectionId: string;
}
export interface MahiloSendToolInput {
    context?: string;
    correlationId?: string;
    declaredSelectors?: Partial<DeclaredSelectors>;
    idempotencyKey?: string;
    message: string;
    payloadType?: string;
    recipient: string;
    recipientConnectionId?: string;
    routingHints?: Record<string, unknown>;
}
export interface TalkToGroupInput extends MahiloSendToolInput {
    groupId?: string;
}
export interface ToolExecutionOptions {
    reportOutcomes?: boolean;
    reviewMode?: ReviewMode;
    skipLocalPolicyGuard?: boolean;
}
export interface MahiloToolResult {
    decision: PolicyDecision;
    deduplicated?: boolean;
    localPolicyGuard?: LocalPolicyGuardResult;
    messageId?: string;
    reason?: string;
    resolutionId?: string;
    response?: unknown;
    status: "denied" | "review_required" | "sent";
}
export interface MahiloContact {
    connectionId?: string;
    id: string;
    label: string;
    metadata?: Record<string, unknown>;
    type: "group" | "user";
}
export type ContactsProvider = () => Promise<MahiloContact[]>;
export interface GetMahiloContextInput extends FetchMahiloPromptContextInput {
}
export interface GetMahiloContextOptions extends FetchMahiloPromptContextOptions {
}
export type MahiloContextToolResult = FetchMahiloPromptContextResult;
export interface PreviewMahiloSendInput extends MahiloSendToolInput {
    recipientType?: "group" | "user";
}
export interface MahiloPreviewRecipientResult {
    decision?: PolicyDecision;
    deliveryMode?: string;
    recipient: string;
}
export interface MahiloPreviewResolvedRecipient {
    recipient: string;
    recipientConnectionId?: string;
    recipientType: "group" | "user";
}
export interface MahiloPreviewReview {
    required?: boolean;
    reviewId?: string;
}
export interface MahiloPreviewResult {
    agentGuidance?: string;
    decision: PolicyDecision;
    deliveryMode?: string;
    expiresAt?: string;
    reasonCode?: string;
    resolutionId?: string;
    resolutionSummary?: string;
    resolvedRecipient?: MahiloPreviewResolvedRecipient;
    response: unknown;
    review?: MahiloPreviewReview;
    serverSelectors: DeclaredSelectors;
    recipientResults: MahiloPreviewRecipientResult[];
}
export interface CreateMahiloOverrideInput {
    durationHours?: number;
    durationMinutes?: number;
    derivedFromMessageId?: string;
    effect: string;
    expiresAt?: string;
    idempotencyKey?: string;
    kind: string;
    maxUses?: number;
    priority?: number;
    recipient?: string;
    recipientType?: "group" | "user";
    reason: string;
    scope: string;
    selectors?: Partial<DeclaredSelectors>;
    senderConnectionId: string;
    sourceResolutionId?: string;
    targetId?: string;
    ttlSeconds?: number;
}
export interface MahiloOverrideResult {
    created?: boolean;
    kind?: string;
    policyId?: string;
    resolvedTargetId?: string;
    response: unknown;
    summary: string;
}
export type ReportedOutcome = "blocked" | "partial_sent" | "review_approved" | "review_rejected" | "review_requested" | "send_failed" | "sent" | "withheld";
export interface MahiloRecipientOutcome {
    outcome: ReportedOutcome;
    recipient: string;
}
export interface MahiloSendOutcomeSummary {
    outcome: ReportedOutcome;
    recipientResults?: MahiloRecipientOutcome[];
    reason?: string;
    status: MahiloToolResult["status"];
}
export declare function talkToAgent(client: MahiloContractClient, input: MahiloSendToolInput, context: MahiloToolContext, options?: ToolExecutionOptions): Promise<MahiloToolResult>;
export declare function talkToGroup(client: MahiloContractClient, input: TalkToGroupInput, context: MahiloToolContext, options?: ToolExecutionOptions): Promise<MahiloToolResult>;
export declare function listMahiloContacts(provider?: ContactsProvider): Promise<MahiloContact[]>;
export declare function getMahiloContext(client: MahiloContractClient, input: GetMahiloContextInput, options?: GetMahiloContextOptions): Promise<MahiloContextToolResult>;
export declare function previewMahiloSend(client: MahiloContractClient, input: PreviewMahiloSendInput, context: MahiloToolContext): Promise<MahiloPreviewResult>;
export declare function createMahiloOverride(client: MahiloContractClient, input: CreateMahiloOverrideInput): Promise<MahiloOverrideResult>;
export declare function summarizeMahiloSendOutcome(response: unknown, fallbackDecision: PolicyDecision, fallbackRecipient: string): MahiloSendOutcomeSummary;
