import { normalizeSelectorDirection } from "@mahilo/policy-core";
import type { MahiloContractClient } from "./client";
import {
  normalizeDeclaredSelectors,
  type DeclaredSelectors,
  type PolicyDecision
} from "./policy-helpers";

const DEFAULT_CONTEXT_INTERACTION_LIMIT = 3;
const DEFAULT_PROMPT_RECENT_INTERACTIONS = 2;
const MAX_CONTEXT_INTERACTION_LIMIT = 5;
const MAX_PROMPT_RECENT_INTERACTIONS = 3;
const MAX_REASON_CODE_LENGTH = 72;
const MAX_RECIPIENT_LABEL_LENGTH = 80;
const MAX_RECENT_SUMMARY_LENGTH = 96;
const MAX_ROLE_COUNT = 3;
const MAX_SUMMARY_LENGTH = 180;

export interface PromptContextCache {
  getCachedContext(cacheKey: string, nowMs?: number): unknown | undefined;
  setCachedContext(cacheKey: string, value: unknown, nowMs?: number): void;
}

export interface FetchMahiloPromptContextInput {
  declaredSelectors?: Partial<DeclaredSelectors>;
  includeRecentInteractions?: boolean;
  interactionLimit?: number;
  recipient: string;
  recipientType?: "group" | "user";
  senderConnectionId: string;
}

export interface FetchMahiloPromptContextOptions {
  cache?: PromptContextCache;
  maxRecentInteractions?: number;
  nowMs?: number;
}

export interface CompactPromptRecipient {
  id?: string;
  label: string;
  relationship?: string;
  roles: string[];
}

export interface CompactPromptGuidance {
  decision: PolicyDecision;
  reasonCode?: string;
  summary?: string;
}

export interface CompactPromptInteraction {
  decision?: PolicyDecision;
  direction?: string;
  summary?: string;
  timestamp?: string;
}

export interface CompactMahiloPromptContext {
  guidance: CompactPromptGuidance;
  recipient: CompactPromptRecipient;
  recentInteractions: CompactPromptInteraction[];
  selectors: DeclaredSelectors;
}

export interface FetchMahiloPromptContextResult {
  cacheKey: string;
  context?: CompactMahiloPromptContext;
  error?: string;
  injection: string;
  ok: boolean;
  source: "cache" | "fallback" | "live";
}

export interface FormatPromptInjectionOptions {
  maxRecentInteractions?: number;
}

export async function fetchMahiloPromptContext(
  client: MahiloContractClient,
  input: FetchMahiloPromptContextInput,
  options: FetchMahiloPromptContextOptions = {}
): Promise<FetchMahiloPromptContextResult> {
  const normalizedSelectors = normalizeDeclaredSelectors(input.declaredSelectors, "outbound");
  const includeRecentInteractions = input.includeRecentInteractions ?? true;
  const interactionLimit = clampContextInteractionLimit(input.interactionLimit);
  const recipientType = input.recipientType ?? "user";
  const cacheKey = buildPromptContextCacheKey({
    includeRecentInteractions,
    interactionLimit,
    recipient: input.recipient,
    recipientType,
    senderConnectionId: input.senderConnectionId,
    selectors: normalizedSelectors
  });
  const nowMs = options.nowMs ?? Date.now();

  const cached = options.cache?.getCachedContext(cacheKey, nowMs);
  if (isCompactPromptContext(cached)) {
    return {
      cacheKey,
      context: cached,
      injection: formatMahiloPromptInjection(cached, {
        maxRecentInteractions: options.maxRecentInteractions
      }),
      ok: true,
      source: "cache"
    };
  }

  try {
    const response = await client.getPromptContext({
      draft_selectors: normalizedSelectors,
      include_recent_interactions: includeRecentInteractions,
      interaction_limit: interactionLimit,
      recipient: input.recipient,
      recipient_type: recipientType,
      sender_connection_id: input.senderConnectionId
    });

    const compactContext = compactPromptContext(response, {
      fallbackRecipient: input.recipient,
      fallbackSelectors: normalizedSelectors
    });

    options.cache?.setCachedContext(cacheKey, compactContext, nowMs);

    return {
      cacheKey,
      context: compactContext,
      injection: formatMahiloPromptInjection(compactContext, {
        maxRecentInteractions: options.maxRecentInteractions
      }),
      ok: true,
      source: "live"
    };
  } catch (error) {
    return {
      cacheKey,
      error: toErrorMessage(error),
      injection: "",
      ok: false,
      source: "fallback"
    };
  }
}

export function formatMahiloPromptInjection(
  context: CompactMahiloPromptContext,
  options: FormatPromptInjectionOptions = {}
): string {
  const lines = [
    "[MahiloContext/v1]",
    `recipient=${formatRecipient(context.recipient)}`,
    `guidance=${formatGuidance(context.guidance)}`,
    `summary=${compactText(context.guidance.summary ?? "none", MAX_SUMMARY_LENGTH)}`,
    `selectors=${context.selectors.direction}/${context.selectors.resource}/${context.selectors.action}`
  ];

  const maxRecentInteractions = clampPromptRecentInteractions(options.maxRecentInteractions);
  const interactions = context.recentInteractions.slice(0, maxRecentInteractions);
  for (let index = 0; index < interactions.length; index += 1) {
    lines.push(`recent_${index + 1}=${formatRecentInteraction(interactions[index]!)}`);
  }

  return lines.join("\n");
}

function compactPromptContext(
  value: unknown,
  options: { fallbackRecipient: string; fallbackSelectors: DeclaredSelectors }
): CompactMahiloPromptContext {
  const root = readObject(value) ?? {};

  return {
    guidance: compactPromptGuidance(root.policy_guidance),
    recipient: compactPromptRecipient(root.recipient, options.fallbackRecipient),
    recentInteractions: compactRecentInteractions(root.recent_interactions),
    selectors: compactSelectors(root.suggested_selectors, options.fallbackSelectors)
  };
}

function compactPromptGuidance(value: unknown): CompactPromptGuidance {
  const guidance = readObject(value);
  const decision = parsePolicyDecision(guidance?.default_decision, "ask");
  const reasonCode = compactOptionalText(
    readOptionalString(guidance?.reason_code) ??
      readOptionalString(guidance?.reasonCode),
    MAX_REASON_CODE_LENGTH
  );
  const summary = compactOptionalText(readOptionalString(guidance?.summary), MAX_SUMMARY_LENGTH);

  return {
    decision,
    reasonCode,
    summary
  };
}

function compactPromptRecipient(value: unknown, fallbackRecipient: string): CompactPromptRecipient {
  const recipient = readObject(value);
  const label = compactText(
    readOptionalString(recipient?.display_name) ??
      readOptionalString(recipient?.displayName) ??
      readOptionalString(recipient?.username) ??
      readOptionalString(recipient?.id) ??
      fallbackRecipient,
    MAX_RECIPIENT_LABEL_LENGTH
  );
  const relationship = compactOptionalText(readOptionalString(recipient?.relationship), 32);
  const roles = compactRoles(recipient?.roles);
  const id = readOptionalString(recipient?.id);

  return {
    id,
    label,
    relationship,
    roles
  };
}

function compactRoles(value: unknown): string[] {
  const roles = readStringArray(value);
  if (roles.length === 0) {
    return [];
  }

  return roles.slice(0, MAX_ROLE_COUNT).map((role) => compactText(role, 24));
}

function compactSelectors(value: unknown, fallbackSelectors: DeclaredSelectors): DeclaredSelectors {
  const selectors = readObject(value);
  if (!selectors) {
    return fallbackSelectors;
  }

  return normalizeDeclaredSelectors(
    {
      action: readOptionalString(selectors.action),
      direction: parseSelectorDirection(selectors.direction),
      resource: readOptionalString(selectors.resource)
    },
    fallbackSelectors.direction
  );
}

function compactRecentInteractions(value: unknown): CompactPromptInteraction[] {
  const interactions: CompactPromptInteraction[] = [];
  const source = readArray(value);

  for (const entry of source) {
    const objectEntry = readObject(entry);
    if (!objectEntry) {
      continue;
    }

    const compactInteraction: CompactPromptInteraction = {};
    const timestamp = compactOptionalText(readOptionalString(objectEntry.timestamp), 40);
    const direction = compactOptionalText(readOptionalString(objectEntry.direction), 24);
    const decision = parsePolicyDecision(objectEntry.decision);
    const summary = compactOptionalText(readOptionalString(objectEntry.summary), MAX_RECENT_SUMMARY_LENGTH);

    if (timestamp) {
      compactInteraction.timestamp = timestamp;
    }

    if (direction) {
      compactInteraction.direction = direction;
    }

    if (decision) {
      compactInteraction.decision = decision;
    }

    if (summary) {
      compactInteraction.summary = summary;
    }

    if (Object.keys(compactInteraction).length > 0) {
      interactions.push(compactInteraction);
    }
  }

  return interactions;
}

function formatGuidance(guidance: CompactPromptGuidance): string {
  if (!guidance.reasonCode) {
    return guidance.decision;
  }

  return `${guidance.decision}:${compactText(guidance.reasonCode, MAX_REASON_CODE_LENGTH)}`;
}

function formatRecipient(recipient: CompactPromptRecipient): string {
  const fields = [`name=${compactText(recipient.label, MAX_RECIPIENT_LABEL_LENGTH)}`];

  if (recipient.relationship) {
    fields.push(`relationship=${compactText(recipient.relationship, 32)}`);
  }

  if (recipient.roles.length > 0) {
    fields.push(`roles=${recipient.roles.map((role) => compactText(role, 24)).join(",")}`);
  }

  return fields.join("; ");
}

function formatRecentInteraction(interaction: CompactPromptInteraction): string {
  const parts: string[] = [];

  if (interaction.timestamp) {
    parts.push(compactText(interaction.timestamp, 40));
  }

  if (interaction.direction) {
    parts.push(compactText(interaction.direction, 24));
  }

  if (interaction.decision) {
    parts.push(interaction.decision);
  }

  if (interaction.summary) {
    parts.push(compactText(interaction.summary, MAX_RECENT_SUMMARY_LENGTH));
  }

  return parts.length > 0 ? parts.join(" ") : "none";
}

function buildPromptContextCacheKey(input: {
  includeRecentInteractions: boolean;
  interactionLimit: number;
  recipient: string;
  recipientType: "group" | "user";
  senderConnectionId: string;
  selectors: DeclaredSelectors;
}): string {
  return [
    "mahilo_prompt_context",
    normalizeCacheToken(input.senderConnectionId),
    normalizeCacheToken(input.recipientType),
    normalizeCacheToken(input.recipient),
    input.includeRecentInteractions ? "recent1" : "recent0",
    `limit${input.interactionLimit}`,
    input.selectors.direction,
    input.selectors.resource,
    input.selectors.action
  ].join("|");
}

function normalizeCacheToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, "_").replace(/\|+/gu, "_");
}

function clampContextInteractionLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CONTEXT_INTERACTION_LIMIT;
  }

  const rounded = Math.trunc(value as number);
  return Math.max(0, Math.min(MAX_CONTEXT_INTERACTION_LIMIT, rounded));
}

function clampPromptRecentInteractions(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PROMPT_RECENT_INTERACTIONS;
  }

  const rounded = Math.trunc(value as number);
  return Math.max(0, Math.min(MAX_PROMPT_RECENT_INTERACTIONS, rounded));
}

function compactOptionalText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) {
    return undefined;
  }

  return compactText(value, maxLength);
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function parseSelectorDirection(value: unknown): DeclaredSelectors["direction"] | undefined {
  return normalizeSelectorDirection(typeof value === "string" ? value : undefined);
}

function parsePolicyDecision(value: unknown): PolicyDecision | undefined;
function parsePolicyDecision(value: unknown, fallback: PolicyDecision): PolicyDecision;
function parsePolicyDecision(value: unknown, fallback?: PolicyDecision): PolicyDecision | undefined {
  if (value === "allow" || value === "ask" || value === "deny") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "allow" || normalized === "ask" || normalized === "deny") {
      return normalized;
    }
  }

  return fallback;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const values: string[] = [];
  for (const entry of value) {
    const normalized = readOptionalString(entry);
    if (normalized) {
      values.push(normalized);
    }
  }

  return values;
}

function isCompactPromptContext(value: unknown): value is CompactMahiloPromptContext {
  const root = readObject(value);
  if (!root || !Array.isArray(root.recentInteractions)) {
    return false;
  }

  const recipient = readObject(root.recipient);
  const guidance = readObject(root.guidance);
  const selectors = readObject(root.selectors);

  return (
    typeof recipient?.label === "string" &&
    typeof guidance?.decision === "string" &&
    typeof selectors?.direction === "string" &&
    typeof selectors?.resource === "string" &&
    typeof selectors?.action === "string"
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "Mahilo prompt context fetch failed";
}
