import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

import type { MahiloContractClient } from "./client";
import { redactSensitiveConfig, type MahiloPluginConfig } from "./config";
import { getMahiloRelationshipView } from "./relationships";
import type { InMemoryPluginState } from "./state";
import { DEFAULT_WEBHOOK_ROUTE_PATH } from "./webhook-route";

export interface MahiloDiagnosticsLogger {
  debug?: (message: string) => void;
  error?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface MahiloDiagnosticsCommandOptions {
  logger?: MahiloDiagnosticsLogger;
  now?: () => number;
  pluginState?: InMemoryPluginState;
  reconnectDelayMs?: number;
}

export interface MahiloCommandDefinition {
  description: string;
  execute: (rawInput?: unknown) => Promise<unknown>;
  label: string;
  name: string;
  parameters: Record<string, unknown>;
}

interface MahiloOperatorCommandRouter {
  registered: boolean;
  subcommands: Map<string, MahiloCommandDefinition>;
}

interface MahiloDiagnosticsRuntimeState {
  lastContactError?: string;
  lastReconnectAt?: string;
  lastSuccessfulContactAt?: string;
  reconnectCount: number;
}

const DEFAULT_RECONNECT_ATTEMPTS = 2;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const DEFAULT_NETWORK_ACTIVITY_LIMIT = 6;
const DEFAULT_REVIEW_LIMIT = 20;
const MAHILO_OPERATOR_COMMAND_NAME = "mahilo";
const MAX_LIMIT = 100;
const operatorRouters = new WeakMap<object, MahiloOperatorCommandRouter>();

export function registerMahiloDiagnosticsCommands(
  api: OpenClawPluginApi,
  config: MahiloPluginConfig,
  client: MahiloContractClient,
  options: MahiloDiagnosticsCommandOptions = {},
): void {
  const runtimeState: MahiloDiagnosticsRuntimeState = {
    reconnectCount: 0,
  };

  const commands: MahiloCommandDefinition[] = [
    createStatusCommand(config, client, runtimeState, options),
    createNetworkCommand(client, runtimeState, options),
    createReviewCommand(client, runtimeState, options),
    createReconnectCommand(client, runtimeState, options),
  ];

  for (const command of commands) {
    registerCommandCompat(api, command);
  }

  options.logger?.info?.(
    "[Mahilo] Registered commands: mahilo status, mahilo network, mahilo review, mahilo reconnect",
  );
}

function createStatusCommand(
  config: MahiloPluginConfig,
  client: MahiloContractClient,
  runtimeState: MahiloDiagnosticsRuntimeState,
  options: MahiloDiagnosticsCommandOptions,
): MahiloCommandDefinition {
  return {
    description:
      "Inspect Mahilo plugin health, config, and local runtime state.",
    execute: async () => {
      const checkedAt = toIsoTimestamp(options.now);

      const reviewProbe = await probe(
        async () => client.listReviews({ limit: 1, status: "open" }),
        "list open reviews",
      );
      const blockedProbe = await probe(
        async () => client.listBlockedEvents(1),
        "list blocked events",
      );
      const connected = reviewProbe.ok && blockedProbe.ok;

      if (connected) {
        runtimeState.lastSuccessfulContactAt = checkedAt;
        runtimeState.lastContactError = undefined;
      } else {
        runtimeState.lastContactError = reviewProbe.error ?? blockedProbe.error;
      }

      const details = {
        checkedAt,
        command: "mahilo status",
        connected,
        diagnostics: {
          lastContactError: runtimeState.lastContactError ?? null,
          lastReconnectAt: runtimeState.lastReconnectAt ?? null,
          lastSuccessfulContactAt: runtimeState.lastSuccessfulContactAt ?? null,
          reconnectCount: runtimeState.reconnectCount,
        },
        plugin: {
          callbackPath: config.callbackPath ?? DEFAULT_WEBHOOK_ROUTE_PATH,
          config: redactSensitiveConfig(config),
        },
        probes: {
          blockedEvents: {
            error: blockedProbe.error ?? null,
            ok: blockedProbe.ok,
            sampleCount: blockedProbe.sampleCount ?? null,
          },
          reviews: {
            error: reviewProbe.error ?? null,
            ok: reviewProbe.ok,
            sampleCount: reviewProbe.sampleCount ?? null,
          },
        },
        runtimeState: options.pluginState
          ? {
              askAroundSessions: options.pluginState.askAroundSessionCount(),
              contextCacheEntries: options.pluginState.contextCacheSize(),
              dedupeEntries: options.pluginState.dedupe.size(),
              inboundRouteEntries: options.pluginState.inboundRouteCount(),
              novelDecisionEntries: options.pluginState.novelDecisionCount(),
              pendingLearningSuggestions:
                options.pluginState.pendingLearningSuggestionCount(),
              productSignalQueries:
                options.pluginState.productSignalQueryCount(),
              productSignalReplies:
                options.pluginState.productSignalReplyCount(),
            }
          : null,
      };

      return toCommandResult(
        connected
          ? "Mahilo status: connected; diagnostics snapshot available."
          : "Mahilo status: connectivity checks failed; inspect details for debug hints.",
        details,
      );
    },
    label: "Mahilo Status",
    name: "mahilo status",
    parameters: {
      additionalProperties: false,
      type: "object",
    },
  };
}

function createReviewCommand(
  client: MahiloContractClient,
  runtimeState: MahiloDiagnosticsRuntimeState,
  options: MahiloDiagnosticsCommandOptions,
): MahiloCommandDefinition {
  return {
    description:
      "Inspect Mahilo review queue items with optional status and limit filters.",
    execute: async (rawInput?: unknown) => {
      const input = readInputObject(rawInput);
      const checkedAt = toIsoTimestamp(options.now);
      const statusFilter = readOptionalString(input.status) ?? "open";
      const limit = readBoundedInteger(
        input.limit,
        DEFAULT_REVIEW_LIMIT,
        1,
        MAX_LIMIT,
      );

      try {
        const response = await client.listReviews({
          limit,
          status: statusFilter,
        });

        runtimeState.lastSuccessfulContactAt = checkedAt;
        runtimeState.lastContactError = undefined;

        const details = {
          checkedAt,
          command: "mahilo review",
          items: normalizeReviewItems(response),
          limit,
          nextCursor:
            readOptionalString(readObject(response)?.next_cursor) ?? null,
          status: statusFilter,
        };

        return toCommandResult(
          `Mahilo review: fetched ${details.items.length} item(s) for status=${statusFilter}.`,
          details,
        );
      } catch (error) {
        const message = toErrorMessage(error);
        runtimeState.lastContactError = message;

        return toCommandResult("Mahilo review: failed to fetch review queue.", {
          checkedAt,
          command: "mahilo review",
          error: message,
          hints: [
            "Verify plugins.entries.mahilo.config.baseUrl points to the active Mahilo server.",
            "Verify plugins.entries.mahilo.config.apiKey is valid and has plugin access.",
          ],
          limit,
          status: statusFilter,
        });
      }
    },
    label: "Mahilo Review",
    name: "mahilo review",
    parameters: {
      additionalProperties: false,
      properties: {
        limit: { type: "integer" },
        status: { type: "string" },
      },
      type: "object",
    },
  };
}

function createNetworkCommand(
  client: MahiloContractClient,
  runtimeState: MahiloDiagnosticsRuntimeState,
  options: MahiloDiagnosticsCommandOptions,
): MahiloCommandDefinition {
  return {
    description:
      "Inspect Mahilo contacts, pending requests, sender connections, recent activity, and the last seven days of lightweight product signals from inside OpenClaw.",
    execute: async (rawInput?: unknown) => {
      const input = readInputObject(rawInput);
      const nowMs =
        typeof options.now === "function" ? options.now() : Date.now();
      const checkedAt = new Date(nowMs).toISOString();
      const activityLimit = readBoundedInteger(
        input.activityLimit ?? input.activity_limit ?? input.limit,
        DEFAULT_NETWORK_ACTIVITY_LIMIT,
        1,
        MAX_LIMIT,
      );
      const result = await getMahiloRelationshipView(client, {
        activityLimit,
      });

      if (result.status === "success") {
        runtimeState.lastSuccessfulContactAt = checkedAt;
        runtimeState.lastContactError = result.warnings?.[0];
      } else {
        runtimeState.lastContactError =
          result.error?.technicalMessage ?? result.error?.message;
      }

      const productSignals =
        options.pluginState && result.status === "success"
          ? options.pluginState.getProductSignalsSnapshot({
              connectedContacts: result.counts?.contacts,
              nowMs,
            })
          : null;
      const text =
        productSignals && hasRecordedProductSignals(productSignals)
          ? `${result.summary} ${productSignals.summary}`
          : result.summary;

      return toCommandResult(text, {
        checkedAt,
        command: "mahilo network",
        activityLimit,
        productSignals,
        ...result,
      });
    },
    label: "Mahilo Network",
    name: "mahilo network",
    parameters: {
      additionalProperties: false,
      properties: {
        activityLimit: { type: "integer" },
        activity_limit: { type: "integer" },
        limit: { type: "integer" },
      },
      type: "object",
    },
  };
}

function createReconnectCommand(
  client: MahiloContractClient,
  runtimeState: MahiloDiagnosticsRuntimeState,
  options: MahiloDiagnosticsCommandOptions,
): MahiloCommandDefinition {
  return {
    description:
      "Retry Mahilo connectivity checks and report actionable reconnect diagnostics.",
    execute: async (rawInput?: unknown) => {
      const input = readInputObject(rawInput);
      const checkedAt = toIsoTimestamp(options.now);
      const attempts = readBoundedInteger(
        input.attempts,
        DEFAULT_RECONNECT_ATTEMPTS,
        1,
        10,
      );
      const delayMs = readBoundedInteger(
        input.delayMs ?? input.delay_ms,
        options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
        0,
        30_000,
      );
      const errors: string[] = [];

      runtimeState.reconnectCount += 1;
      runtimeState.lastReconnectAt = checkedAt;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          await client.listReviews({ limit: 1, status: "open" });
          await client.listBlockedEvents(1);

          const connectedAt = toIsoTimestamp(options.now);
          runtimeState.lastSuccessfulContactAt = connectedAt;
          runtimeState.lastContactError = undefined;

          return toCommandResult(
            `Mahilo reconnect: connected on attempt ${attempt}/${attempts}.`,
            {
              attempt,
              attempts,
              checkedAt,
              command: "mahilo reconnect",
              connected: true,
              delayMs,
              reconnectCount: runtimeState.reconnectCount,
            },
          );
        } catch (error) {
          const message = toErrorMessage(error);
          errors.push(`attempt ${attempt}: ${message}`);
          runtimeState.lastContactError = message;

          if (attempt < attempts && delayMs > 0) {
            await sleep(delayMs);
          }
        }
      }

      return toCommandResult("Mahilo reconnect: all retry attempts failed.", {
        attempts,
        checkedAt,
        command: "mahilo reconnect",
        connected: false,
        delayMs,
        errors,
        hints: [
          "Check Mahilo server reachability from OpenClaw runtime host.",
          "Check plugin API key validity and permission scope.",
          "Check callbackPath/callbackUrl alignment if inbound delivery appears disconnected.",
        ],
        reconnectCount: runtimeState.reconnectCount,
      });
    },
    label: "Mahilo Reconnect",
    name: "mahilo reconnect",
    parameters: {
      additionalProperties: false,
      properties: {
        attempts: { type: "integer" },
        delayMs: { type: "integer" },
        delay_ms: { type: "integer" },
      },
      type: "object",
    },
  };
}

export function registerMahiloOperatorCommand(
  api: OpenClawPluginApi,
  command: MahiloCommandDefinition,
): void {
  const registerCommand = api.registerCommand as unknown as (
    ...args: unknown[]
  ) => void;
  const router = getMahiloOperatorRouter(api);
  const subcommand = readMahiloSubcommand(command.name);

  if (!subcommand) {
    registerCommand({
      description: command.description,
      execute: command.execute,
      handler: async (ctx: unknown) =>
        normalizeMahiloCommandReply(await command.execute(ctx)),
      label: command.label,
      name: command.name,
      parameters: command.parameters,
      run: command.execute,
    });
    return;
  }

  router.subcommands.set(subcommand, command);
  if (router.registered) {
    return;
  }

  registerCommand({
    acceptsArgs: true,
    description:
      "Mahilo setup and diagnostics. Use /mahilo <setup|status|network|review|reconnect> [json].",
    handler: async (ctx: unknown) => executeMahiloOperatorRouter(router, ctx),
    name: MAHILO_OPERATOR_COMMAND_NAME,
    requireAuth: true,
  });
  router.registered = true;
}

function registerCommandCompat(
  api: OpenClawPluginApi,
  command: MahiloCommandDefinition,
): void {
  const registerCommand = api.registerCommand as unknown as (
    ...args: unknown[]
  ) => void;
  const prefersObjectStyle = Boolean(
    (registerCommand as unknown as Record<string, unknown>).__mahiloObjectStyle,
  );

  // Support both object-style and name/handler-style command registration surfaces.
  if (prefersObjectStyle || registerCommand.length < 2) {
    registerMahiloOperatorCommand(api, command);
    return;
  }

  if (registerCommand.length >= 2) {
    registerCommand(command.name, command.execute, {
      description: command.description,
      label: command.label,
      parameters: command.parameters,
    });
    return;
  }

  registerCommand({
    description: command.description,
    execute: command.execute,
    handler: command.execute,
    label: command.label,
    name: command.name,
    parameters: command.parameters,
    run: command.execute,
  });
}

function readInputObject(rawInput: unknown): Record<string, unknown> {
  if (rawInput === undefined) {
    return {};
  }

  if (
    typeof rawInput !== "object" ||
    rawInput === null ||
    Array.isArray(rawInput)
  ) {
    throw new Error("command input must be an object");
  }

  return rawInput as Record<string, unknown>;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
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

function readBoundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const candidate = Number.isInteger(value) ? Number(value) : fallback;
  if (!Number.isFinite(candidate)) {
    return fallback;
  }

  if (candidate < min) {
    return min;
  }

  if (candidate > max) {
    return max;
  }

  return candidate;
}

function toErrorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    typeof error.message === "string" &&
    error.message.length > 0
  ) {
    return error.message;
  }

  return String(error);
}

function hasRecordedProductSignals(snapshot: {
  queriesSent: number;
  repliesReceived: number;
}): boolean {
  return snapshot.queriesSent > 0 || snapshot.repliesReceived > 0;
}

function toIsoTimestamp(nowProvider?: () => number): string {
  const now = typeof nowProvider === "function" ? nowProvider() : Date.now();
  return new Date(now).toISOString();
}

async function probe(
  fn: () => Promise<unknown>,
  operation: string,
): Promise<{ error?: string; ok: boolean; sampleCount?: number }> {
  try {
    const response = await fn();
    return {
      ok: true,
      sampleCount: readItemCount(response),
    };
  } catch (error) {
    return {
      error: `Failed to ${operation}: ${toErrorMessage(error)}`,
      ok: false,
    };
  }
}

function getMahiloOperatorRouter(
  api: OpenClawPluginApi,
): MahiloOperatorCommandRouter {
  const key = api as unknown as object;
  const existing = operatorRouters.get(key);
  if (existing) {
    return existing;
  }

  const created: MahiloOperatorCommandRouter = {
    registered: false,
    subcommands: new Map(),
  };
  operatorRouters.set(key, created);
  return created;
}

function readMahiloSubcommand(name: string): string | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized.startsWith(`${MAHILO_OPERATOR_COMMAND_NAME} `)) {
    return null;
  }

  const subcommand = normalized
    .slice(MAHILO_OPERATOR_COMMAND_NAME.length)
    .trim();
  return subcommand.length > 0 ? subcommand : null;
}

async function executeMahiloOperatorRouter(
  router: MahiloOperatorCommandRouter,
  ctx: unknown,
): Promise<Record<string, unknown>> {
  const args = readOptionalString(readRecordValue(ctx, "args")) ?? "";
  const [firstToken, ...restTokens] = args.split(/\s+/).filter(Boolean);
  const subcommand = firstToken?.trim().toLowerCase();

  if (!subcommand) {
    return {
      text: buildMahiloCommandHelp(router),
    };
  }

  const command = router.subcommands.get(subcommand);
  if (!command) {
    return {
      text: `${buildMahiloCommandHelp(router)}\n\nUnknown subcommand: ${subcommand}`,
    };
  }

  try {
    const input = parseMahiloCommandArgs(subcommand, restTokens.join(" "));
    return normalizeMahiloCommandReply(await command.execute(input));
  } catch (error) {
    return {
      isError: true,
      text: `Mahilo command failed: ${toErrorMessage(error)}`,
    };
  }
}

function buildMahiloCommandHelp(router: MahiloOperatorCommandRouter): string {
  const available = Array.from(router.subcommands.keys()).sort();
  const base =
    "Usage: /mahilo <setup|status|network|review|reconnect> [json]\n" +
    "Examples:\n" +
    '/mahilo setup {"username":"bootstrap-user","invite_token":"mhinv_example"}\n' +
    "/mahilo status\n" +
    "/mahilo network\n" +
    '/mahilo review {"status":"open","limit":10}';

  if (available.length === 0) {
    return base;
  }

  return `${base}\nAvailable: ${available.join(", ")}`;
}

function parseMahiloCommandArgs(subcommand: string, rawArgs: string): unknown {
  const trimmed = rawArgs.trim();
  if (trimmed.length === 0) {
    return {};
  }

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!readObject(parsed)) {
      throw new Error("JSON command arguments must decode to an object");
    }

    return parsed;
  }

  if (subcommand === "setup") {
    const [username, inviteToken] = trimmed.split(/\s+/, 2);
    return {
      invite_token: inviteToken,
      username: username?.replace(/^@+/, ""),
    };
  }

  throw new Error(
    'Pass command arguments as JSON, for example /mahilo review {"status":"open"}',
  );
}

function normalizeMahiloCommandReply(result: unknown): Record<string, unknown> {
  const root = readObject(result);
  if (root && typeof root.text === "string") {
    return {
      isError: root.isError === true,
      text: root.text,
    };
  }

  const text = extractMahiloCommandText(result);
  const details = root ? readObject(root.details) : undefined;
  return {
    text:
      details && Object.keys(details).length > 0
        ? `${text}\n\n${JSON.stringify(details, null, 2)}`
        : text,
  };
}

function extractMahiloCommandText(result: unknown): string {
  if (typeof result === "string" && result.trim().length > 0) {
    return result;
  }

  const root = readObject(result);
  const content = root?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const record = readObject(block);
      if (
        record &&
        typeof record.text === "string" &&
        record.text.trim().length > 0
      ) {
        return record.text;
      }
    }
  }

  return "Mahilo command completed.";
}

function readItemCount(value: unknown): number | undefined {
  const root = readObject(value);
  if (!root) {
    return undefined;
  }

  for (const key of ["items", "reviews", "blocked_events"]) {
    const items = root[key];
    if (Array.isArray(items)) {
      return items.length;
    }
  }

  return undefined;
}

function normalizeReviewItems(
  response: unknown,
): Array<Record<string, unknown>> {
  const root = readObject(response);
  if (!root) {
    return [];
  }

  const items = Array.isArray(root.items)
    ? root.items
    : Array.isArray(root.reviews)
      ? root.reviews
      : [];

  const normalized: Array<Record<string, unknown>> = [];
  for (const rawItem of items) {
    const item = readObject(rawItem);
    if (!item) {
      continue;
    }

    const selectors = readObject(item.selectors);

    normalized.push({
      createdAt: readOptionalString(item.created_at) ?? null,
      decision: readOptionalString(item.decision) ?? null,
      recipient: readOptionalString(item.recipient) ?? null,
      reviewId: readOptionalString(item.review_id) ?? null,
      selectors: selectors
        ? {
            action: readOptionalString(selectors.action) ?? null,
            direction: readOptionalString(selectors.direction) ?? null,
            resource: readOptionalString(selectors.resource) ?? null,
          }
        : null,
      summary: readOptionalString(item.summary) ?? null,
    });
  }

  return normalized;
}

function readRecordValue(value: unknown, key: string): unknown {
  const root = readObject(value);
  return root ? root[key] : undefined;
}

function toCommandResult(
  text: string,
  details: Record<string, unknown>,
): {
  content: Array<{ text: string; type: "text" }>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ text, type: "text" }],
    details,
  };
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
