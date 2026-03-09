import type {
  AnyAgentTool,
  OpenClawPluginApi
} from "openclaw/plugin-sdk/core";

import { MahiloRequestError, type MahiloContractClient } from "./client";
import {
  executeMahiloNetworkAction,
  normalizeMahiloNetworkAction,
  type ExecuteMahiloNetworkActionInput,
  type MahiloNetworkActionResult
} from "./network";
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
import { MAHILO_PLUGIN_RELEASE_VERSION } from "./release";
import {
  attachMahiloSenderResolutionCache,
  resolveMahiloSenderConnection
} from "./sender-resolution";
import { InMemoryPluginState } from "./state";
import { MAHILO_RUNTIME_PLUGIN_ID, MAHILO_RUNTIME_PLUGIN_NAME } from "./identity";
import {
  createMahiloBoundaryChange,
  getMahiloContext,
  previewMahiloSend,
  talkToAgent,
  talkToGroup,
  type MahiloBoundaryChangeInput,
  type MahiloBoundaryChangeResult,
  type ContactsProvider,
  type GetMahiloContextInput,
  type MahiloContextToolResult,
  type MahiloPreviewResult,
  type MahiloSendToolInput,
  type MahiloToolResult,
  type MahiloToolContext,
  type PreviewMahiloSendInput,
  type TalkToGroupInput
} from "./tools-default-sender";
import type { MahiloInboundWebhookPayload } from "./webhook";
import { registerMahiloWebhookRoute, type MahiloWebhookRouteOptions } from "./webhook-route";
import {
  extractMahiloPostSendEvent,
  formatMahiloLearningSuggestion,
  formatMahiloOutcomeSystemEvent,
  shouldQueueMahiloLearningSuggestion
} from "./post-send-hooks";

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
const MAHILO_INBOUND_EVENT_MARKER = "[MahiloInbound/v1]";
const MAX_PROMPT_CONTEXT_INJECTION_LENGTH = 1200;
const MAHILO_BOUNDARIES_TOOL_NAME = "mahilo_boundaries";
const MAHILO_MESSAGE_TOOL_NAME = "mahilo_message";
const MAHILO_NETWORK_TOOL_NAME = "mahilo_network";

type MahiloBoundaryToolAction = "exception" | "set";
type MahiloMessageToolAction = "context" | "preview" | "send";
type MahiloBoundaryToolDetails = MahiloBoundaryChangeResult;
type MahiloMessageToolDetails =
  | MahiloContextToolResult
  | MahiloPreviewResult
  | MahiloToolResult;
type MahiloNetworkToolDetails = MahiloNetworkActionResult;

interface MahiloToolFailure {
  code?: string;
  error: string;
  errorType: "input" | "network" | "server" | "unknown";
  productState?: string;
  retryable: boolean;
  status: "error";
  tool: string;
}

class MahiloToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MahiloToolInputError";
  }
}

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
      pluginVersion: readOptionalString(api.version) ?? MAHILO_PLUGIN_RELEASE_VERSION
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
  const externalAcceptedDelivery = options.webhookRoute?.onAcceptedDelivery;
  const webhookRouteOptions: MahiloWebhookRouteOptions = {
    ...options.webhookRoute,
    dedupeState: options.webhookRoute?.dedupeState ?? pluginState.dedupe,
    onAcceptedDelivery: async (params) => {
      routeAcceptedMahiloDelivery(api, pluginState, params.payload, params.messageId);
      await externalAcceptedDelivery?.(params);
    }
  };
  const diagnosticsCommandOptions: MahiloDiagnosticsCommandOptions = {
    ...options.diagnosticsCommands,
    logger: options.diagnosticsCommands?.logger ?? api.logger,
    pluginState
  };

  api.registerTool(createMahiloMessageTool(client, config, pluginState));
  api.registerTool(createMahiloNetworkTool(client, config));
  api.registerTool(createMahiloBoundariesTool(client));
  registerPromptContextHook(api, client, config, pluginState);
  attachMahiloSenderResolutionCache(client, pluginState);
  registerMahiloPostSendHooks(api, pluginState);
  registerMahiloWebhookRoute(api, config, webhookRouteOptions);
  registerMahiloDiagnosticsCommands(api, config, client, diagnosticsCommandOptions);
}

const defaultMahiloOpenClawPlugin = createMahiloOpenClawPlugin();
export default defaultMahiloOpenClawPlugin;

function createMahiloMessageTool(
  client: MahiloContractClient,
  config: MahiloPluginConfig,
  pluginState: InMemoryPluginState
): AnyAgentTool {
  return {
    description:
      "Mahilo message routing: fetch compact context, preview policy, or send a message to a user or group without switching tools.",
    execute: async (_toolCallId: string, rawInput: unknown) =>
      executeMahiloTool<MahiloMessageToolDetails>(MAHILO_MESSAGE_TOOL_NAME, async () => {
        const action = parseMahiloMessageAction(rawInput);

        if (action === "context") {
          const input = parseGetMahiloContextInput(rawInput);
          const result = await getMahiloContext(client, input, {
            cache: pluginState
          });
          const text = result.ok
            ? `Mahilo context ready from ${result.source}.`
            : `Mahilo context unavailable: ${result.error ?? "request failed"}`;

          return toAgentToolResult(result, text);
        }

        if (action === "preview") {
          const input = parsePreviewMahiloSendInput(rawInput);
          const context = parseToolContext(rawInput, config);
          const result = await previewMahiloSend(client, input, context);
          return toAgentToolResult(result, formatPreviewToolText(result));
        }

        const { input, recipientType } = parseMahiloMessageSendInput(rawInput);
        const context = parseToolContext(rawInput, config);
        const result =
          recipientType === "group"
            ? await talkToGroup(client, input as TalkToGroupInput, context)
            : await talkToAgent(client, input, context);

        return toAgentToolResult(
          result,
          recipientType === "group"
            ? `Mahilo group send status: ${result.status}`
            : `Mahilo send status: ${result.status}`
        );
      }),
    label: "Mahilo Message",
    name: MAHILO_MESSAGE_TOOL_NAME,
    parameters: {
      additionalProperties: false,
      properties: {
        action: {
          description: "Defaults to send. Use context for prompt guidance or preview for preflight resolution.",
          enum: ["context", "preview", "send"],
          type: "string"
        },
        agentSessionId: { type: "string" },
        context: { type: "string" },
        correlationId: { type: "string" },
        declaredSelectors: createSelectorSchema(),
        draftSelectors: createSelectorSchema(),
        draft_selectors: createSelectorSchema(),
        groupId: { type: "string" },
        group_id: { type: "string" },
        idempotencyKey: { type: "string" },
        includeRecentInteractions: { type: "boolean" },
        include_recent_interactions: { type: "boolean" },
        interactionLimit: { type: "integer" },
        interaction_limit: { type: "integer" },
        message: { type: "string" },
        payloadType: { type: "string" },
        recipient: { type: "string" },
        recipientConnectionId: { type: "string" },
        recipientType: {
          enum: ["group", "user"],
          type: "string"
        },
        recipient_type: {
          enum: ["group", "user"],
          type: "string"
        },
        reviewMode: {
          enum: ["auto", "ask", "manual"],
          type: "string"
        },
        routingHints: { type: "object" },
        senderConnectionId: { type: "string" },
        sender_connection_id: { type: "string" }
      },
      type: "object"
    }
  } as unknown as AnyAgentTool;
}

function createMahiloNetworkTool(
  client: MahiloContractClient,
  config: MahiloPluginConfig
): AnyAgentTool {
  return {
    description:
      "Mahilo network management: list contacts and pending requests, send or respond to friend requests, or ask around across contacts, roles, or a group without leaving the same tool.",
    execute: async (_toolCallId: string, rawInput: unknown) =>
      executeMahiloTool<MahiloNetworkToolDetails>(MAHILO_NETWORK_TOOL_NAME, async () => {
        const input = parseMahiloNetworkInput(rawInput);
        const result = await executeMahiloNetworkAction(client, input, parseToolContext(rawInput, config));
        return toAgentToolResult(result, result.summary);
      }),
    label: "Mahilo Network",
    name: MAHILO_NETWORK_TOOL_NAME,
    parameters: {
      additionalProperties: false,
      properties: {
        action: {
          enum: ["list", "send_request", "accept", "decline", "ask_around"],
          type: "string"
        },
        correlationId: { type: "string" },
        correlation_id: { type: "string" },
        declaredSelectors: createSelectorSchema(),
        declared_selectors: createSelectorSchema(),
        friendshipId: { type: "string" },
        friendship_id: { type: "string" },
        group: { type: "string" },
        groupId: { type: "string" },
        group_id: { type: "string" },
        groupName: { type: "string" },
        group_name: { type: "string" },
        idempotencyKey: { type: "string" },
        idempotency_key: { type: "string" },
        message: { type: "string" },
        question: { type: "string" },
        recipient: { type: "string" },
        reviewMode: {
          enum: ["auto", "ask", "manual"],
          type: "string"
        },
        review_mode: {
          enum: ["auto", "ask", "manual"],
          type: "string"
        },
        role: { type: "string" },
        roles: {
          items: { type: "string" },
          type: "array"
        },
        senderConnectionId: { type: "string" },
        sender_connection_id: { type: "string" },
        username: { type: "string" }
      },
      type: "object"
    }
  } as unknown as AnyAgentTool;
}

function createMahiloBoundariesTool(client: MahiloContractClient): AnyAgentTool {
  return {
    description:
      "Mahilo boundary management: change sharing boundaries conversationally for opinions, availability, location, and sensitive personal details while Mahilo writes canonical boundary rules under the hood.",
    execute: async (_toolCallId: string, rawInput: unknown) =>
      executeMahiloTool<MahiloBoundaryToolDetails>(MAHILO_BOUNDARIES_TOOL_NAME, async () => {
        const input = parseMahiloBoundariesInput(rawInput);
        const result = await createMahiloBoundaryChange(client, input);
        return toAgentToolResult(result, result.summary);
      }),
    label: "Mahilo Boundaries",
    name: MAHILO_BOUNDARIES_TOOL_NAME,
    parameters: {
      additionalProperties: false,
      properties: {
        action: {
          description: "Use set for ongoing boundaries and exception for one-off or temporary changes.",
          enum: ["set", "exception", "override"],
          type: "string"
        },
        audience: {
          description: "Defaults to everyone unless a specific recipient or target is provided.",
          enum: ["everyone", "contact", "group", "role"],
          type: "string"
        },
        boundary: {
          description: "Conversational boundary setting: allow, ask, or deny.",
          enum: ["allow", "ask", "deny"],
          type: "string"
        },
        category: {
          description:
            "Common boundary categories. private_details covers health, financial, and contact details together.",
          enum: [
            "opinions",
            "availability",
            "location",
            "health",
            "financial",
            "contact",
            "private_details"
          ],
          type: "string"
        },
        declaredSelectors: createSelectorSchema(),
        derivedFromMessageId: { type: "string" },
        derived_from_message_id: { type: "string" },
        durationHours: { type: "integer" },
        durationMinutes: { type: "integer" },
        duration_hours: { type: "integer" },
        duration_minutes: { type: "integer" },
        effect: { type: "string" },
        expiresAt: { type: "string" },
        expires_at: { type: "string" },
        idempotencyKey: { type: "string" },
        kind: { type: "string" },
        lifetime: {
          description: "Conversational lifetime: once, temporary, or always.",
          enum: ["once", "temporary", "always"],
          type: "string"
        },
        maxUses: { type: "integer" },
        max_uses: { type: "integer" },
        priority: { type: "integer" },
        recipient: { type: "string" },
        recipientType: {
          enum: ["group", "user"],
          type: "string"
        },
        recipient_type: {
          enum: ["group", "user"],
          type: "string"
        },
        reason: { type: "string" },
        scope: { type: "string" },
        selectors: createSelectorSchema(),
        senderConnectionId: { type: "string" },
        sender_connection_id: { type: "string" },
        sourceResolutionId: { type: "string" },
        source_resolution_id: { type: "string" },
        targetId: { type: "string" },
        target_id: { type: "string" },
        ttlSeconds: { type: "integer" },
        ttl_seconds: { type: "integer" }
      },
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
    throw new MahiloToolInputError("recipient is required");
  }

  const message = readOptionalString(input.message);
  if (!message) {
    throw new MahiloToolInputError("message is required");
  }

  return {
    context: readOptionalString(input.context),
    correlationId:
      readOptionalString(input.correlationId) ??
      readOptionalString(input.correlation_id),
    declaredSelectors:
      parseDeclaredSelectors(input.declaredSelectors ?? input.declared_selectors),
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

function parseMahiloMessageAction(rawInput: unknown): MahiloMessageToolAction {
  const input = rawInput === undefined ? {} : readInputObject(rawInput);
  const action = normalizeMahiloMessageAction(readOptionalString(input.action));

  if (action) {
    return action;
  }

  if (input.action !== undefined) {
    throw new MahiloToolInputError("action must be context, preview, or send");
  }

  return "send";
}

function parseMahiloMessageSendInput(
  rawInput: unknown
): { input: MahiloSendToolInput; recipientType: "group" | "user" } {
  const input = readInputObject(rawInput);

  return {
    input: parseSendToolInput(rawInput, { allowGroupAliases: true }),
    recipientType: readMahiloMessageRecipientType(input)
  };
}

function parseToolContext(rawInput: unknown, config: MahiloPluginConfig): MahiloToolContext {
  const input = readInputObject(rawInput);
  const senderConnectionId =
    readOptionalString(input.senderConnectionId) ??
    readOptionalString(input.sender_connection_id);

  return {
    agentSessionId:
      readOptionalString(input.agentSessionId) ??
      readOptionalString(input.agent_session_id),
    reviewMode: parseReviewMode(input.reviewMode ?? input.review_mode) ?? config.reviewMode,
    senderConnectionId
  };
}

function parseGetMahiloContextInput(rawInput: unknown): GetMahiloContextInput {
  const input = readInputObject(rawInput);
  const senderConnectionId =
    readOptionalString(input.senderConnectionId) ??
    readOptionalString(input.sender_connection_id);
  const recipientType = readMahiloMessageRecipientType(input);
  const recipient =
    readOptionalString(input.recipient) ??
    (recipientType === "group"
      ? readOptionalString(input.groupId) ?? readOptionalString(input.group_id)
      : undefined);

  if (!recipient) {
    throw new MahiloToolInputError("recipient is required");
  }

  return {
    declaredSelectors:
      parseDeclaredSelectors(
        input.draftSelectors ??
          input.draft_selectors ??
          input.declaredSelectors ??
          input.declared_selectors
      ),
    includeRecentInteractions:
      readOptionalBoolean(input.includeRecentInteractions) ??
      readOptionalBoolean(input.include_recent_interactions),
    interactionLimit:
      readOptionalInteger(input.interactionLimit) ??
      readOptionalInteger(input.interaction_limit),
    recipient,
    recipientType,
    senderConnectionId
  };
}

function parsePreviewMahiloSendInput(rawInput: unknown): PreviewMahiloSendInput {
  const input = readInputObject(rawInput);
  const parsedInput = parseSendToolInput(rawInput, { allowGroupAliases: true });

  return {
    ...parsedInput,
    recipientType: readMahiloMessageRecipientType(input)
  };
}

function parseMahiloBoundariesInput(rawInput: unknown): MahiloBoundaryChangeInput {
  const input = readInputObject(rawInput);
  const action = normalizeMahiloBoundaryAction(readOptionalString(input.action));

  if (input.action !== undefined && !action) {
    throw new MahiloToolInputError("action must be set, exception, or override");
  }

  return {
    action,
    audience:
      readOptionalString(input.audience) ??
      readOptionalString(input.appliesTo) ??
      readOptionalString(input.applies_to),
    boundary:
      readOptionalString(input.boundary) ??
      readOptionalString(input.preference) ??
      readOptionalString(input.mode) ??
      readOptionalString(input.setting),
    category: readOptionalString(input.category) ?? readOptionalString(input.topic),
    durationHours:
      readPositiveInteger(input.durationHours) ??
      readPositiveInteger(input.duration_hours),
    durationMinutes:
      readPositiveInteger(input.durationMinutes) ??
      readPositiveInteger(input.duration_minutes),
    derivedFromMessageId:
      readOptionalString(input.derivedFromMessageId) ??
      readOptionalString(input.derived_from_message_id),
    effect: readOptionalString(input.effect) ?? "allow",
    expiresAt: readOptionalString(input.expiresAt) ?? readOptionalString(input.expires_at),
    idempotencyKey:
      readOptionalString(input.idempotencyKey) ??
      readOptionalString(input.idempotency_key),
    kind: readOptionalString(input.kind),
    lifetime: readOptionalString(input.lifetime),
    maxUses: readPositiveInteger(input.maxUses) ?? readPositiveInteger(input.max_uses),
    priority: readOptionalInteger(input.priority),
    recipient: readOptionalString(input.recipient),
    recipientType:
      readRecipientType(input.recipientType) ?? readRecipientType(input.recipient_type),
    reason: readOptionalString(input.reason),
    scope: readOptionalString(input.scope),
    selectors: parseDeclaredSelectors(
      input.selectors ?? input.declaredSelectors ?? input.declared_selectors
    ),
    senderConnectionId:
      readOptionalString(input.senderConnectionId) ??
      readOptionalString(input.sender_connection_id),
    sourceResolutionId:
      readOptionalString(input.sourceResolutionId) ??
      readOptionalString(input.source_resolution_id),
    targetId: readOptionalString(input.targetId) ?? readOptionalString(input.target_id),
    ttlSeconds: readPositiveInteger(input.ttlSeconds) ?? readPositiveInteger(input.ttl_seconds)
  };
}

function parseMahiloNetworkInput(
  rawInput: unknown
): ExecuteMahiloNetworkActionInput {
  const input = rawInput === undefined ? {} : readInputObject(rawInput);

  return {
    action: readOptionalString(input.action),
    correlationId:
      readOptionalString(input.correlationId) ??
      readOptionalString(input.correlation_id),
    declaredSelectors:
      parseDeclaredSelectors(input.declaredSelectors ?? input.declared_selectors),
    friendshipId:
      readOptionalString(input.friendshipId) ??
      readOptionalString(input.friendship_id),
    group: readOptionalString(input.group),
    groupId:
      readOptionalString(input.groupId) ??
      readOptionalString(input.group_id),
    groupName:
      readOptionalString(input.groupName) ??
      readOptionalString(input.group_name),
    idempotencyKey:
      readOptionalString(input.idempotencyKey) ??
      readOptionalString(input.idempotency_key),
    message: readOptionalString(input.message),
    question: readOptionalString(input.question),
    role: readOptionalString(input.role),
    roles: readStringArray(input.roles),
    username:
      readOptionalString(input.username) ??
      readOptionalString(input.recipient)
  };
}

function normalizeMahiloBoundaryAction(
  value: string | undefined
): MahiloBoundaryToolAction | undefined {
  const normalized = value?.toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "set":
    case "change":
    case "update":
      return "set";
    case "exception":
    case "grant_exception":
    case "create_override":
    case "override":
      return "exception";
    default:
      return undefined;
  }
}

function normalizeMahiloMessageAction(
  value: string | undefined
): MahiloMessageToolAction | undefined {
  const normalized = value?.toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "context":
    case "fetch_context":
    case "get_context":
      return "context";
    case "preview":
    case "preflight":
    case "resolve":
      return "preview";
    case "message":
    case "send":
      return "send";
    default:
      return undefined;
  }
}

function readMahiloMessageRecipientType(input: Record<string, unknown>): "group" | "user" {
  return (
    readRecipientType(input.recipientType) ??
    readRecipientType(input.recipient_type) ??
    (readOptionalString(input.groupId) ?? readOptionalString(input.group_id) ? "group" : "user")
  );
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
    throw new MahiloToolInputError("tool input must be an object");
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

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

function readOptionalInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.trunc(value);
}

function readPositiveInteger(value: unknown): number | undefined {
  const normalized = readOptionalInteger(value);
  if (typeof normalized !== "number" || normalized <= 0) {
    return undefined;
  }

  return normalized;
}

function readRecipientType(value: unknown): "group" | "user" | undefined {
  return value === "group" || value === "user" ? value : undefined;
}

async function executeMahiloTool<T>(
  toolName: string,
  execute: () => Promise<{ content: Array<{ text: string; type: "text" }>; details: T }>
): Promise<{ content: Array<{ text: string; type: "text" }>; details: MahiloToolFailure | T }> {
  try {
    return await execute();
  } catch (error) {
    const failure = toMahiloToolFailure(toolName, error);
    return toAgentToolResult(failure, `${toolName} failed: ${failure.error}`);
  }
}

function createSelectorSchema(): Record<string, unknown> {
  return {
    additionalProperties: false,
    properties: {
      action: { type: "string" },
      direction: { type: "string" },
      resource: { type: "string" }
    },
    type: "object"
  };
}

function toAgentToolResult<T>(details: T, text: string): { content: Array<{ text: string; type: "text" }>; details: T } {
  return {
    content: [{ text, type: "text" }],
    details
  };
}

function formatPreviewToolText(result: {
  agentGuidance?: string;
  decision: string;
  deliveryMode?: string;
  resolutionSummary?: string;
}): string {
  const summary = result.deliveryMode
    ? `Mahilo preview: ${result.decision} (${result.deliveryMode}).`
    : `Mahilo preview: ${result.decision}.`;
  const details = [result.resolutionSummary, result.agentGuidance]
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  return details.length > 0 ? `${summary} ${details.join(" ")}` : summary;
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

function registerMahiloPostSendHooks(
  api: OpenClawPluginApi,
  pluginState: InMemoryPluginState
): void {
  api.on("after_tool_call", async (event, ctx) => {
    try {
      const params = readOptionalObject(event.params) ?? {};
      rememberMahiloInboundRoute(pluginState, {
        params,
        result: event.result,
        toolName: event.toolName
      }, ctx);
      const postSendEvent = extractMahiloPostSendEvent({
        error: readOptionalString(event.error),
        params,
        result: event.result,
        toolName: readOptionalString(event.toolName) ?? ""
      });

      if (!postSendEvent) {
        return;
      }

      const sessionKey = readOptionalString(ctx.sessionKey);
      if (sessionKey) {
        api.runtime.system.enqueueSystemEvent(
          formatMahiloOutcomeSystemEvent(postSendEvent),
          {
            contextKey: buildMahiloOutcomeContextKey(
              postSendEvent,
              readOptionalString(ctx.runId),
              readOptionalString(ctx.toolCallId)
            ),
            sessionKey
          }
        );
      }

      if (
        postSendEvent.kind === "outcome" &&
        sessionKey &&
        shouldQueueMahiloLearningSuggestion(postSendEvent.observation) &&
        pluginState.markNovelDecision(postSendEvent.observation.fingerprint)
      ) {
        pluginState.queueLearningSuggestion(
          sessionKey,
          postSendEvent.observation
        );
      }
    } catch (error) {
      api.logger?.warn?.(
        `[Mahilo] after_tool_call hook failed: ${toErrorMessage(error)}`
      );
    }
  });

  api.on("agent_end", async (_event, ctx) => {
    try {
      const sessionKey = readOptionalString(ctx.sessionKey);
      if (!sessionKey) {
        return;
      }

      const suggestions = pluginState.consumeLearningSuggestions(sessionKey);
      if (suggestions.length === 0) {
        return;
      }

      for (const suggestion of suggestions) {
        api.runtime.system.enqueueSystemEvent(
          formatMahiloLearningSuggestion(suggestion),
          {
            contextKey: `mahilo:learning:${suggestion.fingerprint}`,
            sessionKey
          }
        );
      }

      api.runtime.system.requestHeartbeatNow({
        agentId: readOptionalString(ctx.agentId),
        reason: "mahilo:learning-suggestion",
        sessionKey
      });
    } catch (error) {
      api.logger?.warn?.(
        `[Mahilo] agent_end hook failed: ${toErrorMessage(error)}`
      );
    }
  });
}

function rememberMahiloInboundRoute(
  pluginState: InMemoryPluginState,
  event: {
    params: Record<string, unknown>;
    result?: unknown;
    toolName: unknown;
  },
  rawContext: unknown
): void {
  const context = readOptionalObject(rawContext) ?? {};
  const sessionKey = readOptionalString(context.sessionKey);
  if (!sessionKey) {
    return;
  }

  const toolName = readOptionalString(event.toolName);
  if (toolName === MAHILO_MESSAGE_TOOL_NAME) {
    rememberMahiloMessageInboundRoute(pluginState, event, {
      agentId: readOptionalString(context.agentId),
      sessionKey
    });
    return;
  }

  if (toolName === MAHILO_NETWORK_TOOL_NAME) {
    rememberMahiloAskAroundInboundRoutes(pluginState, event, {
      agentId: readOptionalString(context.agentId),
      sessionKey
    });
  }
}

function rememberMahiloMessageInboundRoute(
  pluginState: InMemoryPluginState,
  event: {
    params: Record<string, unknown>;
    result?: unknown;
    toolName: unknown;
  },
  context: {
    agentId?: string;
    sessionKey: string;
  }
): void {
  const action = normalizeMahiloMessageAction(readOptionalString(event.params.action));
  if ((event.params.action !== undefined && !action) || action === "context" || action === "preview") {
    return;
  }

  const resultDetails =
    readOptionalObject(readOptionalObject(event.result)?.details) ??
    readOptionalObject(event.result);
  if (!resultDetails) {
    return;
  }

  const status = readOptionalString(resultDetails.status);
  if (status === "denied" || status === "error") {
    return;
  }

  const outboundMessageId =
    readOptionalString(resultDetails.messageId) ??
    readOptionalString(resultDetails.message_id);
  if (!outboundMessageId) {
    return;
  }

  const recipientType = readMahiloMessageRecipientType(event.params);
  const groupId =
    recipientType === "group"
      ? readOptionalString(event.params.groupId) ??
        readOptionalString(event.params.group_id) ??
        readOptionalString(event.params.recipient)
      : undefined;
  const remoteParticipant =
    recipientType === "user" ? readOptionalString(event.params.recipient) : undefined;

  pluginState.rememberInboundRoute({
    agentId: context.agentId,
    correlationId:
      readOptionalString(event.params.correlationId) ??
      readOptionalString(event.params.correlation_id),
    groupId,
    localConnectionId:
      readOptionalString(event.params.senderConnectionId) ??
      readOptionalString(event.params.sender_connection_id),
    outboundMessageId,
    remoteConnectionId:
      readOptionalString(event.params.recipientConnectionId) ??
      readOptionalString(event.params.recipient_connection_id),
    remoteParticipant,
    sessionKey: context.sessionKey
  });
}

function rememberMahiloAskAroundInboundRoutes(
  pluginState: InMemoryPluginState,
  event: {
    params: Record<string, unknown>;
    result?: unknown;
    toolName: unknown;
  },
  context: {
    agentId?: string;
    sessionKey: string;
  }
): void {
  const action = normalizeMahiloNetworkAction(readOptionalString(event.params.action));
  if (action !== "ask_around") {
    return;
  }

  const resultDetails =
    readOptionalObject(readOptionalObject(event.result)?.details) ??
    readOptionalObject(event.result);
  if (!resultDetails || readOptionalString(resultDetails.status) === "error") {
    return;
  }

  const correlationId =
    readOptionalString(resultDetails.correlationId) ??
    readOptionalString(resultDetails.correlation_id) ??
    readOptionalString(event.params.correlationId) ??
    readOptionalString(event.params.correlation_id);
  const senderConnectionId =
    readOptionalString(resultDetails.senderConnectionId) ??
    readOptionalString(resultDetails.sender_connection_id) ??
    readOptionalString(event.params.senderConnectionId) ??
    readOptionalString(event.params.sender_connection_id);
  const deliveries = Array.isArray(resultDetails.deliveries) ? resultDetails.deliveries : [];
  const target = readOptionalObject(resultDetails.target);

  for (const rawDelivery of deliveries) {
    const delivery = readOptionalObject(rawDelivery);
    if (!delivery) {
      continue;
    }

    if (readOptionalString(delivery.status) !== "awaiting_reply") {
      continue;
    }

    const outboundMessageId =
      readOptionalString(delivery.messageId) ??
      readOptionalString(delivery.message_id);
    const recipient = readOptionalString(delivery.recipient);
    const recipientType =
      readRecipientType(delivery.recipientType) ??
      readRecipientType(delivery.recipient_type) ??
      (readOptionalString(target?.kind) === "group" ? "group" : "user");

    if (!outboundMessageId || !recipient) {
      continue;
    }

    const groupId =
      recipientType === "group"
        ? readOptionalString(target?.groupId) ??
          readOptionalString(target?.group_id) ??
          recipient
        : undefined;
    const remoteParticipant = recipientType === "user" ? recipient : undefined;

    pluginState.rememberInboundRoute({
      agentId: context.agentId,
      correlationId,
      groupId,
      localConnectionId: senderConnectionId,
      outboundMessageId,
      remoteParticipant,
      sessionKey: context.sessionKey
    });
  }
}

function routeAcceptedMahiloDelivery(
  api: OpenClawPluginApi,
  pluginState: InMemoryPluginState,
  payload: MahiloInboundWebhookPayload,
  messageId: string
): void {
  const route = pluginState.resolveInboundRoute({
    correlationId: payload.correlation_id,
    groupId: payload.group_id ?? undefined,
    inResponseToMessageId: payload.in_response_to,
    localConnectionId: payload.recipient_connection_id,
    remoteConnectionId: payload.sender_connection_id,
    remoteParticipant: payload.sender
  });

  if (!route) {
    api.logger?.warn?.(
      `[Mahilo] Unable to route inbound message ${messageId}; no matching session context was found.`
    );
    return;
  }

  // Refresh the route with the exact inbound delivery metadata once it resolves.
  pluginState.rememberInboundRoute({
    ...route,
    correlationId: payload.correlation_id ?? route.correlationId,
    groupId: payload.group_id ?? route.groupId,
    localConnectionId: payload.recipient_connection_id,
    remoteConnectionId: payload.sender_connection_id ?? route.remoteConnectionId,
    remoteParticipant: payload.sender
  });

  api.runtime.system.enqueueSystemEvent(
    formatMahiloInboundSystemEvent(payload),
    {
      contextKey: buildMahiloInboundContextKey(payload),
      sessionKey: route.sessionKey
    }
  );
  api.runtime.system.requestHeartbeatNow({
    agentId: route.agentId,
    reason: "mahilo:inbound-message",
    sessionKey: route.sessionKey
  });

  api.logger?.debug?.(
    `[Mahilo] Routed inbound message ${messageId} to session ${route.sessionKey}.`
  );
}

function buildMahiloInboundContextKey(payload: MahiloInboundWebhookPayload): string {
  return [
    "mahilo",
    "inbound",
    payload.group_id ? "group" : "direct",
    payload.delivery_id ?? payload.message_id
  ].join(":");
}

function formatMahiloInboundSystemEvent(payload: MahiloInboundWebhookPayload): string {
  const groupLabel = readOptionalString(payload.group_name) ?? payload.group_id ?? undefined;
  const selectorLabel = formatMahiloInboundSelectorLabel(payload.selectors);
  const messageBody = formatMahiloInboundBody(payload);
  const contextText = normalizeInlineText(payload.context);

  const parts = [
    MAHILO_INBOUND_EVENT_MARKER,
    `Mahilo inbound from ${payload.sender}`,
    groupLabel ? `in group ${groupLabel}` : undefined,
    `via ${payload.sender_agent}`,
    `[message ${payload.message_id}]`,
    payload.delivery_id ? `[delivery ${payload.delivery_id}]` : undefined,
    payload.correlation_id ? `[thread ${payload.correlation_id}]` : undefined,
    selectorLabel ? `[${selectorLabel}]` : undefined
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  let text = parts.join(" ");
  if (messageBody) {
    text = `${text}: ${messageBody}`;
  }

  if (contextText) {
    text = `${text} Context: ${contextText}`;
  }

  return text;
}

function formatMahiloInboundSelectorLabel(
  selectors: MahiloInboundWebhookPayload["selectors"]
): string | undefined {
  if (!selectors) {
    return undefined;
  }

  return `${selectors.resource}/${selectors.action}`;
}

function formatMahiloInboundBody(payload: MahiloInboundWebhookPayload): string {
  const payloadType = readOptionalString(payload.payload_type) ?? "text/plain";
  const message = normalizeInlineText(payload.message) ?? "";

  if (payloadType === "application/mahilo+ciphertext") {
    return `Encrypted payload received (${payloadType}).`;
  }

  if (payloadType.startsWith("text/")) {
    return message;
  }

  if (message.length > 0) {
    return `[payload ${payloadType}] ${message}`;
  }

  return `Payload received as ${payloadType}.`;
}

function buildMahiloOutcomeContextKey(
  event: ReturnType<typeof extractMahiloPostSendEvent>,
  runId: string | undefined,
  toolCallId: string | undefined
): string | undefined {
  if (!event) {
    return undefined;
  }

  if (event.kind === "failure") {
    return [
      "mahilo",
      "outcome",
      "failure",
      event.failure.toolName,
      event.failure.recipient,
      toolCallId ?? runId ?? "unknown"
    ].join(":");
  }

  return [
    "mahilo",
    "outcome",
    event.observation.outcome,
    event.observation.messageId ??
      event.observation.resolutionId ??
      toolCallId ??
      runId ??
      event.observation.fingerprint
  ].join(":");
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

  const senderResolution = await resolveMahiloSenderConnection(client, {
    cache: pluginState,
    explicitSenderConnectionId: promptContextInput.senderConnectionId
  });

  const result = await fetchMahiloPromptContext(
    client,
    {
      ...promptContextInput,
      senderConnectionId: senderResolution.connectionId
    },
    {
      cache: pluginState
    }
  );

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
  senderConnectionId?: string;
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
    );

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

function normalizeInlineText(value: string | undefined): string | undefined {
  const normalized = readOptionalString(value);
  if (!normalized) {
    return undefined;
  }

  return normalized.replace(/\s+/g, " ").trim();
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

function toMahiloToolFailure(tool: string, error: unknown): MahiloToolFailure {
  if (error instanceof MahiloToolInputError) {
    return {
      error: error.message,
      errorType: "input",
      retryable: false,
      status: "error",
      tool
    };
  }

  if (error instanceof MahiloRequestError) {
    return {
      code: error.code,
      error: error.message,
      errorType: error.kind === "network" ? "network" : "server",
      productState: error.productState,
      retryable: error.retryable,
      status: "error",
      tool
    };
  }

  return {
    error: toErrorMessage(error),
    errorType: "unknown",
    retryable: false,
    status: "error",
    tool
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "unknown error";
}
