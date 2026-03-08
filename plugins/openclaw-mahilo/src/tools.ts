import type { ReviewMode } from "./config";
import type { MahiloContractClient } from "./client";
import {
  applyLocalPolicyGuard,
  extractDecision,
  extractResolutionId,
  mergePolicyDecisions,
  normalizeDeclaredSelectors,
  shouldSendForDecision,
  toToolStatus,
  type DeclaredSelectors,
  type PolicyDecision
} from "./policy-helpers";

export interface MahiloToolContext {
  agentSessionId?: string;
  reviewMode?: ReviewMode;
  senderConnectionId: string;
}

export interface MahiloSendToolInput {
  context?: string;
  correlationId?: string;
  declaredSelectors?: Partial<DeclaredSelectors>;
  idempotencyKey?: string;
  message: string;
  payloadType?: string;
  recipient: string;
  recipientConnectionId?: string;
  routingHints?: Record<string, unknown>;
}

export interface TalkToGroupInput extends MahiloSendToolInput {
  groupId?: string;
}

export interface ToolExecutionOptions {
  reportOutcomes?: boolean;
  reviewMode?: ReviewMode;
  skipLocalPolicyGuard?: boolean;
}

export interface MahiloToolResult {
  decision: PolicyDecision;
  deduplicated?: boolean;
  messageId?: string;
  reason?: string;
  resolutionId?: string;
  response?: unknown;
  status: "denied" | "review_required" | "sent";
}

export interface MahiloContact {
  connectionId?: string;
  id: string;
  label: string;
  metadata?: Record<string, unknown>;
  type: "group" | "user";
}

export type ContactsProvider = () => Promise<MahiloContact[]>;

const DEFAULT_REVIEW_MODE: ReviewMode = "ask";

export async function talkToAgent(
  client: MahiloContractClient,
  input: MahiloSendToolInput,
  context: MahiloToolContext,
  options: ToolExecutionOptions = {}
): Promise<MahiloToolResult> {
  return executeSendTool(client, "user", input, context, options);
}

export async function talkToGroup(
  client: MahiloContractClient,
  input: TalkToGroupInput,
  context: MahiloToolContext,
  options: ToolExecutionOptions = {}
): Promise<MahiloToolResult> {
  return executeSendTool(client, "group", input, context, options);
}

export async function listMahiloContacts(provider?: ContactsProvider): Promise<MahiloContact[]> {
  if (!provider) {
    return [];
  }

  const contacts = await provider();
  return contacts.map((contact) => ({
    ...contact,
    label: contact.label.trim()
  }));
}

async function executeSendTool(
  client: MahiloContractClient,
  recipientType: "group" | "user",
  input: MahiloSendToolInput,
  context: MahiloToolContext,
  options: ToolExecutionOptions
): Promise<MahiloToolResult> {
  const reviewMode = options.reviewMode ?? context.reviewMode ?? DEFAULT_REVIEW_MODE;
  const normalizedSelectors = normalizeDeclaredSelectors(input.declaredSelectors, "outbound");

  const localDecision = options.skipLocalPolicyGuard
    ? "allow"
    : applyLocalPolicyGuard({ message: input.message, selectors: normalizedSelectors }).decision;

  const resolvePayload = compactObject({
    agent_session_id: context.agentSessionId,
    context: input.context,
    correlation_id: input.correlationId,
    declared_selectors: normalizedSelectors,
    idempotency_key: input.idempotencyKey,
    message: input.message,
    payload_type: input.payloadType ?? "text/plain",
    recipient: input.recipient,
    recipient_connection_id: input.recipientConnectionId,
    recipient_type: recipientType,
    routing_hints: input.routingHints,
    sender_connection_id: context.senderConnectionId
  });

  const resolveResponse = await client.resolveDraft(resolvePayload);
  const serverDecision = extractDecision(resolveResponse);
  const resolutionId = extractResolutionId(resolveResponse);
  const mergedDecision = mergePolicyDecisions(localDecision, serverDecision);

  if (!shouldSendForDecision(mergedDecision, reviewMode)) {
    return {
      decision: mergedDecision,
      reason: mergedDecision === "deny" ? "request denied by policy" : "policy review required",
      resolutionId,
      response: resolveResponse,
      status: toToolStatus(mergedDecision, reviewMode)
    };
  }

  const sendPayload = compactObject({
    ...resolvePayload,
    resolution_id: resolutionId
  });

  const sendResponse = await client.sendMessage(sendPayload, input.idempotencyKey);
  const messageId = extractMessageId(sendResponse);
  const deduplicated = extractDeduplicated(sendResponse);

  if (options.reportOutcomes ?? true) {
    const outcomePayload = compactObject({
      decision: mergedDecision,
      declared_selectors: normalizedSelectors,
      message_id: messageId,
      outcome: "sent",
      recipient: input.recipient,
      recipient_type: recipientType,
      resolution_id: resolutionId,
      sender_connection_id: context.senderConnectionId
    });

    await reportOutcomeSafely(client, outcomePayload, input.idempotencyKey);
  }

  return {
    decision: mergedDecision,
    deduplicated,
    messageId,
    resolutionId,
    response: sendResponse,
    status: "sent"
  };
}

async function reportOutcomeSafely(
  client: MahiloContractClient,
  payload: Record<string, unknown>,
  idempotencyKey?: string
): Promise<void> {
  try {
    await client.reportOutcome(payload, idempotencyKey);
  } catch {
    // Outcome reporting should not fail the tool execution path.
  }
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};

  for (const [key, candidate] of Object.entries(value)) {
    if (candidate === undefined) {
      continue;
    }

    compacted[key] = candidate;
  }

  return compacted;
}

function extractMessageId(value: unknown): string | undefined {
  const root = readObject(value);
  if (!root) {
    return undefined;
  }

  if (typeof root.message_id === "string" && root.message_id.length > 0) {
    return root.message_id;
  }

  if (typeof root.id === "string" && root.id.length > 0) {
    return root.id;
  }

  const result = readObject(root.result);
  if (result && typeof result.message_id === "string" && result.message_id.length > 0) {
    return result.message_id;
  }

  return undefined;
}

function extractDeduplicated(value: unknown): boolean | undefined {
  const root = readObject(value);
  if (!root) {
    return undefined;
  }

  if (typeof root.deduplicated === "boolean") {
    return root.deduplicated;
  }

  const result = readObject(root.result);
  if (result && typeof result.deduplicated === "boolean") {
    return result.deduplicated;
  }

  return undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
