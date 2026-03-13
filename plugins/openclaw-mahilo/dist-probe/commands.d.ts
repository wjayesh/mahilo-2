import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { MahiloContractClient } from "./client";
import { type MahiloPluginConfig } from "./config";
import type { InMemoryPluginState } from "./state";
export interface MahiloDiagnosticsLogger {
    debug?: (message: string) => void;
    error?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
}
export interface MahiloDiagnosticsCommandOptions {
    logger?: MahiloDiagnosticsLogger;
    now?: () => number;
    pluginState?: InMemoryPluginState;
    reconnectDelayMs?: number;
}
export declare function registerMahiloDiagnosticsCommands(api: OpenClawPluginApi, config: MahiloPluginConfig, client: MahiloContractClient, options?: MahiloDiagnosticsCommandOptions): void;
