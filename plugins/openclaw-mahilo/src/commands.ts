import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

import type { MahiloContractClient } from "./client";
import { redactSensitiveConfig, type MahiloPluginConfig } from "./config";
import type { DeclaredSelectors } from "./policy-helpers";
import type { InMemoryPluginState } from "./state";
import { createMahiloOverride } from "./tools";
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
    createReviewCommand(client, runtimeState, options),
    createOverrideCommand(client, runtimeState, options),
    createReconnectCommand(client, runtimeState, options)
  ];

  for (const command of commands) {
    registerCommandCompat(api, command);
  }

  options.logger?.info?.(
    "[Mahilo] Registered commands: mahilo status, mahilo review, mahilo override, mahilo reconnect"
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
              dedupeEntries: options.pluginState.dedupe.size()
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

function createOverrideCommand(
  client: MahiloContractClient,
  runtimeState: MahiloDiagnosticsRuntimeState,
  options: MahiloDiagnosticsCommandOptions
): MahiloCommand {
  return {
    description:
      "Create a one-time or temporary Mahilo override with user-friendly defaults.",
    execute: async (rawInput?: unknown) => {
      const checkedAt = toIsoTimestamp(options.now);

      try {
        const input = readInputObject(rawInput);
        const senderConnectionId = readRequiredSenderConnectionId(input);
        const reason = readOptionalString(input.reason);

        if (!reason) {
          throw new Error("reason is required");
        }

        const result = await createMahiloOverride(client, {
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
          expiresAt:
            readOptionalString(input.expiresAt) ??
            readOptionalString(input.expires_at),
          idempotencyKey:
            readOptionalString(input.idempotencyKey) ??
            readOptionalString(input.idempotency_key),
          kind: inferOverrideKind(input),
          maxUses:
            readPositiveInteger(input.maxUses) ??
            readPositiveInteger(input.max_uses),
          priority: readOptionalInteger(input.priority),
          recipient: readOptionalString(input.recipient),
          recipientType:
            readRecipientType(input.recipientType) ??
            readRecipientType(input.recipient_type),
          reason,
          scope: readOptionalString(input.scope) ?? "user",
          selectors: parseSelectors(
            input.selectors ?? input.declaredSelectors ?? input.declared_selectors
          ),
          senderConnectionId,
          sourceResolutionId:
            readOptionalString(input.sourceResolutionId) ??
            readOptionalString(input.source_resolution_id),
          targetId:
            readOptionalString(input.targetId) ??
            readOptionalString(input.target_id),
          ttlSeconds:
            readPositiveInteger(input.ttlSeconds) ??
            readPositiveInteger(input.ttl_seconds)
        });

        runtimeState.lastSuccessfulContactAt = checkedAt;
        runtimeState.lastContactError = undefined;

        return toCommandResult(result.summary, {
          checkedAt,
          command: "mahilo override",
          created: result.created ?? null,
          kind: result.kind ?? null,
          policyId: result.policyId ?? null,
          resolvedTargetId: result.resolvedTargetId ?? null
        });
      } catch (error) {
        const message = toErrorMessage(error);
        runtimeState.lastContactError = message;

        return toCommandResult("Mahilo override: failed to create override.", {
          checkedAt,
          command: "mahilo override",
          error: message,
          hints: [
            "Pass recipient for user-scoped overrides to resolve the Mahilo user ID automatically.",
            "Use durationMinutes, durationHours, ttlSeconds, or expiresAt for temporary overrides.",
            "Pass targetId explicitly for group-, role-, or pre-resolved user-scoped overrides."
          ]
        });
      }
    },
    label: "Mahilo Override",
    name: "mahilo override",
    parameters: {
      additionalProperties: false,
      properties: {
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
        idempotency_key: { type: "string" },
        kind: { type: "string" },
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
      required: ["reason", "senderConnectionId"],
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

function readOptionalInteger(value: unknown): number | undefined {
  if (!Number.isInteger(value)) {
    return undefined;
  }

  return Number(value);
}

function readPositiveInteger(value: unknown): number | undefined {
  const normalized = readOptionalInteger(value);
  if (typeof normalized !== "number" || normalized <= 0) {
    return undefined;
  }

  return normalized;
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

function readRequiredSenderConnectionId(input: Record<string, unknown>): string {
  const senderConnectionId =
    readOptionalString(input.senderConnectionId) ??
    readOptionalString(input.sender_connection_id);

  if (!senderConnectionId) {
    throw new Error(
      "senderConnectionId is required (pass senderConnectionId or sender_connection_id)"
    );
  }

  return senderConnectionId;
}

function readRecipientType(value: unknown): "group" | "user" | undefined {
  return value === "group" || value === "user" ? value : undefined;
}

function parseSelectors(value: unknown): Partial<DeclaredSelectors> | undefined {
  const selectors = readObject(value);
  if (!selectors) {
    return undefined;
  }

  const action = readOptionalString(selectors.action);
  const direction = readRecipientDirection(selectors.direction);
  const resource = readOptionalString(selectors.resource);

  if (!action && !direction && !resource) {
    return undefined;
  }

  return {
    action,
    direction,
    resource
  };
}

function readRecipientDirection(
  value: unknown
): DeclaredSelectors["direction"] | undefined {
  return value === "inbound" || value === "outbound" ? value : undefined;
}

function inferOverrideKind(input: Record<string, unknown>): string {
  const explicitKind = readOptionalString(input.kind);
  if (explicitKind) {
    return explicitKind;
  }

  if (
    readOptionalString(input.expiresAt) ||
    readOptionalString(input.expires_at) ||
    typeof readPositiveInteger(input.ttlSeconds) === "number" ||
    typeof readPositiveInteger(input.ttl_seconds) === "number" ||
    typeof readPositiveInteger(input.durationMinutes) === "number" ||
    typeof readPositiveInteger(input.duration_minutes) === "number" ||
    typeof readPositiveInteger(input.durationHours) === "number" ||
    typeof readPositiveInteger(input.duration_hours) === "number"
  ) {
    return "temporary";
  }

  return "one_time";
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

  const items = root.items;
  if (!Array.isArray(items)) {
    return undefined;
  }

  return items.length;
}

function normalizeReviewItems(response: unknown): Array<Record<string, unknown>> {
  const root = readObject(response);
  if (!root || !Array.isArray(root.items)) {
    return [];
  }

  const normalized: Array<Record<string, unknown>> = [];
  for (const rawItem of root.items) {
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
