import { describe, expect, it } from "bun:test";

import { createMahiloOpenClawPlugin } from "../src";

interface MockClientState {
  outcomeCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
  resolveCalls: Array<Record<string, unknown>>;
  sendCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
}

interface RegisteredTool {
  execute: (toolCallId: string, input: unknown) => Promise<unknown>;
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
    outcomeCalls: [],
    resolveCalls: [],
    sendCalls: []
  };

  const client = {
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
): { api: never; routes: RegisteredHttpRoute[]; tools: RegisteredTool[] } {
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
    registerCommand: () => {},
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
    routes,
    tools
  };
}

function findTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`expected tool ${name} to be registered`);
  }

  return tool;
}

describe("createMahiloOpenClawPlugin", () => {
  it("registers current OpenClaw tool names", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, routes, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "list_mahilo_contacts",
      "talk_to_agent",
      "talk_to_group"
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
});
