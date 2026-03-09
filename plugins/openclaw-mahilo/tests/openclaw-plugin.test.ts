import { describe, expect, it } from "bun:test";

import { createMahiloOpenClawPlugin } from "../src";

interface MockClientState {
  blockedEventCalls: number[];
  listReviewCalls: Array<{ limit?: number; status?: string }>;
  outcomeCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
  promptContextCalls: Array<Record<string, unknown>>;
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

interface RegisteredHook {
  execute: (payload: unknown) => Promise<unknown>;
  name: string;
}

function createMockContractClient(options: { promptContextResponse?: Record<string, unknown> } = {}) {
  const state: MockClientState = {
    blockedEventCalls: [],
    listReviewCalls: [],
    outcomeCalls: [],
    promptContextCalls: [],
    resolveCalls: [],
    sendCalls: []
  };
  const promptContextResponse = options.promptContextResponse ?? {
    policy_guidance: {
      default_decision: "ask",
      reason_code: "context.ask.role.structured",
      summary: "Share only high-level details."
    },
    recipient: {
      relationship: "friend",
      roles: ["close_friends"],
      username: "alice"
    },
    recent_interactions: [
      {
        decision: "allow",
        direction: "inbound",
        summary: "Asked for travel timing."
      }
    ],
    suggested_selectors: {
      action: "share",
      direction: "inbound",
      resource: "message.general"
    }
  };

  const client = {
    getPromptContext: async (payload: Record<string, unknown>) => {
      state.promptContextCalls.push(payload);
      return promptContextResponse;
    },
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
): {
  api: never;
  commands: RegisteredCommand[];
  hooks: RegisteredHook[];
  routes: RegisteredHttpRoute[];
  tools: RegisteredTool[];
} {
  const commands: RegisteredCommand[] = [];
  const hooks: RegisteredHook[] = [];
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
    registerHook: (...args: unknown[]) => {
      const hook = parseRegisteredHook(args);
      if (hook) {
        hooks.push(hook);
      }
    },
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
    hooks,
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

function parseRegisteredHook(args: unknown[]): RegisteredHook | undefined {
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
      execute: execute as RegisteredHook["execute"],
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

function findHook(hooks: RegisteredHook[], name: string): RegisteredHook {
  const hook = hooks.find((candidate) => candidate.name === name);
  if (!hook) {
    throw new Error(`expected hook ${name} to be registered`);
  }

  return hook;
}

describe("createMahiloOpenClawPlugin", () => {
  it("registers current OpenClaw tool names and diagnostics commands", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, commands, hooks, routes, tools } = createMockPluginApi({
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
    expect(hooks.map((hook) => hook.name)).toContain("before_prompt_build");
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

  it("injects bounded Mahilo context into prompt during before_prompt_build", async () => {
    const { client, state } = createMockContractClient({
      promptContextResponse: {
        policy_guidance: {
          default_decision: "ask",
          reason_code: "context.ask.role.structured",
          summary:
            "This is a very long summary intended to verify prompt-size controls remain bounded even when the server returns more context than needed."
        },
        recipient: {
          relationship: "friend",
          roles: ["close_friends", "trusted", "long_list_role"],
          username: "alice"
        },
        recent_interactions: [
          { direction: "inbound", decision: "allow", summary: "one" },
          { direction: "outbound", decision: "ask", summary: "two" },
          { direction: "inbound", decision: "deny", summary: "three" },
          { direction: "outbound", decision: "allow", summary: "four" }
        ],
        suggested_selectors: {
          action: "share",
          direction: "inbound",
          resource: "message.general"
        }
      }
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, hooks } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const hook = findHook(hooks, "before_prompt_build");
    const result = await hook.execute({
      message: {
        recipient_connection_id: "conn_receiver",
        sender: "alice",
        selectors: {
          action: "share",
          direction: "inbound",
          resource: "message.general"
        }
      },
      prompt: "You are a helpful assistant."
    });

    expect(state.promptContextCalls).toHaveLength(1);
    expect(state.promptContextCalls[0]).toMatchObject({
      recipient: "alice",
      recipient_type: "user",
      sender_connection_id: "conn_receiver"
    });

    expect(isRecord(result)).toBe(true);
    if (!isRecord(result)) {
      throw new Error("expected before_prompt_build hook to return a payload object");
    }

    const promptValue = result.prompt;
    if (typeof promptValue !== "string") {
      throw new Error("expected before_prompt_build hook to return prompt as string");
    }

    const prompt = promptValue;
    expect(prompt).toContain("[MahiloContext/v1]");
    expect(prompt).toContain("guidance=ask:context.ask.role.structured");
    expect(prompt).toContain("recipient=name=alice; relationship=friend; roles=close_friends,trusted,long_list_role");
    expect(prompt).toContain("recent_1=");
    expect(prompt).toContain("recent_2=");
    expect(prompt).not.toContain("recent_3=");
    expect(prompt).toContain("You are a helpful assistant.");
    expect(prompt.length).toBeLessThan(1400);
  });

  it("does not register prompt hook when promptContextEnabled is false", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, hooks } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
      promptContextEnabled: false
    });

    await plugin.register?.(api);

    expect(hooks.map((hook) => hook.name)).not.toContain("before_prompt_build");
  });
});
