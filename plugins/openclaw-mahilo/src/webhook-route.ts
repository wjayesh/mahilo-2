import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

import type { MahiloPluginConfig } from "./config";
import type { HeaderBag } from "./keys";
import { InMemoryDedupeState } from "./state";
import type { MahiloInboundWebhookPayload, ProcessWebhookResult } from "./webhook";
import { processWebhookDelivery } from "./webhook";

export const DEFAULT_WEBHOOK_ROUTE_PATH = "/mahilo/incoming";
export const DEFAULT_WEBHOOK_ROUTE_AUTH_MODE = "none";

export type MahiloWebhookRouteAuthMode = "none" | "public";

export interface MahiloWebhookLogger {
  debug?: (message: string) => void;
  error?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface MahiloWebhookRouteOptions {
  authMode?: MahiloWebhookRouteAuthMode;
  callbackSecret?: string;
  dedupeState?: InMemoryDedupeState;
  dedupeTtlMs?: number;
  getCallbackSecret?: () => string | undefined | Promise<string | undefined>;
  logger?: MahiloWebhookLogger;
  maxSignatureAgeSeconds?: number;
  nowSeconds?: number | (() => number);
  onAcceptedDelivery?: (params: {
    messageId: string;
    payload: MahiloInboundWebhookPayload;
    result: ProcessWebhookResult;
  }) => void | Promise<void>;
  path?: string;
}

interface HttpRequestLike {
  body?: unknown;
  headers?: Record<string, unknown>;
  method?: string;
  rawBody?: unknown;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}

interface HttpResponseLike {
  end: (chunk?: string) => void;
  setHeader?: (name: string, value: string) => void;
  statusCode?: number;
  writeHead?: (statusCode: number, headers?: Record<string, string>) => void;
}

export function registerMahiloWebhookRoute(
  api: OpenClawPluginApi,
  config: MahiloPluginConfig,
  options: MahiloWebhookRouteOptions = {}
): void {
  const path = resolveWebhookRoutePath(config, options);
  const authMode = options.authMode ?? DEFAULT_WEBHOOK_ROUTE_AUTH_MODE;
  const handler = createMahiloWebhookRouteHandler(options);
  const routeRegistration = buildRouteRegistration(path, handler, authMode);

  api.registerHttpRoute(routeRegistration);
  options.logger?.info?.(`[Mahilo] Registered webhook route at ${path} (auth mode: ${authMode})`);
}

export function createMahiloWebhookRouteHandler(options: MahiloWebhookRouteOptions = {}) {
  const dedupeState = options.dedupeState ?? new InMemoryDedupeState(options.dedupeTtlMs);

  return async (req: unknown, res: unknown): Promise<void> => {
    const request = req as HttpRequestLike;
    const response = res as HttpResponseLike;

    if (isReadinessProbeMethod(request.method)) {
      writeJson(response, 200, {
        path: options.path ?? null,
        status: "ready"
      });
      return;
    }

    if (!isPostMethod(request.method)) {
      writeJson(response, 405, {
        error: "method_not_allowed",
        message: "Use POST for Mahilo webhook callbacks."
      }, {
        Allow: "GET, HEAD, POST"
      });
      return;
    }

    const callbackSecret = await resolveCallbackSecret(options);
    if (!callbackSecret) {
      options.logger?.warn?.("[Mahilo] Callback secret unavailable; rejecting webhook callback.");
      writeJson(response, 503, {
        error: "callback_secret_unavailable",
        message: "Webhook callback secret is not configured."
      });
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readRawRequestBody(request);
    } catch (error) {
      writeJson(response, 400, {
        error: "invalid_payload",
        message: error instanceof Error ? error.message : "Failed to read raw request body"
      });
      return;
    }

    const result = processWebhookDelivery(
      {
        headers: toHeaderBag(request.headers),
        rawBody
      },
      {
        callbackSecret,
        dedupeState,
        maxSignatureAgeSeconds: options.maxSignatureAgeSeconds,
        nowSeconds: resolveNowSeconds(options.nowSeconds)
      }
    );

    if (result.status === "invalid_signature") {
      options.logger?.warn?.(
        `[Mahilo] Rejected webhook callback: invalid signature (${result.reason ?? "unknown"}).`
      );
      writeJson(response, 401, {
        error: "invalid_signature",
        reason: result.reason ?? "invalid_signature"
      });
      return;
    }

    if (result.status === "invalid_payload") {
      writeJson(response, 400, {
        error: "invalid_payload",
        message: result.error ?? "Invalid webhook payload"
      });
      return;
    }

    if (result.status === "duplicate") {
      options.logger?.debug?.(`[Mahilo] Ignored duplicate webhook delivery for ${result.messageId ?? "unknown"}.`);
    }

    if (result.status === "accepted" && result.payload && result.messageId) {
      try {
        await options.onAcceptedDelivery?.({
          messageId: result.messageId,
          payload: result.payload,
          result
        });
      } catch (error) {
        options.logger?.error?.(
          `[Mahilo] Webhook post-processing failed for ${result.messageId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    writeJson(response, 200, {
      deduplicated: result.deduplicated,
      messageId: result.messageId ?? null,
      status: result.status
    });
  };
}

function resolveWebhookRoutePath(
  config: Pick<MahiloPluginConfig, "callbackPath">,
  options: Pick<MahiloWebhookRouteOptions, "path">
): string {
  return options.path ?? config.callbackPath ?? DEFAULT_WEBHOOK_ROUTE_PATH;
}

function buildRouteRegistration(
  path: string,
  handler: (req: unknown, res: unknown) => Promise<void>,
  authMode: MahiloWebhookRouteAuthMode
): Parameters<OpenClawPluginApi["registerHttpRoute"]>[0] {
  return {
    path,
    handler: handler as never,
    method: "POST",
    methods: ["GET", "HEAD", "POST"],
    authMode,
    auth: {
      mode: authMode
    },
    rawBody: true,
    requestBody: {
      mode: "raw",
      parse: false
    }
  } as unknown as Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];
}

async function resolveCallbackSecret(options: MahiloWebhookRouteOptions): Promise<string | undefined> {
  if (typeof options.getCallbackSecret === "function") {
    const secret = await options.getCallbackSecret();
    return normalizeSecret(secret);
  }

  return normalizeSecret(options.callbackSecret);
}

function normalizeSecret(secret: unknown): string | undefined {
  if (typeof secret !== "string") {
    return undefined;
  }

  const trimmed = secret.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveNowSeconds(nowSeconds: MahiloWebhookRouteOptions["nowSeconds"]): number | undefined {
  if (typeof nowSeconds === "function") {
    return nowSeconds();
  }

  return nowSeconds;
}

function isPostMethod(method: string | undefined): boolean {
  return (method ?? "POST").toUpperCase() === "POST";
}

function isReadinessProbeMethod(method: string | undefined): boolean {
  const normalized = (method ?? "POST").toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

async function readRawRequestBody(request: HttpRequestLike): Promise<string> {
  if (typeof request.rawBody === "string") {
    return request.rawBody;
  }

  if (request.rawBody instanceof Uint8Array) {
    return Buffer.from(request.rawBody).toString("utf8");
  }

  if (typeof request.body === "string") {
    return request.body;
  }

  if (request.body instanceof Uint8Array) {
    return Buffer.from(request.body).toString("utf8");
  }

  if (request.body !== undefined && request.body !== null) {
    throw new Error("raw request body is required for signature verification");
  }

  const iterator = request[Symbol.asyncIterator];
  if (typeof iterator !== "function") {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<unknown>) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk, "utf8"));
      continue;
    }

    if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
      continue;
    }

    throw new Error("unsupported request body chunk type");
  }

  return Buffer.concat(chunks).toString("utf8");
}

function toHeaderBag(headers: Record<string, unknown> | undefined): HeaderBag {
  if (!headers) {
    return {};
  }

  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      const firstString = value.find((entry) => typeof entry === "string");
      normalized[key] = typeof firstString === "string" ? firstString : undefined;
      continue;
    }

    normalized[key] = undefined;
  }

  return normalized;
}

function writeJson(
  response: HttpResponseLike,
  statusCode: number,
  payload: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): void {
  const headers = {
    "Content-Type": "application/json",
    ...extraHeaders
  };

  if (typeof response.writeHead === "function") {
    response.writeHead(statusCode, headers);
  } else {
    response.statusCode = statusCode;
    if (typeof response.setHeader === "function") {
      for (const [key, value] of Object.entries(headers)) {
        response.setHeader(key, value);
      }
    }
  }

  response.end(JSON.stringify(payload));
}
