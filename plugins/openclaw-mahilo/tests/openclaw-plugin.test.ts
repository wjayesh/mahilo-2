import { describe, expect, it } from "bun:test";

import { createMahiloOpenClawPlugin } from "../src";

interface MockClientState {
  blockedEventCalls: number[];
  listReviewCalls: Array<{ limit?: number; status?: string }>;
  outcomeCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
  resolveCalls: Array<Record<string, unknown>>;
  sendCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
}

interface RegisteredTool {
  execute: (toolCallId: string, input: unknown) => Promise<unknown>;
  name: string;
}

interface RegisteredCommand {
  execute: (input?: unknown) => Promise<unknown>;
  name: string;
}

interface RegisteredHttpRoute {
  auth?: { mode?: string };
  authMode?: string;
  handler: (req: unknown, res: unknown) => Promise<void>;
  method?: string;
  path: string;
  rawBody?: boolean;
}

function createMockContractClient() {
  const state: MockClientState = {
    blockedEventCalls: [],
    listReviewCalls: [],
    outcomeCalls: [],
    resolveCalls: [],
    sendCalls: []
  };

  const client = {
    listBlockedEvents: async (limit?: number) => {
      state.blockedEventCalls.push(limit ?? 0);
      return {
        items: []
      };
    },
    listReviews: async (params?: { limit?: number; status?: string }) => {
      state.listReviewCalls.push(params ?? {});
      return {
        items: []
      };
    },
    reportOutcome: async (payload: Record<string, unknown>, idempotencyKey?: string) => {
      state.outcomeCalls.push({ idempotencyKey, payload });
      return { ok: true };
    },
    resolveDraft: async (payload: Record<string, unknown>) => {
      state.resolveCalls.push(payload);
      return {
        decision: "allow",
        resolution_id: "res_123"
      };
    },
    sendMessage: async (payload: Record<string, unknown>, idempotencyKey?: string) => {
      state.sendCalls.push({ idempotencyKey, payload });
      return {
        message_id: "msg_123"
      };
    }
  };

  return {
    client: client as never,
    state
  };
}

function createMockPluginApi(
  pluginConfig: Record<string, unknown>
): { api: never; commands: RegisteredCommand[]; routes: RegisteredHttpRoute[]; tools: RegisteredTool[] } {
  const commands: RegisteredCommand[] = [];
  const tools: RegisteredTool[] = [];
  const routes: RegisteredHttpRoute[] = [];

  const api = {
    config: {},
    id: "mahilo",
    logger: {
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: () => {}
    },
    name: "Mahilo",
    on: () => {},
    pluginConfig,
    registerChannel: () => {},
    registerCli: () => {},
    registerCommand: (...args: unknown[]) => {
      const command = parseRegisteredCommand(args);
      if (command) {
        commands.push(command);
      }
    },
    registerContextEngine: () => {},
    registerGatewayMethod: () => {},
    registerHook: () => {},
    registerHttpRoute: (route: RegisteredHttpRoute) => {
      routes.push(route);
    },
    registerProvider: () => {},
    registerService: () => {},
    registerTool: (tool: RegisteredTool) => {
      tools.push(tool);
    },
    resolvePath: (input: string) => input,
    runtime: {},
    source: "tests/openclaw-plugin",
    version: "1.2.3"
  };

  return {
    api: api as never,
    commands,
    routes,
    tools
  };
}

function parseRegisteredCommand(args: unknown[]): RegisteredCommand | undefined {
  if (args.length === 0) {
    return undefined;
  }

  if (typeof args[0] === "string") {
    const name = args[0];
    const execute = args[1];
    if (typeof execute !== "function") {
      return undefined;
    }

    return {
      execute: execute as RegisteredCommand["execute"],
      name
    };
  }

  const candidate = args[0];
  if (!isRecord(candidate)) {
    return undefined;
  }

  const name = typeof candidate.name === "string" ? candidate.name : undefined;
  const execute = resolveCommandExecutor(candidate);
  if (!name || !execute) {
    return undefined;
  }

  return {
    execute,
    name
  };
}

function resolveCommandExecutor(candidate: Record<string, unknown>): RegisteredCommand["execute"] | undefined {
  const execute = candidate.execute;
  if (typeof execute === "function") {
    return execute as RegisteredCommand["execute"];
  }

  const handler = candidate.handler;
  if (typeof handler === "function") {
    return handler as RegisteredCommand["execute"];
  }

  const run = candidate.run;
  if (typeof run === "function") {
    return run as RegisteredCommand["execute"];
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`expected tool ${name} to be registered`);
  }

  return tool;
}

function findCommand(commands: RegisteredCommand[], name: string): RegisteredCommand {
  const command = commands.find((candidate) => candidate.name === name);
  if (!command) {
    throw new Error(`expected command ${name} to be registered`);
  }

  return command;
}

describe("createMahiloOpenClawPlugin", () => {
  it("registers current OpenClaw tool names and diagnostics commands", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, commands, routes, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "list_mahilo_contacts",
      "talk_to_agent",
      "talk_to_group"
    ]);
    expect(commands.map((command) => command.name).sort()).toEqual([
      "mahilo reconnect",
      "mahilo review",
      "mahilo status"
    ]);
    expect(routes).toHaveLength(1);
  });

  it("registers webhook route with explicit auth mode and raw-body hints", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, routes } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe("/mahilo/incoming");
    expect(routes[0]?.method).toBe("POST");
    expect(routes[0]?.authMode).toBe("none");
    expect(routes[0]?.auth).toEqual({ mode: "none" });
    expect(routes[0]?.rawBody).toBe(true);
  });

  it("uses callbackPath as webhook route path when configured", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, routes } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
      callbackPath: "/hooks/mahilo"
    });

    await plugin.register?.(api);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe("/hooks/mahilo");
  });

  it("executes talk_to_agent with sender_connection_id alias", async () => {
    const { client, state } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
      reviewMode: "auto"
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "talk_to_agent");
    const result = await tool.execute("tool_call_1", {
      message: "hello",
      recipient: "alice",
      sender_connection_id: "conn_sender"
    });

    expect(result).toMatchObject({
      details: {
        messageId: "msg_123",
        status: "sent"
      }
    });
    expect(state.resolveCalls).toHaveLength(1);
    expect(state.resolveCalls[0]?.sender_connection_id).toBe("conn_sender");
    expect(state.sendCalls).toHaveLength(1);
    expect(state.outcomeCalls).toHaveLength(1);
  });

  it("requires senderConnectionId for send tools", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "talk_to_agent");
    await expect(
      tool.execute("tool_call_2", {
        message: "hello",
        recipient: "alice"
      })
    ).rejects.toThrow("senderConnectionId is required");
  });

  it("lists contacts through the provided contacts provider", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      contactsProvider: async () => [
        {
          id: "alice",
          label: " Alice ",
          type: "user"
        }
      ],
      createClient: () => client
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "list_mahilo_contacts");
    const result = await tool.execute("tool_call_3", {});

    expect(result).toMatchObject({
      details: [
        {
          id: "alice",
          label: "Alice",
          type: "user"
        }
      ]
    });
  });

  it("returns diagnostics output for mahilo status", async () => {
    const { client, state } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, commands } = createMockPluginApi({
      apiKey: "mhl_test_secret",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const command = findCommand(commands, "mahilo status");
    const result = await command.execute();

    expect(result).toMatchObject({
      details: {
        command: "mahilo status",
        connected: true,
        diagnostics: {
          reconnectCount: 0
        },
        plugin: {
          config: {
            apiKey: "mh***et"
          }
        }
      }
    });
    expect(state.listReviewCalls).toHaveLength(1);
    expect(state.blockedEventCalls).toHaveLength(1);
  });
});
