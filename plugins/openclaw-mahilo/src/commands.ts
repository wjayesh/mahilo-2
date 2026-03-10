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

interface MahiloCommand {
  description: string;
  execute: (rawInput?: unknown) => Promise<unknown>;
  label: string;
  name: string;
  parameters: Record<string, unknown>;
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
const MAX_LIMIT = 100;

export function registerMahiloDiagnosticsCommands(
  api: OpenClawPluginApi,
  config: MahiloPluginConfig,
  client: MahiloContractClient,
  options: MahiloDiagnosticsCommandOptions = {}
): void {
  const runtimeState: MahiloDiagnosticsRuntimeState = {
    reconnectCount: 0
  };

  const commands: MahiloCommand[] = [
    createStatusCommand(config, client, runtimeState, options),
    createNetworkCommand(client, runtimeState, options),
    createReviewCommand(client, runtimeState, options),
    createReconnectCommand(client, runtimeState, options)
  ];

  for (const command of commands) {
    registerCommandCompat(api, command);
  }

  options.logger?.info?.(
    "[Mahilo] Registered commands: mahilo status, mahilo network, mahilo review, mahilo reconnect"
  );
}

function createStatusCommand(
  config: MahiloPluginConfig,
  client: MahiloContractClient,
  runtimeState: MahiloDiagnosticsRuntimeState,
  options: MahiloDiagnosticsCommandOptions
): MahiloCommand {
  return {
    description: "Inspect Mahilo plugin health, config, and local runtime state.",
    execute: async () => {
      const checkedAt = toIsoTimestamp(options.now);

      const reviewProbe = await probe(
        async () => client.listReviews({ limit: 1, status: "open" }),
        "list open reviews"
      );
      const blockedProbe = await probe(
        async () => client.listBlockedEvents(1),
        "list blocked events"
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
          reconnectCount: runtimeState.reconnectCount
        },
        plugin: {
          callbackPath: config.callbackPath ?? DEFAULT_WEBHOOK_ROUTE_PATH,
          config: redactSensitiveConfig(config)
        },
        probes: {
          blockedEvents: {
            error: blockedProbe.error ?? null,
            ok: blockedProbe.ok,
            sampleCount: blockedProbe.sampleCount ?? null
          },
          reviews: {
            error: reviewProbe.error ?? null,
            ok: reviewProbe.ok,
            sampleCount: reviewProbe.sampleCount ?? null
          }
        },
        runtimeState: options.pluginState
          ? {
              contextCacheEntries: options.pluginState.contextCacheSize(),
              dedupeEntries: options.pluginState.dedupe.size(),
              inboundRouteEntries: options.pluginState.inboundRouteCount(),
              novelDecisionEntries: options.pluginState.novelDecisionCount(),
              pendingLearningSuggestions:
                options.pluginState.pendingLearningSuggestionCount()
            }
          : null
      };

      return toCommandResult(
        connected
          ? "Mahilo status: connected; diagnostics snapshot available."
          : "Mahilo status: connectivity checks failed; inspect details for debug hints.",
        details
      );
    },
    label: "Mahilo Status",
    name: "mahilo status",
    parameters: {
      additionalProperties: false,
      type: "object"
    }
  };
}

function createReviewCommand(
  client: MahiloContractClient,
  runtimeState: MahiloDiagnosticsRuntimeState,
  options: MahiloDiagnosticsCommandOptions
): MahiloCommand {
  return {
    description: "Inspect Mahilo review queue items with optional status and limit filters.",
    execute: async (rawInput?: unknown) => {
      const input = readInputObject(rawInput);
      const checkedAt = toIsoTimestamp(options.now);
      const statusFilter = readOptionalString(input.status) ?? "open";
      const limit = readBoundedInteger(input.limit, DEFAULT_REVIEW_LIMIT, 1, MAX_LIMIT);

      try {
        const response = await client.listReviews({
          limit,
          status: statusFilter
        });

        runtimeState.lastSuccessfulContactAt = checkedAt;
        runtimeState.lastContactError = undefined;

        const details = {
          checkedAt,
          command: "mahilo review",
          items: normalizeReviewItems(response),
          limit,
          nextCursor: readOptionalString(readObject(response)?.next_cursor) ?? null,
          status: statusFilter
        };

        return toCommandResult(
          `Mahilo review: fetched ${details.items.length} item(s) for status=${statusFilter}.`,
          details
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
            "Verify plugins.entries.mahilo.config.apiKey is valid and has plugin access."
          ],
          limit,
          status: statusFilter
        });
      }
    },
    label: "Mahilo Review",
    name: "mahilo review",
    parameters: {
      additionalProperties: false,
      properties: {
        limit: { type: "integer" },
        status: { type: "string" }
      },
      type: "object"
    }
  };
}

function createNetworkCommand(
  client: MahiloContractClient,
  runtimeState: MahiloDiagnosticsRuntimeState,
  options: MahiloDiagnosticsCommandOptions
): MahiloCommand {
  return {
    description:
      "Inspect Mahilo contacts, pending requests, sender connections, and recent activity from inside OpenClaw.",
    execute: async (rawInput?: unknown) => {
      const input = readInputObject(rawInput);
      const checkedAt = toIsoTimestamp(options.now);
      const activityLimit = readBoundedInteger(
        input.activityLimit ?? input.activity_limit ?? input.limit,
        DEFAULT_NETWORK_ACTIVITY_LIMIT,
        1,
        MAX_LIMIT
      );
      const result = await getMahiloRelationshipView(client, {
        activityLimit
      });

      if (result.status === "success") {
        runtimeState.lastSuccessfulContactAt = checkedAt;
        runtimeState.lastContactError = result.warnings?.[0];
      } else {
        runtimeState.lastContactError = result.error?.technicalMessage ?? result.error?.message;
      }

      return toCommandResult(result.summary, {
        checkedAt,
        command: "mahilo network",
        activityLimit,
        ...result
      });
    },
    label: "Mahilo Network",
    name: "mahilo network",
    parameters: {
      additionalProperties: false,
      properties: {
        activityLimit: { type: "integer" },
        activity_limit: { type: "integer" },
        limit: { type: "integer" }
      },
      type: "object"
    }
  };
}

function createReconnectCommand(
  client: MahiloContractClient,
  runtimeState: MahiloDiagnosticsRuntimeState,
  options: MahiloDiagnosticsCommandOptions
): MahiloCommand {
  return {
    description: "Retry Mahilo connectivity checks and report actionable reconnect diagnostics.",
    execute: async (rawInput?: unknown) => {
      const input = readInputObject(rawInput);
      const checkedAt = toIsoTimestamp(options.now);
      const attempts = readBoundedInteger(input.attempts, DEFAULT_RECONNECT_ATTEMPTS, 1, 10);
      const delayMs = readBoundedInteger(
        input.delayMs ?? input.delay_ms,
        options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
        0,
        30_000
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

          return toCommandResult(`Mahilo reconnect: connected on attempt ${attempt}/${attempts}.`, {
            attempt,
            attempts,
            checkedAt,
            command: "mahilo reconnect",
            connected: true,
            delayMs,
            reconnectCount: runtimeState.reconnectCount
          });
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
          "Check callbackPath/callbackUrl alignment if inbound delivery appears disconnected."
        ],
        reconnectCount: runtimeState.reconnectCount
      });
    },
    label: "Mahilo Reconnect",
    name: "mahilo reconnect",
    parameters: {
      additionalProperties: false,
      properties: {
        attempts: { type: "integer" },
        delayMs: { type: "integer" },
        delay_ms: { type: "integer" }
      },
      type: "object"
    }
  };
}

function registerCommandCompat(api: OpenClawPluginApi, command: MahiloCommand): void {
  const registerCommand = api.registerCommand as unknown as (...args: unknown[]) => void;

  // Support both object-style and name/handler-style command registration surfaces.
  if (registerCommand.length >= 2) {
    registerCommand(command.name, command.execute, {
      description: command.description,
      label: command.label,
      parameters: command.parameters
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
    run: command.execute
  });
}

function readInputObject(rawInput: unknown): Record<string, unknown> {
  if (rawInput === undefined) {
    return {};
  }

  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
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

function readBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
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
  if (error instanceof Error && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

function toIsoTimestamp(nowProvider?: () => number): string {
  const now = typeof nowProvider === "function" ? nowProvider() : Date.now();
  return new Date(now).toISOString();
}

async function probe(
  fn: () => Promise<unknown>,
  operation: string
): Promise<{ error?: string; ok: boolean; sampleCount?: number }> {
  try {
    const response = await fn();
    return {
      ok: true,
      sampleCount: readItemCount(response)
    };
  } catch (error) {
    return {
      error: `Failed to ${operation}: ${toErrorMessage(error)}`,
      ok: false
    };
  }
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

function normalizeReviewItems(response: unknown): Array<Record<string, unknown>> {
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
      selectors:
        selectors
          ? {
              action: readOptionalString(selectors.action) ?? null,
              direction: readOptionalString(selectors.direction) ?? null,
              resource: readOptionalString(selectors.resource) ?? null
            }
          : null,
      summary: readOptionalString(item.summary) ?? null
    });
  }

  return normalized;
}

function toCommandResult(
  text: string,
  details: Record<string, unknown>
): { content: Array<{ text: string; type: "text" }>; details: Record<string, unknown> } {
  return {
    content: [{ text, type: "text" }],
    details
  };
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
