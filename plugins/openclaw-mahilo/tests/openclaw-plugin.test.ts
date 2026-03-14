import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CorePolicy } from "@mahilo/policy-core";

import {
  createMahiloOpenClawPlugin,
  generateCallbackSignature,
  InMemoryPluginState,
  MahiloRequestError,
  MahiloRuntimeBootstrapStore,
  resetSharedMahiloPluginStates,
} from "../src";

const CALLBACK_SECRET = "callback-secret";

beforeEach(() => {
  resetSharedMahiloPluginStates();
});

interface MockClientState {
  acceptFriendRequestCalls: string[];
  agentConnectionCalls: number;
  agentConnectionsResponse: unknown;
  blockedEventCalls: number[];
  currentIdentityCalls: number;
  directSendBundleCalls: Array<Record<string, unknown>>;
  friendConnectionCalls: string[];
  friendRequestCalls: string[];
  friendConnectionsByUsername: Record<string, unknown[]>;
  friendshipCalls: Array<{ status?: string }>;
  friendshipsResponse: unknown;
  groupFanoutBundleCalls: Array<Record<string, unknown>>;
  groupCalls: number;
  groupsResponse: unknown;
  listReviewCalls: Array<{ limit?: number; status?: string }>;
  localDecisionCommitCalls: Array<{
    idempotencyKey?: string;
    payload: Record<string, unknown>;
  }>;
  overrideCalls: Array<{
    idempotencyKey?: string;
    payload: Record<string, unknown>;
  }>;
  outcomeCalls: Array<{
    idempotencyKey?: string;
    payload: Record<string, unknown>;
  }>;
  pingCalls: string[];
  promptContextCalls: Array<Record<string, unknown>>;
  registerAgentConnectionCalls: Array<Record<string, unknown>>;
  registerIdentityCalls: Array<Record<string, unknown>>;
  rejectFriendRequestCalls: string[];
  resolveCalls: Array<Record<string, unknown>>;
  sendCalls: Array<{
    idempotencyKey?: string;
    payload: Record<string, unknown>;
  }>;
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

interface RegisteredService {
  id: string;
  start: (ctx: unknown) => Promise<void> | void;
  stop?: (ctx: unknown) => Promise<void> | void;
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

function buildDefaultDirectSendBundle(payload: Record<string, unknown>) {
  const recipient =
    typeof payload.recipient === "string" && payload.recipient.trim().length > 0
      ? payload.recipient.trim().toLowerCase()
      : "alice";
  const senderConnectionId =
    typeof payload.sender_connection_id === "string" &&
    payload.sender_connection_id.length > 0
      ? payload.sender_connection_id
      : "conn_sender_default";
  const declaredSelectors =
    payload.declared_selectors &&
    typeof payload.declared_selectors === "object" &&
    !Array.isArray(payload.declared_selectors)
      ? (payload.declared_selectors as Record<string, unknown>)
      : {
          action: "share",
          direction: "outbound",
          resource: "message.general",
        };

  return {
    applicable_policies: [],
    authenticated_identity: {
      sender_connection_id: senderConnectionId,
      sender_user_id: "usr_sender",
    },
    bundle_metadata: {
      bundle_id: "bundle_direct_default",
      expires_at: "2026-03-14T10:35:00.000Z",
      issued_at: "2026-03-14T10:30:00.000Z",
      resolution_id: "res_direct_default",
    },
    bundle_type: "direct_send",
    contract_version: "1.0.0",
    llm: {
      provider_defaults: null,
      subject: recipient,
    },
    recipient: {
      id: `usr_${recipient}`,
      type: "user",
      username: recipient,
    },
    selector_context: {
      action:
        typeof declaredSelectors.action === "string"
          ? declaredSelectors.action
          : "share",
      direction:
        typeof declaredSelectors.direction === "string"
          ? declaredSelectors.direction
          : "outbound",
      resource:
        typeof declaredSelectors.resource === "string"
          ? declaredSelectors.resource
          : "message.general",
    },
  };
}

function createPolicy(
  overrides: Partial<CorePolicy> & Pick<CorePolicy, "id">,
): CorePolicy {
  return {
    id: overrides.id,
    scope: overrides.scope ?? "global",
    effect: overrides.effect ?? "deny",
    evaluator: overrides.evaluator ?? "structured",
    policy_content: overrides.policy_content ?? {},
    effective_from: overrides.effective_from ?? null,
    expires_at: overrides.expires_at ?? null,
    max_uses: overrides.max_uses ?? null,
    remaining_uses: overrides.remaining_uses ?? null,
    source: overrides.source ?? "user_created",
    derived_from_message_id: overrides.derived_from_message_id ?? null,
    learning_provenance: overrides.learning_provenance ?? null,
    priority: overrides.priority ?? 1,
    created_at: overrides.created_at ?? null,
  };
}

function buildDefaultGroupFanoutBundle(payload: Record<string, unknown>) {
  const groupId =
    typeof payload.recipient === "string" && payload.recipient.trim().length > 0
      ? payload.recipient.trim()
      : "grp_hiking";
  const senderConnectionId =
    typeof payload.sender_connection_id === "string" &&
    payload.sender_connection_id.length > 0
      ? payload.sender_connection_id
      : "conn_sender_default";
  const declaredSelectors =
    payload.declared_selectors &&
    typeof payload.declared_selectors === "object" &&
    !Array.isArray(payload.declared_selectors)
      ? (payload.declared_selectors as Record<string, unknown>)
      : {
          action: "share",
          direction: "outbound",
          resource: "message.general",
        };

  return {
    aggregate_metadata: {
      empty_group_summary: "No active recipients in group.",
      fanout_mode: "per_recipient",
      mixed_decision_priority: ["allow", "ask", "deny"],
      partial_reason_code: "policy.partial.group_fanout",
      partial_summary_template:
        "Partial group delivery: {delivered} delivered, {pending} pending, {denied} denied, {review_required} review-required, {failed} failed.",
      policy_evaluation_mode: "group_outbound_fanout",
    },
    authenticated_identity: {
      sender_connection_id: senderConnectionId,
      sender_user_id: "usr_sender",
    },
    bundle_metadata: {
      bundle_id: "bundle_group_default",
      expires_at: "2026-03-14T10:35:00.000Z",
      issued_at: "2026-03-14T10:30:00.000Z",
      resolution_id: "res_group_default",
    },
    bundle_type: "group_fanout",
    contract_version: "1.0.0",
    group: {
      id: groupId,
      member_count: 1,
      name: "Hiking Crew",
      type: "group",
    },
    group_overlay_policies: [],
    members: [
      {
        llm: {
          provider_defaults: null,
          subject: "alice",
        },
        member_applicable_policies: [],
        recipient: {
          id: "usr_alice",
          type: "user",
          username: "alice",
        },
        resolution_id: "res_group_default_usr_alice",
        roles: [],
      },
    ],
    selector_context: {
      action:
        typeof declaredSelectors.action === "string"
          ? declaredSelectors.action
          : "share",
      direction:
        typeof declaredSelectors.direction === "string"
          ? declaredSelectors.direction
          : "outbound",
      resource:
        typeof declaredSelectors.resource === "string"
          ? declaredSelectors.resource
          : "message.general",
    },
  };
}

function buildDefaultLocalDecisionCommitResponse(payload: Record<string, unknown>) {
  const localDecision = payload.local_decision as Record<string, unknown> | undefined;
  const decision =
    typeof localDecision?.decision === "string"
      ? localDecision.decision
      : "allow";
  const deliveryMode =
    typeof localDecision?.delivery_mode === "string"
      ? localDecision.delivery_mode
      : decision === "allow"
        ? "full_send"
        : decision === "ask"
          ? "review_required"
          : "blocked";
  const status =
    decision === "allow"
      ? "pending"
      : decision === "ask"
        ? "review_required"
        : "rejected";
  const deliveryStatus =
    decision === "allow"
      ? "pending"
      : decision === "ask"
        ? "review_required"
        : "rejected";
  const resolutionId =
    typeof payload.resolution_id === "string" ? payload.resolution_id : "res_local_default";
  const recipient =
    typeof payload.recipient === "string" ? payload.recipient : "alice";

  return {
    committed: true,
    message_id: `msg_commit_${resolutionId}`,
    recorded: true,
    recipient_results: [
      {
        decision,
        delivery_mode: deliveryMode,
        delivery_status: deliveryStatus,
        recipient,
      },
    ],
    resolution: {
      decision,
      delivery_mode: deliveryMode,
      reason_code:
        typeof localDecision?.reason_code === "string"
          ? localDecision.reason_code
          : undefined,
      resolution_id: resolutionId,
      summary:
        typeof localDecision?.summary === "string"
          ? localDecision.summary
          : typeof localDecision?.reason === "string"
            ? localDecision.reason
            : undefined,
    },
    status,
  };
}

function createMockContractClient(
  options: {
    acceptFriendRequestError?: Error;
    acceptFriendRequestResponse?: Record<string, unknown>;
    agentConnectionsResponse?: unknown;
    currentIdentityError?: Error;
    currentIdentityResponse?: Record<string, unknown>;
    blockedEventsResponse?: unknown;
    createOverrideError?: Error;
    directSendBundleError?: Error;
    directSendBundleResponse?:
      | Record<string, unknown>
      | ((payload: Record<string, unknown>) => Record<string, unknown>);
    friendConnectionErrorsByUsername?: Record<string, Error>;
    friendConnectionsByUsername?: Record<string, unknown[]>;
    friendshipsByStatus?: Record<string, unknown>;
    friendshipsResponse?: unknown;
    groupFanoutBundleError?: Error;
    groupFanoutBundleResponse?: Record<string, unknown>;
    groupsResponse?: unknown;
    localDecisionCommitError?: Error;
    localDecisionCommitResponse?: Record<string, unknown>;
    pingAgentConnectionError?: Error;
    promptContextError?: Error;
    promptContextResponse?: Record<string, unknown>;
    rejectFriendRequestError?: Error;
    rejectFriendRequestResponse?: Record<string, unknown>;
    registerAgentConnectionError?: Error;
    registerAgentConnectionResponse?: Record<string, unknown>;
    registerIdentityError?: Error;
    registerIdentityResponse?: Record<string, unknown>;
    resolveError?: Error;
    resolveResponse?: Record<string, unknown>;
    reviewsResponse?: unknown;
    sendError?: Error;
    sendFriendRequestError?: Error;
    sendFriendRequestResponse?: Record<string, unknown>;
  } = {},
) {
  const state: MockClientState = {
    acceptFriendRequestCalls: [],
    agentConnectionCalls: 0,
    agentConnectionsResponse: options.agentConnectionsResponse ?? [
      {
        active: true,
        framework: "openclaw",
        id: "conn_sender_default",
        label: "default",
      },
    ],
    blockedEventCalls: [],
    currentIdentityCalls: 0,
    directSendBundleCalls: [],
    friendConnectionCalls: [],
    friendRequestCalls: [],
    friendConnectionsByUsername: options.friendConnectionsByUsername ?? {},
    friendshipCalls: [],
    friendshipsResponse: options.friendshipsResponse ?? [
      {
        direction: "sent",
        displayName: "Alice",
        friendshipId: "fr_alice",
        roles: ["friends"],
        status: "accepted",
        userId: "usr_alice",
        username: "alice",
      },
    ],
    groupFanoutBundleCalls: [],
    groupCalls: 0,
    groupsResponse: options.groupsResponse ?? [
      {
        groupId: "grp_hiking",
        memberCount: 4,
        name: "Hiking Crew",
        role: "owner",
        status: "active",
      },
    ],
    listReviewCalls: [],
    localDecisionCommitCalls: [],
    overrideCalls: [],
    outcomeCalls: [],
    pingCalls: [],
    promptContextCalls: [],
    registerAgentConnectionCalls: [],
    registerIdentityCalls: [],
    rejectFriendRequestCalls: [],
    resolveCalls: [],
    sendCalls: [],
  };
  const currentIdentityResponse = options.currentIdentityResponse ?? {
    raw: {
      username: "mahilo-user",
    },
    username: "mahilo-user",
  };
  const promptContextResponse = options.promptContextResponse ?? {
    policy_guidance: {
      default_decision: "ask",
      reason_code: "context.ask.role.structured",
      summary: "Share only high-level details.",
    },
    recipient: {
      relationship: "friend",
      roles: ["close_friends"],
      username: "alice",
    },
    recent_interactions: [
      {
        decision: "allow",
        direction: "inbound",
        summary: "Asked for travel timing.",
      },
    ],
    suggested_selectors: {
      action: "share",
      direction: "inbound",
      resource: "message.general",
    },
  };

  const client = {
    acceptFriendRequest: async (friendshipId: string) => {
      state.acceptFriendRequestCalls.push(friendshipId);
      if (options.acceptFriendRequestError) {
        throw options.acceptFriendRequestError;
      }

      return (
        options.acceptFriendRequestResponse ?? {
          friendshipId,
          raw: {
            friendshipId,
            status: "accepted",
          },
          status: "accepted",
          success: true,
        }
      );
    },
    createOverride: async (
      payload: Record<string, unknown>,
      idempotencyKey?: string,
    ) => {
      state.overrideCalls.push({ idempotencyKey, payload });
      if (options.createOverrideError) {
        throw options.createOverrideError;
      }

      return {
        created: true,
        kind: "one_time",
        policy_id: "pol_789",
      };
    },
    getPromptContext: async (payload: Record<string, unknown>) => {
      state.promptContextCalls.push(payload);
      if (options.promptContextError) {
        throw options.promptContextError;
      }

      return promptContextResponse;
    },
    getDirectSendPolicyBundle: async (payload: Record<string, unknown>) => {
      state.directSendBundleCalls.push(payload);
      if (options.directSendBundleError) {
        throw options.directSendBundleError;
      }

      if (typeof options.directSendBundleResponse === "function") {
        return options.directSendBundleResponse(payload);
      }

      return options.directSendBundleResponse ?? buildDefaultDirectSendBundle(payload);
    },
    getFriendAgentConnections: async (username: string) => {
      state.friendConnectionCalls.push(username);
      const error = options.friendConnectionErrorsByUsername?.[username];
      if (error) {
        throw error;
      }

      const connections = state.friendConnectionsByUsername[username] ?? [];
      return {
        connections,
        raw: connections,
        state: connections.length > 0 ? "available" : "no_active_connections",
        username,
      };
    },
    getGroupFanoutPolicyBundle: async (payload: Record<string, unknown>) => {
      state.groupFanoutBundleCalls.push(payload);
      if (options.groupFanoutBundleError) {
        throw options.groupFanoutBundleError;
      }

      return options.groupFanoutBundleResponse ?? buildDefaultGroupFanoutBundle(payload);
    },
    getCurrentIdentity: async () => {
      state.currentIdentityCalls += 1;
      if (options.currentIdentityError) {
        throw options.currentIdentityError;
      }

      return currentIdentityResponse;
    },
    listGroups: async () => {
      state.groupCalls += 1;
      return state.groupsResponse;
    },
    listOwnAgentConnections: async () => {
      state.agentConnectionCalls += 1;
      return state.agentConnectionsResponse;
    },
    listFriendships: async (params?: { status?: string }) => {
      state.friendshipCalls.push(params ?? {});
      return (
        (params?.status
          ? options.friendshipsByStatus?.[params.status]
          : undefined) ?? state.friendshipsResponse
      );
    },
    listBlockedEvents: async (limit?: number) => {
      state.blockedEventCalls.push(limit ?? 0);
      return (
        options.blockedEventsResponse ?? {
          items: [],
        }
      );
    },
    listReviews: async (params?: { limit?: number; status?: string }) => {
      state.listReviewCalls.push(params ?? {});
      return (
        options.reviewsResponse ?? {
          items: [],
        }
      );
    },
    commitLocalDecision: async (
      payload: Record<string, unknown>,
      idempotencyKey?: string,
    ) => {
      state.localDecisionCommitCalls.push({ idempotencyKey, payload });
      if (options.localDecisionCommitError) {
        throw options.localDecisionCommitError;
      }

      return (
        options.localDecisionCommitResponse ??
        buildDefaultLocalDecisionCommitResponse(payload)
      );
    },
    pingAgentConnection: async (connectionId: string) => {
      state.pingCalls.push(connectionId);
      if (options.pingAgentConnectionError) {
        throw options.pingAgentConnectionError;
      }

      return { success: true };
    },
    reportOutcome: async (
      payload: Record<string, unknown>,
      idempotencyKey?: string,
    ) => {
      state.outcomeCalls.push({ idempotencyKey, payload });
      return { ok: true };
    },
    rejectFriendRequest: async (friendshipId: string) => {
      state.rejectFriendRequestCalls.push(friendshipId);
      if (options.rejectFriendRequestError) {
        throw options.rejectFriendRequestError;
      }

      return (
        options.rejectFriendRequestResponse ?? {
          friendshipId,
          raw: {
            friendshipId,
            status: "declined",
          },
          status: "declined",
          success: true,
        }
      );
    },
    registerAgentConnection: async (payload: Record<string, unknown>) => {
      state.registerAgentConnectionCalls.push(payload);
      if (options.registerAgentConnectionError) {
        throw options.registerAgentConnectionError;
      }

      const rawResponse = options.registerAgentConnectionResponse ?? {
        callback_secret: "callback-secret-from-server",
        connection_id: "conn_registered_default",
        mode: "webhook",
      };
      const connectionId =
        typeof rawResponse.connectionId === "string"
          ? rawResponse.connectionId
          : typeof rawResponse.connection_id === "string"
            ? rawResponse.connection_id
            : "conn_registered_default";
      const callbackSecret =
        typeof rawResponse.callbackSecret === "string"
          ? rawResponse.callbackSecret
          : typeof rawResponse.callback_secret === "string"
            ? rawResponse.callback_secret
            : undefined;
      state.agentConnectionsResponse = [
        {
          active: true,
          callbackUrl:
            typeof payload.callbackUrl === "string"
              ? payload.callbackUrl
              : undefined,
          framework:
            typeof payload.framework === "string"
              ? payload.framework
              : "openclaw",
          id: connectionId,
          label: typeof payload.label === "string" ? payload.label : "default",
          status: "active",
        },
      ];

      return {
        callbackSecret,
        connectionId,
        mode:
          typeof rawResponse.mode === "string" ? rawResponse.mode : undefined,
        raw: rawResponse,
        updated: rawResponse.updated === true,
      };
    },
    registerIdentity: async (payload: Record<string, unknown>) => {
      state.registerIdentityCalls.push(payload);
      if (options.registerIdentityError) {
        throw options.registerIdentityError;
      }

      return (
        options.registerIdentityResponse ?? {
          api_key: "mhl_bootstrap",
          username: payload.username,
        }
      );
    },
    resolveDraft: async (payload: Record<string, unknown>) => {
      state.resolveCalls.push(payload);
      if (options.resolveError) {
        throw options.resolveError;
      }

      return (
        options.resolveResponse ?? {
          decision: "allow",
          resolution_id: "res_123",
        }
      );
    },
    sendMessage: async (
      payload: Record<string, unknown>,
      idempotencyKey?: string,
    ) => {
      state.sendCalls.push({ idempotencyKey, payload });
      if (options.sendError) {
        throw options.sendError;
      }

      return {
        message_id: "msg_123",
      };
    },
    sendFriendRequest: async (username: string) => {
      state.friendRequestCalls.push(username);
      if (options.sendFriendRequestError) {
        throw options.sendFriendRequestError;
      }

      return (
        options.sendFriendRequestResponse ?? {
          friendshipId: `fr_pending_${username}`,
          raw: {
            friendshipId: `fr_pending_${username}`,
            status: "pending",
          },
          status: "pending",
          success: true,
        }
      );
    },
  };

  return {
    client: client as never,
    state,
  };
}

function createMockPluginApi(pluginConfig: Record<string, unknown>): {
  api: never;
  commands: RegisteredCommand[];
  heartbeatRequests: RecordedHeartbeatRequest[];
  hooks: RegisteredHook[];
  routes: RegisteredHttpRoute[];
  services: RegisteredService[];
  systemEvents: RecordedSystemEvent[];
  tools: RegisteredTool[];
} {
  const commands: RegisteredCommand[] = [];
  const heartbeatRequests: RecordedHeartbeatRequest[] = [];
  const hooks: RegisteredHook[] = [];
  const tools: RegisteredTool[] = [];
  const routes: RegisteredHttpRoute[] = [];
  const services: RegisteredService[] = [];
  const systemEvents: RecordedSystemEvent[] = [];

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
    registerCommand: (commandInput: unknown) => {
      const command = parseRegisteredCommand([commandInput]);
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
    registerService: (service: RegisteredService) => {
      services.push(service);
    },
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
    source: "tests/openclaw-plugin",
    version: "1.2.3",
  };

  return {
    api: api as never,
    commands,
    heartbeatRequests,
    hooks,
    routes,
    services,
    systemEvents,
    tools,
  };
}

function createTempRuntimeBootstrapStore(): {
  cleanup: () => void;
  store: MahiloRuntimeBootstrapStore;
} {
  const directory = mkdtempSync(join(tmpdir(), "mahilo-openclaw-bootstrap-"));
  const path = join(directory, "runtime-store.json");

  return {
    cleanup: () => {
      rmSync(directory, {
        force: true,
        recursive: true,
      });
    },
    store: new MahiloRuntimeBootstrapStore({
      path,
    }),
  };
}

function buildInboundWebhookRawBody(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    message: "Incoming Mahilo request.",
    message_id: "msg_inbound_1",
    recipient_connection_id: "conn_sender",
    sender: "alice",
    sender_agent: "openclaw",
    timestamp: "2026-03-08T12:15:00.000Z",
    ...overrides,
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
    body: () => JSON.parse(body) as Record<string, unknown>,
    response,
    status: () => response.statusCode,
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

  const name = typeof candidate.name === "string" ? candidate.name : undefined;
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

  const name = typeof candidate.name === "string" ? candidate.name : undefined;
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

function findCommand(
  commands: RegisteredCommand[],
  name: string,
): RegisteredCommand {
  const command = commands.find((candidate) => candidate.name === name);
  if (!command) {
    throw new Error(`expected command ${name} to be registered`);
  }

  return command;
}

async function runMahiloOperatorCommand(
  commands: RegisteredCommand[],
  args: string,
): Promise<unknown> {
  const command = findCommand(commands, "mahilo");
  return command.execute({ args });
}

function findHook(hooks: RegisteredHook[], name: string): RegisteredHook {
  const hook = hooks.find((candidate) => candidate.name === name);
  if (!hook) {
    throw new Error(`expected hook ${name} to be registered`);
  }

  return hook;
}

describe("createMahiloOpenClawPlugin", () => {
  it("registers stable OpenClaw-native tool names and a single operator command", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, commands, hooks, routes, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "ask_network",
      "manage_network",
      "send_message",
      "set_boundaries",
    ]);
    expect(commands.map((command) => command.name)).toEqual(["mahilo"]);
    expect(hooks.map((hook) => hook.name)).toEqual(
      expect.arrayContaining([
        "before_prompt_build",
        "after_tool_call",
        "agent_end",
      ]),
    );
    expect(routes).toHaveLength(1);
  });

  it("registers webhook route with explicit auth mode and raw-body hints", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, routes } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
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
      createClient: () => client,
    });
    const { api, routes } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
      callbackPath: "/hooks/mahilo",
    });

    await plugin.register?.(api);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe("/hooks/mahilo");
  });

  it("bootstraps identity and default sender from inside mahilo setup without a configured apiKey", async () => {
    const runtimeStore = createTempRuntimeBootstrapStore();

    try {
      const { client, state } = createMockContractClient({
        agentConnectionsResponse: [],
        currentIdentityResponse: {
          raw: {
            username: "bootstrap-user",
          },
          username: "bootstrap-user",
        },
        registerAgentConnectionResponse: {
          callback_secret: "callback-secret-from-server",
          connection_id: "conn_registered_default",
          mode: "webhook",
        },
        registerIdentityResponse: {
          api_key: "mhl_bootstrap",
          username: "bootstrap-user",
        },
      });
      const plugin = createMahiloOpenClawPlugin({
        createClient: () => client,
        runtimeBootstrapStore: runtimeStore.store,
      });
      const { api, commands, tools } = createMockPluginApi({
        baseUrl: "https://mahilo.example",
        callbackUrl: "https://openclaw.example/mahilo/incoming",
      });

      await plugin.register?.(api);

      expect(commands.map((command) => command.name)).toEqual(["mahilo"]);
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "ask_network",
        "manage_network",
        "send_message",
        "set_boundaries",
      ]);

      const result = await runMahiloOperatorCommand(
        commands,
        "setup bootstrap-user mhinv_bootstrap_token",
      );

      expect(state.registerIdentityCalls).toEqual([
        {
          displayName: undefined,
          inviteToken: "mhinv_bootstrap_token",
          username: "bootstrap-user",
        },
      ]);
      expect(state.registerAgentConnectionCalls).toEqual([
        expect.objectContaining({
          callbackUrl: "https://openclaw.example/mahilo/incoming",
          framework: "openclaw",
          label: "default",
          mode: "webhook",
          rotateSecret: true,
        }),
      ]);
      expect(state.pingCalls).toEqual(["conn_registered_default"]);
      const replyText =
        typeof (result as Record<string, unknown>).text === "string"
          ? ((result as Record<string, unknown>).text as string)
          : "";
      expect(replyText).toContain("saved in the local Mahilo runtime store");
      expect(replyText).toContain('"credentialSource": "fresh_registration"');
      expect(replyText).toContain('"connectionId": "conn_registered_default"');

      expect(runtimeStore.store.read("https://mahilo.example")).toMatchObject({
        apiKey: "mhl_bootstrap",
        callbackConnectionId: "conn_registered_default",
        callbackSecret: "callback-secret-from-server",
        callbackUrl: "https://openclaw.example/mahilo/incoming",
        username: "bootstrap-user",
      });
    } finally {
      runtimeStore.cleanup();
    }
  });

  it("uses stored bootstrap credentials to register the full plugin surface on restart", async () => {
    const runtimeStore = createTempRuntimeBootstrapStore();

    try {
      runtimeStore.store.write("https://mahilo.example", {
        apiKey: "mhl_cached_bootstrap",
        callbackSecret: "callback-secret-from-store",
        callbackUrl: "https://openclaw.example/mahilo/incoming",
        username: "cached-user",
      });

      const { client } = createMockContractClient();
      const plugin = createMahiloOpenClawPlugin({
        createClient: (config) => {
          expect(config.apiKey).toBe("mhl_cached_bootstrap");
          return client;
        },
        runtimeBootstrapStore: runtimeStore.store,
      });
      const { api, commands, tools } = createMockPluginApi({
        baseUrl: "https://mahilo.example",
      });

      await plugin.register?.(api);

      expect(commands.map((command) => command.name)).toEqual(["mahilo"]);
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "ask_network",
        "manage_network",
        "send_message",
        "set_boundaries",
      ]);
    } finally {
      runtimeStore.cleanup();
    }
  });

  it("falls back to localhost callback detection when no callbackUrl is configured", async () => {
    const runtimeStore = createTempRuntimeBootstrapStore();

    try {
      const { client } = createMockContractClient({
        agentConnectionsResponse: [],
      });
      const plugin = createMahiloOpenClawPlugin({
        createClient: () => client,
        runtimeBootstrapStore: runtimeStore.store,
      });
      const { api, commands } = createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
      });

      await plugin.register?.(api);

      const result = await runMahiloOperatorCommand(commands, "setup");

      const replyText =
        typeof (result as Record<string, unknown>).text === "string"
          ? ((result as Record<string, unknown>).text as string)
          : "";
      expect(replyText).toContain("Connectivity checks passed");
      expect(replyText).toContain("http://localhost:18789/mahilo/incoming");
      expect(replyText).toContain('"status": "success"');
    } finally {
      runtimeStore.cleanup();
    }
  });

  it("reports a gateway exposure blocker when only localhost callback detection is available and the ping fails", async () => {
    const runtimeStore = createTempRuntimeBootstrapStore();

    try {
      const { client } = createMockContractClient({
        agentConnectionsResponse: [],
        pingAgentConnectionError: new Error("connect ECONNREFUSED"),
      });
      const plugin = createMahiloOpenClawPlugin({
        createClient: () => client,
        runtimeBootstrapStore: runtimeStore.store,
      });
      const { api, commands } = createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
      });

      await plugin.register?.(api);

      const result = await runMahiloOperatorCommand(commands, "setup");
      const replyText =
        typeof (result as Record<string, unknown>).text === "string"
          ? ((result as Record<string, unknown>).text as string)
          : "";

      expect(replyText).toContain('"kind": "callback_readiness"');
      expect(replyText).toContain("Enable gateway remote/Tailscale exposure");
      expect(replyText).toContain('"status": "blocked"');
    } finally {
      runtimeStore.cleanup();
    }
  });

  it("auto-registers the default sender on startup when an apiKey is configured", async () => {
    const runtimeStore = createTempRuntimeBootstrapStore();

    try {
      const { client, state } = createMockContractClient({
        agentConnectionsResponse: [],
      });
      const plugin = createMahiloOpenClawPlugin({
        createClient: () => client,
        runtimeBootstrapStore: runtimeStore.store,
      });
      const { api, services, tools } = createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
      });

      await plugin.register?.(api);

      expect(services.map((service) => service.id)).toContain(
        "mahilo-auto-register",
      );

      await services[0]!.start({
        config: {
          gateway: {
            port: 19123,
          },
        },
        logger: {
          info: () => {},
          warn: () => {},
        },
        stateDir: "/tmp/mahilo-openclaw-tests",
      });

      expect(state.registerAgentConnectionCalls).toEqual([
        expect.objectContaining({
          callbackUrl: "http://localhost:19123/mahilo/incoming",
          framework: "openclaw",
          label: "default",
          mode: "webhook",
        }),
      ]);
      expect(runtimeStore.store.read("https://mahilo.example")).toMatchObject({
        callbackConnectionId: "conn_registered_default",
        callbackSecret: "callback-secret-from-server",
        callbackUrl: "http://localhost:19123/mahilo/incoming",
      });

      const tool = findTool(tools, "send_message");
      const result = await tool.execute("tool_call_auto_setup_1", {
        message: "hello",
        recipient: "alice",
      });

      expect(result).toMatchObject({
        details: {
          status: "sent",
        },
      });
      expect(state.sendCalls[0]?.payload.sender_connection_id).toBe(
        "conn_registered_default",
      );
    } finally {
      runtimeStore.cleanup();
    }
  });

  it("returns agent-facing bootstrap guidance from Mahilo tools before setup is finished", async () => {
    const { client, state } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, tools } = createMockPluginApi({
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "send_message");
    const result = await tool.execute("tool_call_needs_setup_1", {
      message: "hello",
      recipient: "alice",
    });

    expect(state.agentConnectionCalls).toBe(0);
    expect(isRecord(result)).toBe(true);
    if (!isRecord(result)) {
      throw new Error("expected send_message to return a structured error");
    }

    const contentBlocks = Array.isArray(result.content) ? result.content : [];
    const firstBlock = contentBlocks[0];
    const replyText =
      isRecord(firstBlock) && typeof firstBlock.text === "string"
        ? firstBlock.text
        : "";

    expect(replyText).toContain(
      "Mahilo is not bootstrapped yet.",
    );
    expect(replyText).toContain(
      "POST https://mahilo.example/api/v1/auth/register",
    );
    expect(replyText).toContain(
      "do NOT ask the human to run commands",
    );
    expect(replyText).toContain("config.patch");
    expect(replyText).toContain('"apiKey"');
    expect(replyText).toContain("invite token (mhinv_...) is NOT an API key");
    expect(replyText).not.toContain(
      "could not find any agent connections for the current identity",
    );
  });

  it("starts using Mahilo tools without restart after the runtime bootstrap store gets an api key", async () => {
    const runtimeStore = createTempRuntimeBootstrapStore();

    try {
      const createClientCalls: Array<string | undefined> = [];
      const { client, state } = createMockContractClient();
      const plugin = createMahiloOpenClawPlugin({
        createClient: (nextConfig) => {
          createClientCalls.push(nextConfig.apiKey);
          return client;
        },
        runtimeBootstrapStore: runtimeStore.store,
      });
      const { api, tools } = createMockPluginApi({
        baseUrl: "https://mahilo.example",
      });

      await plugin.register?.(api);

      runtimeStore.store.write("https://mahilo.example", {
        apiKey: "mhl_bootstrap_from_agent",
        username: "sandboxoc",
      });

      const tool = findTool(tools, "manage_network");
      const result = await tool.execute("tool_call_runtime_store_1", {
        action: "list_contacts",
      });

      expect(state.friendshipCalls.length).toBeGreaterThan(0);
      expect(createClientCalls).toContain("mhl_bootstrap_from_agent");
      expect(isRecord(result)).toBe(true);
      if (!isRecord(result)) {
        throw new Error(
          "expected manage_network to return a structured response",
        );
      }

      const contentBlocks = Array.isArray(result.content) ? result.content : [];
      const firstBlock = contentBlocks[0];
      const replyText =
        isRecord(firstBlock) && typeof firstBlock.text === "string"
          ? firstBlock.text
          : "";

      expect(replyText).not.toContain("not bootstrapped");
    } finally {
      runtimeStore.cleanup();
    }
  });

  it("routes inbound webhook callbacks back to the originating session by correlation id", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const {
      api,
      commands,
      heartbeatRequests,
      hooks,
      routes,
      systemEvents,
      tools,
    } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "send_message");
    const outboundInput = {
      correlationId: "corr_routing_1",
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute("tool_call_route_1", outboundInput);

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: outboundInput,
        result: toolResult,
        toolName: "send_message",
      },
      {
        agentId: "mahilo-agent",
        runId: "run_route_1",
        sessionKey: "session_route_1",
        toolCallId: "tool_call_route_1",
        toolName: "send_message",
      },
    );

    systemEvents.length = 0;
    heartbeatRequests.length = 0;

    const rawBody = buildInboundWebhookRawBody({
      correlation_id: "corr_routing_1",
      message: "Replying in the same Mahilo thread.",
      recipient_connection_id: "conn_sender",
      sender_connection_id: "conn_alice",
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateCallbackSignature(
      rawBody,
      CALLBACK_SECRET,
      timestamp,
    );
    const request = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_1",
        "x-mahilo-signature": `sha256=${signature}`,
        "x-mahilo-timestamp": String(timestamp),
      },
      rawBody,
    });
    const response = createMockWebhookResponse();

    await routes[0]!.handler(request, response.response);

    expect(response.status()).toBe(200);
    expect(response.body()).toMatchObject({
      messageId: "msg_inbound_1",
      status: "accepted",
    });
    expect(systemEvents).toEqual([
      expect.objectContaining({
        contextKey: "mahilo:inbound:direct:msg_inbound_1",
        sessionKey: "session_route_1",
        text: expect.stringContaining("[MahiloInbound/v1]"),
      }),
    ]);
    expect(systemEvents[0]?.text).toContain("[thread corr_routing_1]");
    expect(systemEvents[0]?.text).toContain(
      "Replying in the same Mahilo thread.",
    );
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-agent",
        reason: "mahilo:inbound-message",
        sessionKey: "session_route_1",
      },
    ]);
  });

  it("falls back to sender and local connection routing when correlation id is absent", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const {
      api,
      commands,
      heartbeatRequests,
      hooks,
      routes,
      systemEvents,
      tools,
    } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "send_message");
    const outboundInput = {
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute("tool_call_route_2", outboundInput);

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: outboundInput,
        result: toolResult,
        toolName: "send_message",
      },
      {
        agentId: "mahilo-agent-2",
        runId: "run_route_2",
        sessionKey: "session_route_2",
        toolCallId: "tool_call_route_2",
        toolName: "send_message",
      },
    );

    systemEvents.length = 0;
    heartbeatRequests.length = 0;

    const rawBody = buildInboundWebhookRawBody({
      message: "Fallback route should still hit the active session.",
      recipient_connection_id: "conn_sender",
      sender: "Alice",
      sender_connection_id: "conn_alice",
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateCallbackSignature(
      rawBody,
      CALLBACK_SECRET,
      timestamp,
    );
    const request = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_1",
        "x-mahilo-signature": `sha256=${signature}`,
        "x-mahilo-timestamp": String(timestamp),
      },
      rawBody,
    });
    const response = createMockWebhookResponse();

    await routes[0]!.handler(request, response.response);

    expect(response.status()).toBe(200);
    expect(systemEvents).toEqual([
      expect.objectContaining({
        sessionKey: "session_route_2",
        text: expect.stringContaining(
          "Fallback route should still hit the active session.",
        ),
      }),
    ]);
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-agent-2",
        reason: "mahilo:inbound-message",
        sessionKey: "session_route_2",
      },
    ]);
  });

  it("falls back to the main OpenClaw session when no exact inbound route can be resolved", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const { api, heartbeatRequests, routes, systemEvents } =
      createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
      });

    await plugin.register?.(api);

    const rawBody = buildInboundWebhookRawBody({
      message: "Deliver this even without a remembered route.",
      message_id: "msg_inbound_main_1",
      recipient_connection_id: "conn_sender",
      sender: "Alice",
      sender_connection_id: "conn_alice",
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateCallbackSignature(
      rawBody,
      CALLBACK_SECRET,
      timestamp,
    );
    const request = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_main_1",
        "x-mahilo-signature": `sha256=${signature}`,
        "x-mahilo-timestamp": String(timestamp),
      },
      rawBody,
    });
    const response = createMockWebhookResponse();

    await routes[0]!.handler(request, response.response);

    expect(response.status()).toBe(200);
    expect(systemEvents).toEqual([
      expect.objectContaining({
        sessionKey: "main",
        text: expect.stringContaining(
          "Deliver this even without a remembered route.",
        ),
      }),
    ]);
    expect(heartbeatRequests).toEqual([
      {
        agentId: undefined,
        reason: "mahilo:inbound-message",
        sessionKey: "main",
      },
    ]);
  });

  it("routes inbound webhook callbacks back to the originating session after ask_network fan-out", async () => {
    const { client } = createMockContractClient({
      friendConnectionsByUsername: {
        alice: [{ active: true, id: "conn_alice" }],
      },
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const {
      api,
      commands,
      heartbeatRequests,
      hooks,
      routes,
      systemEvents,
      tools,
    } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "ask_network");
    const outboundInput = {
      correlationId: "corr_network_route_1",
      question: "Who knows a good ramen spot?",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute(
      "tool_call_network_route_1",
      outboundInput,
    );

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: outboundInput,
        result: toolResult,
        toolName: "ask_network",
      },
      {
        agentId: "mahilo-network-agent",
        runId: "run_network_route_1",
        sessionKey: "session_network_route_1",
        toolCallId: "tool_call_network_route_1",
        toolName: "ask_network",
      },
    );

    systemEvents.length = 0;
    heartbeatRequests.length = 0;

    const rawBody = buildInboundWebhookRawBody({
      correlation_id: "corr_network_route_1",
      message: "Try Mensho for the broth.",
      message_id: "msg_inbound_network_1",
      recipient_connection_id: "conn_sender",
      sender: "Alice",
      sender_connection_id: "conn_alice",
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateCallbackSignature(
      rawBody,
      CALLBACK_SECRET,
      timestamp,
    );
    const request = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_network_1",
        "x-mahilo-signature": `sha256=${signature}`,
        "x-mahilo-timestamp": String(timestamp),
      },
      rawBody,
    });
    const response = createMockWebhookResponse();

    await routes[0]!.handler(request, response.response);

    expect(response.status()).toBe(200);
    expect(systemEvents).toEqual([
      expect.objectContaining({
        contextKey: "mahilo:inbound:direct:msg_inbound_network_1",
        sessionKey: "session_network_route_1",
        text: expect.stringContaining("Try Mensho for the broth."),
      }),
    ]);
    expect(systemEvents[0]?.text).toContain("Mahilo ask-around update");
    expect(systemEvents[0]?.text).toContain(
      "Question: Who knows a good ramen spot?",
    );
    expect(systemEvents[0]?.text).toContain(
      "Synthesized summary (plugin-generated):",
    );
    expect(systemEvents[0]?.text).toContain("Direct replies:");
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-network-agent",
        reason: "mahilo:inbound-message",
        sessionKey: "session_network_route_1",
      },
    ]);

    const networkResult = await runMahiloOperatorCommand(commands, "network");

    const networkReplyText =
      typeof (networkResult as Record<string, unknown>).text === "string"
        ? ((networkResult as Record<string, unknown>).text as string)
        : "";
    expect(networkReplyText).toContain("Mahilo product signals (last 7 days):");
    expect(networkReplyText).toContain('"command": "mahilo network"');
    expect(networkReplyText).toContain('"queriesSent": 1');
  });

  it("recovers ask_network session routing when after_tool_call omits sessionKey", async () => {
    const { client } = createMockContractClient({
      friendConnectionsByUsername: {
        alice: [{ active: true, id: "conn_alice" }],
      },
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const { api, heartbeatRequests, hooks, routes, systemEvents, tools } =
      createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
      });

    await plugin.register?.(api);

    const tool = findTool(tools, "ask_network");
    const beforeToolCall = findHook(hooks, "before_tool_call");
    const afterToolCall = findHook(hooks, "after_tool_call");
    const outboundInput = {
      correlationId: "corr_network_route_recovered_1",
      question: "Who knows a good ramen spot?",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute(
      "tool_call_network_route_recovered_1",
      outboundInput,
    );

    await beforeToolCall.execute(
      {
        params: outboundInput,
        toolName: "ask_network",
      },
      {
        agentId: "mahilo-network-agent",
        sessionKey: "session_network_route_recovered_1",
        toolName: "ask_network",
      },
    );

    await afterToolCall.execute(
      {
        params: outboundInput,
        result: toolResult,
        toolName: "ask_network",
      },
      {
        agentId: "mahilo-network-agent",
        runId: "run_network_route_recovered_1",
        toolCallId: "tool_call_network_route_recovered_1",
        toolName: "ask_network",
      },
    );

    systemEvents.length = 0;
    heartbeatRequests.length = 0;

    const rawBody = buildInboundWebhookRawBody({
      correlation_id: "corr_network_route_recovered_1",
      message: "Try Mensho for the broth.",
      message_id: "msg_inbound_network_recovered_1",
      recipient_connection_id: "conn_sender",
      sender: "Alice",
      sender_connection_id: "conn_alice",
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateCallbackSignature(
      rawBody,
      CALLBACK_SECRET,
      timestamp,
    );
    const request = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_network_recovered_1",
        "x-mahilo-signature": `sha256=${signature}`,
        "x-mahilo-timestamp": String(timestamp),
      },
      rawBody,
    });
    const response = createMockWebhookResponse();

    await routes[0]!.handler(request, response.response);

    expect(response.status()).toBe(200);
    expect(systemEvents).toEqual([
      expect.objectContaining({
        contextKey: "mahilo:inbound:direct:msg_inbound_network_recovered_1",
        sessionKey: "session_network_route_recovered_1",
        text: expect.stringContaining("Try Mensho for the broth."),
      }),
    ]);
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-network-agent",
        reason: "mahilo:inbound-message",
        sessionKey: "session_network_route_recovered_1",
      },
    ]);
  });

  it("routes ask_network replies using before_tool_call route metadata when live after_tool_call lacks ids", async () => {
    const { client } = createMockContractClient({
      friendConnectionsByUsername: {
        alice: [{ active: true, id: "conn_alice" }],
      },
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const { api, heartbeatRequests, hooks, routes, systemEvents, tools } =
      createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
      });

    await plugin.register?.(api);

    const tool = findTool(tools, "ask_network");
    const beforeToolCall = findHook(hooks, "before_tool_call");
    const afterToolCall = findHook(hooks, "after_tool_call");
    const outboundInput = {
      correlationId: "corr_network_route_live_contract_1",
      question: "Who knows a good ramen spot?",
      senderConnectionId: "conn_sender",
    };
    const beforeResult = (await beforeToolCall.execute(
      {
        params: outboundInput,
        toolName: "ask_network",
      },
      {
        agentId: "mahilo-network-agent",
        sessionKey: "session_network_route_live_contract_1",
        toolName: "ask_network",
      },
    )) as { params?: Record<string, unknown> } | undefined;
    const runtimeParams = {
      ...outboundInput,
      ...(beforeResult?.params ?? {}),
    };
    const toolResult = await tool.execute(
      "tool_call_network_route_live_contract_1",
      runtimeParams,
    );

    expect(beforeResult).toEqual({
      params: {
        __mahiloRouteContext: {
          agentId: "mahilo-network-agent",
          sessionKey: "session_network_route_live_contract_1",
        },
      },
    });

    await beforeToolCall.execute(
      {
        params: {
          action: "list",
        },
        toolName: "manage_network",
      },
      {
        agentId: "main-agent",
        sessionKey: "main",
        toolName: "manage_network",
      },
    );

    await afterToolCall.execute(
      {
        params: runtimeParams,
        result: toolResult,
        toolName: "ask_network",
      },
      {
        toolName: "ask_network",
      },
    );

    systemEvents.length = 0;
    heartbeatRequests.length = 0;

    const rawBody = buildInboundWebhookRawBody({
      correlation_id: "corr_network_route_live_contract_1",
      message: "Try Mensho for the broth.",
      message_id: "msg_inbound_network_live_contract_1",
      recipient_connection_id: "conn_sender",
      sender: "Alice",
      sender_connection_id: "conn_alice",
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateCallbackSignature(
      rawBody,
      CALLBACK_SECRET,
      timestamp,
    );
    const request = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_network_live_contract_1",
        "x-mahilo-signature": `sha256=${signature}`,
        "x-mahilo-timestamp": String(timestamp),
      },
      rawBody,
    });
    const response = createMockWebhookResponse();

    await routes[0]!.handler(request, response.response);

    expect(response.status()).toBe(200);
    expect(systemEvents).toEqual([
      expect.objectContaining({
        contextKey: "mahilo:inbound:direct:msg_inbound_network_live_contract_1",
        sessionKey: "session_network_route_live_contract_1",
        text: expect.stringContaining("Try Mensho for the broth."),
      }),
    ]);
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-network-agent",
        reason: "mahilo:inbound-message",
        sessionKey: "session_network_route_live_contract_1",
      },
    ]);
  });

  it("shares ask_network routing across hook and webhook plugin instances while keeping main fallback for unrelated replies", async () => {
    const { client } = createMockContractClient({
      friendConnectionsByUsername: {
        alice: [{ active: true, id: "conn_alice" }],
      },
    });
    const hookPlugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const webhookPlugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const {
      api: hookApi,
      hooks,
      tools,
    } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });
    const {
      api: webhookApi,
      heartbeatRequests,
      routes,
      systemEvents,
    } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await hookPlugin.register?.(hookApi);
    await webhookPlugin.register?.(webhookApi);

    const tool = findTool(tools, "ask_network");
    const beforeToolCall = findHook(hooks, "before_tool_call");
    const afterToolCall = findHook(hooks, "after_tool_call");
    const outboundInput = {
      correlationId: "corr_network_route_shared_state_1",
      question: "Who knows a good ramen spot?",
      senderConnectionId: "conn_sender",
    };
    const beforeResult = (await beforeToolCall.execute(
      {
        params: outboundInput,
        toolName: "ask_network",
      },
      {
        agentId: "mahilo-network-agent",
        sessionKey: "session_network_route_shared_state_1",
        toolName: "ask_network",
      },
    )) as { params?: Record<string, unknown> } | undefined;
    const runtimeParams = {
      ...outboundInput,
      ...(beforeResult?.params ?? {}),
    };
    const toolResult = await tool.execute(
      "tool_call_network_route_shared_state_1",
      runtimeParams,
    );

    await afterToolCall.execute(
      {
        params: runtimeParams,
        result: toolResult,
        toolName: "ask_network",
      },
      {
        toolName: "ask_network",
      },
    );

    const correlatedRawBody = buildInboundWebhookRawBody({
      correlation_id: "corr_network_route_shared_state_1",
      message: "Try Mensho for the broth.",
      message_id: "msg_inbound_network_shared_state_1",
      recipient_connection_id: "conn_sender",
      sender: "Alice",
      sender_connection_id: "conn_alice",
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const correlatedSignature = generateCallbackSignature(
      correlatedRawBody,
      CALLBACK_SECRET,
      timestamp,
    );
    const correlatedRequest = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_network_shared_state_1",
        "x-mahilo-signature": `sha256=${correlatedSignature}`,
        "x-mahilo-timestamp": String(timestamp),
      },
      rawBody: correlatedRawBody,
    });
    const correlatedResponse = createMockWebhookResponse();

    await routes[0]!.handler(correlatedRequest, correlatedResponse.response);

    expect(correlatedResponse.status()).toBe(200);
    expect(systemEvents).toEqual([
      expect.objectContaining({
        contextKey: "mahilo:inbound:direct:msg_inbound_network_shared_state_1",
        sessionKey: "session_network_route_shared_state_1",
        text: expect.stringContaining("Try Mensho for the broth."),
      }),
    ]);
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-network-agent",
        reason: "mahilo:inbound-message",
        sessionKey: "session_network_route_shared_state_1",
      },
    ]);

    systemEvents.length = 0;
    heartbeatRequests.length = 0;

    const unrelatedRawBody = buildInboundWebhookRawBody({
      correlation_id: "corr_network_route_unrelated_1",
      message: "This should stay on main because no route matches.",
      message_id: "msg_inbound_network_unrelated_1",
      recipient_connection_id: "conn_sender",
      sender: "Bob",
      sender_connection_id: "conn_bob",
    });
    const unrelatedSignature = generateCallbackSignature(
      unrelatedRawBody,
      CALLBACK_SECRET,
      timestamp + 1,
    );
    const unrelatedRequest = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_network_unrelated_1",
        "x-mahilo-signature": `sha256=${unrelatedSignature}`,
        "x-mahilo-timestamp": String(timestamp + 1),
      },
      rawBody: unrelatedRawBody,
    });
    const unrelatedResponse = createMockWebhookResponse();

    await routes[0]!.handler(unrelatedRequest, unrelatedResponse.response);

    expect(unrelatedResponse.status()).toBe(200);
    expect(systemEvents).toEqual([
      expect.objectContaining({
        sessionKey: "main",
        text: expect.stringContaining(
          "This should stay on main because no route matches.",
        ),
      }),
    ]);
    expect(heartbeatRequests).toEqual([
      {
        agentId: undefined,
        reason: "mahilo:inbound-message",
        sessionKey: "main",
      },
    ]);
  });

  it("keeps ask_network reply routing tied to the originating toolCallId when another session becomes active first", async () => {
    const { client } = createMockContractClient({
      friendConnectionsByUsername: {
        alice: [{ active: true, id: "conn_alice" }],
      },
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const { api, heartbeatRequests, hooks, routes, systemEvents, tools } =
      createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
      });

    await plugin.register?.(api);

    const tool = findTool(tools, "ask_network");
    const beforeToolCall = findHook(hooks, "before_tool_call");
    const afterToolCall = findHook(hooks, "after_tool_call");
    const outboundInput = {
      correlationId: "corr_network_route_tool_call_1",
      question: "Who knows a good ramen spot?",
      senderConnectionId: "conn_sender",
    };
    const toolCallId = "tool_call_network_route_tool_call_1";
    const toolResult = await tool.execute(toolCallId, outboundInput);

    await beforeToolCall.execute(
      {
        params: outboundInput,
        toolName: "ask_network",
      },
      {
        agentId: "mahilo-network-agent",
        sessionKey: "session_network_route_tool_call_1",
        toolCallId,
        toolName: "ask_network",
      },
    );

    await beforeToolCall.execute(
      {
        params: {
          action: "list",
        },
        toolName: "manage_network",
      },
      {
        agentId: "main-agent",
        sessionKey: "main",
        toolCallId: "tool_call_other_session_1",
        toolName: "manage_network",
      },
    );

    await afterToolCall.execute(
      {
        params: outboundInput,
        result: toolResult,
        toolName: "ask_network",
      },
      {
        agentId: "mahilo-network-agent",
        runId: "run_network_route_tool_call_1",
        toolCallId,
        toolName: "ask_network",
      },
    );

    systemEvents.length = 0;
    heartbeatRequests.length = 0;

    const rawBody = buildInboundWebhookRawBody({
      correlation_id: "corr_network_route_tool_call_1",
      message: "Try Mensho for the broth.",
      message_id: "msg_inbound_network_tool_call_1",
      recipient_connection_id: "conn_sender",
      sender: "Alice",
      sender_connection_id: "conn_alice",
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateCallbackSignature(
      rawBody,
      CALLBACK_SECRET,
      timestamp,
    );
    const request = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_network_tool_call_1",
        "x-mahilo-signature": `sha256=${signature}`,
        "x-mahilo-timestamp": String(timestamp),
      },
      rawBody,
    });
    const response = createMockWebhookResponse();

    await routes[0]!.handler(request, response.response);

    expect(response.status()).toBe(200);
    expect(systemEvents).toEqual([
      expect.objectContaining({
        contextKey: "mahilo:inbound:direct:msg_inbound_network_tool_call_1",
        sessionKey: "session_network_route_tool_call_1",
        text: expect.stringContaining("Try Mensho for the broth."),
      }),
    ]);
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-network-agent",
        reason: "mahilo:inbound-message",
        sessionKey: "session_network_route_tool_call_1",
      },
    ]);
  });

  it("routes group ask-around replies back into the originating OpenClaw thread with attribution", async () => {
    const pluginState = new InMemoryPluginState();
    const { client, state } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      pluginState,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const { api, heartbeatRequests, hooks, routes, systemEvents, tools } =
      createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
      });

    await plugin.register?.(api);

    const tool = findTool(tools, "ask_network");
    const outboundInput = {
      group: "the hiking group",
      question: "Has anyone done Half Dome recently?",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute(
      "tool_call_group_route_1",
      outboundInput,
    );
    const toolResultForHook = structuredClone(toolResult);
    const correlationId = String(
      (toolResultForHook.details as { correlationId?: string }).correlationId,
    );

    expect(state.groupCalls).toBe(1);
    expect(state.groupFanoutBundleCalls).toHaveLength(1);
    expect(state.localDecisionCommitCalls).toHaveLength(1);
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0]?.payload).toMatchObject({
      correlation_id: expect.any(String),
      recipient: "alice",
      recipient_type: "user",
      resolution_id: "res_group_default_usr_alice",
      sender_connection_id: "conn_sender",
    });
    expect(toolResult).toMatchObject({
      details: {
        action: "ask_around",
        correlationId: expect.any(String),
        deliveries: [
          expect.objectContaining({
            messageId: "msg_123",
            recipient: "alice",
            recipientType: "user",
            status: "awaiting_reply",
          }),
        ],
        replyRecipients: [
          expect.objectContaining({
            messageId: "msg_123",
            recipient: "alice",
            recipientType: "user",
          }),
        ],
        senderConnectionId: "conn_sender",
        target: {
          groupId: "grp_hiking",
          groupName: "Hiking Crew",
          kind: "group",
          memberCount: 4,
        },
      },
    });

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: outboundInput,
        result: toolResultForHook,
        toolName: "ask_network",
      },
      {
        agentId: "mahilo-group-agent",
        runId: "run_group_route_1",
        sessionKey: "session_group_route_1",
        toolCallId: "tool_call_group_route_1",
        toolName: "ask_network",
      },
    );
    expect(
      pluginState.getAskAroundSession(
        correlationId,
      ),
    ).toMatchObject({
      correlationId,
      expectedParticipants: [
        {
          label: "alice",
          recipient: "alice",
        },
      ],
      target: {
        groupId: "grp_hiking",
        groupName: "Hiking Crew",
        kind: "group",
      },
    });
    expect(
      pluginState.resolveInboundRoute({
        groupId: "grp_hiking",
        localConnectionId: "conn_sender",
      }),
    ).toMatchObject({
      sessionKey: "session_group_route_1",
    });
    expect(
      pluginState.resolveInboundRoute({
        inResponseToMessageId: "msg_123",
      }),
    ).toMatchObject({
      sessionKey: "session_group_route_1",
    });

    systemEvents.length = 0;
    heartbeatRequests.length = 0;

    const rawBody = buildInboundWebhookRawBody({
      group_id: "grp_hiking",
      group_name: "Hiking Crew",
      message: "We went last weekend; cables were crowded.",
      message_id: "msg_inbound_group_1",
      recipient_connection_id: "conn_sender",
      sender: "Alice",
      sender_connection_id: "conn_alice",
      timestamp: "2026-03-10T12:15:00.000Z",
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateCallbackSignature(
      rawBody,
      CALLBACK_SECRET,
      timestamp,
    );
    const request = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_group_1",
        "x-mahilo-signature": `sha256=${signature}`,
        "x-mahilo-timestamp": String(timestamp),
      },
      rawBody,
    });
    const response = createMockWebhookResponse();

    await routes[0]!.handler(request, response.response);

    expect(response.status()).toBe(200);
    expect(systemEvents).toEqual([
      expect.objectContaining({
        contextKey: "mahilo:inbound:group:msg_inbound_group_1",
        sessionKey: "session_group_route_1",
        text: expect.stringContaining("Mahilo ask-around update"),
      }),
    ]);
    const eventText = systemEvents[0]?.text ?? "";
    expect(eventText).toContain(
      "Question: Has anyone done Half Dome recently?",
    );
    expect(eventText).toContain('Asked: group "Hiking Crew" (4 members).');
    expect(eventText).toContain(
      'Synthesized summary (plugin-generated): 1 contact has replied so far from group "Hiking Crew".',
    );
    expect(eventText).toContain(
      "Alice (2026-03-10T12:15:00.000Z) said: We went last weekend; cables were crowded.",
    );
    expect(eventText).toContain(
      "- Alice via openclaw at 2026-03-10T12:15:00.000Z [message msg_inbound_group_1]. Direct reply: We went last weekend; cables were crowded.",
    );
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-group-agent",
        reason: "mahilo:inbound-message",
        sessionKey: "session_group_route_1",
      },
    ]);
  });

  it("does not register group ask-around reply routes when local policy only holds or blocks the fanout", async () => {
    const pluginState = new InMemoryPluginState();
    const { client, state } = createMockContractClient({
      groupFanoutBundleResponse: {
        ...buildDefaultGroupFanoutBundle({
          recipient: "grp_hiking",
          sender_connection_id: "conn_sender",
        }),
        group: {
          id: "grp_hiking",
          member_count: 2,
          name: "Hiking Crew",
          type: "group",
        },
        members: [
          {
            llm: {
              provider_defaults: null,
              subject: "alice",
            },
            member_applicable_policies: [
              createPolicy({
                effect: "ask",
                evaluator: "structured",
                id: "pol_group_hold_alice",
                policy_content: { intent: "manual_review" },
                priority: 100,
                scope: "user",
              }),
            ],
            recipient: {
              id: "usr_alice",
              type: "user",
              username: "alice",
            },
            resolution_id: "res_group_hold_alice",
            roles: [],
          },
          {
            llm: {
              provider_defaults: null,
              subject: "bob",
            },
            member_applicable_policies: [
              createPolicy({
                effect: "deny",
                evaluator: "structured",
                id: "pol_group_block_bob",
                policy_content: {},
                priority: 100,
                scope: "user",
              }),
            ],
            recipient: {
              id: "usr_bob",
              type: "user",
              username: "bob",
            },
            resolution_id: "res_group_block_bob",
            roles: [],
          },
        ],
      },
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      pluginState,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const { api, hooks, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "ask_network");
    const outboundInput = {
      correlationId: "corr_group_local_no_send_1",
      group: "Hiking Crew",
      question: "Has anyone done Half Dome recently?",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute(
      "tool_call_group_local_no_send_1",
      outboundInput,
    );
    const toolResultForHook = structuredClone(toolResult);

    expect(toolResult).toMatchObject({
      details: {
        counts: {
          awaitingReplies: 0,
          blocked: 1,
          reviewRequired: 1,
          sendFailed: 0,
          skipped: 0,
        },
        deliveries: [
          expect.objectContaining({
            decision: "ask",
            recipient: "alice",
            status: "review_required",
          }),
          expect.objectContaining({
            decision: "deny",
            recipient: "bob",
            status: "blocked",
          }),
        ],
        target: {
          groupId: "grp_hiking",
          groupName: "Hiking Crew",
          kind: "group",
        },
      },
    });
    expect(state.groupFanoutBundleCalls).toHaveLength(1);
    expect(state.localDecisionCommitCalls).toHaveLength(2);
    expect(state.sendCalls).toHaveLength(0);

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: outboundInput,
        result: toolResultForHook,
        toolName: "ask_network",
      },
      {
        agentId: "mahilo-group-agent",
        runId: "run_group_local_no_send_1",
        sessionKey: "session_group_local_no_send_1",
        toolCallId: "tool_call_group_local_no_send_1",
        toolName: "ask_network",
      },
    );

    expect(
      pluginState.getAskAroundSession("corr_group_local_no_send_1"),
    ).toMatchObject({
      correlationId: "corr_group_local_no_send_1",
      expectedParticipants: undefined,
      target: {
        groupId: "grp_hiking",
        groupName: "Hiking Crew",
        kind: "group",
      },
    });
    expect(
      pluginState.resolveInboundRoute({
        groupId: "grp_hiking",
        localConnectionId: "conn_sender",
      }),
    ).toBeUndefined();
    expect(
      pluginState.resolveInboundRoute({
        inResponseToMessageId: "msg_123",
      }),
    ).toBeUndefined();
  });

  it("keeps synthesized ask-around updates separate from direct attributed replies", async () => {
    const { client } = createMockContractClient({
      friendConnectionsByUsername: {
        alice: [{ active: true, id: "conn_alice" }],
        bob: [{ active: true, id: "conn_bob" }],
      },
      friendshipsResponse: [
        {
          direction: "sent",
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["friends"],
          status: "accepted",
          userId: "usr_alice",
          username: "alice",
        },
        {
          direction: "sent",
          displayName: "Bob",
          friendshipId: "fr_bob",
          roles: ["friends"],
          status: "accepted",
          userId: "usr_bob",
          username: "bob",
        },
      ],
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const { api, hooks, routes, systemEvents, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "ask_network");
    const outboundInput = {
      correlationId: "corr_network_summary_1",
      question: "Who knows a good ramen spot?",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute(
      "tool_call_network_summary_1",
      outboundInput,
    );

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: outboundInput,
        result: toolResult,
        toolName: "ask_network",
      },
      {
        agentId: "mahilo-network-agent",
        runId: "run_network_summary_1",
        sessionKey: "session_network_summary_1",
        toolCallId: "tool_call_network_summary_1",
        toolName: "ask_network",
      },
    );

    const firstReplyBody = buildInboundWebhookRawBody({
      context: "Went last month",
      correlation_id: "corr_network_summary_1",
      message: "Try Mensho for the broth.",
      message_id: "msg_inbound_summary_1",
      recipient_connection_id: "conn_sender",
      sender: "Alice",
      sender_connection_id: "conn_alice",
    });
    const firstTimestamp = Math.floor(Date.now() / 1000);
    const firstSignature = generateCallbackSignature(
      firstReplyBody,
      CALLBACK_SECRET,
      firstTimestamp,
    );
    const firstRequest = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_summary_1",
        "x-mahilo-signature": `sha256=${firstSignature}`,
        "x-mahilo-timestamp": String(firstTimestamp),
      },
      rawBody: firstReplyBody,
    });
    const firstResponse = createMockWebhookResponse();

    await routes[0]!.handler(firstRequest, firstResponse.response);

    expect(firstResponse.status()).toBe(200);
    expect(systemEvents[0]?.text).toContain(
      "Synthesized summary (plugin-generated): 1 of 2 contacted people has replied so far.",
    );
    expect(systemEvents[0]?.text).toContain(
      "Alice (context: Went last month) said: Try Mensho for the broth.",
    );
    expect(systemEvents[0]?.text).toContain("Direct replies:");
    expect(systemEvents[0]?.text).toContain(
      "- Alice via openclaw at 2026-03-08T12:15:00.000Z [message msg_inbound_summary_1]. Experience context: Went last month. Direct reply: Try Mensho for the broth.",
    );

    const secondReplyBody = buildInboundWebhookRawBody({
      correlation_id: "corr_network_summary_1",
      message: "Ramen Shop is worth the wait.",
      message_id: "msg_inbound_summary_2",
      recipient_connection_id: "conn_sender",
      sender: "Bob",
      sender_connection_id: "conn_bob",
      timestamp: "2026-03-08T12:17:00.000Z",
    });
    const secondTimestamp = Math.floor(Date.now() / 1000);
    const secondSignature = generateCallbackSignature(
      secondReplyBody,
      CALLBACK_SECRET,
      secondTimestamp,
    );
    const secondRequest = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_summary_2",
        "x-mahilo-signature": `sha256=${secondSignature}`,
        "x-mahilo-timestamp": String(secondTimestamp),
      },
      rawBody: secondReplyBody,
    });
    const secondResponse = createMockWebhookResponse();

    await routes[0]!.handler(secondRequest, secondResponse.response);

    expect(secondResponse.status()).toBe(200);
    const finalEventText = systemEvents[1]?.text ?? "";
    expect(finalEventText).toContain(
      "Synthesized summary (plugin-generated): 2 of 2 contacted people have replied so far.",
    );
    expect(finalEventText).toContain(
      "Alice (context: Went last month) said: Try Mensho for the broth.",
    );
    expect(finalEventText).toContain(
      "Bob (2026-03-08T12:17:00.000Z) said: Ramen Shop is worth the wait.",
    );
    expect(finalEventText).toContain("Direct replies:");
    expect(finalEventText).toContain(
      "- Alice via openclaw at 2026-03-08T12:15:00.000Z [message msg_inbound_summary_1]. Experience context: Went last month. Direct reply: Try Mensho for the broth.",
    );
    expect(finalEventText).toContain(
      "- Bob via openclaw at 2026-03-08T12:17:00.000Z [message msg_inbound_summary_2]. Direct reply: Ramen Shop is worth the wait.",
    );
  });

  it("formats explicit no-grounded-answer replies as trusted unknowns instead of attributed advice", async () => {
    const { client } = createMockContractClient({
      friendConnectionsByUsername: {
        alice: [{ active: true, id: "conn_alice" }],
        bob: [{ active: true, id: "conn_bob" }],
      },
      friendshipsResponse: [
        {
          direction: "sent",
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["friends"],
          status: "accepted",
          userId: "usr_alice",
          username: "alice",
        },
        {
          direction: "sent",
          displayName: "Bob",
          friendshipId: "fr_bob",
          roles: ["friends"],
          status: "accepted",
          userId: "usr_bob",
          username: "bob",
        },
      ],
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const { api, hooks, routes, systemEvents, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "ask_network");
    const outboundInput = {
      correlationId: "corr_network_unknown_1",
      question: "Who knows a good ramen spot?",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute(
      "tool_call_network_unknown_1",
      outboundInput,
    );

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: outboundInput,
        result: toolResult,
        toolName: "ask_network",
      },
      {
        agentId: "mahilo-network-agent",
        runId: "run_network_unknown_1",
        sessionKey: "session_network_unknown_1",
        toolCallId: "tool_call_network_unknown_1",
        toolName: "ask_network",
      },
    );

    const noGroundedReply = JSON.stringify({
      message: "I don't know.",
      outcome: "no_grounded_answer",
    });
    const rawBody = buildInboundWebhookRawBody({
      correlation_id: "corr_network_unknown_1",
      message: noGroundedReply,
      message_id: "msg_inbound_unknown_1",
      payload_type: "application/json",
      recipient_connection_id: "conn_sender",
      sender: "Bob",
      sender_connection_id: "conn_bob",
      timestamp: "2026-03-08T12:16:00.000Z",
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateCallbackSignature(
      rawBody,
      CALLBACK_SECRET,
      timestamp,
    );
    const request = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_unknown_1",
        "x-mahilo-signature": `sha256=${signature}`,
        "x-mahilo-timestamp": String(timestamp),
      },
      rawBody,
    });
    const response = createMockWebhookResponse();

    await routes[0]!.handler(request, response.response);

    expect(response.status()).toBe(200);
    const eventText = systemEvents[0]?.text ?? "";
    expect(eventText).toContain(
      "Synthesized summary (plugin-generated): 1 of 2 contacted people has replied so far. Bob (2026-03-08T12:16:00.000Z) reported no grounded answer.",
    );
    expect(eventText).not.toContain("Bob (2026-03-08T12:16:00.000Z) said:");
    expect(eventText).toContain(
      "- Bob via openclaw at 2026-03-08T12:16:00.000Z [message msg_inbound_unknown_1]. Outcome: no grounded answer. Direct reply: I don't know.",
    );
  });

  it("keeps unattributed ask-around replies separate from trusted friend attribution", async () => {
    const { client } = createMockContractClient({
      friendConnectionsByUsername: {
        alice: [{ active: true, id: "conn_alice" }],
        bob: [{ active: true, id: "conn_bob" }],
      },
      friendshipsResponse: [
        {
          direction: "sent",
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["friends"],
          status: "accepted",
          userId: "usr_alice",
          username: "alice",
        },
        {
          direction: "sent",
          displayName: "Bob",
          friendshipId: "fr_bob",
          roles: ["friends"],
          status: "accepted",
          userId: "usr_bob",
          username: "bob",
        },
      ],
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const { api, hooks, routes, systemEvents, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "ask_network");
    const outboundInput = {
      correlationId: "corr_network_unverified_1",
      question: "Who knows a good ramen spot?",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute(
      "tool_call_network_unverified_1",
      outboundInput,
    );

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: outboundInput,
        result: toolResult,
        toolName: "ask_network",
      },
      {
        agentId: "mahilo-network-agent",
        runId: "run_network_unverified_1",
        sessionKey: "session_network_unverified_1",
        toolCallId: "tool_call_network_unverified_1",
        toolName: "ask_network",
      },
    );

    const rawBody = buildInboundWebhookRawBody({
      correlation_id: "corr_network_unverified_1",
      message: "Go to Ramen Shop.",
      message_id: "msg_inbound_unverified_1",
      recipient_connection_id: "conn_sender",
      sender: "Mallory",
      sender_connection_id: "conn_mallory",
      timestamp: "2026-03-08T12:18:00.000Z",
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateCallbackSignature(
      rawBody,
      CALLBACK_SECRET,
      timestamp,
    );
    const request = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_unverified_1",
        "x-mahilo-signature": `sha256=${signature}`,
        "x-mahilo-timestamp": String(timestamp),
      },
      rawBody,
    });
    const response = createMockWebhookResponse();

    await routes[0]!.handler(request, response.response);

    expect(response.status()).toBe(200);
    const eventText = systemEvents[0]?.text ?? "";
    expect(eventText).toContain(
      "Synthesized summary (plugin-generated): 0 of 2 contacted people have replied so far. 1 reply could not be safely attributed to a contacted friend and is kept separate below.",
    );
    expect(eventText).not.toContain("Mallory said:");
    expect(eventText).toContain(
      '- Unverified sender claim "Mallory" via openclaw at 2026-03-08T12:18:00.000Z [message msg_inbound_unverified_1]. Mahilo couldn\'t confirm this sender was one of the contacts asked in this thread. Raw reply: Go to Ramen Shop.',
    );
  });

  it("surfaces setup nudges when ask-around cannot reach anyone yet", async () => {
    const { client } = createMockContractClient({
      friendConnectionErrorsByUsername: {
        bob: new MahiloRequestError(
          "Mahilo request failed with status 403: Not friends",
          {
            code: "NOT_FRIENDS",
            kind: "http",
            status: 403,
          },
        ),
      },
      friendConnectionsByUsername: {
        alice: [],
      },
      friendshipsResponse: [
        {
          direction: "sent",
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["friends"],
          status: "accepted",
          userId: "usr_alice",
          username: "alice",
        },
        {
          direction: "sent",
          displayName: "Bob",
          friendshipId: "fr_bob",
          roles: ["friends"],
          status: "accepted",
          userId: "usr_bob",
          username: "bob",
        },
      ],
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "ask_network");
    const result = await tool.execute("tool_call_network_gap_1", {
      question: "Who has a good dentist in SF?",
      senderConnectionId: "conn_sender",
    });

    expect(result).toMatchObject({
      content: [
        {
          text: expect.stringContaining("Nothing is waiting on a reply."),
        },
      ],
      details: {
        action: "ask_around",
        deliveries: [
          expect.objectContaining({
            reason: expect.stringContaining(
              "Your circle is started. Ask them to finish Mahilo setup in OpenClaw",
            ),
          }),
          expect.objectContaining({
            reason: expect.stringContaining(
              "Build your circle from this same tool: use action=send_request",
            ),
          }),
        ],
        gaps: [
          expect.objectContaining({
            kind: "needs_agent_connection",
            recipientLabels: ["Alice"],
            suggestedAction: expect.stringContaining(
              "Your circle is started. Ask them to finish Mahilo setup in OpenClaw",
            ),
          }),
          expect.objectContaining({
            kind: "not_in_network",
            recipientLabels: ["Bob"],
            suggestedAction: expect.stringContaining(
              "Build your circle from this same tool: use action=send_request",
            ),
          }),
        ],
        replyExpectation: expect.stringContaining(
          "Nothing is waiting on a reply.",
        ),
        summary: expect.stringContaining(
          "couldn't ask your 2 contacts right now",
        ),
      },
    });
  });

  it("only registers ask-network reply routes for contacts whose locally approved asks were sent", async () => {
    const pluginState = new InMemoryPluginState();
    const { client, state } = createMockContractClient({
      directSendBundleResponse: (payload) => {
        const bundle = buildDefaultDirectSendBundle(payload);
        const recipient =
          typeof payload.recipient === "string"
            ? payload.recipient.trim().toLowerCase()
            : "alice";

        if (recipient === "bob") {
          return {
            ...bundle,
            applicable_policies: [
              createPolicy({
                effect: "ask",
                evaluator: "structured",
                id: "pol_bob_review",
                policy_content: { intent: "manual_review" },
                priority: 100,
                scope: "user",
              }),
            ],
            bundle_metadata: {
              ...bundle.bundle_metadata,
              resolution_id: "res_local_bob",
            },
            llm: {
              ...bundle.llm,
              subject: "bob",
            },
            recipient: {
              ...bundle.recipient,
              id: "usr_bob",
              username: "bob",
            },
          };
        }

        if (recipient === "carol") {
          return {
            ...bundle,
            applicable_policies: [
              createPolicy({
                effect: "deny",
                evaluator: "structured",
                id: "pol_carol_block",
                policy_content: {},
                priority: 100,
                scope: "user",
              }),
            ],
            bundle_metadata: {
              ...bundle.bundle_metadata,
              resolution_id: "res_local_carol",
            },
            llm: {
              ...bundle.llm,
              subject: "carol",
            },
            recipient: {
              ...bundle.recipient,
              id: "usr_carol",
              username: "carol",
            },
          };
        }

        return {
          ...bundle,
          bundle_metadata: {
            ...bundle.bundle_metadata,
            resolution_id: "res_local_alice",
          },
        };
      },
      friendConnectionsByUsername: {
        alice: [{ active: true, id: "conn_alice" }],
        bob: [{ active: true, id: "conn_bob" }],
        carol: [{ active: true, id: "conn_carol" }],
      },
      friendshipsResponse: [
        {
          direction: "sent",
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["friends"],
          status: "accepted",
          userId: "usr_alice",
          username: "alice",
        },
        {
          direction: "sent",
          displayName: "Bob",
          friendshipId: "fr_bob",
          roles: ["friends"],
          status: "accepted",
          userId: "usr_bob",
          username: "bob",
        },
        {
          direction: "sent",
          displayName: "Carol",
          friendshipId: "fr_carol",
          roles: ["friends"],
          status: "accepted",
          userId: "usr_carol",
          username: "carol",
        },
      ],
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      pluginState,
      webhookRoute: {
        callbackSecret: CALLBACK_SECRET,
      },
    });
    const { api, heartbeatRequests, hooks, routes, systemEvents, tools } =
      createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
        inboundAgentId: "mahilo-fallback-agent",
        inboundSessionKey: "session_fallback_local_policy",
      });

    await plugin.register?.(api);

    const tool = findTool(tools, "ask_network");
    const outboundInput = {
      correlationId: "corr_network_local_policy_1",
      question: "Who knows a good ramen spot?",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute(
      "tool_call_network_local_policy_1",
      outboundInput,
    );

    expect(toolResult).toMatchObject({
      details: {
        counts: {
          awaitingReplies: 1,
          blocked: 1,
          reviewRequired: 1,
          sendFailed: 0,
          skipped: 0,
        },
        deliveries: [
          expect.objectContaining({
            decision: "allow",
            messageId: "msg_123",
            recipient: "alice",
            status: "awaiting_reply",
          }),
          expect.objectContaining({
            decision: "ask",
            recipient: "bob",
            status: "review_required",
          }),
          expect.objectContaining({
            decision: "deny",
            recipient: "carol",
            status: "blocked",
          }),
        ],
      },
    });
    expect(
      state.directSendBundleCalls.map((call) => String(call.recipient)),
    ).toEqual(["alice", "bob", "carol"]);
    expect(state.localDecisionCommitCalls).toHaveLength(3);
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0]?.payload).toMatchObject({
      correlation_id: "corr_network_local_policy_1",
      recipient: "alice",
      resolution_id: "res_local_alice",
      sender_connection_id: "conn_sender",
    });

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: outboundInput,
        result: toolResult,
        toolName: "ask_network",
      },
      {
        agentId: "mahilo-network-agent",
        runId: "run_network_local_policy_1",
        sessionKey: "session_network_local_policy_1",
        toolCallId: "tool_call_network_local_policy_1",
        toolName: "ask_network",
      },
    );
    expect(
      pluginState.getAskAroundSession("corr_network_local_policy_1"),
    ).toMatchObject({
      expectedParticipants: [
        {
          label: "Alice",
          recipient: "alice",
        },
      ],
      expectedReplyCount: 1,
    });
    expect(
      pluginState.resolveInboundRoute({
        inResponseToMessageId: "msg_123",
      }),
    ).toMatchObject({
      correlationId: "corr_network_local_policy_1",
      sessionKey: "session_network_local_policy_1",
    });

    systemEvents.length = 0;
    heartbeatRequests.length = 0;

    const aliceRawBody = buildInboundWebhookRawBody({
      in_response_to: "msg_123",
      message: "Try Mensho for the broth.",
      message_id: "msg_inbound_local_policy_alice_1",
      recipient_connection_id: "conn_sender",
      sender: "Alice",
      sender_connection_id: "conn_alice",
      timestamp: "2026-03-10T12:15:00.000Z",
    });
    const aliceTimestamp = Math.floor(Date.now() / 1000);
    const aliceSignature = generateCallbackSignature(
      aliceRawBody,
      CALLBACK_SECRET,
      aliceTimestamp,
    );
    const aliceRequest = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_local_policy_alice_1",
        "x-mahilo-signature": `sha256=${aliceSignature}`,
        "x-mahilo-timestamp": String(aliceTimestamp),
      },
      rawBody: aliceRawBody,
    });
    const aliceResponse = createMockWebhookResponse();

    await routes[0]!.handler(aliceRequest, aliceResponse.response);

    expect(aliceResponse.status()).toBe(200);
    expect(systemEvents).toEqual([
      expect.objectContaining({
        sessionKey: "session_network_local_policy_1",
        text: expect.stringContaining(
          "Synthesized summary (plugin-generated): 1 of 1 contacted people has replied so far.",
        ),
      }),
    ]);
    expect(systemEvents[0]?.text).toContain(
      "Alice (2026-03-10T12:15:00.000Z) said: Try Mensho for the broth.",
    );
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-network-agent",
        reason: "mahilo:inbound-message",
        sessionKey: "session_network_local_policy_1",
      },
    ]);

    systemEvents.length = 0;
    heartbeatRequests.length = 0;

    const bobRawBody = buildInboundWebhookRawBody({
      message: "I know a spot too.",
      message_id: "msg_inbound_local_policy_bob_1",
      recipient_connection_id: "conn_sender",
      sender: "Bob",
      sender_connection_id: "conn_bob",
      timestamp: "2026-03-10T12:18:00.000Z",
    });
    const bobTimestamp = Math.floor(Date.now() / 1000);
    const bobSignature = generateCallbackSignature(
      bobRawBody,
      CALLBACK_SECRET,
      bobTimestamp,
    );
    const bobRequest = createMockWebhookRequest({
      headers: {
        "x-mahilo-message-id": "msg_inbound_local_policy_bob_1",
        "x-mahilo-signature": `sha256=${bobSignature}`,
        "x-mahilo-timestamp": String(bobTimestamp),
      },
      rawBody: bobRawBody,
    });
    const bobResponse = createMockWebhookResponse();

    await routes[0]!.handler(bobRequest, bobResponse.response);

    expect(bobResponse.status()).toBe(200);
    expect(systemEvents).toEqual([
      expect.objectContaining({
        sessionKey: "session_fallback_local_policy",
        text: expect.stringContaining("I know a spot too."),
      }),
    ]);
    expect(systemEvents[0]?.text).not.toContain("Mahilo ask-around update");
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-fallback-agent",
        reason: "mahilo:inbound-message",
        sessionKey: "session_fallback_local_policy",
      },
    ]);
  });

  it("executes send_message sends with sender_connection_id alias", async () => {
    const { client, state } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "send_message");
    const result = await tool.execute("tool_call_1", {
      message: "hello",
      recipient: "alice",
      sender_connection_id: "conn_sender",
    });

    expect(result).toMatchObject({
      details: {
        decision: "allow",
        messageId: "msg_123",
        resolutionId: "res_direct_default",
        status: "sent",
      },
    });
    expect(state.directSendBundleCalls).toEqual([
      expect.objectContaining({
        recipient: "alice",
        recipient_type: "user",
        sender_connection_id: "conn_sender",
      }),
    ]);
    expect(state.localDecisionCommitCalls).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          local_decision: expect.objectContaining({
            decision: "allow",
          }),
          recipient: "alice",
          resolution_id: "res_direct_default",
          sender_connection_id: "conn_sender",
        }),
      }),
    ]);
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0]?.payload).toMatchObject({
      resolution_id: "res_direct_default",
      sender_connection_id: "conn_sender",
    });
  });

  it("resolves a default sender connection for send_message sends when input omits it", async () => {
    const { client, state } = createMockContractClient({
      agentConnectionsResponse: [
        {
          active: true,
          framework: "other",
          id: "conn_other",
          label: "zeta",
        },
        {
          active: true,
          framework: "openclaw",
          id: "conn_sender_default",
          label: "primary",
        },
      ],
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "send_message");
    const result = await tool.execute("tool_call_2", {
      message: "hello",
      recipient: "alice",
    });

    expect(result).toMatchObject({
      details: {
        decision: "allow",
        resolutionId: "res_direct_default",
        status: "sent",
      },
    });
    expect(state.agentConnectionCalls).toBe(1);
    expect(state.localDecisionCommitCalls).toHaveLength(1);
    expect(state.sendCalls[0]?.payload).toMatchObject({
      resolution_id: "res_direct_default",
      sender_connection_id: "conn_sender_default",
    });
  });

  it("records local review-required sends without calling transport", async () => {
    const { client, state } = createMockContractClient({
      directSendBundleResponse: {
        applicable_policies: [
          {
            created_at: null,
            derived_from_message_id: null,
            effective_from: null,
            effect: "ask",
            evaluator: "structured",
            expires_at: null,
            id: "pol_direct_review",
            learning_provenance: null,
            max_uses: null,
            policy_content: { intent: "manual_review" },
            priority: 100,
            remaining_uses: null,
            scope: "user",
            source: "user_created",
          },
        ],
        authenticated_identity: {
          sender_connection_id: "conn_sender",
          sender_user_id: "usr_sender",
        },
        bundle_metadata: {
          bundle_id: "bundle_direct_review",
          expires_at: "2026-03-14T10:35:00.000Z",
          issued_at: "2026-03-14T10:30:00.000Z",
          resolution_id: "res_direct_review",
        },
        bundle_type: "direct_send",
        contract_version: "1.0.0",
        llm: {
          provider_defaults: null,
          subject: "alice",
        },
        recipient: {
          id: "usr_alice",
          type: "user",
          username: "alice",
        },
        selector_context: {
          action: "share",
          direction: "outbound",
          resource: "message.general",
        },
      },
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "send_message");
    const result = await tool.execute("tool_call_local_review", {
      message: "share location",
      recipient: "alice",
      senderConnectionId: "conn_sender",
    });

    expect(result).toMatchObject({
      content: [
        {
          text: expect.stringContaining(
            "Mahilo needs review before sending this person message.",
          ),
        },
      ],
      details: {
        decision: "ask",
        reason: "Review required: Policy has no constraints and applies to all messages",
        resolutionId: "res_direct_review",
        status: "review_required",
      },
    });
    expect(
      (result as { details?: { messageId?: string } }).details?.messageId,
    ).toBeUndefined();
    expect(state.directSendBundleCalls).toHaveLength(1);
    expect(state.localDecisionCommitCalls).toHaveLength(1);
    expect(state.sendCalls).toHaveLength(0);
  });

  it("lists contacts from Mahilo server data through manage_network instead of the host contacts provider", async () => {
    let providerCalls = 0;
    const { client, state } = createMockContractClient({
      blockedEventsResponse: {
        blocked_events: [
          {
            id: "blocked_msg_123",
            reason: "Message blocked by policy.",
            timestamp: "2026-03-09T10:00:00.000Z",
          },
        ],
      },
      friendConnectionsByUsername: {
        alice: [
          {
            active: true,
            id: "conn_alice_primary",
            label: "primary",
            priority: 5,
          },
        ],
      },
      friendshipsResponse: [
        {
          direction: "sent",
          displayName: " Alice ",
          friendshipId: "fr_alice",
          roles: ["close_friends"],
          status: "accepted",
          userId: "usr_alice",
          username: "alice",
        },
      ],
      reviewsResponse: {
        reviews: [
          {
            created_at: "2026-03-10T11:00:00.000Z",
            review_id: "rev_123",
            status: "review_required",
            summary: "Current location share requires confirmation.",
          },
        ],
      },
    });
    const plugin = createMahiloOpenClawPlugin({
      contactsProvider: async () => {
        providerCalls += 1;
        return [
          {
            id: "provider-alice",
            label: " Provider Alice ",
            type: "user",
          },
        ];
      },
      createClient: () => client,
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "manage_network");
    const result = await tool.execute("tool_call_3", {
      action: "list_contacts",
      activityLimit: 4,
    });

    expect(result).toMatchObject({
      details: {
        action: "list",
        agentConnections: [
          {
            id: "conn_sender_default",
            label: "default",
          },
        ],
        contacts: [
          {
            connectionId: "conn_alice_primary",
            connectionState: "available",
            id: "alice",
            label: "Alice",
            metadata: {
              connectionCount: 1,
              connectionState: "available",
              friendshipId: "fr_alice",
            },
            type: "user",
          },
        ],
        recentActivity: [
          {
            kind: "review",
            reviewId: "rev_123",
          },
          {
            kind: "blocked_event",
            messageId: "blocked_msg_123",
          },
        ],
        recentActivityCounts: {
          blockedEvents: 1,
          reviews: 1,
          total: 2,
        },
        status: "success",
      },
    });
    expect(providerCalls).toBe(0);
    expect(state.friendshipCalls).toEqual([
      { status: "accepted" },
      { status: "pending" },
    ]);
    expect(state.friendConnectionCalls).toEqual(["alice"]);
    expect(state.agentConnectionCalls).toBe(1);
    expect(state.listReviewCalls).toEqual([
      {
        limit: 4,
        status: "review_required,approval_pending",
      },
    ]);
    expect(state.blockedEventCalls).toEqual([4]);
  });

  it("executes manage_network to send friend requests by @username", async () => {
    const { client, state } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "manage_network");
    const result = await tool.execute("tool_call_relationship_add", {
      action: "send_friend_request",
      username: "@alice",
    });

    expect(result).toMatchObject({
      details: {
        action: "send_request",
        request: {
          friendshipId: "fr_pending_alice",
          status: "pending",
          username: "alice",
        },
        status: "success",
        summary: "Sent a Mahilo friend request to @alice.",
      },
    });
    expect(state.friendRequestCalls).toEqual(["alice"]);
  });

  it("surfaces not-on-Mahilo nudges through manage_network send_request errors", async () => {
    const { client } = createMockContractClient({
      sendFriendRequestError: new MahiloRequestError(
        "Mahilo request failed with status 404: User not found",
        {
          code: "USER_NOT_FOUND",
          kind: "http",
          status: 404,
        },
      ),
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "manage_network");
    const result = await tool.execute("tool_call_relationship_add_missing", {
      action: "send_friend_request",
      username: "@alice",
    });

    expect(result).toMatchObject({
      content: [
        {
          text: expect.stringContaining(
            "If they have not joined yet, ask them to set up Mahilo in OpenClaw",
          ),
        },
      ],
      details: {
        action: "send_request",
        error: {
          message: expect.stringContaining(
            "If they have not joined yet, ask them to set up Mahilo in OpenClaw",
          ),
          productState: "not_found",
        },
        status: "error",
      },
    });
  });

  it("accepts pending Mahilo requests from server-backed relationship state", async () => {
    const { client, state } = createMockContractClient({
      friendshipsByStatus: {
        pending: [
          {
            direction: "received",
            displayName: "Alice",
            friendshipId: "fr_pending_alice",
            status: "pending",
            username: "alice",
          },
        ],
      },
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "manage_network");
    const result = await tool.execute("tool_call_relationship_accept", {
      action: "respond_to_request",
      decision: "accept",
      username: "alice",
    });

    expect(result).toMatchObject({
      details: {
        action: "accept",
        request: {
          friendshipId: "fr_pending_alice",
          status: "accepted",
          username: "alice",
        },
        status: "success",
        summary: "Accepted the Mahilo request from @alice.",
      },
    });
    expect(state.friendshipCalls).toEqual([{ status: "pending" }]);
    expect(state.acceptFriendRequestCalls).toEqual(["fr_pending_alice"]);
  });

  it("executes set_boundaries with conversational category defaults", async () => {
    const { client, state } = createMockContractClient({
      promptContextResponse: {
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
      },
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "set_boundaries");
    const result = await tool.execute("tool_call_6", {
      action: "exception",
      category: "location",
      durationMinutes: 30,
      recipient: "alice",
      sourceResolutionId: "res_123",
    });

    expect(result).toMatchObject({
      content: [
        {
          text: expect.stringContaining(
            "Boundary exception saved: allow sharing location with alice for 30 minutes.",
          ),
        },
      ],
      details: {
        action: "exception",
        category: "location",
        created: true,
        effect: "allow",
        kind: "temporary",
        resolvedTargetId: "usr_alice",
        scope: "user",
        writes: [
          {
            selector: {
              action: "share",
              direction: "outbound",
              resource: "location.current",
            },
          },
          {
            selector: {
              action: "share",
              direction: "outbound",
              resource: "location.history",
            },
          },
        ],
      },
    });
    expect(state.agentConnectionCalls).toBe(1);
    expect(state.promptContextCalls).toEqual([
      {
        draft_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current",
        },
        include_recent_interactions: false,
        interaction_limit: 1,
        recipient: "alice",
        recipient_type: "user",
        sender_connection_id: "conn_sender_default",
      },
    ]);
    expect(state.overrideCalls).toHaveLength(2);
    expect(state.overrideCalls[0]?.payload).toMatchObject({
      effect: "allow",
      kind: "temporary",
      scope: "user",
      selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.current",
      },
      sender_connection_id: "conn_sender_default",
      source_resolution_id: "res_123",
      target_id: "usr_alice",
      ttl_seconds: 1800,
    });
    expect(state.overrideCalls[1]?.payload).toMatchObject({
      effect: "allow",
      kind: "temporary",
      scope: "user",
      selectors: {
        action: "share",
        direction: "outbound",
        resource: "location.history",
      },
      sender_connection_id: "conn_sender_default",
      source_resolution_id: "res_123",
      target_id: "usr_alice",
      ttl_seconds: 1800,
    });
  });

  it("returns graceful server failures for send_message sends", async () => {
    const { client } = createMockContractClient({
      sendError: new MahiloRequestError(
        "Mahilo request failed with status 503",
        {
          kind: "http",
          status: 503,
        },
      ),
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, tools } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const tool = findTool(tools, "send_message");
    const result = await tool.execute("tool_call_7", {
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender",
    });

    expect(result).toMatchObject({
      details: {
        error: "Mahilo request failed with status 503",
        errorType: "server",
        retryable: true,
        status: "error",
        tool: "send_message",
      },
    });
  });

  it("returns diagnostics output for mahilo status", async () => {
    const { client, state } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, commands } = createMockPluginApi({
      apiKey: "mhl_test_secret",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const result = await runMahiloOperatorCommand(commands, "status");

    const replyText =
      typeof (result as Record<string, unknown>).text === "string"
        ? ((result as Record<string, unknown>).text as string)
        : "";
    expect(replyText).toContain("Mahilo status: connected");
    expect(replyText).toContain('"command": "mahilo status"');
    expect(replyText).toContain('"reconnectCount": 0');
    expect(replyText).toContain('"apiKey": "mh***et"');
    expect(state.listReviewCalls).toHaveLength(1);
    expect(state.blockedEventCalls).toHaveLength(1);
  });

  it("returns connection and activity details for mahilo network", async () => {
    const { client, state } = createMockContractClient({
      blockedEventsResponse: {
        blocked_events: [
          {
            id: "blocked_msg_123",
            reason: "Message blocked by policy.",
            timestamp: "2026-03-09T12:00:00.000Z",
          },
        ],
      },
      friendConnectionsByUsername: {
        alice: [
          {
            active: true,
            id: "conn_alice_primary",
            label: "primary",
            priority: 5,
          },
        ],
      },
      friendshipsByStatus: {
        pending: [
          {
            direction: "received",
            displayName: "Bob",
            friendshipId: "fr_bob_pending",
            status: "pending",
            username: "bob",
          },
        ],
      },
      friendshipsResponse: [
        {
          direction: "sent",
          displayName: "Alice",
          friendshipId: "fr_alice",
          roles: ["friends"],
          status: "accepted",
          username: "alice",
        },
      ],
      reviewsResponse: {
        reviews: [
          {
            created_at: "2026-03-10T12:00:00.000Z",
            review_id: "rev_123",
            status: "review_required",
            summary: "Current location share requires confirmation.",
          },
        ],
      },
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, commands } = createMockPluginApi({
      apiKey: "mhl_test_secret",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const result = await runMahiloOperatorCommand(
      commands,
      'network {"activityLimit":4}',
    );

    const replyText =
      typeof (result as Record<string, unknown>).text === "string"
        ? ((result as Record<string, unknown>).text as string)
        : "";
    expect(replyText).toContain("Mahilo product signals (last 7 days):");
    expect(replyText).toContain('"action": "list"');
    expect(replyText).toContain('"activityLimit": 4');
    expect(replyText).toContain('"command": "mahilo network"');
    expect(replyText).toContain('"contacts": 1');
    expect(replyText).toContain('"blockedEvents": 1');
    expect(state.agentConnectionCalls).toBe(1);
    expect(state.listReviewCalls).toEqual([
      {
        limit: 4,
        status: "review_required,approval_pending",
      },
    ]);
    expect(state.blockedEventCalls).toEqual([4]);
  });

  it("queues Mahilo outcome notes and learning suggestions after novel send results", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, heartbeatRequests, hooks, systemEvents, tools } =
      createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
      });

    await plugin.register?.(api);

    const tool = findTool(tools, "send_message");
    const input = {
      declaredSelectors: {
        action: "share",
        resource: "location.current",
      },
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute("tool_call_post_send_1", input);

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: input,
        result: toolResult,
        toolName: "send_message",
      },
      {
        agentId: "mahilo-agent",
        runId: "run_1",
        sessionKey: "session_1",
        toolCallId: "tool_call_post_send_1",
        toolName: "send_message",
      },
    );

    expect(systemEvents).toHaveLength(1);
    expect(systemEvents[0]?.sessionKey).toBe("session_1");
    expect(String(systemEvents[0]?.text ?? "")).toContain(
      "Mahilo outcome: sent to alice (location.current/share)",
    );

    const agentEnd = findHook(hooks, "agent_end");
    await agentEnd.execute(
      {
        durationMs: 1_200,
        messages: [],
        success: true,
      },
      {
        agentId: "mahilo-agent",
        sessionKey: "session_1",
      },
    );

    expect(systemEvents).toHaveLength(2);
    expect(systemEvents[1]?.sessionKey).toBe("session_1");
    expect(String(systemEvents[1]?.text ?? "")).toContain(
      "Mahilo learning opportunity:",
    );
    expect(String(systemEvents[1]?.text ?? "")).toContain(
      "location.current/share",
    );
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-agent",
        reason: "mahilo:learning-suggestion",
        sessionKey: "session_1",
      },
    ]);
  });

  it("keeps locally allowed send_message results routed as real sends in after-tool hooks", async () => {
    const pluginState = new InMemoryPluginState();
    const { client, state } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      pluginState,
    });
    const { api, heartbeatRequests, hooks, systemEvents, tools } =
      createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
      });

    await plugin.register?.(api);

    const tool = findTool(tools, "send_message");
    const input = {
      correlationId: "corr_local_allow_hook_1",
      declaredSelectors: {
        action: "share",
        resource: "location.current",
      },
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute("tool_call_local_allow_hook_1", input);

    expect(toolResult).toMatchObject({
      content: [
        {
          text: "Message sent through Mahilo.",
        },
      ],
      details: {
        decision: "allow",
        messageId: "msg_123",
        resolutionId: "res_direct_default",
        status: "sent",
      },
    });
    expect(state.localDecisionCommitCalls).toHaveLength(1);
    expect(state.sendCalls).toHaveLength(1);

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: input,
        result: toolResult,
        toolName: "send_message",
      },
      {
        agentId: "mahilo-agent",
        runId: "run_local_allow_hook_1",
        sessionKey: "session_local_allow_hook_1",
        toolCallId: "tool_call_local_allow_hook_1",
        toolName: "send_message",
      },
    );

    expect(
      pluginState.resolveInboundRoute({
        inResponseToMessageId: "msg_123",
      }),
    ).toMatchObject({
      correlationId: "corr_local_allow_hook_1",
      sessionKey: "session_local_allow_hook_1",
    });
    expect(systemEvents).toEqual([
      expect.objectContaining({
        sessionKey: "session_local_allow_hook_1",
        text:
          "Mahilo outcome: sent to alice (location.current/share) [message msg_123].",
      }),
    ]);

    const agentEnd = findHook(hooks, "agent_end");
    await agentEnd.execute(
      {
        messages: [],
        success: true,
      },
      {
        agentId: "mahilo-agent",
        sessionKey: "session_local_allow_hook_1",
      },
    );

    expect(systemEvents).toHaveLength(2);
    expect(String(systemEvents[1]?.text ?? "")).toContain(
      "Mahilo learning opportunity:",
    );
    expect(String(systemEvents[1]?.text ?? "")).toContain(
      "Mahilo just shared new information with alice",
    );
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-agent",
        reason: "mahilo:learning-suggestion",
        sessionKey: "session_local_allow_hook_1",
      },
    ]);
  });

  it("keeps locally held send_message results out of reply routing while preserving review hooks", async () => {
    const pluginState = new InMemoryPluginState();
    const { client, state } = createMockContractClient({
      directSendBundleResponse: (payload) => ({
        ...buildDefaultDirectSendBundle(payload),
        applicable_policies: [
          createPolicy({
            effect: "ask",
            evaluator: "structured",
            id: "pol_direct_review_hook",
            policy_content: { intent: "manual_review" },
            priority: 100,
            scope: "user",
          }),
        ],
        bundle_metadata: {
          ...buildDefaultDirectSendBundle(payload).bundle_metadata,
          resolution_id: "res_direct_review_hook",
        },
      }),
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      pluginState,
    });
    const { api, heartbeatRequests, hooks, systemEvents, tools } =
      createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
      });

    await plugin.register?.(api);

    const tool = findTool(tools, "send_message");
    const input = {
      correlationId: "corr_local_review_hook_1",
      declaredSelectors: {
        action: "share",
        resource: "location.current",
      },
      message: "share location",
      recipient: "alice",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute("tool_call_local_review_hook_1", input);

    expect(toolResult).toMatchObject({
      content: [
        {
          text: expect.stringContaining(
            "Mahilo needs review before sending this person message.",
          ),
        },
      ],
      details: {
        decision: "ask",
        reason: expect.stringContaining("Review required"),
        resolutionId: "res_direct_review_hook",
        status: "review_required",
      },
    });
    expect(state.localDecisionCommitCalls).toHaveLength(1);
    expect(state.sendCalls).toHaveLength(0);

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: input,
        result: toolResult,
        toolName: "send_message",
      },
      {
        agentId: "mahilo-agent",
        runId: "run_local_review_hook_1",
        sessionKey: "session_local_review_hook_1",
        toolCallId: "tool_call_local_review_hook_1",
        toolName: "send_message",
      },
    );

    expect(pluginState.inboundRouteCount()).toBe(0);
    expect(systemEvents).toEqual([
      expect.objectContaining({
        sessionKey: "session_local_review_hook_1",
        text: expect.stringContaining(
          "Mahilo outcome: review required for alice (location.current/share).",
        ),
      }),
    ]);

    const agentEnd = findHook(hooks, "agent_end");
    await agentEnd.execute(
      {
        messages: [],
        success: true,
      },
      {
        agentId: "mahilo-agent",
        sessionKey: "session_local_review_hook_1",
      },
    );

    expect(systemEvents).toHaveLength(2);
    expect(String(systemEvents[1]?.text ?? "")).toContain(
      "Mahilo learning opportunity:",
    );
    expect(String(systemEvents[1]?.text ?? "")).toContain(
      "Mahilo asked for review before sending to alice",
    );
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-agent",
        reason: "mahilo:learning-suggestion",
        sessionKey: "session_local_review_hook_1",
      },
    ]);
  });

  it("keeps locally blocked send_message results out of reply routing while preserving blocked hooks", async () => {
    const pluginState = new InMemoryPluginState();
    const { client, state } = createMockContractClient({
      directSendBundleResponse: (payload) => ({
        ...buildDefaultDirectSendBundle(payload),
        applicable_policies: [
          createPolicy({
            effect: "deny",
            evaluator: "structured",
            id: "pol_direct_block_hook",
            policy_content: {},
            priority: 100,
            scope: "user",
          }),
        ],
        bundle_metadata: {
          ...buildDefaultDirectSendBundle(payload).bundle_metadata,
          resolution_id: "res_direct_block_hook",
        },
      }),
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
      pluginState,
    });
    const { api, heartbeatRequests, hooks, systemEvents, tools } =
      createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
      });

    await plugin.register?.(api);

    const tool = findTool(tools, "send_message");
    const input = {
      correlationId: "corr_local_block_hook_1",
      declaredSelectors: {
        action: "share",
        resource: "location.current",
      },
      message: "share ssn",
      recipient: "alice",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute("tool_call_local_block_hook_1", input);

    expect(toolResult).toMatchObject({
      content: [
        {
          text: expect.stringContaining("Mahilo blocked this person message."),
        },
      ],
      details: {
        decision: "deny",
        reason: expect.any(String),
        resolutionId: "res_direct_block_hook",
        status: "denied",
      },
    });
    expect(state.localDecisionCommitCalls).toHaveLength(1);
    expect(state.sendCalls).toHaveLength(0);

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: input,
        result: toolResult,
        toolName: "send_message",
      },
      {
        agentId: "mahilo-agent",
        runId: "run_local_block_hook_1",
        sessionKey: "session_local_block_hook_1",
        toolCallId: "tool_call_local_block_hook_1",
        toolName: "send_message",
      },
    );

    expect(pluginState.inboundRouteCount()).toBe(0);
    expect(systemEvents).toEqual([
      expect.objectContaining({
        sessionKey: "session_local_block_hook_1",
        text: expect.stringContaining(
          "Mahilo outcome: blocked for alice (location.current/share).",
        ),
      }),
    ]);

    const agentEnd = findHook(hooks, "agent_end");
    await agentEnd.execute(
      {
        messages: [],
        success: true,
      },
      {
        agentId: "mahilo-agent",
        sessionKey: "session_local_block_hook_1",
      },
    );

    expect(systemEvents).toHaveLength(2);
    expect(String(systemEvents[1]?.text ?? "")).toContain(
      "Mahilo learning opportunity:",
    );
    expect(String(systemEvents[1]?.text ?? "")).toContain(
      "Mahilo blocked a send to alice",
    );
    expect(heartbeatRequests).toEqual([
      {
        agentId: "mahilo-agent",
        reason: "mahilo:learning-suggestion",
        sessionKey: "session_local_block_hook_1",
      },
    ]);
  });

  it("does not repeat learning suggestions for the same Mahilo decision fingerprint", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, heartbeatRequests, hooks, systemEvents, tools } =
      createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
      });

    await plugin.register?.(api);

    const tool = findTool(tools, "send_message");
    const afterToolCall = findHook(hooks, "after_tool_call");
    const agentEnd = findHook(hooks, "agent_end");
    const input = {
      declaredSelectors: {
        action: "share",
        resource: "location.current",
      },
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender",
    };

    const firstResult = await tool.execute("tool_call_post_send_2a", input);
    await afterToolCall.execute(
      {
        params: input,
        result: firstResult,
        toolName: "send_message",
      },
      {
        runId: "run_2a",
        sessionKey: "session_2",
        toolCallId: "tool_call_post_send_2a",
        toolName: "send_message",
      },
    );
    await agentEnd.execute(
      {
        messages: [],
        success: true,
      },
      {
        sessionKey: "session_2",
      },
    );

    const secondResult = await tool.execute("tool_call_post_send_2b", input);
    await afterToolCall.execute(
      {
        params: input,
        result: secondResult,
        toolName: "send_message",
      },
      {
        runId: "run_2b",
        sessionKey: "session_2",
        toolCallId: "tool_call_post_send_2b",
        toolName: "send_message",
      },
    );
    await agentEnd.execute(
      {
        messages: [],
        success: true,
      },
      {
        sessionKey: "session_2",
      },
    );

    const learningEvents = systemEvents.filter((event) =>
      event.text.includes("Mahilo learning opportunity:"),
    );

    expect(learningEvents).toHaveLength(1);
    expect(heartbeatRequests).toHaveLength(1);
  });

  it("keeps routine message.general sends out of the learning-suggestion path", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, heartbeatRequests, hooks, systemEvents, tools } =
      createMockPluginApi({
        apiKey: "mhl_test",
        baseUrl: "https://mahilo.example",
      });

    await plugin.register?.(api);

    const tool = findTool(tools, "send_message");
    const input = {
      message: "hello",
      recipient: "alice",
      senderConnectionId: "conn_sender",
    };
    const toolResult = await tool.execute("tool_call_post_send_3", input);

    const afterToolCall = findHook(hooks, "after_tool_call");
    await afterToolCall.execute(
      {
        params: input,
        result: toolResult,
        toolName: "send_message",
      },
      {
        sessionKey: "session_3",
        toolCallId: "tool_call_post_send_3",
        toolName: "send_message",
      },
    );

    const agentEnd = findHook(hooks, "agent_end");
    await agentEnd.execute(
      {
        messages: [],
        success: true,
      },
      {
        sessionKey: "session_3",
      },
    );

    expect(systemEvents).toHaveLength(1);
    expect(JSON.stringify(systemEvents[0])).toContain("message.general/share");
    expect(JSON.stringify(systemEvents[0])).not.toContain(
      "Mahilo learning opportunity:",
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
            "This is a very long summary intended to verify prompt-size controls remain bounded even when the server returns more context than needed.",
        },
        recipient: {
          relationship: "friend",
          roles: ["close_friends", "trusted", "long_list_role"],
          username: "alice",
        },
        recent_interactions: [
          { direction: "inbound", decision: "allow", summary: "one" },
          { direction: "outbound", decision: "ask", summary: "two" },
          { direction: "inbound", decision: "deny", summary: "three" },
          { direction: "outbound", decision: "allow", summary: "four" },
        ],
        suggested_selectors: {
          action: "share",
          direction: "inbound",
          resource: "message.general",
        },
      },
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, hooks } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
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
          resource: "message.general",
        },
      },
      prompt: "You are a helpful assistant.",
    });

    expect(state.promptContextCalls).toHaveLength(1);
    expect(state.promptContextCalls[0]).toMatchObject({
      recipient: "alice",
      recipient_type: "user",
      sender_connection_id: "conn_receiver",
    });

    expect(isRecord(result)).toBe(true);
    if (!isRecord(result)) {
      throw new Error(
        "expected before_prompt_build hook to return a payload object",
      );
    }

    const promptValue = result.prompt;
    if (typeof promptValue !== "string") {
      throw new Error(
        "expected before_prompt_build hook to return prompt as string",
      );
    }

    const prompt = promptValue;
    expect(prompt).toContain("[MahiloContext/v1]");
    expect(prompt).toContain("guidance=ask:context.ask.role.structured");
    expect(prompt).toContain(
      "recipient=name=alice; relationship=friend; roles=close_friends,trusted,long_list_role",
    );
    expect(prompt).toContain("recent_1=");
    expect(prompt).toContain("recent_2=");
    expect(prompt).not.toContain("recent_3=");
    expect(prompt).toContain("You are a helpful assistant.");
    expect(prompt.length).toBeLessThan(1400);
  });

  it("injects agent-facing bootstrap instructions into prompt before Mahilo is configured", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, hooks } = createMockPluginApi({
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const hook = findHook(hooks, "before_prompt_build");
    const result = await hook.execute({
      prompt: "You are a helpful assistant.",
    });

    expect(isRecord(result)).toBe(true);
    if (!isRecord(result)) {
      throw new Error(
        "expected before_prompt_build hook to return a payload object",
      );
    }

    const promptValue = result.prompt;
    if (typeof promptValue !== "string") {
      throw new Error(
        "expected before_prompt_build hook to return prompt as string",
      );
    }

    expect(promptValue).toContain("[MahiloSetup/v1]");
    expect(promptValue).toContain(
      "POST https://mahilo.example/api/v1/auth/register",
    );
    expect(promptValue).toContain("config.patch");
    expect(promptValue).toContain('"apiKey"');
    expect(promptValue).toContain("Do NOT ask the human to run /mahilo setup");
    expect(promptValue).toContain(
      "Do NOT read docs or source code.",
    );
    expect(promptValue).toContain("invite token (mhinv_...) is NOT an API key");
    expect(promptValue).toContain("You are a helpful assistant.");
  });

  it("resolves prompt-hook sender context from active Mahilo connections when none is passed", async () => {
    const { client, state } = createMockContractClient({
      agentConnectionsResponse: [
        {
          active: true,
          framework: "other",
          id: "conn_other",
          label: "zeta",
        },
        {
          active: true,
          framework: "openclaw",
          id: "conn_sender_default",
          label: "primary",
        },
      ],
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, hooks } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const hook = findHook(hooks, "before_prompt_build");
    await hook.execute({
      message: {
        sender: "alice",
        selectors: {
          action: "share",
          direction: "inbound",
          resource: "message.general",
        },
      },
      prompt: "You are a helpful assistant.",
    });

    expect(state.agentConnectionCalls).toBe(1);
    expect(state.promptContextCalls[0]).toMatchObject({
      recipient: "alice",
      recipient_type: "user",
      sender_connection_id: "conn_sender_default",
    });
  });

  it("treats request hook directions as inbound-like for prompt context recipient resolution", async () => {
    const { client, state } = createMockContractClient({
      agentConnectionsResponse: [
        {
          active: true,
          framework: "openclaw",
          id: "conn_sender_default",
          label: "primary",
        },
      ],
    });
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, hooks } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
    });

    await plugin.register?.(api);

    const hook = findHook(hooks, "before_prompt_build");
    await hook.execute({
      message: {
        recipient: "ignored_recipient",
        sender: "alice",
        selectors: {
          action: "request",
          direction: "request",
          resource: "message.general",
        },
      },
      prompt: "You are a helpful assistant.",
    });

    expect(state.promptContextCalls[0]).toMatchObject({
      recipient: "alice",
      recipient_type: "user",
      sender_connection_id: "conn_sender_default",
    });
  });

  it("does not register prompt hook when promptContextEnabled is false", async () => {
    const { client } = createMockContractClient();
    const plugin = createMahiloOpenClawPlugin({
      createClient: () => client,
    });
    const { api, hooks } = createMockPluginApi({
      apiKey: "mhl_test",
      baseUrl: "https://mahilo.example",
      promptContextEnabled: false,
    });

    await plugin.register?.(api);

    expect(hooks.map((hook) => hook.name)).not.toContain("before_prompt_build");
  });
});
