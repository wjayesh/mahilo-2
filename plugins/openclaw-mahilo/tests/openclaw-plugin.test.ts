import { describe, expect, it } from "bun:test";

import {
  createMahiloOpenClawPlugin,
  generateCallbackSignature,
  MahiloRequestError
} from "../src";

const CALLBACK_SECRET = "callback-secret";

interface MockClientState {
  agentConnectionCalls: number;
  agentConnectionsResponse: unknown;
  blockedEventCalls: number[];
  listReviewCalls: Array<{ limit?: number; status?: string }>;
  overrideCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
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
  execute: (...args: unknown[]) => Promise<unknown> | unknown;
  name: string;
}

interface RecordedSystemEvent {
  contextKey?: string | null;
  sessionKey: string;
  text: string;
}

interface RecordedHeartbeatRequest {
  agentId?: string;
  reason?: string;
  sessionKey?: string;
}

function createMockContractClient(options: {
  agentConnectionsResponse?: unknown;
  createOverrideError?: Error;
  promptContextError?: Error;
  promptContextResponse?: Record<string, unknown>;
  resolveError?: Error;
  resolveResponse?: Record<string, unknown>;
} = {}) {
  const state: MockClientState = {
    agentConnectionCalls: 0,
    agentConnectionsResponse:
      options.agentConnectionsResponse ??
      [
        {
          active: true,
          framework: "openclaw",
          id: "conn_sender_default",
          label: "default"
        }
      ],
    blockedEventCalls: [],
    listReviewCalls: [],
    overrideCalls: [],
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
    createOverride: async (payload: Record<string, unknown>, idempotencyKey?: string) => {
      state.overrideCalls.push({ idempotencyKey, payload });
      if (options.createOverrideError) {
        throw options.createOverrideError;
      }

      return {
        created: true,
        kind: "one_time",
        policy_id: "pol_789"
      };
    },
    getPromptContext: async (payload: Record<string, unknown>) => {
      state.promptContextCalls.push(payload);
      if (options.promptContextError) {
        throw options.promptContextError;
      }

      return promptContextResponse;
    },
    listOwnAgentConnections: async () => {
      state.agentConnectionCalls += 1;
      return state.agentConnectionsResponse;
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
      if (options.resolveError) {
        throw options.resolveError;
      }

      return options.resolveResponse ?? {
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
  heartbeatRequests: RecordedHeartbeatRequest[];
  hooks: RegisteredHook[];
  routes: RegisteredHttpRoute[];
  systemEvents: RecordedSystemEvent[];
  tools: RegisteredTool[];
} {
  const commands: RegisteredCommand[] = [];
  const heartbeatRequests: RecordedHeartbeatRequest[] = [];
  const hooks: RegisteredHook[] = [];
  const tools: RegisteredTool[] = [];
  const routes: RegisteredHttpRoute[] = [];
  const systemEvents: RecordedSystemEvent[] = [];

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
    on: (name: string, execute: RegisteredHook["execute"]) => {
      hooks.push({ execute, name });
    },
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
    runtime: {
      system: {
        enqueueSystemEvent: (
          text: string,
          options: { contextKey?: string | null; sessionKey: string }
        ) => {
          systemEvents.push({
            contextKey: options.contextKey,
            sessionKey: options.sessionKey,
            text
          });
          return true;
        },
        requestHeartbeatNow: (options?: RecordedHeartbeatRequest) => {
          heartbeatRequests.push(options ?? {});
        }
      }
    },
    source: "tests/openclaw-plugin",
    version: "1.2.3"
  };

  return {
    api: api as never,
    commands,
    heartbeatRequests,
    hooks,
    routes,
    systemEvents,
    tools
  };
}

function buildInboundWebhookRawBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    message: "Incoming Mahilo request.",
    message_id: "msg_inbound_1",
    recipient_connection_id: "conn_sender",
    sender: "alice",
    sender_agent: "openclaw",
    timestamp: "2026-03-08T12:15:00.000Z",
    ...overrides
  });
}

function createMockWebhookRequest(params: {
  headers?: Record<string, string>;
  method?: string;
  rawBody: string;
}) {
  return {
    headers: params.headers ?? {},
    method: params.method ?? "POST",
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(params.rawBody, "utf8");
    }
  };
}

function createMockWebhookResponse(): {
  body: () => Record<string, unknown>;
  response: {
    end: (chunk?: string) => void;
    setHeader: (name: string, value: string) => void;
    statusCode: number;
    writeHead: (statusCode: number, headers?: Record<string, string>) => void;
  };
  status: () => number;
} {
  let body = "";
  const response = {
    end: (chunk?: string) => {
      if (typeof chunk === "string") {
        body = chunk;
      }
    },
    setHeader: (_name: string, _value: string) => {},
    statusCode: 200,
    writeHead: (statusCode: number, _headers?: Record<string, string>) => {
      response.statusCode = statusCode;
    }
  };

  return {
    body: () => JSON.parse(body) as Record<string, unknown>,
    response,
    status: () => response.statusCode
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
  it("registers stable OpenClaw-native tool names and diagnostics commands", async () => {
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
      "create_mahilo_override",
      "get_mahilo_context",
      "list_mahilo_contacts",
      "preview_mahilo_send",
      "talk_to_agent",
      "talk_to_group"
    ]);
    expect(commands.map((command) => command.name).sort()).toEqual([
      "mahilo override",
      "mahilo reconnect",
      "mahilo review",
      "mahilo setup",
      "mahilo status"
    ]);
    expect(hooks.map((hook) => hook.name)).toEqual(
      expect.arrayContaining(["before_prompt_build", "after_tool_call", "agent_end"])
    );
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

  it("routes inbound webhook callbacks back to the originating session by correlation id", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET
      }
    });
    const { api, heartbeatRequests, hooks, routes, systemEvents, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "talk_to_agent");
    const outboundInput = {
      correlationId: "corr_routing_1",
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender"
    };
    const toolResult = await tool.execute("tool_call_route_1", outboundInput);

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: outboundInput,
        result: toolResult,
        toolName: "talk_to_agent"
      },
      {
        agentId: "mahilo-agent",
        runId: "run_route_1",
        sessionKey: "session_route_1",
        toolCallId: "tool_call_route_1",
        toolName: "talk_to_agent"
      }
    );

    systemEvents.length = 0;
    heartbeatRequests.length = 0;

    const rawBody = buildInboundWebhookRawBody({
      correlation_id: "corr_routing_1",
      message: "Replying in the same Mahilo thread.",
      recipient_connection_id: "conn_sender",
      sender_connection_id: "conn_alice"
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateCallbackSignature(rawBody, CALLBACK_SECRET, timestamp);
    const request = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_1",
        "x-mahilo-signature": `sha256=${signature}`,
        "x-mahilo-timestamp": String(timestamp)
      },
      rawBody
    });
    const response = createMockWebhookResponse();

    await routes[0]!.handler(request, response.response);

    expect(response.status()).toBe(200);
    expect(response.body()).toMatchObject({
      messageId: "msg_inbound_1",
      status: "accepted"
    });
    expect(systemEvents).toEqual([
      expect.objectContaining({
        contextKey: "mahilo:inbound:direct:msg_inbound_1",
        sessionKey: "session_route_1",
        text: expect.stringContaining("[MahiloInbound/v1]")
      })
    ]);
    expect(systemEvents[0]?.text).toContain("[thread corr_routing_1]");
    expect(systemEvents[0]?.text).toContain("Replying in the same Mahilo thread.");
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-agent",
        reason: "mahilo:inbound-message",
        sessionKey: "session_route_1"
      }
    ]);
  });

  it("falls back to sender and local connection routing when correlation id is absent", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET
      }
    });
    const { api, heartbeatRequests, hooks, routes, systemEvents, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "talk_to_agent");
    const outboundInput = {
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender"
    };
    const toolResult = await tool.execute("tool_call_route_2", outboundInput);

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: outboundInput,
        result: toolResult,
        toolName: "talk_to_agent"
      },
      {
        agentId: "mahilo-agent-2",
        runId: "run_route_2",
        sessionKey: "session_route_2",
        toolCallId: "tool_call_route_2",
        toolName: "talk_to_agent"
      }
    );

    systemEvents.length = 0;
    heartbeatRequests.length = 0;

    const rawBody = buildInboundWebhookRawBody({
      message: "Fallback route should still hit the active session.",
      recipient_connection_id: "conn_sender",
      sender: "Alice",
      sender_connection_id: "conn_alice"
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateCallbackSignature(rawBody, CALLBACK_SECRET, timestamp);
    const request = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_1",
        "x-mahilo-signature": `sha256=${signature}`,
        "x-mahilo-timestamp": String(timestamp)
      },
      rawBody
    });
    const response = createMockWebhookResponse();

    await routes[0]!.handler(request, response.response);

    expect(response.status()).toBe(200);
    expect(systemEvents).toEqual([
      expect.objectContaining({
        sessionKey: "session_route_2",
        text: expect.stringContaining("Fallback route should still hit the active session.")
      })
    ]);
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-agent-2",
        reason: "mahilo:inbound-message",
        sessionKey: "session_route_2"
      }
    ]);
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

  it("resolves a default sender connection for talk_to_agent when input omits it", async () => {
    const { client, state } = createMockContractClient({
      agentConnectionsResponse: [
        {
          active: true,
          framework: "other",
          id: "conn_other",
          label: "zeta"
        },
        {
          active: true,
          framework: "openclaw",
          id: "conn_sender_default",
          label: "primary"
        }
      ]
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "talk_to_agent");
    const result = await tool.execute("tool_call_2", {
      message: "hello",
      recipient: "alice"
    });

    expect(result).toMatchObject({
      details: {
        status: "sent"
      }
    });
    expect(state.agentConnectionCalls).toBe(1);
    expect(state.resolveCalls[0]?.sender_connection_id).toBe("conn_sender_default");
    expect(state.sendCalls[0]?.payload.sender_connection_id).toBe("conn_sender_default");
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

  it("executes get_mahilo_context through the context contract", async () => {
    const { client, state } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "get_mahilo_context");
    const result = await tool.execute("tool_call_4", {
      declaredSelectors: {
        action: "share",
        resource: "location.current"
      },
      interactionLimit: 10,
      recipient: "alice",
      senderConnectionId: "conn_sender"
    });

    expect(result).toMatchObject({
      details: {
        ok: true,
        source: "live"
      }
    });
    expect(state.promptContextCalls).toHaveLength(1);
    expect(state.promptContextCalls[0]).toEqual({
      draft_selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current"
      },
      include_recent_interactions: true,
      interaction_limit: 5,
      recipient: "alice",
      recipient_type: "user",
      sender_connection_id: "conn_sender"
    });
  });

  it("executes preview_mahilo_send without creating a send record", async () => {
    const { client, state } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "preview_mahilo_send");
    const result = await tool.execute("tool_call_5", {
      declaredSelectors: {
        action: "share",
        resource: "location.current"
      },
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender"
    });

    expect(result).toMatchObject({
      details: {
        decision: "allow",
        resolutionId: "res_123",
        serverSelectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current"
        }
      }
    });
    expect(state.resolveCalls).toHaveLength(1);
    expect(state.sendCalls).toHaveLength(0);
    expect(state.outcomeCalls).toHaveLength(0);
  });

  it("surfaces preview guidance when Mahilo requires review", async () => {
    const { client } = createMockContractClient({
      resolveResponse: {
        agent_guidance: "Ask for approval or create an override.",
        decision: "ask",
        delivery_mode: "review_required",
        reason_code: "policy.ask.resolved",
        resolution_id: "res_ask_1",
        resolution_summary: "Message requires review before delivery."
      }
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "preview_mahilo_send");
    const result = await tool.execute("tool_call_5b", {
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender"
    });

    expect(result).toMatchObject({
      content: [
        {
          text: expect.stringContaining(
            "Message requires review before delivery. Ask for approval or create an override."
          )
        }
      ],
      details: {
        agentGuidance: "Ask for approval or create an override.",
        decision: "ask",
        deliveryMode: "review_required",
        resolutionId: "res_ask_1",
        resolutionSummary: "Message requires review before delivery."
      }
    });
  });

  it("executes create_mahilo_override against the override contract", async () => {
    const { client, state } = createMockContractClient({
      promptContextResponse: {
        policy_guidance: {
          default_decision: "ask",
          reason_code: "context.ask.role.structured",
          summary: "Location shares require explicit approval."
        },
        recipient: {
          id: "usr_alice",
          relationship: "friend",
          roles: ["close_friends"],
          username: "alice"
        },
        suggested_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current"
        }
      }
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "create_mahilo_override");
    const result = await tool.execute("tool_call_6", {
      effect: "allow",
      kind: "once",
      recipient: "alice",
      reason: "User approved a one-time share.",
      scope: "user",
      selectors: {
        action: "share",
        resource: "location.current"
      },
      senderConnectionId: "conn_sender",
      sourceResolutionId: "res_123"
    });

    expect(result).toMatchObject({
      content: [
        {
          text: expect.stringContaining("one-time override")
        }
      ],
      details: {
        created: true,
        kind: "one_time",
        policyId: "pol_789",
        resolvedTargetId: "usr_alice"
      }
    });
    expect(state.promptContextCalls).toEqual([
      {
        draft_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current"
        },
        include_recent_interactions: false,
        interaction_limit: 1,
        recipient: "alice",
        recipient_type: "user",
        sender_connection_id: "conn_sender"
      }
    ]);
    expect(state.overrideCalls).toHaveLength(1);
    expect(state.overrideCalls[0]?.payload).toEqual({
      effect: "allow",
      kind: "one_time",
      max_uses: 1,
      reason: "User approved a one-time share.",
      scope: "user",
      selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current"
      },
      sender_connection_id: "conn_sender",
      source_resolution_id: "res_123",
      target_id: "usr_alice"
    });
  });

  it("returns graceful server failures for preview_mahilo_send", async () => {
    const { client } = createMockContractClient({
      resolveError: new MahiloRequestError("Mahilo request failed with status 503", {
        kind: "http",
        status: 503
      })
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "preview_mahilo_send");
    const result = await tool.execute("tool_call_7", {
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender"
    });

    expect(result).toMatchObject({
      details: {
        error: "Mahilo request failed with status 503",
        errorType: "server",
        retryable: true,
        status: "error",
        tool: "preview_mahilo_send"
      }
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

  it("queues Mahilo outcome notes and learning suggestions after novel send results", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, heartbeatRequests, hooks, systemEvents, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "talk_to_agent");
    const input = {
      declaredSelectors: {
        action: "share",
        resource: "location.current"
      },
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender"
    };
    const toolResult = await tool.execute("tool_call_post_send_1", input);

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: input,
        result: toolResult,
        toolName: "talk_to_agent"
      },
      {
        agentId: "mahilo-agent",
        runId: "run_1",
        sessionKey: "session_1",
        toolCallId: "tool_call_post_send_1",
        toolName: "talk_to_agent"
      }
    );

    expect(systemEvents).toHaveLength(1);
    expect(systemEvents[0]?.sessionKey).toBe("session_1");
    expect(String(systemEvents[0]?.text ?? "")).toContain(
      "Mahilo outcome: sent to alice (location.current/share)"
    );

    const agentEnd = findHook(hooks, "agent_end");
    await agentEnd.execute(
      {
        durationMs: 1_200,
        messages: [],
        success: true
      },
      {
        agentId: "mahilo-agent",
        sessionKey: "session_1"
      }
    );

    expect(systemEvents).toHaveLength(2);
    expect(systemEvents[1]?.sessionKey).toBe("session_1");
    expect(String(systemEvents[1]?.text ?? "")).toContain(
      "Mahilo learning opportunity:"
    );
    expect(String(systemEvents[1]?.text ?? "")).toContain("location.current/share");
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-agent",
        reason: "mahilo:learning-suggestion",
        sessionKey: "session_1"
      }
    ]);
  });

  it("does not repeat learning suggestions for the same Mahilo decision fingerprint", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, heartbeatRequests, hooks, systemEvents, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "talk_to_agent");
    const afterToolCall = findHook(hooks, "after_tool_call");
    const agentEnd = findHook(hooks, "agent_end");
    const input = {
      declaredSelectors: {
        action: "share",
        resource: "location.current"
      },
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender"
    };

    const firstResult = await tool.execute("tool_call_post_send_2a", input);
    await afterToolCall.execute(
      {
        params: input,
        result: firstResult,
        toolName: "talk_to_agent"
      },
      {
        runId: "run_2a",
        sessionKey: "session_2",
        toolCallId: "tool_call_post_send_2a",
        toolName: "talk_to_agent"
      }
    );
    await agentEnd.execute(
      {
        messages: [],
        success: true
      },
      {
        sessionKey: "session_2"
      }
    );

    const secondResult = await tool.execute("tool_call_post_send_2b", input);
    await afterToolCall.execute(
      {
        params: input,
        result: secondResult,
        toolName: "talk_to_agent"
      },
      {
        runId: "run_2b",
        sessionKey: "session_2",
        toolCallId: "tool_call_post_send_2b",
        toolName: "talk_to_agent"
      }
    );
    await agentEnd.execute(
      {
        messages: [],
        success: true
      },
      {
        sessionKey: "session_2"
      }
    );

    const learningEvents = systemEvents.filter((event) =>
      event.text.includes("Mahilo learning opportunity:")
    );

    expect(learningEvents).toHaveLength(1);
    expect(heartbeatRequests).toHaveLength(1);
  });

  it("keeps routine message.general sends out of the learning-suggestion path", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client
    });
    const { api, heartbeatRequests, hooks, systemEvents, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example"
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "talk_to_agent");
    const input = {
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender"
    };
    const toolResult = await tool.execute("tool_call_post_send_3", input);

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: input,
        result: toolResult,
        toolName: "talk_to_agent"
      },
      {
        sessionKey: "session_3",
        toolCallId: "tool_call_post_send_3",
        toolName: "talk_to_agent"
      }
    );

    const agentEnd = findHook(hooks, "agent_end");
    await agentEnd.execute(
      {
        messages: [],
        success: true
      },
      {
        sessionKey: "session_3"
      }
    );

    expect(systemEvents).toHaveLength(1);
    expect(JSON.stringify(systemEvents[0])).toContain("message.general/share");
    expect(JSON.stringify(systemEvents[0])).not.toContain(
      "Mahilo learning opportunity:"
    );
    expect(heartbeatRequests).toHaveLength(0);
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

  it("resolves prompt-hook sender context from active Mahilo connections when none is passed", async () => {
    const { client, state } = createMockContractClient({
      agentConnectionsResponse: [
        {
          active: true,
          framework: "other",
          id: "conn_other",
          label: "zeta"
        },
        {
          active: true,
          framework: "openclaw",
          id: "conn_sender_default",
          label: "primary"
        }
      ]
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
    await hook.execute({
      message: {
        sender: "alice",
        selectors: {
          action: "share",
          direction: "inbound",
          resource: "message.general"
        }
      },
      prompt: "You are a helpful assistant."
    });

    expect(state.agentConnectionCalls).toBe(1);
    expect(state.promptContextCalls[0]).toMatchObject({
      recipient: "alice",
      recipient_type: "user",
      sender_connection_id: "conn_sender_default"
    });
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
