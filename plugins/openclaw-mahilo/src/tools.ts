import type { ReviewMode } from "./config";
import type { MahiloContractClient } from "./client";
import {
  applyLocalPolicyGuard,
  extractDecision,
  extractResolutionId,
  normalizeDeclaredSelectors,
  type DeclaredSelectors,
  type LocalPolicyGuardResult,
  type PolicyDecision
} from "./policy-helpers";
import {
  fetchMahiloPromptContext,
  type FetchMahiloPromptContextInput,
  type FetchMahiloPromptContextOptions,
  type FetchMahiloPromptContextResult
} from "./prompt-context";

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
  localPolicyGuard?: LocalPolicyGuardResult;
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

export interface GetMahiloContextInput extends FetchMahiloPromptContextInput {}

export interface GetMahiloContextOptions extends FetchMahiloPromptContextOptions {}

export type MahiloContextToolResult = FetchMahiloPromptContextResult;

export interface PreviewMahiloSendInput extends MahiloSendToolInput {
  recipientType?: "group" | "user";
}

export interface MahiloPreviewRecipientResult {
  decision?: PolicyDecision;
  deliveryMode?: string;
  recipient: string;
}

export interface MahiloPreviewResolvedRecipient {
  recipient: string;
  recipientConnectionId?: string;
  recipientType: "group" | "user";
}

export interface MahiloPreviewReview {
  required?: boolean;
  reviewId?: string;
}

export interface MahiloPreviewResult {
  agentGuidance?: string;
  decision: PolicyDecision;
  deliveryMode?: string;
  expiresAt?: string;
  reasonCode?: string;
  resolutionId?: string;
  resolutionSummary?: string;
  resolvedRecipient?: MahiloPreviewResolvedRecipient;
  response: unknown;
  review?: MahiloPreviewReview;
  serverSelectors: DeclaredSelectors;
  recipientResults: MahiloPreviewRecipientResult[];
}

export interface CreateMahiloOverrideInput {
  derivedFromMessageId?: string;
  effect: string;
  expiresAt?: string;
  idempotencyKey?: string;
  kind: string;
  maxUses?: number;
  priority?: number;
  reason: string;
  scope: string;
  selectors?: Partial<DeclaredSelectors>;
  senderConnectionId: string;
  sourceResolutionId?: string;
  targetId?: string;
  ttlSeconds?: number;
}

export interface MahiloOverrideResult {
  created?: boolean;
  kind?: string;
  policyId?: string;
  response: unknown;
}

type ReportedOutcome =
  | "blocked"
  | "partial_sent"
  | "review_approved"
  | "review_rejected"
  | "review_requested"
  | "send_failed"
  | "sent"
  | "withheld";

interface RecipientOutcome {
  outcome: ReportedOutcome;
  recipient: string;
}

interface SendOutcomeSummary {
  outcome: ReportedOutcome;
  recipientResults?: RecipientOutcome[];
  reason?: string;
  status: MahiloToolResult["status"];
}

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

export async function getMahiloContext(
  client: MahiloContractClient,
  input: GetMahiloContextInput,
  options: GetMahiloContextOptions = {}
): Promise<MahiloContextToolResult> {
  return fetchMahiloPromptContext(client, input, options);
}

export async function previewMahiloSend(
  client: MahiloContractClient,
  input: PreviewMahiloSendInput,
  context: MahiloToolContext
): Promise<MahiloPreviewResult> {
  const recipientType = input.recipientType ?? "user";
  const normalizedSelectors = normalizeDeclaredSelectors(input.declaredSelectors, "outbound");
  const response = await client.resolveDraft(
    buildResolvePayload(recipientType, input, context, normalizedSelectors)
  );

  return summarizePreviewResponse(response, normalizedSelectors, input.recipient, recipientType);
}

export async function createMahiloOverride(
  client: MahiloContractClient,
  input: CreateMahiloOverrideInput
): Promise<MahiloOverrideResult> {
  const selectors = input.selectors
    ? normalizeDeclaredSelectors(input.selectors, "outbound")
    : undefined;
  const payload = compactObject({
    derived_from_message_id: input.derivedFromMessageId,
    effect: input.effect,
    expires_at: input.expiresAt,
    kind: input.kind,
    max_uses: input.maxUses,
    priority: input.priority,
    reason: input.reason,
    scope: input.scope,
    selectors,
    sender_connection_id: input.senderConnectionId,
    source_resolution_id: input.sourceResolutionId,
    target_id: input.targetId,
    ttl_seconds: input.ttlSeconds
  });
  const response = await client.createOverride(payload, input.idempotencyKey);
  const root = readObject(response);

  return {
    created: readBoolean(root?.created),
    kind: readString(root?.kind),
    policyId: readString(root?.policy_id) ?? readString(root?.policyId),
    response
  };
}

async function executeSendTool(
  client: MahiloContractClient,
  recipientType: "group" | "user",
  input: MahiloSendToolInput,
  context: MahiloToolContext,
  options: ToolExecutionOptions
): Promise<MahiloToolResult> {
  const normalizedSelectors = normalizeDeclaredSelectors(input.declaredSelectors, "outbound");

  const localPolicyGuard = options.skipLocalPolicyGuard
    ? undefined
    : applyLocalPolicyGuard({ message: input.message, selectors: normalizedSelectors });

  const resolvePayload = buildResolvePayload(recipientType, input, context, normalizedSelectors);

  const resolveResponse = await client.resolveDraft(resolvePayload);
  const preflightDecision = extractDecision(resolveResponse);
  const preflightResolutionId = extractResolutionId(resolveResponse);

  const sendPayload = compactObject({
    ...resolvePayload,
    resolution_id: preflightResolutionId
  });

  const sendResponse = await client.sendMessage(sendPayload, input.idempotencyKey);
  const sendDecision = extractDecision(sendResponse, preflightDecision);
  const resolutionId = extractResolutionId(sendResponse) ?? preflightResolutionId;
  const messageId = extractMessageId(sendResponse);
  const deduplicated = extractDeduplicated(sendResponse);
  const sendOutcomeSummary = summarizeSendOutcome(sendResponse, sendDecision, input.recipient);

  if ((options.reportOutcomes ?? true) && messageId) {
    const outcomePayload = compactObject({
      message_id: messageId,
      outcome: sendOutcomeSummary.outcome,
      recipient_results: sendOutcomeSummary.recipientResults,
      resolution_id: resolutionId,
      sender_connection_id: context.senderConnectionId
    });

    await reportOutcomeSafely(client, outcomePayload, input.idempotencyKey);
  }

  return {
    decision: sendDecision,
    deduplicated,
    localPolicyGuard,
    messageId,
    reason: sendOutcomeSummary.reason,
    resolutionId,
    response: sendResponse,
    status: sendOutcomeSummary.status
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

function buildResolvePayload(
  recipientType: "group" | "user",
  input: MahiloSendToolInput,
  context: MahiloToolContext,
  normalizedSelectors: DeclaredSelectors
): Record<string, unknown> {
  return compactObject({
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

function summarizePreviewResponse(
  response: unknown,
  fallbackSelectors: DeclaredSelectors,
  fallbackRecipient: string,
  fallbackRecipientType: "group" | "user"
): MahiloPreviewResult {
  const root = readObject(response);
  const result = root ? readObject(root.result) : undefined;
  const resolution = readObject(root?.resolution) ?? readObject(result?.resolution);
  const decision = extractDecision(response);
  const deliveryMode =
    readString(root?.delivery_mode) ??
    readString(result?.delivery_mode) ??
    readString(resolution?.delivery_mode);
  const reasonCode =
    readString(root?.reason_code) ??
    readString(result?.reason_code) ??
    readString(resolution?.reason_code);
  const resolutionSummary =
    readString(root?.resolution_summary) ??
    readString(result?.resolution_summary) ??
    readResolutionSummary(root) ??
    readResolutionSummary(result);
  const resolvedRecipient =
    readPreviewResolvedRecipient(root?.resolved_recipient, fallbackRecipient, fallbackRecipientType) ??
    readPreviewResolvedRecipient(result?.resolved_recipient, fallbackRecipient, fallbackRecipientType);
  const review = readPreviewReview(root?.review) ?? readPreviewReview(result?.review);
  const recipientResults = readPreviewRecipientResults(
    root?.recipient_results ?? result?.recipient_results,
    fallbackRecipient,
    decision,
    deliveryMode
  );

  return {
    agentGuidance: readString(root?.agent_guidance) ?? readString(result?.agent_guidance),
    decision,
    deliveryMode,
    expiresAt: readString(root?.expires_at) ?? readString(result?.expires_at),
    reasonCode,
    resolutionId: extractResolutionId(response),
    resolutionSummary,
    resolvedRecipient,
    response,
    review,
    serverSelectors: readPreviewSelectors(
      root?.server_selectors ?? result?.server_selectors,
      fallbackSelectors
    ),
    recipientResults
  };
}

function summarizeSendOutcome(
  response: unknown,
  fallbackDecision: PolicyDecision,
  fallbackRecipient: string
): SendOutcomeSummary {
  const root = readObject(response);
  const result = root ? readObject(root.result) : undefined;
  const inferredOutcome = inferOutcomeFromResponse(root, result, fallbackDecision);
  const recipientResults = readRecipientOutcomes(root, result, inferredOutcome, fallbackRecipient);
  const outcome = deriveAggregateOutcome(recipientResults, inferredOutcome);
  const reason = deriveOutcomeReason(outcome, root, result);

  return {
    outcome,
    reason,
    recipientResults,
    status: outcomeToToolStatus(outcome)
  };
}

function inferOutcomeFromResponse(
  root: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
  fallbackDecision: PolicyDecision
): ReportedOutcome {
  const status = readString(root?.status) ?? readString(result?.status);
  if (status === "review_required" || status === "approval_pending") {
    return "review_requested";
  }
  if (status === "rejected" || status === "blocked") {
    return "blocked";
  }
  if (status === "failed") {
    return "send_failed";
  }
  if (status === "partial_sent") {
    return "partial_sent";
  }

  const deliveryStatus = readString(root?.delivery_status) ?? readString(result?.delivery_status);
  if (deliveryStatus === "review_required" || deliveryStatus === "approval_pending") {
    return "review_requested";
  }
  if (deliveryStatus === "rejected") {
    return "blocked";
  }
  if (deliveryStatus === "failed") {
    return "send_failed";
  }

  const resolution = readObject(root?.resolution) ?? readObject(result?.resolution);
  const deliveryMode = readString(resolution?.delivery_mode);
  if (deliveryMode === "review_required" || deliveryMode === "hold_for_approval") {
    return "review_requested";
  }
  if (deliveryMode === "blocked") {
    return "blocked";
  }

  if (fallbackDecision === "ask") {
    return "review_requested";
  }
  if (fallbackDecision === "deny") {
    return "blocked";
  }

  return "sent";
}

function readRecipientOutcomes(
  root: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
  fallbackOutcome: ReportedOutcome,
  fallbackRecipient: string
): RecipientOutcome[] | undefined {
  const rawResults = Array.isArray(root?.recipient_results)
    ? root.recipient_results
    : Array.isArray(result?.recipient_results)
      ? result.recipient_results
      : [];

  const normalizedResults: RecipientOutcome[] = [];
  for (const rawResult of rawResults) {
    const recipientResult = readObject(rawResult);
    if (!recipientResult) {
      continue;
    }

    const recipient = readString(recipientResult.recipient);
    if (!recipient) {
      continue;
    }

    normalizedResults.push({
      outcome: inferRecipientOutcome(recipientResult, fallbackOutcome),
      recipient
    });
  }

  if (normalizedResults.length > 0) {
    return normalizedResults;
  }

  if (fallbackRecipient.length > 0) {
    return [
      {
        outcome: fallbackOutcome,
        recipient: fallbackRecipient
      }
    ];
  }

  return undefined;
}

function inferRecipientOutcome(
  recipientResult: Record<string, unknown>,
  fallbackOutcome: ReportedOutcome
): ReportedOutcome {
  const deliveryStatus = readString(recipientResult.delivery_status);
  if (deliveryStatus === "delivered") {
    return "sent";
  }
  if (deliveryStatus === "review_required" || deliveryStatus === "approval_pending") {
    return "review_requested";
  }
  if (deliveryStatus === "rejected") {
    return "blocked";
  }
  if (deliveryStatus === "failed") {
    return "send_failed";
  }

  const deliveryMode = readString(recipientResult.delivery_mode);
  if (deliveryMode === "review_required" || deliveryMode === "hold_for_approval") {
    return "review_requested";
  }
  if (deliveryMode === "blocked") {
    return "blocked";
  }

  const decision = extractDecision(recipientResult);
  if (decision === "ask") {
    return "review_requested";
  }
  if (decision === "deny") {
    return "blocked";
  }

  return fallbackOutcome;
}

function deriveAggregateOutcome(
  recipientResults: RecipientOutcome[] | undefined,
  fallbackOutcome: ReportedOutcome
): ReportedOutcome {
  if (!recipientResults || recipientResults.length === 0) {
    return fallbackOutcome;
  }

  const outcomes = new Set(recipientResults.map((result) => result.outcome));
  if (outcomes.size === 1) {
    return recipientResults[0].outcome;
  }

  if (outcomes.has("sent")) {
    return "partial_sent";
  }

  return fallbackOutcome;
}

function deriveOutcomeReason(
  outcome: ReportedOutcome,
  root: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined
): string | undefined {
  const summary =
    readResolutionSummary(root) ??
    readResolutionSummary(result) ??
    readString(root?.rejection_reason) ??
    readString(result?.rejection_reason);

  if (outcome === "review_requested") {
    return summary ?? "policy review required";
  }
  if (outcome === "blocked") {
    return summary ?? "request denied by policy";
  }
  if (outcome === "send_failed") {
    return summary ?? "message delivery failed";
  }

  return undefined;
}

function outcomeToToolStatus(outcome: ReportedOutcome): MahiloToolResult["status"] {
  if (outcome === "review_requested") {
    return "review_required";
  }

  if (
    outcome === "blocked" ||
    outcome === "review_rejected" ||
    outcome === "send_failed" ||
    outcome === "withheld"
  ) {
    return "denied";
  }

  return "sent";
}

function readResolutionSummary(value: Record<string, unknown> | undefined): string | undefined {
  const resolution = readObject(value?.resolution);
  if (!resolution) {
    return undefined;
  }

  return (
    readString(resolution.summary) ??
    readString(resolution.reason) ??
    readString(resolution.resolution_summary)
  );
}

function readPreviewResolvedRecipient(
  value: unknown,
  fallbackRecipient: string,
  fallbackRecipientType: "group" | "user"
): MahiloPreviewResolvedRecipient | undefined {
  const recipient = readObject(value);
  const resolvedRecipient =
    readString(recipient?.recipient) ??
    readString(recipient?.id) ??
    fallbackRecipient;

  if (!resolvedRecipient) {
    return undefined;
  }

  return {
    recipient: resolvedRecipient,
    recipientConnectionId:
      readString(recipient?.recipient_connection_id) ??
      readString(recipient?.recipientConnectionId),
    recipientType:
      readRecipientType(recipient?.recipient_type) ??
      readRecipientType(recipient?.recipientType) ??
      fallbackRecipientType
  };
}

function readPreviewReview(value: unknown): MahiloPreviewReview | undefined {
  const review = readObject(value);
  if (!review) {
    return undefined;
  }

  const normalized: MahiloPreviewReview = {};
  const required = readBoolean(review.required);
  const reviewId = readString(review.review_id) ?? readString(review.reviewId);

  if (typeof required === "boolean") {
    normalized.required = required;
  }

  if (reviewId) {
    normalized.reviewId = reviewId;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function readPreviewSelectors(
  value: unknown,
  fallbackSelectors: DeclaredSelectors
): DeclaredSelectors {
  const selectors = readObject(value);
  if (!selectors) {
    return fallbackSelectors;
  }

  return normalizeDeclaredSelectors(
    {
      action: readString(selectors.action),
      direction: readSelectorDirection(selectors.direction),
      resource: readString(selectors.resource)
    },
    fallbackSelectors.direction
  );
}

function readPreviewRecipientResults(
  value: unknown,
  fallbackRecipient: string,
  fallbackDecision: PolicyDecision,
  fallbackDeliveryMode?: string
): MahiloPreviewRecipientResult[] {
  const recipientResults: MahiloPreviewRecipientResult[] = [];
  const rawResults = Array.isArray(value) ? value : [];

  for (const rawResult of rawResults) {
    const recipientResult = readObject(rawResult);
    if (!recipientResult) {
      continue;
    }

    const recipient = readString(recipientResult.recipient);
    if (!recipient) {
      continue;
    }

    recipientResults.push({
      decision: extractDecision(recipientResult, fallbackDecision),
      deliveryMode: readString(recipientResult.delivery_mode),
      recipient
    });
  }

  if (recipientResults.length > 0) {
    return recipientResults;
  }

  if (!fallbackRecipient) {
    return [];
  }

  return [
    {
      decision: fallbackDecision,
      deliveryMode: fallbackDeliveryMode,
      recipient: fallbackRecipient
    }
  ];
}

function readRecipientType(value: unknown): "group" | "user" | undefined {
  return value === "group" || value === "user" ? value : undefined;
}

function readSelectorDirection(value: unknown): DeclaredSelectors["direction"] | undefined {
  return value === "inbound" || value === "outbound" ? value : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
