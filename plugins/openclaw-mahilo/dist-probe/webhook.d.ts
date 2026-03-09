import type { HeaderBag, SignatureFailureReason } from "./keys";
import { type DeclaredSelectors } from "./policy-helpers";
import { InMemoryDedupeState } from "./state";
export interface MahiloInboundWebhookPayload {
    context?: string;
    correlation_id?: string;
    delivery_id?: string | null;
    group_id?: string | null;
    group_name?: string | null;
    in_response_to?: string;
    message: string;
    message_id: string;
    payload_type?: string;
    recipient_connection_id: string;
    selectors?: DeclaredSelectors;
    sender: string;
    sender_agent: string;
    sender_connection_id?: string;
    sender_user_id?: string;
    timestamp: string;
}
export interface ProcessWebhookInput {
    headers: HeaderBag;
    rawBody: string;
}
export interface ProcessWebhookOptions {
    callbackSecret: string;
    dedupeState?: InMemoryDedupeState;
    maxSignatureAgeSeconds?: number;
    nowSeconds?: number;
}
export interface ProcessWebhookResult {
    deduplicated: boolean;
    error?: string;
    messageId?: string;
    payload?: MahiloInboundWebhookPayload;
    reason?: SignatureFailureReason;
    status: "accepted" | "duplicate" | "invalid_payload" | "invalid_signature";
}
export declare function parseInboundWebhookPayload(rawBody: string): MahiloInboundWebhookPayload;
export declare function processWebhookDelivery(input: ProcessWebhookInput, options: ProcessWebhookOptions): ProcessWebhookResult;
