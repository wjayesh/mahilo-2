import type { HeaderBag, SignatureFailureReason } from "./keys";
import { extractWebhookSignatureHeaders, verifyWebhookSignature } from "./keys";
import { normalizeDeclaredSelectors, type DeclaredSelectors } from "./policy-helpers";
import { InMemoryDedupeState } from "./state";

export interface MahiloInboundWebhookPayload {
  context?: string;
  correlation_id?: string;
  delivery_id?: string | null;
  group_id?: string | null;
  group_name?: string | null;
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

const MAX_MESSAGE_ID_LENGTH = 512;

export function parseInboundWebhookPayload(rawBody: string): MahiloInboundWebhookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error("webhook body must be valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("webhook payload must be an object");
  }

  const payload = parsed as Record<string, unknown>;
  const messageId = readRequiredMessageId(payload.message_id, "message_id");
  const recipientConnectionId = readRequiredString(payload.recipient_connection_id, "recipient_connection_id");
  const sender = readRequiredString(payload.sender, "sender");
  const senderAgent = readRequiredString(payload.sender_agent, "sender_agent");
  const message = readRequiredString(payload.message, "message");
  const timestamp = readRequiredString(payload.timestamp, "timestamp");

  return {
    context: readOptionalString(payload.context),
    correlation_id: readOptionalString(payload.correlation_id),
    delivery_id: readNullableString(payload.delivery_id),
    group_id: readNullableString(payload.group_id),
    group_name: readNullableString(payload.group_name),
    message,
    message_id: messageId,
    payload_type: readOptionalString(payload.payload_type) ?? "text/plain",
    recipient_connection_id: recipientConnectionId,
    selectors: normalizeSelectors(payload.selectors),
    sender,
    sender_agent: senderAgent,
    sender_connection_id: readOptionalString(payload.sender_connection_id),
    sender_user_id: readOptionalString(payload.sender_user_id),
    timestamp
  };
}

export function processWebhookDelivery(input: ProcessWebhookInput, options: ProcessWebhookOptions): ProcessWebhookResult {
  const signatureCheck = verifyWebhookSignature(input.rawBody, input.headers, options.callbackSecret, {
    maxAgeSeconds: options.maxSignatureAgeSeconds,
    nowSeconds: options.nowSeconds
  });

  if (!signatureCheck.ok) {
    return {
      deduplicated: false,
      error: "signature verification failed",
      reason: signatureCheck.reason,
      status: "invalid_signature"
    };
  }

  let payload: MahiloInboundWebhookPayload;
  try {
    payload = parseInboundWebhookPayload(input.rawBody);
  } catch (error) {
    return {
      deduplicated: false,
      error: error instanceof Error ? error.message : "invalid payload",
      status: "invalid_payload"
    };
  }

  const signatureHeaders = extractWebhookSignatureHeaders(input.headers);
  let headerMessageId: string | undefined;
  try {
    headerMessageId = readOptionalMessageId(signatureHeaders.messageId, "x-mahilo-message-id");
  } catch (error) {
    return {
      deduplicated: false,
      error: error instanceof Error ? error.message : "invalid message id header",
      status: "invalid_payload"
    };
  }

  const messageId = payload.message_id;
  if (headerMessageId && headerMessageId !== messageId) {
    return {
      deduplicated: false,
      error: "x-mahilo-message-id must match payload message_id",
      status: "invalid_payload"
    };
  }

  if (options.dedupeState) {
    const isNewMessage = options.dedupeState.markSeen(messageId);
    if (!isNewMessage) {
      return {
        deduplicated: true,
        messageId,
        payload,
        status: "duplicate"
      };
    }
  }

  return {
    deduplicated: false,
    messageId,
    payload,
    status: "accepted"
  };
}

function readRequiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }

  return value;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.trim().length > 0 ? value : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  return readOptionalString(value);
}

function normalizeSelectors(value: unknown): DeclaredSelectors | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const selectors = value as Partial<DeclaredSelectors>;
  return normalizeDeclaredSelectors(selectors, "inbound");
}

function readRequiredMessageId(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }

  const normalized = value.trim();
  if (normalized.length > MAX_MESSAGE_ID_LENGTH) {
    throw new Error(`${key} must be at most ${MAX_MESSAGE_ID_LENGTH} characters`);
  }

  return normalized;
}

function readOptionalMessageId(value: unknown, key: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  if (normalized.length > MAX_MESSAGE_ID_LENGTH) {
    throw new Error(`${key} must be at most ${MAX_MESSAGE_ID_LENGTH} characters`);
  }

  return normalized;
}
