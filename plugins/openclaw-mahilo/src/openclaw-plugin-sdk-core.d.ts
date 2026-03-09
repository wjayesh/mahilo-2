declare module "openclaw/plugin-sdk/core" {
  export interface AnyAgentTool {
    [key: string]: unknown;
  }

  export interface OpenClawPluginLogger {
    debug?: (message: string) => void;
    error?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
  }

  export interface OpenClawRuntimeSystem {
    enqueueSystemEvent: (
      message: string,
      options?: Record<string, unknown>
    ) => void;
    requestHeartbeatNow: (options?: Record<string, unknown>) => void;
  }

  export interface OpenClawRuntime {
    system: OpenClawRuntimeSystem;
  }

  export interface OpenClawPluginEventContext {
    [key: string]: unknown;
  }

  export interface OpenClawPluginEventPayload {
    [key: string]: unknown;
  }

  export interface OpenClawPluginApi {
    logger?: OpenClawPluginLogger;
    on: (
      event: string,
      handler: (
        event: OpenClawPluginEventPayload,
        ctx: OpenClawPluginEventContext
      ) => unknown | Promise<unknown>
    ) => void;
    pluginConfig?: unknown;
    registerCommand: (...args: unknown[]) => void;
    registerHook: (
      name: string,
      handler: (...args: unknown[]) => unknown | Promise<unknown>
    ) => void;
    registerHttpRoute: (route: Record<string, unknown>) => void;
    registerTool: (tool: AnyAgentTool) => void;
    runtime: OpenClawRuntime;
    version?: string;
  }
}
