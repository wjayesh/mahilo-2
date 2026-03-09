import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { type MahiloContractClient } from "./client";
import { type MahiloDiagnosticsCommandOptions } from "./commands";
import { type MahiloPluginConfig } from "./config";
import { InMemoryPluginState } from "./state";
import { type ContactsProvider } from "./tools";
import { type MahiloWebhookRouteOptions } from "./webhook-route";
export interface MahiloOpenClawPluginOptions {
    contactsProvider?: ContactsProvider;
    createClient?: (config: MahiloPluginConfig) => MahiloContractClient;
    diagnosticsCommands?: MahiloDiagnosticsCommandOptions;
    pluginState?: InMemoryPluginState;
    webhookRoute?: MahiloWebhookRouteOptions;
}
export interface MahiloOpenClawPluginDefinition {
    description: string;
    id: string;
    name: string;
    register: (api: OpenClawPluginApi) => void | Promise<void>;
}
export declare function createMahiloOpenClawPlugin(options?: MahiloOpenClawPluginOptions): MahiloOpenClawPluginDefinition;
export declare function registerMahiloOpenClawPlugin(api: OpenClawPluginApi, options?: MahiloOpenClawPluginOptions): void;
declare const defaultMahiloOpenClawPlugin: MahiloOpenClawPluginDefinition;
export default defaultMahiloOpenClawPlugin;
