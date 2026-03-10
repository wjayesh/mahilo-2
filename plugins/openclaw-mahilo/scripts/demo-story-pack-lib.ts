import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

import type {
  MahiloAgentConnectionSummary,
  MahiloContractClient,
  MahiloFriendConnectionDirectory,
  MahiloFriendshipSummary,
  MahiloGroupSummary,
  MahiloIdentitySummary,
} from "../src/client";
import { generateCallbackSignature } from "../src/keys";
import { createMahiloOpenClawPlugin } from "../src/openclaw-plugin-wrapper";

const DEMO_CALLBACK_SECRET = "mahilo-demo-story-pack-secret";
const DEFAULT_AGENT_ID_SUFFIX = "demo-agent";
const DEFAULT_RUN_ID_SUFFIX = "demo-run";
const DEFAULT_SESSION_ID_SUFFIX = "demo-session";
const DEFAULT_TIMESTAMP = "2026-03-08T12:15:00.000Z";

export const DEMO_STORY_FIXTURE_DIRECTORY = fileURLToPath(
  new URL("../docs/demo-fixtures", import.meta.url),
);

export interface DemoStoryFixture {
  id: string;
  mock: DemoStoryMockConfig;
  order: number;
  persona: string;
  prompt: string;
  steps: DemoStoryStep[];
  summary: string;
  title: string;
  trustSignals: string[];
}

export interface DemoStoryMockConfig {
  agentConnections?: MahiloAgentConnectionSummary[];
  blockedEventsResponse?: unknown;
  friendConnectionsByUsername?: Record<string, MahiloAgentConnectionSummary[]>;
  friendships?: MahiloFriendshipSummary[];
  groups?: MahiloGroupSummary[];
  identity?: MahiloIdentitySummary;
  promptContextResponse?: Record<string, unknown>;
  resolveDraftResponses?: Array<Record<string, unknown>>;
  reviewsResponse?: unknown;
}

interface DemoCommandStep {
  input?: Record<string, unknown>;
  kind: "command";
  label: string;
  name: string;
  note?: string;
}

interface DemoToolStep {
  input: Record<string, unknown>;
  kind: "tool";
  label: string;
  name: string;
  note?: string;
  toolCallId?: string;
}

export interface DemoWebhookPayload {
  [key: string]: unknown;
  context?: string;
  correlation_id?: string;
  group_id?: string;
  group_name?: string;
  message: Record<string, unknown> | string;
  message_id: string;
  payload_type?: string;
  recipient_connection_id?: string;
  sender: string;
  sender_agent?: string;
  sender_connection_id?: string;
  timestamp?: string;
}

interface DemoWebhookStep {
  kind: "webhook";
  label: string;
  note?: string;
  payload: DemoWebhookPayload;
}

export type DemoStoryStep = DemoCommandStep | DemoToolStep | DemoWebhookStep;

export interface DemoStoryRunStep {
  details?: unknown;
  kind: DemoStoryStep["kind"];
  label: string;
  note?: string;
  outputText: string;
  surface: string;
}

export interface DemoStoryRun {
  fixture: DemoStoryFixture;
  steps: DemoStoryRunStep[];
}

interface MockClientState {
  acceptFriendRequestCalls: string[];
  createOverrideCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
  getPromptContextCalls: Array<Record<string, unknown>>;
  listAgentConnectionsCalls: number;
  listBlockedEventsCalls: number[];
  listFriendAgentConnectionsCalls: string[];
  listFriendshipsCalls: Array<{ status?: string }>;
  listGroupsCalls: number;
  listReviewsCalls: Array<{ limit?: number; status?: string }>;
  pingAgentConnectionCalls: string[];
  rejectFriendRequestCalls: string[];
  reportOutcomeCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
  resolveDraftCalls: Array<Record<string, unknown>>;
  sendFriendRequestCalls: string[];
  sendMessageCalls: Array<{ idempotencyKey?: string; payload: Record<string, unknown> }>;
}

interface RegisteredCommand {
  execute: (input?: unknown) => Promise<unknown>;
  name: string;
}

interface RegisteredHook {
  execute: (...args: unknown[]) => Promise<unknown> | unknown;
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

interface RegisteredTool {
  execute: (toolCallId: string, input: unknown) => Promise<unknown>;
  name: string;
}

interface RecordedHeartbeatRequest {
  agentId?: string;
  reason?: string;
  sessionKey?: string;
}

interface RecordedSystemEvent {
  contextKey?: string | null;
  sessionKey: string;
  text: string;
}

export function loadBundledDemoStoryFixtures(): DemoStoryFixture[] {
  return loadDemoStoryFixtures();
}

export function loadDemoStoryFixtures(
  fixtureDirectory = DEMO_STORY_FIXTURE_DIRECTORY,
): DemoStoryFixture[] {
  return readdirSync(fixtureDirectory)
    .filter((entry: string) => entry.endsWith(".json"))
    .map((entry: string) => {
      const filePath = join(fixtureDirectory, entry);
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      return parseDemoStoryFixture(parsed, filePath);
    })
    .sort(compareDemoStoryFixtures);
}

export async function runDemoStoryFixture(
  fixture: DemoStoryFixture,
): Promise<DemoStoryRun> {
  const { client } = createMockContractClient(fixture.mock);
  const plugin = createMahiloOpenClawPlugin({
    createClient: () => client,
    webhookRoute: {
      callbackSecret: DEMO_CALLBACK_SECRET,
    },
  });
  const { api, commands, heartbeatRequests, hooks, routes, systemEvents, tools } =
    createMockPluginApi({
      apiKey: "mhl_demo",
      baseUrl: "https://mahilo.example",
    });

  await plugin.register?.(api);

  const afterToolCallHook = findOptionalHook(hooks, "after_tool_call");
  const route = routes[0];
  const steps: DemoStoryRunStep[] = [];
  const sessionKey = `${fixture.id}:${DEFAULT_SESSION_ID_SUFFIX}`;
  const runId = `${fixture.id}:${DEFAULT_RUN_ID_SUFFIX}`;
  const agentId = `${fixture.id}:${DEFAULT_AGENT_ID_SUFFIX}`;

  for (let index = 0; index < fixture.steps.length; index += 1) {
    const step = fixture.steps[index]!;
    if (step.kind === "command") {
      const command = findCommand(commands, step.name);
      const result = await command.execute(step.input);
      steps.push({
        details: readResultDetails(result),
        kind: step.kind,
        label: step.label,
        note: step.note,
        outputText: readResultText(result),
        surface: command.name,
      });
      continue;
    }

    if (step.kind === "tool") {
      const tool = findTool(tools, step.name);
      const toolCallId =
        step.toolCallId ?? `${fixture.id}:tool:${index + 1}:${tool.name}`;
      const result = await tool.execute(toolCallId, step.input);

      if (afterToolCallHook) {
        await afterToolCallHook.execute(
          {
            params: step.input,
            result,
            toolName: tool.name,
          },
          {
            agentId,
            runId,
            sessionKey,
            toolCallId,
            toolName: tool.name,
          },
        );
      }

      steps.push({
        details: readResultDetails(result),
        kind: step.kind,
        label: step.label,
        note: step.note,
        outputText: buildToolStepOutputText(result),
        surface: tool.name,
      });
      continue;
    }

    if (!route) {
      throw new Error(`Demo story ${fixture.id} requires a registered webhook route.`);
    }

    const priorEventCount = systemEvents.length;
    const priorHeartbeatCount = heartbeatRequests.length;
    const rawBody = buildInboundWebhookRawBody(step.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateCallbackSignature(
      rawBody,
      DEMO_CALLBACK_SECRET,
      timestamp,
    );
    const request = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": step.payload.message_id,
        "x-mahilo-signature": `sha256=${signature}`,
        "x-mahilo-timestamp": String(timestamp),
      },
      rawBody,
    });
    const response = createMockWebhookResponse();

    await route.handler(request, response.response);

    const newEvents = systemEvents.slice(priorEventCount);
    const newHeartbeats = heartbeatRequests.slice(priorHeartbeatCount);
    const responseBody = response.body();
    const responseSummary = [
      responseBody?.status ? `Webhook status: ${String(responseBody.status)}.` : undefined,
      responseBody?.messageId
        ? `Message: ${String(responseBody.messageId)}.`
        : undefined,
      newHeartbeats.length > 0 ? "The demo also requested an immediate OpenClaw heartbeat." : undefined,
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ");
    const systemEventText = newEvents
      .map((event) => event.text.trim())
      .filter((value) => value.length > 0)
      .join("\n\n");

    steps.push({
      details: responseBody,
      kind: step.kind,
      label: step.label,
      note: step.note,
      outputText: systemEventText.length > 0 ? systemEventText : responseSummary,
      surface: "incoming Mahilo webhook",
    });
  }

  return {
    fixture,
    steps,
  };
}

export async function runDemoStoryFixturePack(
  fixtures = loadBundledDemoStoryFixtures(),
): Promise<DemoStoryRun[]> {
  const runs: DemoStoryRun[] = [];
  for (const fixture of fixtures.slice().sort(compareDemoStoryFixtures)) {
    runs.push(await runDemoStoryFixture(fixture));
  }

  return runs;
}

export function renderDemoStoryPack(runs: DemoStoryRun[]): string {
  return runs
    .slice()
    .sort((left, right) => compareDemoStoryFixtures(left.fixture, right.fixture))
    .map((run) => renderDemoStoryRun(run))
    .join("\n\n");
}

export function renderDemoStoryRun(run: DemoStoryRun): string {
  const { fixture } = run;
  const lines = [
    `# ${fixture.title}`,
    `Story ID: ${fixture.id}`,
    `Persona: ${fixture.persona}`,
    `Prompt: ${fixture.prompt}`,
    fixture.summary,
    "",
    "Replay:",
  ];

  for (let index = 0; index < run.steps.length; index += 1) {
    const step = run.steps[index]!;
    lines.push(`${index + 1}. ${step.label}`);
    lines.push(`   Surface: \`${step.surface}\``);
    if (step.note) {
      lines.push(`   Note: ${step.note}`);
    }

    const renderedOutput = indentBlock(step.outputText, "   ");
    if (renderedOutput.length > 0) {
      lines.push(renderedOutput);
    }
  }

  if (fixture.trustSignals.length > 0) {
    lines.push("", "What this proves:");
    for (const signal of fixture.trustSignals) {
      lines.push(`- ${signal}`);
    }
  }

  return lines.join("\n");
}

function compareDemoStoryFixtures(
  left: DemoStoryFixture,
  right: DemoStoryFixture,
): number {
  if (left.order !== right.order) {
    return left.order - right.order;
  }

  return left.id.localeCompare(right.id);
}

function buildInboundWebhookRawBody(payload: DemoWebhookPayload): string {
  const message =
    typeof payload.message === "string"
      ? payload.message
      : JSON.stringify(payload.message);
  const normalizedPayloadType =
    typeof payload.payload_type === "string"
      ? payload.payload_type
      : typeof payload.message === "string"
        ? undefined
        : "application/json";
  const payloadRecord: Record<string, unknown> = { ...payload };

  return JSON.stringify({
    ...payloadRecord,
    message,
    message_id: payload.message_id,
    payload_type: normalizedPayloadType,
    recipient_connection_id:
      payload.recipient_connection_id ?? "conn_sender_default",
    sender: payload.sender,
    sender_agent: payload.sender_agent ?? "openclaw",
    sender_connection_id: payload.sender_connection_id,
    timestamp: payload.timestamp ?? DEFAULT_TIMESTAMP,
  });
}

function createMockContractClient(options: DemoStoryMockConfig): {
  client: MahiloContractClient;
  state: MockClientState;
} {
  const state: MockClientState = {
    acceptFriendRequestCalls: [],
    createOverrideCalls: [],
    getPromptContextCalls: [],
    listAgentConnectionsCalls: 0,
    listBlockedEventsCalls: [],
    listFriendAgentConnectionsCalls: [],
    listFriendshipsCalls: [],
    listGroupsCalls: 0,
    listReviewsCalls: [],
    pingAgentConnectionCalls: [],
    rejectFriendRequestCalls: [],
    reportOutcomeCalls: [],
    resolveDraftCalls: [],
    sendFriendRequestCalls: [],
    sendMessageCalls: [],
  };

  const resolveDraftResponses =
    options.resolveDraftResponses?.slice() ?? [];
  let createOverrideCount = 0;

  const identity: MahiloIdentitySummary =
    options.identity ?? {
      displayName: "Jay",
      raw: { username: "jay" },
      userId: "usr_jay",
      username: "jay",
      verified: true,
    };
  const agentConnections =
    options.agentConnections ?? [
      {
        active: true,
        framework: "openclaw",
        id: "conn_sender_default",
        label: "default",
        raw: {
          id: "conn_sender_default",
          is_default: true,
        },
      },
    ];
  const friendships = options.friendships ?? [];
  const groups = options.groups ?? [];
  const promptContextResponse =
    options.promptContextResponse ?? {
      policy_guidance: {
        default_decision: "ask",
        reason_code: "context.ask.role.structured",
        summary: "Location shares require explicit approval.",
      },
      recipient: {
        id: "usr_alice",
        relationship: "friend",
        roles: ["close_friends"],
        username: "alice",
      },
      suggested_selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current",
      },
    };

  const client = {
    acceptFriendRequest: async (friendshipId: string) => {
      state.acceptFriendRequestCalls.push(friendshipId);
      return {
        friendshipId,
        raw: {
          friendshipId,
          status: "accepted",
        },
        status: "accepted",
        success: true,
      };
    },
    createOverride: async (
      payload: Record<string, unknown>,
      idempotencyKey?: string,
    ) => {
      state.createOverrideCalls.push({ idempotencyKey, payload });
      createOverrideCount += 1;
      return {
        created: true,
        kind: payload.kind ?? "temporary",
        policy_id: `pol_demo_${createOverrideCount}`,
      };
    },
    getCurrentIdentity: async () => identity,
    getFriendAgentConnections: async (
      username: string,
    ): Promise<MahiloFriendConnectionDirectory> => {
      state.listFriendAgentConnectionsCalls.push(username);
      const connections = options.friendConnectionsByUsername?.[username] ?? [];
      return {
        connections,
        raw: connections,
        state: connections.length > 0 ? "available" : "no_active_connections",
        username,
      };
    },
    getPromptContext: async (payload: Record<string, unknown>) => {
      state.getPromptContextCalls.push(payload);
      return promptContextResponse;
    },
    listBlockedEvents: async (limit?: number) => {
      state.listBlockedEventsCalls.push(limit ?? 0);
      return options.blockedEventsResponse ?? { items: [] };
    },
    listFriendships: async (params?: { status?: string }) => {
      state.listFriendshipsCalls.push(params ?? {});
      const statusFilter = params?.status?.trim().toLowerCase();
      if (!statusFilter) {
        return friendships;
      }

      return friendships.filter(
        (friendship) =>
          (friendship.status ?? "").trim().toLowerCase() === statusFilter,
      );
    },
    listGroups: async () => {
      state.listGroupsCalls += 1;
      return groups;
    },
    listOwnAgentConnections: async () => {
      state.listAgentConnectionsCalls += 1;
      return agentConnections;
    },
    listReviews: async (params?: { limit?: number; status?: string }) => {
      state.listReviewsCalls.push(params ?? {});
      return options.reviewsResponse ?? { items: [] };
    },
    pingAgentConnection: async (senderConnectionId: string) => {
      state.pingAgentConnectionCalls.push(senderConnectionId);
      return {
        ok: true,
        senderConnectionId,
      };
    },
    rejectFriendRequest: async (friendshipId: string) => {
      state.rejectFriendRequestCalls.push(friendshipId);
      return {
        friendshipId,
        raw: {
          friendshipId,
          status: "declined",
        },
        status: "declined",
        success: true,
      };
    },
    reportOutcome: async (
      payload: Record<string, unknown>,
      idempotencyKey?: string,
    ) => {
      state.reportOutcomeCalls.push({ idempotencyKey, payload });
      return { ok: true };
    },
    resolveDraft: async (payload: Record<string, unknown>) => {
      state.resolveDraftCalls.push(payload);
      const next = resolveDraftResponses.shift();
      return (
        next ?? {
          decision: "allow",
          resolution_id: `res_demo_${state.resolveDraftCalls.length}`,
        }
      );
    },
    sendFriendRequest: async (username: string) => {
      state.sendFriendRequestCalls.push(username);
      return {
        friendshipId: `fr_pending_${username}`,
        raw: {
          friendshipId: `fr_pending_${username}`,
          status: "pending",
        },
        status: "pending",
        success: true,
      };
    },
    sendMessage: async (
      payload: Record<string, unknown>,
      idempotencyKey?: string,
    ) => {
      state.sendMessageCalls.push({ idempotencyKey, payload });
      return {
        message_id: `msg_demo_${state.sendMessageCalls.length}`,
      };
    },
  };

  return {
    client: client as unknown as MahiloContractClient,
    state,
  };
}

function createMockPluginApi(pluginConfig: Record<string, unknown>): {
  api: OpenClawPluginApi;
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
  const routes: RegisteredHttpRoute[] = [];
  const systemEvents: RecordedSystemEvent[] = [];
  const tools: RegisteredTool[] = [];

  const api = {
    config: {},
    id: "mahilo",
    logger: {
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: () => {},
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
          options: { contextKey?: string | null; sessionKey: string },
        ) => {
          systemEvents.push({
            contextKey: options.contextKey,
            sessionKey: options.sessionKey,
            text,
          });
          return true;
        },
        requestHeartbeatNow: (options?: RecordedHeartbeatRequest) => {
          heartbeatRequests.push(options ?? {});
        },
      },
    },
    source: "demo-story-pack",
    version: "0.1.0",
  };

  return {
    api: api as unknown as OpenClawPluginApi,
    commands,
    heartbeatRequests,
    hooks,
    routes,
    systemEvents,
    tools,
  };
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
    },
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
    },
  };

  return {
    body: () => (body.length > 0 ? (JSON.parse(body) as Record<string, unknown>) : {}),
    response,
    status: () => response.statusCode,
  };
}

function parseDemoStoryFixture(
  value: unknown,
  filePath: string,
): DemoStoryFixture {
  const root = expectRecord(value, filePath);
  return {
    id: readRequiredString(root, "id", filePath),
    mock: readMockConfig(root.mock, filePath),
    order: readRequiredNumber(root, "order", filePath),
    persona: readRequiredString(root, "persona", filePath),
    prompt: readRequiredString(root, "prompt", filePath),
    steps: readDemoStorySteps(root.steps, filePath),
    summary: readRequiredString(root, "summary", filePath),
    title: readRequiredString(root, "title", filePath),
    trustSignals: readRequiredStringArray(root, "trustSignals", filePath),
  };
}

function readMockConfig(value: unknown, filePath: string): DemoStoryMockConfig {
  const root = expectRecord(value, `${filePath}::mock`);
  return {
    agentConnections: readOptionalStructuredRecordArray<MahiloAgentConnectionSummary>(
      root.agentConnections,
    ),
    blockedEventsResponse: root.blockedEventsResponse,
    friendConnectionsByUsername:
      readOptionalStringKeyedStructuredRecordArrayMap<MahiloAgentConnectionSummary>(
        root.friendConnectionsByUsername,
      ),
    friendships: readOptionalStructuredRecordArray<MahiloFriendshipSummary>(
      root.friendships,
    ),
    groups: readOptionalStructuredRecordArray<MahiloGroupSummary>(root.groups),
    identity: readOptionalStructuredRecord<MahiloIdentitySummary>(root.identity),
    promptContextResponse: readOptionalRecord(root.promptContextResponse),
    resolveDraftResponses: readOptionalRecordArray(root.resolveDraftResponses),
    reviewsResponse: root.reviewsResponse,
  };
}

function readDemoStorySteps(
  value: unknown,
  filePath: string,
): DemoStoryStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${filePath} must define a non-empty steps array.`);
  }

  return value.map((entry, index) => {
    const root = expectRecord(entry, `${filePath}::steps[${index}]`);
    const kind = readRequiredString(root, "kind", `${filePath}::steps[${index}]`);
    const base = {
      label: readRequiredString(root, "label", `${filePath}::steps[${index}]`),
      note: readOptionalString(root.note),
    };

    switch (kind) {
      case "command":
        return {
          ...base,
          input: readOptionalRecord(root.input),
          kind,
          name: readRequiredString(root, "name", `${filePath}::steps[${index}]`),
        };
      case "tool":
        return {
          ...base,
          input: expectRecord(root.input, `${filePath}::steps[${index}]::input`),
          kind,
          name: readRequiredString(root, "name", `${filePath}::steps[${index}]`),
          toolCallId: readOptionalString(root.toolCallId),
        };
      case "webhook":
        return {
          ...base,
          kind,
          payload: readWebhookPayload(root.payload, `${filePath}::steps[${index}]::payload`),
        };
      default:
        throw new Error(
          `${filePath} uses unsupported step kind ${JSON.stringify(kind)}.`,
        );
    }
  });
}

function readWebhookPayload(
  value: unknown,
  filePath: string,
): DemoWebhookPayload {
  const root = expectRecord(value, filePath);
  const message = root.message;
  if (
    typeof message !== "string" &&
    !isRecord(message)
  ) {
    throw new Error(`${filePath} must define message as a string or object.`);
  }

  return {
    ...root,
    message,
    message_id: readRequiredString(root, "message_id", filePath),
    sender: readRequiredString(root, "sender", filePath),
  };
}

function parseRegisteredCommand(
  args: unknown[],
): RegisteredCommand | undefined {
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
      name,
    };
  }

  const candidate = args[0];
  if (!isRecord(candidate)) {
    return undefined;
  }

  const name = readOptionalString(candidate.name);
  const execute = resolveCommandExecutor(candidate);
  if (!name || !execute) {
    return undefined;
  }

  return {
    execute,
    name,
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
      name,
    };
  }

  const candidate = args[0];
  if (!isRecord(candidate)) {
    return undefined;
  }

  const name = readOptionalString(candidate.name);
  const execute = resolveCommandExecutor(candidate);
  if (!name || !execute) {
    return undefined;
  }

  return {
    execute,
    name,
  };
}

function resolveCommandExecutor(
  candidate: Record<string, unknown>,
): RegisteredCommand["execute"] | undefined {
  if (typeof candidate.execute === "function") {
    return candidate.execute as RegisteredCommand["execute"];
  }

  if (typeof candidate.handler === "function") {
    return candidate.handler as RegisteredCommand["execute"];
  }

  if (typeof candidate.run === "function") {
    return candidate.run as RegisteredCommand["execute"];
  }

  return undefined;
}

function findCommand(
  commands: RegisteredCommand[],
  name: string,
): RegisteredCommand {
  const command = commands.find((candidate) => candidate.name === name);
  if (!command) {
    throw new Error(`Expected command ${name} to be registered.`);
  }

  return command;
}

function findOptionalHook(
  hooks: RegisteredHook[],
  name: string,
): RegisteredHook | undefined {
  return hooks.find((candidate) => candidate.name === name);
}

function findTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected tool ${name} to be registered.`);
  }

  return tool;
}

function indentBlock(value: string, prefix: string): string {
  if (value.trim().length === 0) {
    return "";
  }

  return value
    .trim()
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function readOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readOptionalStructuredRecord<T>(
  value: unknown,
): T | undefined {
  return isRecord(value) ? (value as T) : undefined;
}

function readOptionalRecordArray(
  value: unknown,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => ({ ...entry }));
}

function readOptionalStructuredRecordArray<T>(
  value: unknown,
): T[] | undefined {
  const records = readOptionalRecordArray(value);
  return records ? (records as T[]) : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readOptionalStringKeyedRecordArrayMap(
  value: unknown,
): Record<string, Array<Record<string, unknown>>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const mapped: Record<string, Array<Record<string, unknown>>> = {};
  for (const [key, entry] of Object.entries(value)) {
    const records = readOptionalRecordArray(entry);
    if (records) {
      mapped[key] = records;
    }
  }

  return mapped;
}

function readOptionalStringKeyedStructuredRecordArrayMap<T>(
  value: unknown,
): Record<string, T[]> | undefined {
  const mapped = readOptionalStringKeyedRecordArrayMap(value);
  return mapped ? (mapped as Record<string, T[]>) : undefined;
}

function readRequiredNumber(
  root: Record<string, unknown>,
  key: string,
  filePath: string,
): number {
  const value = root[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${filePath} must define numeric ${key}.`);
  }

  return value;
}

function readRequiredString(
  root: Record<string, unknown>,
  key: string,
  filePath: string,
): string {
  const value = readOptionalString(root[key]);
  if (!value) {
    throw new Error(`${filePath} must define string ${key}.`);
  }

  return value;
}

function readRequiredStringArray(
  root: Record<string, unknown>,
  key: string,
  filePath: string,
): string[] {
  const value = root[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${filePath} must define a non-empty ${key} array.`);
  }

  const strings = value
    .map((entry) => readOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (strings.length !== value.length) {
    throw new Error(`${filePath} must define ${key} as strings only.`);
  }

  return strings;
}

function readResultDetails(result: unknown): unknown {
  if (isRecord(result) && "details" in result) {
    return result.details;
  }

  return undefined;
}

function readResultText(result: unknown): string {
  if (isRecord(result)) {
    const content = result.content;
    if (Array.isArray(content)) {
      const textParts = content
        .map((entry) =>
          isRecord(entry) && typeof entry.text === "string" ? entry.text.trim() : undefined,
        )
        .filter((entry): entry is string => Boolean(entry));
      if (textParts.length > 0) {
        return textParts.join("\n");
      }
    }

    if (typeof result.text === "string") {
      return result.text.trim();
    }
    if (typeof result.message === "string") {
      return result.message.trim();
    }
  }

  return stringifyUnknown(result);
}

function buildToolStepOutputText(result: unknown): string {
  const outputText = readResultText(result);
  const details = readResultDetails(result);
  const replyExpectation =
    isRecord(details) && typeof details.replyExpectation === "string"
      ? details.replyExpectation.trim()
      : "";

  if (replyExpectation.length === 0 || outputText.includes(replyExpectation)) {
    return outputText;
  }

  return [outputText, replyExpectation].filter(Boolean).join("\n");
}

function expectRecord(
  value: unknown,
  filePath: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  return value;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
