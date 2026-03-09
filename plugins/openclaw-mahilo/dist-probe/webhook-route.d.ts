import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { MahiloPluginConfig } from "./config";
import { InMemoryDedupeState } from "./state";
import type { MahiloInboundWebhookPayload, ProcessWebhookResult } from "./webhook";
export declare const DEFAULT_WEBHOOK_ROUTE_PATH = "/mahilo/incoming";
export declare const DEFAULT_WEBHOOK_ROUTE_AUTH_MODE = "none";
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
export declare function registerMahiloWebhookRoute(api: OpenClawPluginApi, config: MahiloPluginConfig, options?: MahiloWebhookRouteOptions): void;
export declare function createMahiloWebhookRouteHandler(options?: MahiloWebhookRouteOptions): (req: unknown, res: unknown) => Promise<void>;
