export type HeaderBag = Headers | Record<string, string | undefined>;
export interface WebhookSignatureHeaders {
    deliveryId?: string;
    groupId?: string;
    messageId?: string;
    signature?: string;
    timestamp?: string;
}
export interface SignatureVerificationOptions {
    maxAgeSeconds?: number;
    nowSeconds?: number;
}
export type SignatureFailureReason = "invalid_signature" | "invalid_timestamp" | "missing_headers" | "stale_timestamp";
export interface SignatureVerificationResult {
    expectedSignature?: string;
    ok: boolean;
    reason?: SignatureFailureReason;
    timestamp?: number;
}
export declare function buildCallbackSignaturePayload(rawBody: string, timestamp: number): string;
export declare function generateCallbackSignature(rawBody: string, secret: string, timestamp: number): string;
export declare function extractWebhookSignatureHeaders(headers: HeaderBag): WebhookSignatureHeaders;
export declare function verifyWebhookSignature(rawBody: string, headers: HeaderBag, secret: string, options?: SignatureVerificationOptions): SignatureVerificationResult;
