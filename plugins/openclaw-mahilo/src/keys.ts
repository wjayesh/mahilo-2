import { createHmac, timingSafeEqual } from "node:crypto";

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

const DEFAULT_MAX_AGE_SECONDS = 300;
const HMAC_ALGORITHM = "sha256";
const SIGNATURE_HEADER_PREFIX = "sha256=";

export function buildCallbackSignaturePayload(rawBody: string, timestamp: number): string {
  return `${timestamp}.${rawBody}`;
}

export function generateCallbackSignature(rawBody: string, secret: string, timestamp: number): string {
  return createHmac(HMAC_ALGORITHM, secret).update(buildCallbackSignaturePayload(rawBody, timestamp)).digest("hex");
}

export function extractWebhookSignatureHeaders(headers: HeaderBag): WebhookSignatureHeaders {
  return {
    deliveryId: readHeader(headers, "x-mahilo-delivery-id"),
    groupId: readHeader(headers, "x-mahilo-group-id"),
    messageId: readHeader(headers, "x-mahilo-message-id"),
    signature: readHeader(headers, "x-mahilo-signature"),
    timestamp: readHeader(headers, "x-mahilo-timestamp")
  };
}

export function verifyWebhookSignature(
  rawBody: string,
  headers: HeaderBag,
  secret: string,
  options: SignatureVerificationOptions = {}
): SignatureVerificationResult {
  const signatureHeaders = extractWebhookSignatureHeaders(headers);
  const signatureHex = normalizeSignature(signatureHeaders.signature);
  const timestamp = parseTimestamp(signatureHeaders.timestamp);

  if (!signatureHex || timestamp === undefined) {
    return {
      ok: false,
      reason: "missing_headers"
    };
  }

  const nowSeconds = Number.isInteger(options.nowSeconds) ? Number(options.nowSeconds) : Math.floor(Date.now() / 1000);
  const maxAgeSeconds = Number.isInteger(options.maxAgeSeconds) ? Number(options.maxAgeSeconds) : DEFAULT_MAX_AGE_SECONDS;

  if (!Number.isFinite(nowSeconds) || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) {
    return {
      ok: false,
      reason: "invalid_timestamp"
    };
  }

  if (Math.abs(nowSeconds - timestamp) > maxAgeSeconds) {
    return {
      ok: false,
      reason: "stale_timestamp",
      timestamp
    };
  }

  const expectedSignature = generateCallbackSignature(rawBody, secret, timestamp);
  const isMatch = constantTimeHexMatch(expectedSignature, signatureHex);
  if (!isMatch) {
    return {
      expectedSignature,
      ok: false,
      reason: "invalid_signature",
      timestamp
    };
  }

  return {
    expectedSignature,
    ok: true,
    timestamp
  };
}

function parseTimestamp(timestampHeader: string | undefined): number | undefined {
  if (typeof timestampHeader !== "string" || timestampHeader.trim().length === 0) {
    return undefined;
  }

  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }

  return timestamp;
}

function normalizeSignature(signatureHeader: string | undefined): string | undefined {
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) {
    return undefined;
  }

  const normalized = signatureHeader.trim().toLowerCase();
  if (!normalized.startsWith(SIGNATURE_HEADER_PREFIX)) {
    return undefined;
  }

  const hex = normalized.slice(SIGNATURE_HEADER_PREFIX.length);
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length !== 64) {
    return undefined;
  }

  return hex;
}

function constantTimeHexMatch(expectedHex: string, actualHex: string): boolean {
  const expectedBuffer = Buffer.from(expectedHex, "hex");
  const actualBuffer = Buffer.from(actualHex, "hex");

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function readHeader(headers: HeaderBag, headerName: string): string | undefined {
  if (headers instanceof Headers) {
    const value = headers.get(headerName);
    return value === null ? undefined : value;
  }

  const lowercaseName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowercaseName) {
      continue;
    }

    return typeof value === "string" ? value : undefined;
  }

  return undefined;
}
