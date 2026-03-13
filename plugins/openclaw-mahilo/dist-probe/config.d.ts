import { MahiloContractClient } from "./client";
import type { MahiloClientOptions } from "./client";
export type ReviewMode = "auto" | "ask" | "manual";
export interface MahiloPluginConfig {
    apiKey: string;
    baseUrl: string;
    cacheTtlSeconds: number;
    callbackPath?: string;
    callbackUrl?: string;
    contractVersion: string;
    pluginVersion: string;
    promptContextEnabled: boolean;
    reviewMode: ReviewMode;
}
export interface ParseConfigOptions {
    defaults?: Partial<Pick<MahiloPluginConfig, "cacheTtlSeconds" | "contractVersion" | "pluginVersion" | "promptContextEnabled" | "reviewMode">>;
}
export declare class MahiloConfigError extends Error {
    constructor(message: string);
}
export declare function parseMahiloPluginConfig(rawConfig: unknown, options?: ParseConfigOptions): MahiloPluginConfig;
export declare function createClientOptionsFromConfig(config: MahiloPluginConfig): MahiloClientOptions;
export declare function createMahiloClientFromConfig(config: MahiloPluginConfig): MahiloContractClient;
export declare function redactSensitiveConfig(config: MahiloPluginConfig): Record<string, unknown>;
