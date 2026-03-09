import type {
  AnyAgentTool,
  OpenClawPluginApi
} from "openclaw/plugin-sdk/core";

import type { MahiloContractClient } from "./client";
import {
  registerMahiloDiagnosticsCommands,
  type MahiloDiagnosticsCommandOptions
} from "./commands";
import {
  createMahiloClientFromConfig,
  parseMahiloPluginConfig,
  type MahiloPluginConfig,
  type ReviewMode
} from "./config";
import type { DeclaredSelectors } from "./policy-helpers";
import { fetchMahiloPromptContext } from "./prompt-context";
import { InMemoryPluginState } from "./state";
import { MAHILO_RUNTIME_PLUGIN_ID, MAHILO_RUNTIME_PLUGIN_NAME } from "./identity";
import {
  listMahiloContacts,
  talkToAgent,
  talkToGroup,
  type ContactsProvider,
  type MahiloSendToolInput,
  type MahiloToolContext,
  type TalkToGroupInput
} from "./tools";
import { registerMahiloWebhookRoute, type MahiloWebhookRouteOptions } from "./webhook-route";

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

const MAHILO_PROMPT_CONTEXT_MARKER = "[MahiloContext/v1]";
const MAX_PROMPT_CONTEXT_INJECTION_LENGTH = 1200;

export function createMahiloOpenClawPlugin(
  options: MahiloOpenClawPluginOptions = {}
): MahiloOpenClawPluginDefinition {
  return {
    description: "Mahilo policy-aware communication tools for OpenClaw.",
    id: MAHILO_RUNTIME_PLUGIN_ID,
    name: MAHILO_RUNTIME_PLUGIN_NAME,
    register: (api: OpenClawPluginApi) => {
      registerMahiloOpenClawPlugin(api, options);
    }
  };
}

export function registerMahiloOpenClawPlugin(
  api: OpenClawPluginApi,
  options: MahiloOpenClawPluginOptions = {}
): void {
  const config = parseMahiloPluginConfig(api.pluginConfig ?? {}, {
    defaults: {
      pluginVersion: readOptionalString(api.version) ?? "0.0.0"
    }
  });

  const createClient = options.createClient ?? createMahiloClientFromConfig;
  const client = createClient(config);
  const pluginState =
    options.pluginState ??
    new InMemoryPluginState({
      contextCacheTtlSeconds: config.cacheTtlSeconds,
      dedupeTtlMs: options.webhookRoute?.dedupeTtlMs
    });
  const webhookRouteOptions: MahiloWebhookRouteOptions = {
    ...options.webhookRoute,
    dedupeState: options.webhookRoute?.dedupeState ?? pluginState.dedupe
  };
  const diagnosticsCommandOptions: MahiloDiagnosticsCommandOptions = {
    ...options.diagnosticsCommands,
    logger: options.diagnosticsCommands?.logger ?? api.logger,
    pluginState
  };

  api.registerTool(createTalkToAgentTool(client, config));
  api.registerTool(createTalkToGroupTool(client, config));
  api.registerTool(createListMahiloContactsTool(options.contactsProvider));
  registerPromptContextHook(api, client, config, pluginState);
  registerMahiloWebhookRoute(api, config, webhookRouteOptions);
  registerMahiloDiagnosticsCommands(api, config, client, diagnosticsCommandOptions);
}

const defaultMahiloOpenClawPlugin = createMahiloOpenClawPlugin();
export default defaultMahiloOpenClawPlugin;

function createTalkToAgentTool(client: MahiloContractClient, config: MahiloPluginConfig): AnyAgentTool {
  return {
    description: "Send a policy-aware message to a Mahilo user.",
    execute: async (_toolCallId: string, rawInput: unknown) => {
      const input = parseSendToolInput(rawInput, { allowGroupAliases: false });
      const context = parseToolContext(rawInput, config);
      const result = await talkToAgent(client, input, context);
      return toAgentToolResult(result, `Mahilo send status: ${result.status}`);
    },
    label: "Talk To Agent",
    name: "talk_to_agent",
    parameters: {
      additionalProperties: false,
      properties: {
        agentSessionId: { type: "string" },
        context: { type: "string" },
        correlationId: { type: "string" },
        declaredSelectors: {
          additionalProperties: false,
          properties: {
            action: { type: "string" },
            direction: { type: "string" },
            resource: { type: "string" }
          },
          type: "object"
        },
        idempotencyKey: { type: "string" },
        message: { type: "string" },
        payloadType: { type: "string" },
        recipient: { type: "string" },
        recipientConnectionId: { type: "string" },
        reviewMode: {
          enum: ["auto", "ask", "manual"],
          type: "string"
        },
        routingHints: { type: "object" },
        senderConnectionId: { type: "string" },
        sender_connection_id: { type: "string" }
      },
      required: ["recipient", "message", "senderConnectionId"],
      type: "object"
    }
  } as unknown as AnyAgentTool;
}

function createTalkToGroupTool(client: MahiloContractClient, config: MahiloPluginConfig): AnyAgentTool {
  return {
    description: "Send a policy-aware message to a Mahilo group.",
    execute: async (_toolCallId: string, rawInput: unknown) => {
      const input = parseSendToolInput(rawInput, { allowGroupAliases: true });
      const context = parseToolContext(rawInput, config);
      const result = await talkToGroup(client, input as TalkToGroupInput, context);
      return toAgentToolResult(result, `Mahilo group send status: ${result.status}`);
    },
    label: "Talk To Group",
    name: "talk_to_group",
    parameters: {
      additionalProperties: false,
      properties: {
        agentSessionId: { type: "string" },
        context: { type: "string" },
        correlationId: { type: "string" },
        declaredSelectors: {
          additionalProperties: false,
          properties: {
            action: { type: "string" },
            direction: { type: "string" },
            resource: { type: "string" }
          },
          type: "object"
        },
        groupId: { type: "string" },
        group_id: { type: "string" },
        idempotencyKey: { type: "string" },
        message: { type: "string" },
        payloadType: { type: "string" },
        recipient: { type: "string" },
        recipientConnectionId: { type: "string" },
        reviewMode: {
          enum: ["auto", "ask", "manual"],
          type: "string"
        },
        routingHints: { type: "object" },
        senderConnectionId: { type: "string" },
        sender_connection_id: { type: "string" }
      },
      required: ["message", "senderConnectionId"],
      type: "object"
    }
  } as unknown as AnyAgentTool;
}

function createListMahiloContactsTool(contactsProvider?: ContactsProvider): AnyAgentTool {
  return {
    description: "List known Mahilo contacts.",
    execute: async () => {
      const contacts = await listMahiloContacts(contactsProvider);
      return toAgentToolResult(contacts, `Mahilo contacts returned: ${contacts.length}`);
    },
    label: "List Mahilo Contacts",
    name: "list_mahilo_contacts",
    parameters: {
      additionalProperties: false,
      type: "object"
    }
  } as unknown as AnyAgentTool;
}

function parseSendToolInput(
  rawInput: unknown,
  options: { allowGroupAliases: boolean }
): MahiloSendToolInput {
  const input = readInputObject(rawInput);

  const recipient =
    readOptionalString(input.recipient) ??
    (options.allowGroupAliases
      ? readOptionalString(input.groupId) ?? readOptionalString(input.group_id)
      : undefined);

  if (!recipient) {
    throw new Error("recipient is required");
  }

  const message = readOptionalString(input.message);
  if (!message) {
    throw new Error("message is required");
  }

  return {
    context: readOptionalString(input.context),
    correlationId:
      readOptionalString(input.correlationId) ??
      readOptionalString(input.correlation_id),
    declaredSelectors: parseDeclaredSelectors(input.declaredSelectors),
    idempotencyKey:
      readOptionalString(input.idempotencyKey) ??
      readOptionalString(input.idempotency_key),
    message,
    payloadType: readOptionalString(input.payloadType) ?? readOptionalString(input.payload_type),
    recipient,
    recipientConnectionId:
      readOptionalString(input.recipientConnectionId) ??
      readOptionalString(input.recipient_connection_id),
    routingHints: readOptionalObject(input.routingHints) ?? readOptionalObject(input.routing_hints)
  };
}

function parseToolContext(rawInput: unknown, config: MahiloPluginConfig): MahiloToolContext {
  const input = readInputObject(rawInput);
  const senderConnectionId =
    readOptionalString(input.senderConnectionId) ??
    readOptionalString(input.sender_connection_id);

  if (!senderConnectionId) {
    throw new Error(
      "senderConnectionId is required (pass senderConnectionId or sender_connection_id)"
    );
  }

  return {
    agentSessionId:
      readOptionalString(input.agentSessionId) ??
      readOptionalString(input.agent_session_id),
    reviewMode: parseReviewMode(input.reviewMode ?? input.review_mode) ?? config.reviewMode,
    senderConnectionId
  };
}

function parseDeclaredSelectors(value: unknown): Partial<DeclaredSelectors> | undefined {
  const selectors = readOptionalObject(value);
  if (!selectors) {
    return undefined;
  }

  const parsed: Partial<DeclaredSelectors> = {};
  const action = readOptionalString(selectors.action);
  const direction = readOptionalString(selectors.direction);
  const resource = readOptionalString(selectors.resource);

  if (action) {
    parsed.action = action;
  }

  if (direction) {
    parsed.direction = direction as DeclaredSelectors["direction"];
  }

  if (resource) {
    parsed.resource = resource;
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseReviewMode(value: unknown): ReviewMode | undefined {
  const candidate = readOptionalString(value);
  if (!candidate) {
    return undefined;
  }

  if (candidate === "auto" || candidate === "ask" || candidate === "manual") {
    return candidate;
  }

  return undefined;
}

function readInputObject(rawInput: unknown): Record<string, unknown> {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    throw new Error("tool input must be an object");
  }

  return rawInput as Record<string, unknown>;
}

function readOptionalObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function toAgentToolResult<T>(details: T, text: string): { content: Array<{ text: string; type: "text" }>; details: T } {
  return {
    content: [{ text, type: "text" }],
    details
  };
}

function registerPromptContextHook(
  api: OpenClawPluginApi,
  client: MahiloContractClient,
  config: MahiloPluginConfig,
  pluginState: InMemoryPluginState
): void {
  if (!config.promptContextEnabled) {
    return;
  }

  api.registerHook("before_prompt_build", async (rawHookInput: unknown) => {
    try {
      return await injectMahiloContextIntoPrompt(rawHookInput, client, pluginState);
    } catch (error) {
      api.logger?.warn?.(
        `[Mahilo] before_prompt_build hook failed: ${toErrorMessage(error)}`
      );
      return rawHookInput;
    }
  });
}

async function injectMahiloContextIntoPrompt(
  rawHookInput: unknown,
  client: MahiloContractClient,
  pluginState: InMemoryPluginState
): Promise<unknown> {
  const hookInput = readOptionalObject(rawHookInput);
  if (!hookInput) {
    return rawHookInput;
  }

  const promptContextInput = parsePromptContextInput(hookInput);
  if (!promptContextInput) {
    return rawHookInput;
  }

  const result = await fetchMahiloPromptContext(client, promptContextInput, {
    cache: pluginState
  });

  if (!result.ok || result.injection.length === 0) {
    return rawHookInput;
  }

  const boundedInjection = boundPromptInjection(result.injection);
  if (boundedInjection.length === 0) {
    return rawHookInput;
  }

  return injectPromptPayload(hookInput, boundedInjection);
}

function parsePromptContextInput(hookInput: Record<string, unknown>): {
  declaredSelectors?: Partial<DeclaredSelectors>;
  recipient: string;
  recipientType: "group" | "user";
  senderConnectionId: string;
} | undefined {
  const sources = collectPromptContextSources(hookInput);
  const declaredSelectors = parseHookSelectors(sources);
  const direction = readHookDirection(sources, declaredSelectors);
  const senderConnectionId =
    readFirstString(
      sources,
      "senderConnectionId",
      "sender_connection_id",
      "recipientConnectionId",
      "recipient_connection_id"
    ) ?? "";

  if (senderConnectionId.length === 0) {
    return undefined;
  }

  const explicitRecipientType = readFirstString(
    sources,
    "recipientType",
    "recipient_type"
  );
  const groupId = readFirstString(sources, "groupId", "group_id");
  const recipientType = normalizeRecipientType(explicitRecipientType, groupId);
  const recipient = resolvePromptRecipient(sources, direction, recipientType, groupId);

  if (!recipient) {
    return undefined;
  }

  return {
    declaredSelectors,
    recipient,
    recipientType,
    senderConnectionId
  };
}

function collectPromptContextSources(
  hookInput: Record<string, unknown>
): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [hookInput];
  const addSource = (value: unknown) => {
    const source = readOptionalObject(value);
    if (source) {
      sources.push(source);
    }
  };

  addSource(hookInput.message);
  addSource(hookInput.incomingMessage);
  addSource(hookInput.incoming_message);
  addSource(hookInput.payload);
  addSource(hookInput.event);

  const event = readOptionalObject(hookInput.event);
  addSource(event?.payload);
  addSource(hookInput.context);

  return sources;
}

function parseHookSelectors(
  sources: Record<string, unknown>[]
): Partial<DeclaredSelectors> | undefined {
  const candidates = [
    readFirstObject(sources, "declaredSelectors", "declared_selectors"),
    readFirstObject(sources, "draftSelectors", "draft_selectors"),
    readFirstObject(sources, "selectors")
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const parsed: Partial<DeclaredSelectors> = {};
    const action = readOptionalString(candidate.action);
    const direction = readOptionalString(candidate.direction);
    const resource = readOptionalString(candidate.resource);

    if (action) {
      parsed.action = action;
    }

    if (direction === "inbound" || direction === "outbound") {
      parsed.direction = direction;
    }

    if (resource) {
      parsed.resource = resource;
    }

    if (Object.keys(parsed).length > 0) {
      return parsed;
    }
  }

  return undefined;
}

function readHookDirection(
  sources: Record<string, unknown>[],
  declaredSelectors: Partial<DeclaredSelectors> | undefined
): "inbound" | "outbound" | undefined {
  if (declaredSelectors?.direction === "inbound" || declaredSelectors?.direction === "outbound") {
    return declaredSelectors.direction;
  }

  const direction = readFirstString(sources, "direction");
  return direction === "inbound" || direction === "outbound" ? direction : undefined;
}

function normalizeRecipientType(
  explicitType: string | undefined,
  groupId: string | undefined
): "group" | "user" {
  if (explicitType === "group") {
    return "group";
  }

  if (explicitType === "user") {
    return "user";
  }

  return groupId ? "group" : "user";
}

function resolvePromptRecipient(
  sources: Record<string, unknown>[],
  direction: "inbound" | "outbound" | undefined,
  recipientType: "group" | "user",
  groupId: string | undefined
): string | undefined {
  if (recipientType === "group") {
    return groupId ?? readFirstString(sources, "recipient", "target");
  }

  const sender = readFirstString(
    sources,
    "sender",
    "sender_user_id",
    "senderUserId",
    "from"
  );
  const recipient = readFirstString(sources, "recipient", "to", "target");

  if (direction === "inbound") {
    return sender ?? recipient;
  }

  return recipient ?? sender;
}

function injectPromptPayload(
  hookInput: Record<string, unknown>,
  injection: string
): Record<string, unknown> {
  const promptString = readOptionalString(hookInput.prompt);
  if (typeof hookInput.prompt === "string") {
    if (promptString?.includes(MAHILO_PROMPT_CONTEXT_MARKER)) {
      return hookInput;
    }

    return {
      ...hookInput,
      prompt: prependContextBlock(promptString ?? "", injection)
    };
  }

  const messages = readOptionalArray(hookInput.messages);
  if (messages) {
    const injected = prependPromptMessages(messages, injection);
    if (injected !== messages) {
      return {
        ...hookInput,
        messages: injected
      };
    }
  }

  const promptMessages = readOptionalArray(hookInput.promptMessages);
  if (promptMessages) {
    const injected = prependPromptMessages(promptMessages, injection);
    if (injected !== promptMessages) {
      return {
        ...hookInput,
        promptMessages: injected
      };
    }
  }

  const promptObject = readOptionalObject(hookInput.prompt);
  if (promptObject) {
    const promptObjectMessages = readOptionalArray(promptObject.messages);
    if (promptObjectMessages) {
      const injected = prependPromptMessages(promptObjectMessages, injection);
      if (injected !== promptObjectMessages) {
        return {
          ...hookInput,
          prompt: {
            ...promptObject,
            messages: injected
          }
        };
      }
    }
  }

  return hookInput;
}

function prependPromptMessages(messages: unknown[], injection: string): unknown[] {
  for (const message of messages.slice(0, 3)) {
    if (messageContainsMahiloContext(message)) {
      return messages;
    }
  }

  return [
    {
      content: injection,
      role: "system"
    },
    ...messages
  ];
}

function messageContainsMahiloContext(message: unknown): boolean {
  const asObject = readOptionalObject(message);
  if (!asObject) {
    return false;
  }

  const candidates = [
    readOptionalString(asObject.content),
    readOptionalString(asObject.text),
    readOptionalString(asObject.prompt)
  ];

  return candidates.some((entry) => entry?.includes(MAHILO_PROMPT_CONTEXT_MARKER) === true);
}

function prependContextBlock(prompt: string, injection: string): string {
  if (prompt.length === 0) {
    return injection;
  }

  return `${injection}\n\n${prompt}`;
}

function boundPromptInjection(injection: string): string {
  const normalized = injection.trim();
  if (normalized.length <= MAX_PROMPT_CONTEXT_INJECTION_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_PROMPT_CONTEXT_INJECTION_LENGTH - 3).trimEnd()}...`;
}

function readFirstObject(
  sources: Record<string, unknown>[],
  ...keys: string[]
): Record<string, unknown> | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = readOptionalObject(source[key]);
      if (value) {
        return value;
      }
    }
  }

  return undefined;
}

function readFirstString(
  sources: Record<string, unknown>[],
  ...keys: string[]
): string | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = readOptionalString(source[key]);
      if (value) {
        return value;
      }
    }
  }

  return undefined;
}

function readOptionalArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "unknown error";
}
