import type {
  AnyAgentTool,
  OpenClawPluginApi
} from "openclaw/plugin-sdk/core";

import { MahiloRequestError, type MahiloContractClient } from "./client";
import {
  executeMahiloNetworkAction,
  type MahiloAskAroundTarget,
  type ExecuteMahiloNetworkActionInput,
  type MahiloAskAroundActionResult
} from "./network";
import {
  executeMahiloRelationshipAction,
  type ExecuteMahiloRelationshipActionInput,
  type MahiloRelationshipActionResult
} from "./relationships";
import {
  registerMahiloDiagnosticsCommands,
  type MahiloDiagnosticsCommandOptions
} from "./commands";
import {
  createMahiloClientFromConfig,
  parseMahiloPluginConfig,
  type MahiloPluginConfig
} from "./config";
import type { DeclaredSelectors } from "./policy-helpers";
import { fetchMahiloPromptContext } from "./prompt-context";
import { MAHILO_PLUGIN_RELEASE_VERSION } from "./release";
import {
  attachMahiloSenderResolutionCache,
  resolveMahiloSenderConnection
} from "./sender-resolution";
import {
  InMemoryPluginState,
  type MahiloAskAroundSession
} from "./state";
import { MAHILO_RUNTIME_PLUGIN_ID, MAHILO_RUNTIME_PLUGIN_NAME } from "./identity";
import {
  createMahiloBoundaryChange,
  talkToAgent,
  talkToGroup,
  type MahiloBoundaryChangeInput,
  type MahiloBoundaryChangeResult,
  type ContactsProvider,
  type MahiloSendToolInput,
  type MahiloToolResult,
  type MahiloToolContext,
  type TalkToGroupInput
} from "./tools-default-sender";
import type { ApplicablePolicy, MahiloInboundWebhookPayload } from "./webhook";
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
const MAHILO_ASK_NETWORK_TOOL_NAME = "ask_network";
const MAHILO_MANAGE_NETWORK_TOOL_NAME = "manage_network";
const MAHILO_SEND_MESSAGE_TOOL_NAME = "send_message";
const MAHILO_SET_BOUNDARIES_TOOL_NAME = "set_boundaries";

type MahiloBoundaryToolAction = "exception" | "set";
type MahiloBoundaryToolDetails = MahiloBoundaryChangeResult;
type MahiloManageNetworkToolDetails = MahiloRelationshipActionResult;
type MahiloAskNetworkToolDetails = MahiloAskAroundActionResult;
type MahiloSendMessageToolDetails = MahiloToolResult;

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
    },
    requireApiKey: false
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

  api.registerTool(createSendMessageTool(client));
  api.registerTool(createManageNetworkTool(client));
  api.registerTool(createAskNetworkTool(client));
  api.registerTool(createSetBoundariesTool(client));
  registerPromptContextHook(api, client, config, pluginState);
  attachMahiloSenderResolutionCache(client, pluginState);
  registerMahiloPostSendHooks(api, pluginState);
  registerMahiloWebhookRoute(api, config, webhookRouteOptions);
  registerMahiloDiagnosticsCommands(api, config, client, diagnosticsCommandOptions);
}

const defaultMahiloOpenClawPlugin = createMahiloOpenClawPlugin();
export default defaultMahiloOpenClawPlugin;

function createSendMessageTool(client: MahiloContractClient): AnyAgentTool {
  return {
    description:
      "Send one message through Mahilo to a person or a group. Mahilo infers the sender connection, checks boundaries, and routes the delivery.",
    execute: async (_toolCallId: string, rawInput: unknown) =>
      executeMahiloTool<MahiloSendMessageToolDetails>(MAHILO_SEND_MESSAGE_TOOL_NAME, async () => {
        const { input, recipientType } = parseSendMessageToolInput(rawInput);
        const context = parseToolContext(rawInput);
        const result =
          recipientType === "group"
            ? await talkToGroup(client, input as TalkToGroupInput, context)
            : await talkToAgent(client, input, context);

        return toAgentToolResult(result, formatSendMessageToolText(result, recipientType));
      }),
    label: "Send Message",
    name: MAHILO_SEND_MESSAGE_TOOL_NAME,
    parameters: {
      additionalProperties: false,
      properties: {
        action: {
          description: "What the sender is doing with the resource (e.g. share, recommend, request). Defaults to share.",
          type: "string"
        },
        message: { type: "string" },
        resource: {
          description: "What kind of data is being shared (e.g. location.current, health.metric, calendar.availability, message.general). Defaults to message.general.",
          type: "string"
        },
        target: { type: "string" },
        targetType: {
          enum: ["group", "person"],
          type: "string"
        }
      },
      required: ["message", "target"],
      type: "object"
    }
  } as unknown as AnyAgentTool;
}

function createManageNetworkTool(client: MahiloContractClient): AnyAgentTool {
  return {
    description:
      "Manage your Mahilo network: list contacts and pending requests, send a friend request, or accept/decline a request. Defaults to listing contacts when no action is given.",
    execute: async (_toolCallId: string, rawInput: unknown) =>
      executeMahiloTool<MahiloManageNetworkToolDetails>(MAHILO_MANAGE_NETWORK_TOOL_NAME, async () => {
        const input = parseManageNetworkToolInput(rawInput);
        const result = await executeMahiloRelationshipAction(client, input);
        return toAgentToolResult(result, result.summary);
      }),
    label: "Manage Network",
    name: MAHILO_MANAGE_NETWORK_TOOL_NAME,
    parameters: {
      additionalProperties: false,
      properties: {
        action: {
          enum: ["list_contacts", "respond_to_request", "send_friend_request"],
          type: "string"
        },
        decision: {
          enum: ["accept", "decline"],
          type: "string"
        },
        friendshipId: { type: "string" },
        username: { type: "string" }
      },
      type: "object"
    }
  } as unknown as AnyAgentTool;
}

function createAskNetworkTool(client: MahiloContractClient): AnyAgentTool {
  return {
    description:
      "Ask your Mahilo network one question. Mahilo can fan the ask out to all contacts, a role-based slice, or a group, then route replies back into the same OpenClaw thread.",
    execute: async (_toolCallId: string, rawInput: unknown) =>
      executeMahiloTool<MahiloAskNetworkToolDetails>(MAHILO_ASK_NETWORK_TOOL_NAME, async () => {
        const input = parseAskNetworkToolInput(rawInput);
        const result = await executeMahiloNetworkAction(client, input, parseToolContext(rawInput));
        if (result.action !== "ask_around") {
          throw new Error("Mahilo ask-network execution did not return an ask-around result");
        }
        return toAgentToolResult(result, formatAskNetworkToolText(result));
      }),
    label: "Ask Network",
    name: MAHILO_ASK_NETWORK_TOOL_NAME,
    parameters: {
      additionalProperties: false,
      properties: {
        group: { type: "string" },
        question: { type: "string" },
        role: { type: "string" },
        scope: {
          enum: ["all_contacts", "group", "role"],
          type: "string"
        }
      },
      required: ["question"],
      type: "object"
    }
  } as unknown as AnyAgentTool;
}

function createSetBoundariesTool(client: MahiloContractClient): AnyAgentTool {
  return {
    description:
      "Set Mahilo sharing boundaries conversationally. Use this to allow, ask, or deny topics like location, health, finances, opinions, or private details for everyone or a narrower audience.",
    execute: async (_toolCallId: string, rawInput: unknown) =>
      executeMahiloTool<MahiloBoundaryToolDetails>(MAHILO_SET_BOUNDARIES_TOOL_NAME, async () => {
        const input = parseSetBoundariesToolInput(rawInput);
        const result = await createMahiloBoundaryChange(client, input);
        return toAgentToolResult(result, result.summary);
      }),
    label: "Set Boundaries",
    name: MAHILO_SET_BOUNDARIES_TOOL_NAME,
    parameters: {
      additionalProperties: false,
      properties: {
        action: {
          description: "Use set for ongoing boundaries and exception for one-off or temporary changes.",
          enum: ["exception", "set"],
          type: "string"
        },
        appliesTo: {
          enum: ["contact", "everyone", "group", "role"],
          type: "string"
        },
        contact: { type: "string" },
        duration: {
          enum: ["always", "once", "temporary"],
          type: "string"
        },
        group: { type: "string" },
        hours: { type: "integer" },
        policy: {
          enum: ["allow", "ask", "deny"],
          type: "string"
        },
        reason: { type: "string" },
        role: { type: "string" },
        topic: {
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
        }
      },
      required: ["topic", "policy"],
      type: "object"
    }
  } as unknown as AnyAgentTool;
}

function parseSendMessageToolInput(
  rawInput: unknown
): { input: MahiloSendToolInput; recipientType: "group" | "user" } {
  const input = readInputObject(rawInput);
  const recipientType = readMahiloMessageRecipientType(input);
  const recipient =
    readOptionalString(input.target) ??
    readOptionalString(input.recipient) ??
    readOptionalString(input.group) ??
    (recipientType === "group"
      ? readOptionalString(input.groupId) ?? readOptionalString(input.group_id)
      : undefined);
  const message = readOptionalString(input.message);

  if (!recipient) {
    throw new MahiloToolInputError("target is required");
  }

  if (!message) {
    throw new MahiloToolInputError("message is required");
  }

  return {
    input: {
      context: readOptionalString(input.context),
      correlationId:
        readOptionalString(input.correlationId) ??
        readOptionalString(input.correlation_id),
      declaredSelectors:
        parseDeclaredSelectors(
          input.declaredSelectors ??
            input.declared_selectors ??
            input.draftSelectors ??
            input.draft_selectors
        ) ?? buildSelectorsFromTopLevel(input),
      idempotencyKey:
        readOptionalString(input.idempotencyKey) ??
        readOptionalString(input.idempotency_key),
      message,
      payloadType:
        readOptionalString(input.payloadType) ??
        readOptionalString(input.payload_type),
      recipient,
      recipientConnectionId:
        readOptionalString(input.recipientConnectionId) ??
        readOptionalString(input.recipient_connection_id),
      routingHints:
        readOptionalObject(input.routingHints) ??
        readOptionalObject(input.routing_hints)
    },
    recipientType
  };
}

function parseToolContext(rawInput: unknown): MahiloToolContext {
  const input = readInputObject(rawInput);
  const senderConnectionId =
    readOptionalString(input.senderConnectionId) ??
    readOptionalString(input.sender_connection_id);

  return {
    agentSessionId:
      readOptionalString(input.agentSessionId) ??
      readOptionalString(input.agent_session_id),
    senderConnectionId
  };
}

function parseSetBoundariesToolInput(rawInput: unknown): MahiloBoundaryChangeInput {
  const input = readInputObject(rawInput);
  const action = normalizeMahiloBoundaryAction(readOptionalString(input.action));
  const audience =
    readOptionalString(input.appliesTo) ??
    readOptionalString(input.applies_to) ??
    readOptionalString(input.audience) ??
    inferBoundaryAudienceFromInput(input);
  const normalizedAudience = normalizeBoundaryAudience(audience);
  const recipient =
    readOptionalString(input.contact) ??
    readOptionalString(input.group) ??
    readOptionalString(input.recipient);
  const targetId =
    (normalizedAudience === "role"
      ? readOptionalString(input.role)
      : undefined) ??
    readOptionalString(input.targetId) ??
    readOptionalString(input.target_id);

  if (input.action !== undefined && !action) {
    throw new MahiloToolInputError("action must be set, exception, or override");
  }

  return {
    action,
    audience,
    boundary:
      readOptionalString(input.policy) ??
      readOptionalString(input.boundary) ??
      readOptionalString(input.preference) ??
      readOptionalString(input.mode) ??
      readOptionalString(input.setting),
    category: readOptionalString(input.category) ?? readOptionalString(input.topic),
    durationHours:
      readPositiveInteger(input.hours) ??
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
    lifetime: readOptionalString(input.duration) ?? readOptionalString(input.lifetime),
    maxUses: readPositiveInteger(input.maxUses) ?? readPositiveInteger(input.max_uses),
    priority: readOptionalInteger(input.priority),
    recipient,
    recipientType:
      normalizedAudience === "group"
        ? "group"
        : (readRecipientType(input.recipientType) ?? readRecipientType(input.recipient_type)),
    reason: readOptionalString(input.reason),
    scope: normalizedAudience ?? readOptionalString(input.scope),
    selectors: parseDeclaredSelectors(
      input.selectors ?? input.declaredSelectors ?? input.declared_selectors
    ),
    senderConnectionId:
      readOptionalString(input.senderConnectionId) ??
      readOptionalString(input.sender_connection_id),
    sourceResolutionId:
      readOptionalString(input.sourceResolutionId) ??
      readOptionalString(input.source_resolution_id),
    targetId,
    ttlSeconds: readPositiveInteger(input.ttlSeconds) ?? readPositiveInteger(input.ttl_seconds)
  };
}

function parseManageNetworkToolInput(
  rawInput: unknown
): ExecuteMahiloRelationshipActionInput {
  const input = rawInput === undefined ? {} : readInputObject(rawInput);
  const action = normalizeManageNetworkAction(readOptionalString(input.action), input);

  if (action.kind === "list") {
    return {
      action: "list",
      activityLimit:
        readOptionalInteger(input.activityLimit) ??
        readOptionalInteger(input.activity_limit)
    };
  }

  if (action.kind === "send_request") {
    return {
      action: "send_request",
      username:
        readOptionalString(input.username) ??
        readOptionalString(input.recipient)
    };
  }

  return {
    action: action.decision,
    friendshipId:
      readOptionalString(input.friendshipId) ??
      readOptionalString(input.friendship_id),
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

function readMahiloMessageRecipientType(input: Record<string, unknown>): "group" | "user" {
  return (
    normalizeTargetType(
      readOptionalString(input.targetType) ??
        readOptionalString(input.target_type)
    ) ??
    readRecipientType(input.recipientType) ??
    readRecipientType(input.recipient_type) ??
    (readOptionalString(input.group) ??
    readOptionalString(input.groupId) ??
    readOptionalString(input.group_id)
      ? "group"
      : "user")
  );
}

function parseAskNetworkToolInput(
  rawInput: unknown
): ExecuteMahiloNetworkActionInput {
  const input = readInputObject(rawInput);
  const question =
    readOptionalString(input.question) ??
    readOptionalString(input.message);
  const scope = normalizeAskNetworkScope(readOptionalString(input.scope), input);

  if (!question) {
    throw new MahiloToolInputError("question is required");
  }

  if (
    scope === "group" &&
    !readOptionalString(input.group) &&
    !readOptionalString(input.groupId) &&
    !readOptionalString(input.group_id) &&
    !readOptionalString(input.groupName) &&
    !readOptionalString(input.group_name) &&
    !readOptionalString(input.target)
  ) {
    throw new MahiloToolInputError("group is required when scope is group");
  }

  if (scope === "role" && !readOptionalString(input.role) && !readStringArray(input.roles)) {
    throw new MahiloToolInputError("role is required when scope is role");
  }

  return {
    action: "ask_around",
    correlationId:
      readOptionalString(input.correlationId) ??
      readOptionalString(input.correlation_id),
    declaredSelectors:
      parseDeclaredSelectors(input.declaredSelectors ?? input.declared_selectors),
    group:
      scope === "group"
        ? readOptionalString(input.group) ??
          readOptionalString(input.groupName) ??
          readOptionalString(input.group_name) ??
          readOptionalString(input.target)
        : undefined,
    groupId:
      scope === "group"
        ? readOptionalString(input.groupId) ?? readOptionalString(input.group_id)
        : undefined,
    groupName:
      scope === "group"
        ? readOptionalString(input.groupName) ??
          readOptionalString(input.group_name) ??
          readOptionalString(input.group)
        : undefined,
    idempotencyKey:
      readOptionalString(input.idempotencyKey) ??
      readOptionalString(input.idempotency_key),
    question,
    role: scope === "role" ? readOptionalString(input.role) : undefined,
    roles: scope === "role" ? readStringArray(input.roles) : undefined
  };
}

function normalizeManageNetworkAction(
  value: string | undefined,
  input: Record<string, unknown>
): { kind: "list" } | { kind: "send_request" } | { decision: "accept" | "decline"; kind: "respond" } {
  const normalized = value?.toLowerCase().replace(/[\s-]+/g, "_");

  switch (normalized) {
    case undefined:
    case "":
    case "contacts":
    case "directory":
    case "list":
    case "list_contacts":
    case "network":
      return { kind: "list" };
    case "add":
    case "friend_request":
    case "request":
    case "send":
    case "send_friend_request":
    case "send_request":
      return { kind: "send_request" };
    case "accept":
    case "approve":
      return { decision: "accept", kind: "respond" };
    case "decline":
    case "reject":
      return { decision: "decline", kind: "respond" };
    case "respond":
    case "respond_to_request": {
      const decision = normalizeManageNetworkDecision(input.decision);
      if (!decision) {
        throw new MahiloToolInputError("decision must be accept or decline");
      }

      return { decision, kind: "respond" };
    }
    case "ask":
    case "ask_around":
    case "ask_network":
      throw new MahiloToolInputError(
        "Use the ask_network tool to ask your network a question"
      );
    default:
      throw new MahiloToolInputError(
        "action must be list_contacts, send_friend_request, or respond_to_request"
      );
  }
}

function normalizeManageNetworkDecision(value: unknown): "accept" | "decline" | undefined {
  const normalized = readOptionalString(value)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "accept" || normalized === "approve") {
    return "accept";
  }

  if (normalized === "decline" || normalized === "reject") {
    return "decline";
  }

  return undefined;
}

function normalizeAskNetworkScope(
  value: string | undefined,
  input: Record<string, unknown>
): "all_contacts" | "group" | "role" {
  const normalized = value?.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "group") {
    return "group";
  }

  if (normalized === "role" || normalized === "roles") {
    return "role";
  }

  if (
    readOptionalString(input.group) ??
    readOptionalString(input.groupId) ??
    readOptionalString(input.group_id) ??
    readOptionalString(input.groupName) ??
    readOptionalString(input.group_name)
  ) {
    return "group";
  }

  if (readOptionalString(input.role) || readStringArray(input.roles)) {
    return "role";
  }

  return "all_contacts";
}

function inferBoundaryAudienceFromInput(input: Record<string, unknown>): string | undefined {
  if (readOptionalString(input.contact)) {
    return "contact";
  }

  if (readOptionalString(input.group)) {
    return "group";
  }

  if (readOptionalString(input.role)) {
    return "role";
  }

  return undefined;
}

function normalizeBoundaryAudience(value: string | undefined): "contact" | "everyone" | "group" | "role" | undefined {
  const normalized = value?.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "contact" || normalized === "everyone" || normalized === "group" || normalized === "role") {
    return normalized;
  }

  return undefined;
}

function normalizeTargetType(value: string | undefined): "group" | "user" | undefined {
  const normalized = value?.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "group") {
    return "group";
  }

  if (normalized === "person" || normalized === "user") {
    return "user";
  }

  return undefined;
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

function buildSelectorsFromTopLevel(input: Record<string, unknown>): Partial<DeclaredSelectors> | undefined {
  const resource = readOptionalString(input.resource);
  const action = readOptionalString(input.action);

  if (!resource && !action) {
    return undefined;
  }

  const parsed: Partial<DeclaredSelectors> = {};
  if (resource) {
    parsed.resource = resource;
  }
  if (action) {
    parsed.action = action;
  }
  return parsed;
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

function readNonNegativeInteger(value: unknown): number | undefined {
  const normalized = readOptionalInteger(value);
  if (typeof normalized !== "number" || normalized < 0) {
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

function toAgentToolResult<T>(details: T, text: string): { content: Array<{ text: string; type: "text" }>; details: T } {
  return {
    content: [{ text, type: "text" }],
    details
  };
}

function formatAskNetworkToolText(result: MahiloAskNetworkToolDetails): string {
  if ((result.counts?.awaitingReplies ?? 0) > 0 || !result.replyExpectation) {
    return result.summary;
  }

  return `${result.summary} ${result.replyExpectation}`;
}

function formatSendMessageToolText(
  result: MahiloSendMessageToolDetails,
  recipientType: "group" | "user"
): string {
  const targetLabel = recipientType === "group" ? "group" : "person";

  switch (result.status) {
    case "denied":
      return result.reason
        ? `Mahilo blocked this ${targetLabel} message. ${result.reason}`
        : `Mahilo blocked this ${targetLabel} message.`;
    case "review_required":
      return result.reason
        ? `Mahilo needs review before sending this ${targetLabel} message. ${result.reason}`
        : `Mahilo needs review before sending this ${targetLabel} message.`;
    case "sent":
      return result.reason
        ? `Message sent through Mahilo. ${result.reason}`
        : "Message sent through Mahilo.";
  }
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
  }, {
    description: "Injects bounded Mahilo relationship and policy context before prompt build.",
    name: "mahilo.before_prompt_build",
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

  const agentId = readOptionalString(context.agentId);
  pluginState.touchActiveSession(sessionKey, agentId);

  const toolName = readOptionalString(event.toolName);
  if (toolName === MAHILO_SEND_MESSAGE_TOOL_NAME) {
    rememberMahiloMessageInboundRoute(pluginState, event, {
      agentId: readOptionalString(context.agentId),
      sessionKey
    });
    return;
  }

  if (toolName === MAHILO_ASK_NETWORK_TOOL_NAME) {
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
        readOptionalString(event.params.group) ??
        readOptionalString(event.params.target) ??
        readOptionalString(event.params.recipient)
      : undefined;
  const remoteParticipant =
    recipientType === "user"
      ? readOptionalString(event.params.target) ?? readOptionalString(event.params.recipient)
      : undefined;

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
  const target = readMahiloAskAroundTarget(resultDetails.target);
  const expectedReplyCount = readMahiloAskAroundExpectedReplyCount(resultDetails, deliveries, target);
  const expectedParticipants: Array<{ label?: string; recipient: string }> = [];

  for (const rawDelivery of deliveries) {
    const delivery = readOptionalObject(rawDelivery);
    if (!delivery || readOptionalString(delivery.status) !== "awaiting_reply") {
      continue;
    }

    const recipient = readOptionalString(delivery.recipient);
    const recipientType =
      readRecipientType(delivery.recipientType) ??
      readRecipientType(delivery.recipient_type) ??
      (target?.kind === "group" ? "group" : "user");

    if (recipientType !== "user" || !recipient) {
      continue;
    }

    expectedParticipants.push({
      label:
        readOptionalString(delivery.recipientLabel) ??
        readOptionalString(delivery.recipient_label),
      recipient
    });
  }

  if (correlationId) {
    pluginState.rememberAskAroundSession({
      correlationId,
      expectedReplyCount,
      expectedParticipants:
        expectedParticipants.length > 0 ? expectedParticipants : undefined,
      question:
        readOptionalString(resultDetails.question) ??
        readOptionalString(event.params.question) ??
        readOptionalString(event.params.message),
      target
    });

    if (deliveries.some((rawDelivery) => readOptionalString(readOptionalObject(rawDelivery)?.status) === "awaiting_reply")) {
      pluginState.recordAskAroundQuery({
        correlationId,
        expectedReplyCount,
        senderConnectionId,
        target
      });
    }
  }

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
      (target?.kind === "group" ? "group" : "user");

    if (!outboundMessageId || !recipient) {
      continue;
    }

    const groupId =
      recipientType === "group"
        ? target?.groupId ??
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
  let route = pluginState.resolveInboundRoute({
    correlationId: payload.correlation_id,
    groupId: payload.group_id ?? undefined,
    inResponseToMessageId: payload.in_response_to,
    localConnectionId: payload.recipient_connection_id,
    remoteConnectionId: payload.sender_connection_id,
    remoteParticipant: payload.sender
  });

  if (!route) {
    const lastActive = pluginState.getLastActiveSession();
    if (lastActive) {
      api.logger?.info?.(
        `[Mahilo] No exact route for inbound message ${messageId}; falling back to last active session ${lastActive.sessionKey}.`
      );
      route = {
        agentId: lastActive.agentId,
        localConnectionId: payload.recipient_connection_id,
        remoteConnectionId: payload.sender_connection_id,
        remoteParticipant: payload.sender,
        sessionKey: lastActive.sessionKey
      };
    } else {
      api.logger?.info?.(
        `[Mahilo] No session context for inbound message ${messageId}; delivering to active session.`
      );
      const askAroundSession =
        payload.correlation_id
          ? pluginState.recordAskAroundReply(payload.correlation_id, {
              context: payload.context,
              deliveryId: payload.delivery_id ?? undefined,
              groupId: payload.group_id ?? undefined,
              groupName: payload.group_name ?? undefined,
              message: payload.message,
              messageId: payload.message_id,
              payloadType: payload.payload_type,
              sender: payload.sender,
              senderAgent: payload.sender_agent,
              senderConnectionId: payload.sender_connection_id,
              senderUserId: payload.sender_user_id,
              timestamp: payload.timestamp
            })
          : undefined;

      api.runtime.system.enqueueSystemEvent(
        formatMahiloInboundSystemEvent(payload, askAroundSession),
        { contextKey: buildMahiloInboundContextKey(payload) }
      );
      api.runtime.system.requestHeartbeatNow({
        reason: "mahilo:inbound-message"
      });
      return;
    }
  }

  const correlationId = payload.correlation_id ?? route.correlationId;

  // Refresh the route with the exact inbound delivery metadata once it resolves.
  pluginState.rememberInboundRoute({
    ...route,
    correlationId,
    groupId: payload.group_id ?? route.groupId,
    localConnectionId: payload.recipient_connection_id,
    remoteConnectionId: payload.sender_connection_id ?? route.remoteConnectionId,
    remoteParticipant: payload.sender
  });

  const askAroundSession =
    correlationId
      ? pluginState.recordAskAroundReply(correlationId, {
          context: payload.context,
          deliveryId: payload.delivery_id ?? undefined,
          groupId: payload.group_id ?? undefined,
          groupName: payload.group_name ?? undefined,
          message: payload.message,
          messageId: payload.message_id,
          payloadType: payload.payload_type,
          sender: payload.sender,
          senderAgent: payload.sender_agent,
          senderConnectionId: payload.sender_connection_id,
          senderUserId: payload.sender_user_id,
          timestamp: payload.timestamp
        })
      : undefined;

  api.runtime.system.enqueueSystemEvent(
    formatMahiloInboundSystemEvent(payload, askAroundSession),
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

function formatMahiloInboundSystemEvent(
  payload: MahiloInboundWebhookPayload,
  askAroundSession?: MahiloAskAroundSession
): string {
  if (askAroundSession) {
    return formatMahiloAskAroundInboundSystemEvent(askAroundSession);
  }

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

  const policyBlock = formatApplicablePolicies(payload.applicable_policies);
  if (policyBlock) {
    text = `${text}\n${policyBlock}`;
  }

  return text;
}

function formatApplicablePolicies(policies?: ApplicablePolicy[]): string | undefined {
  if (!policies || policies.length === 0) {
    return undefined;
  }

  const lines = policies.map((p) => {
    const selector = [p.direction, p.resource, p.action].filter(Boolean).join("/") || "*";
    return `- ${p.effect} ${selector} (${p.scope})`;
  });

  return `Policies for this sender:\n${lines.join("\n")}`;
}

function formatMahiloAskAroundInboundSystemEvent(
  session: MahiloAskAroundSession
): string {
  const lines = [
    [
      MAHILO_INBOUND_EVENT_MARKER,
      "Mahilo ask-around update",
      `[thread ${session.correlationId}]`
    ].join(" ")
  ];
  const question = normalizeInlineText(session.question);
  if (question) {
    lines.push(`Question: ${question}`);
  }

  const targetLine = formatMahiloAskAroundTargetLine(session.target);
  if (targetLine) {
    lines.push(targetLine);
  }

  lines.push(
    `Synthesized summary (plugin-generated): ${formatMahiloAskAroundSummary(session)}`
  );
  lines.push("Direct replies:");
  lines.push(...session.replies.map((reply) => formatMahiloAskAroundDirectReply(reply)));

  return lines.join("\n");
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
  return formatMahiloInboundBodyContent(payload.message, payload.payload_type);
}

function formatMahiloInboundBodyContent(
  messageValue: string | undefined,
  payloadTypeValue: string | undefined
): string {
  const payloadType = readOptionalString(payloadTypeValue) ?? "text/plain";
  const message = normalizeInlineText(messageValue) ?? "";

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

function readMahiloAskAroundTarget(value: unknown): MahiloAskAroundTarget | undefined {
  const target = readOptionalObject(value);
  if (!target) {
    return undefined;
  }

  const kind = readOptionalString(target.kind);
  if (kind !== "all_contacts" && kind !== "group" && kind !== "roles") {
    return undefined;
  }

  return {
    contactCount: readNonNegativeInteger(target.contactCount),
    groupId: readOptionalString(target.groupId) ?? readOptionalString(target.group_id),
    groupName: readOptionalString(target.groupName) ?? readOptionalString(target.group_name),
    kind,
    memberCount: readNonNegativeInteger(target.memberCount) ?? readNonNegativeInteger(target.member_count),
    roles: readStringArray(target.roles)
  };
}

function readMahiloAskAroundExpectedReplyCount(
  resultDetails: Record<string, unknown>,
  deliveries: unknown[],
  target: MahiloAskAroundTarget | undefined
): number | undefined {
  if (target?.kind === "group") {
    return undefined;
  }

  const counts = readOptionalObject(resultDetails.counts);
  const countedReplies =
    readNonNegativeInteger(counts?.awaitingReplies) ??
    readNonNegativeInteger(counts?.awaiting_replies);
  if (typeof countedReplies === "number" && countedReplies > 0) {
    return countedReplies;
  }

  let awaitingReplyCount = 0;
  for (const rawDelivery of deliveries) {
    const delivery = readOptionalObject(rawDelivery);
    if (readOptionalString(delivery?.status) === "awaiting_reply") {
      awaitingReplyCount += 1;
    }
  }

  return awaitingReplyCount > 0 ? awaitingReplyCount : undefined;
}

function formatMahiloAskAroundTargetLine(
  target: MahiloAskAroundTarget | undefined
): string | undefined {
  if (!target) {
    return undefined;
  }

  switch (target.kind) {
    case "all_contacts":
      return "Asked: your Mahilo contacts.";
    case "group": {
      const groupLabel = target.groupName ?? target.groupId;
      if (!groupLabel) {
        return "Asked: a Mahilo group.";
      }

      const memberCountSuffix =
        typeof target.memberCount === "number" && target.memberCount > 0
          ? ` (${target.memberCount} members)`
          : "";
      return `Asked: group ${formatQuotedLabel(groupLabel)}${memberCountSuffix}.`;
    }
    case "roles":
      return target.roles && target.roles.length > 0
        ? `Asked: Mahilo contacts in roles ${formatQuotedList(target.roles)}.`
        : "Asked: role-filtered Mahilo contacts.";
  }
}

function formatMahiloAskAroundSummary(session: MahiloAskAroundSession): string {
  if (session.replies.length === 0) {
    return "No direct replies are recorded yet.";
  }

  const replyCounts = countMahiloAskAroundReplyOutcomes(session);
  const respondentCount = countMahiloAskAroundRespondents(session);
  const attributedMessageCount = session.replies.filter(
    (reply) => readMahiloAskAroundReplyOutcome(reply) !== "attribution_unverified"
  ).length;
  let overview: string;

  if (session.target?.kind === "group") {
    const groupLabel = session.target.groupName ?? session.target.groupId;
    const groupSuffix = groupLabel ? ` from group ${formatQuotedLabel(groupLabel)}` : "";
    overview =
      respondentCount === 1
        ? `1 contact has replied so far${groupSuffix}.`
        : `${respondentCount} contacts have replied so far${groupSuffix}.`;
  } else if (
    typeof session.expectedReplyCount === "number" &&
    session.expectedReplyCount > 0
  ) {
    overview =
      respondentCount === 1
        ? `1 of ${session.expectedReplyCount} contacted people has replied so far.`
        : `${respondentCount} of ${session.expectedReplyCount} contacted people have replied so far.`;
  } else {
    overview =
      respondentCount === 1
        ? "1 contact has replied so far."
        : `${respondentCount} contacts have replied so far.`;
  }

  if (attributedMessageCount > respondentCount) {
    overview = `${overview} ${attributedMessageCount} attributed direct messages are on record.`;
  }

  if (replyCounts.noGroundedAnswer > 1) {
    overview = `${overview} ${replyCounts.noGroundedAnswer} contacts explicitly reported no grounded answer.`;
  }

  if (replyCounts.attributionUnverified > 0) {
    const replyWord = replyCounts.attributionUnverified === 1 ? "reply" : "replies";
    const verb = replyCounts.attributionUnverified === 1 ? "is" : "are";
    overview = `${overview} ${replyCounts.attributionUnverified} ${replyWord} could not be safely attributed to a contacted friend and ${verb} kept separate below.`;
  }

  const replySnippets = session.replies
    .filter((reply) => readMahiloAskAroundReplyOutcome(reply) !== "attribution_unverified")
    .map((reply) => formatMahiloAskAroundReplySnippet(reply))
    .join(" ");

  return replySnippets.length > 0 ? `${overview} ${replySnippets}` : overview;
}

function formatMahiloAskAroundReplySnippet(
  reply: MahiloAskAroundSession["replies"][number]
): string {
  const outcome = readMahiloAskAroundReplyOutcome(reply);
  const contextText = normalizeInlineText(reply.context);
  const timeText = normalizeInlineText(reply.timestamp);
  const attributionSuffix = contextText
    ? ` (context: ${contextText})`
    : timeText
      ? ` (${timeText})`
      : "";

  if (outcome === "no_grounded_answer") {
    return `${reply.sender}${attributionSuffix} reported no grounded answer.`;
  }

  if (outcome === "attribution_unverified") {
    return "An unattributed Mahilo reply was received and kept separate from trusted contact attribution.";
  }

  return `${reply.sender}${attributionSuffix} said: ${formatMahiloAskAroundReplyBody(reply)}`;
}

function formatMahiloAskAroundDirectReply(
  reply: MahiloAskAroundSession["replies"][number]
): string {
  const outcome = readMahiloAskAroundReplyOutcome(reply);
  if (outcome === "attribution_unverified") {
    const details = [
      `- Unverified sender claim ${formatQuotedLabel(reply.sender)}`,
      `via ${reply.senderAgent}`,
      reply.timestamp ? `at ${reply.timestamp}` : undefined,
      `[message ${reply.messageId}]`,
      reply.deliveryId ? `[delivery ${reply.deliveryId}]` : undefined
    ].filter((value): value is string => typeof value === "string" && value.length > 0);

    let line = `${details.join(" ")}. Mahilo couldn't confirm this sender was one of the contacts asked in this thread.`;
    const contextText = normalizeInlineText(reply.context);
    if (contextText) {
      line = `${line} Claimed context: ${contextText}.`;
    }

    return `${line} Raw reply: ${formatMahiloInboundBodyContent(
      reply.message,
      reply.payloadType
    )}`;
  }

  const details = [
    `- ${reply.sender}`,
    `via ${reply.senderAgent}`,
    reply.timestamp ? `at ${reply.timestamp}` : undefined,
    `[message ${reply.messageId}]`,
    reply.deliveryId ? `[delivery ${reply.deliveryId}]` : undefined
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  let line = `${details.join(" ")}.`;
  const contextText = normalizeInlineText(reply.context);
  if (contextText) {
    line = `${line} Experience context: ${contextText}.`;
  }

  if (outcome === "no_grounded_answer") {
    return `${line} Outcome: no grounded answer. Direct reply: ${formatMahiloAskAroundReplyBody(
      reply
    )}`;
  }

  return `${line} Direct reply: ${formatMahiloAskAroundReplyBody(reply)}`;
}

function countMahiloAskAroundRespondents(session: MahiloAskAroundSession): number {
  const respondents = new Set(
    session.replies
      .filter((reply) => readMahiloAskAroundReplyOutcome(reply) !== "attribution_unverified")
      .map((reply) => normalizeInlineText(reply.sender)?.toLowerCase())
      .filter((sender): sender is string => Boolean(sender))
  );

  return respondents.size;
}

function countMahiloAskAroundReplyOutcomes(session: MahiloAskAroundSession): {
  attributionUnverified: number;
  directReply: number;
  noGroundedAnswer: number;
} {
  return session.replies.reduce(
    (counts, reply) => {
      switch (readMahiloAskAroundReplyOutcome(reply)) {
        case "attribution_unverified":
          counts.attributionUnverified += 1;
          break;
        case "no_grounded_answer":
          counts.noGroundedAnswer += 1;
          break;
        default:
          counts.directReply += 1;
          break;
      }

      return counts;
    },
    {
      attributionUnverified: 0,
      directReply: 0,
      noGroundedAnswer: 0
    }
  );
}

function readMahiloAskAroundReplyOutcome(
  reply: MahiloAskAroundSession["replies"][number]
): "attribution_unverified" | "direct_reply" | "no_grounded_answer" {
  const outcome = readOptionalString(reply.outcome);
  switch (outcome) {
    case "attribution_unverified":
    case "no_grounded_answer":
      return outcome;
    default:
      return "direct_reply";
  }
}

function formatMahiloAskAroundReplyBody(
  reply: MahiloAskAroundSession["replies"][number]
): string {
  if (readMahiloAskAroundReplyOutcome(reply) !== "no_grounded_answer") {
    return formatMahiloInboundBodyContent(reply.message, reply.payloadType);
  }

  const structuredBody = readMahiloAskAroundStructuredBody(reply.message, reply.payloadType);
  const explicitText = normalizeInlineText(
    readOptionalString(structuredBody?.message) ??
      readOptionalString(structuredBody?.text) ??
      readOptionalString(structuredBody?.reason)
  );

  return explicitText ?? normalizeInlineText(reply.message) ?? "No grounded answer.";
}

function readMahiloAskAroundStructuredBody(
  message: string,
  payloadType: string | undefined
): Record<string, unknown> | undefined {
  const normalizedPayloadType = readOptionalString(payloadType)?.toLowerCase();
  if (
    normalizedPayloadType &&
    !normalizedPayloadType.includes("json") &&
    !message.trim().startsWith("{")
  ) {
    return undefined;
  }

  if (!normalizedPayloadType && !message.trim().startsWith("{")) {
    return undefined;
  }

  try {
    return readOptionalObject(JSON.parse(message) as unknown);
  } catch {
    return undefined;
  }
}

function formatQuotedLabel(value: string): string {
  return `"${value}"`;
}

function formatQuotedList(values: string[]): string {
  return values.map((value) => formatQuotedLabel(value)).join(", ");
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
    "targetType",
    "target_type",
    "recipientType",
    "recipient_type"
  );
  const groupId = readFirstString(sources, "group", "groupId", "group_id");
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

  if (explicitType === "user" || explicitType === "person") {
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
