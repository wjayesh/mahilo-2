import {
  createLLMPolicyEvaluator,
  isInboundSelectorDirection,
  type AuthenticatedSenderIdentity,
  type CorePolicy,
  type EvaluatedPolicy,
  type LLMEvaluationFallbackMode,
  type LLMPolicyEvaluationError,
  type LLMPolicyEvaluationInput,
  type LLMPolicyEvaluationResult,
  type LLMPolicyEvaluator,
  type LLMProviderAdapter,
  type PolicyResolverLayer,
} from "@mahilo/policy-core";
import type { MahiloContractClient } from "./client";
import {
  normalizeDeclaredSelectors,
  resolveLocalPolicySet,
  type DeclaredSelectors,
  type PolicyDecision,
} from "./policy-helpers";

export type LocalPolicyBundleType = "direct_send" | "group_fanout";
export type LocalDecisionDeliveryMode =
  | "blocked"
  | "full_send"
  | "hold_for_approval"
  | "review_required";
export type LocalTransportAction = "block" | "hold" | "send";
export type LocalPolicyRecipientType = "group" | "user";

export interface LocalPolicyBundleMetadata {
  bundle_id: string;
  resolution_id: string;
  issued_at: string;
  expires_at: string;
}

export interface LocalPolicyLLMProviderDefaults {
  model: string;
  provider: string;
}

export interface LocalPolicyLLMContext {
  provider_defaults: LocalPolicyLLMProviderDefaults | null;
  subject: string;
}

export interface LocalPolicyUserRecipient {
  id: string;
  type: "user";
  username: string;
}

export interface DirectSendPolicyBundle {
  contract_version: string;
  bundle_type: "direct_send";
  bundle_metadata: LocalPolicyBundleMetadata;
  authenticated_identity: AuthenticatedSenderIdentity;
  selector_context: DeclaredSelectors;
  recipient: LocalPolicyUserRecipient;
  applicable_policies: CorePolicy[];
  llm: LocalPolicyLLMContext;
}

export interface GroupFanoutPolicyBundleMember {
  recipient: LocalPolicyUserRecipient;
  roles: string[];
  resolution_id: string;
  member_applicable_policies: CorePolicy[];
  llm: LocalPolicyLLMContext;
}

export interface GroupFanoutPolicyBundleAggregateMetadata {
  fanout_mode: "per_recipient";
  mixed_decision_priority: PolicyDecision[];
  partial_reason_code: string;
  empty_group_summary: string;
  partial_summary_template: string;
  policy_evaluation_mode: "group_outbound_fanout";
}

export interface GroupFanoutPolicyBundle {
  contract_version: string;
  bundle_type: "group_fanout";
  bundle_metadata: LocalPolicyBundleMetadata;
  authenticated_identity: AuthenticatedSenderIdentity;
  selector_context: DeclaredSelectors;
  group: {
    id: string;
    member_count: number;
    name: string;
    type: "group";
  };
  aggregate_metadata: GroupFanoutPolicyBundleAggregateMetadata;
  group_overlay_policies: CorePolicy[];
  members: GroupFanoutPolicyBundleMember[];
}

export interface LocalPolicyRuntimeInput {
  context?: string;
  correlationId?: string;
  declaredSelectors?: Partial<DeclaredSelectors>;
  idempotencyKey?: string;
  inResponseTo?: string;
  message: string;
  payloadType?: string;
  recipient: string;
  senderConnectionId?: string;
}

export interface EvaluateLocalPolicyInput extends LocalPolicyRuntimeInput {
  recipientType?: LocalPolicyRecipientType;
}

export interface LocalPolicyLLMEvaluatorContext {
  bundleType: LocalPolicyBundleType;
  llm: LocalPolicyLLMContext;
  recipient: LocalPolicyUserRecipient;
  selectorContext: DeclaredSelectors;
}

export type LocalPolicyLLMEvaluatorFactory = (
  context: LocalPolicyLLMEvaluatorContext,
) =>
  | LLMPolicyEvaluator
  | Promise<LLMPolicyEvaluator | undefined>
  | undefined;

export interface LocalPolicyEvaluationOptions {
  llmErrorMode?: LLMEvaluationFallbackMode;
  llmEvaluator?: LLMPolicyEvaluator;
  llmEvaluatorFactory?: LocalPolicyLLMEvaluatorFactory;
  llmProviderAdapter?: LLMProviderAdapter;
  normalizeLLMError?: (error: unknown) => LLMPolicyEvaluationError;
  onLLMError?: (
    error: LLMPolicyEvaluationError,
    input: LLMPolicyEvaluationInput,
  ) => LLMPolicyEvaluationResult | Promise<LLMPolicyEvaluationResult>;
  llmUnavailableMode?: LLMEvaluationFallbackMode;
}

export interface LocalPolicyDecisionDetails {
  decision: PolicyDecision;
  delivery_mode: LocalDecisionDeliveryMode;
  summary: string;
  reason?: string;
  reason_code: string;
  resolution_explanation: string;
  resolver_layer?: PolicyResolverLayer;
  guardrail_id?: string;
  winning_policy_id?: string;
  matched_policy_ids: string[];
  evaluated_policies: EvaluatedPolicy[];
}

export interface LocalPolicyRecipientResult {
  recipient: string;
  recipient_id: string;
  recipient_type: "user";
  resolution_id: string;
  roles: string[];
  llm: LocalPolicyLLMContext;
  local_decision: LocalPolicyDecisionDetails;
  should_send: boolean;
  transport_action: LocalTransportAction;
}

export interface LocalPolicyTransportPayload {
  context?: string;
  correlation_id?: string;
  declared_selectors: DeclaredSelectors;
  idempotency_key?: string;
  in_response_to?: string;
  message: string;
  payload_type: string;
  recipient: string;
  recipient_type: LocalPolicyRecipientType;
  resolution_id: string;
  sender_connection_id: string;
}

export interface LocalPolicyCommitPayload {
  context?: string;
  correlation_id?: string;
  declared_selectors: DeclaredSelectors;
  idempotency_key?: string;
  in_response_to?: string;
  local_decision: LocalPolicyDecisionDetails;
  message: string;
  payload_type: string;
  recipient: string;
  recipient_type: "user";
  resolution_id: string;
  sender_connection_id: string;
}

export interface LocalGroupAggregateCounts {
  delivered: number;
  pending: number;
  denied: number;
  review_required: number;
  failed: number;
}

export interface LocalGroupAggregateResult {
  counts: LocalGroupAggregateCounts;
  decision: PolicyDecision;
  has_sendable_recipients: boolean;
  partial_delivery: boolean;
  reason_code: string;
  summary: string;
}

export interface LocalDirectPolicyRuntimeResult {
  contract_version: string;
  bundle_type: "direct_send";
  bundle_metadata: LocalPolicyBundleMetadata;
  authenticated_identity: AuthenticatedSenderIdentity;
  selector_context: DeclaredSelectors;
  recipient: LocalPolicyUserRecipient;
  llm: LocalPolicyLLMContext;
  local_decision: LocalPolicyDecisionDetails;
  recipient_results: LocalPolicyRecipientResult[];
  transport_payload: LocalPolicyTransportPayload;
  commit_payload: LocalPolicyCommitPayload;
}

export interface LocalGroupPolicyRuntimeResult {
  contract_version: string;
  bundle_type: "group_fanout";
  bundle_metadata: LocalPolicyBundleMetadata;
  authenticated_identity: AuthenticatedSenderIdentity;
  selector_context: DeclaredSelectors;
  group: GroupFanoutPolicyBundle["group"];
  aggregate_metadata: GroupFanoutPolicyBundleAggregateMetadata;
  aggregate: LocalGroupAggregateResult;
  recipient_results: LocalPolicyRecipientResult[];
  transport_payload: LocalPolicyTransportPayload;
}

export type LocalPolicyRuntimeResult =
  | LocalDirectPolicyRuntimeResult
  | LocalGroupPolicyRuntimeResult;

export type MahiloPolicyBundleClient = Pick<
  MahiloContractClient,
  "getDirectSendPolicyBundle" | "getGroupFanoutPolicyBundle"
>;

export interface MahiloLocalPolicyRuntimeOptions
  extends LocalPolicyEvaluationOptions {
  client: MahiloPolicyBundleClient;
}

export class MahiloLocalPolicyRuntime {
  private readonly client: MahiloPolicyBundleClient;
  private readonly options: LocalPolicyEvaluationOptions;

  constructor(options: MahiloLocalPolicyRuntimeOptions) {
    this.client = options.client;
    this.options = {
      llmErrorMode: options.llmErrorMode,
      llmEvaluator: options.llmEvaluator,
      llmEvaluatorFactory: options.llmEvaluatorFactory,
      llmProviderAdapter: options.llmProviderAdapter,
      normalizeLLMError: options.normalizeLLMError,
      onLLMError: options.onLLMError,
      llmUnavailableMode: options.llmUnavailableMode,
    };
  }

  async evaluate(
    input: EvaluateLocalPolicyInput,
  ): Promise<LocalPolicyRuntimeResult> {
    if (input.recipientType === "group") {
      return this.evaluateGroupFanout(input);
    }

    return this.evaluateDirectSend(input);
  }

  async evaluateDirectSend(
    input: LocalPolicyRuntimeInput,
  ): Promise<LocalDirectPolicyRuntimeResult> {
    const normalizedSelectors = normalizeDeclaredSelectors(
      input.declaredSelectors,
      "outbound",
    );
    const bundle = (await this.client.getDirectSendPolicyBundle(
      buildBundleRequestPayload("user", input, normalizedSelectors),
    )) as DirectSendPolicyBundle;

    return evaluateDirectSendBundleLocally(bundle, input, this.options);
  }

  async evaluateGroupFanout(
    input: LocalPolicyRuntimeInput,
  ): Promise<LocalGroupPolicyRuntimeResult> {
    const normalizedSelectors = normalizeDeclaredSelectors(
      input.declaredSelectors,
      "outbound",
    );
    const bundle = (await this.client.getGroupFanoutPolicyBundle(
      buildBundleRequestPayload("group", input, normalizedSelectors),
    )) as GroupFanoutPolicyBundle;

    return evaluateGroupFanoutBundleLocally(bundle, input, this.options);
  }
}

export function createMahiloLocalPolicyRuntime(
  options: MahiloLocalPolicyRuntimeOptions,
): MahiloLocalPolicyRuntime {
  return new MahiloLocalPolicyRuntime(options);
}

export async function evaluateDirectSendBundleLocally(
  bundle: DirectSendPolicyBundle,
  input: LocalPolicyRuntimeInput,
  options: LocalPolicyEvaluationOptions = {},
): Promise<LocalDirectPolicyRuntimeResult> {
  const selectorContext = normalizeDeclaredSelectors(
    bundle.selector_context,
    "outbound",
  );
  const llmEvaluator = await resolveConfiguredLLMEvaluator(options, {
    bundleType: bundle.bundle_type,
    llm: bundle.llm,
    recipient: bundle.recipient,
    selectorContext,
  });
  const policyResult = await resolveLocalPolicySet({
    policies: bundle.applicable_policies,
    ownerUserId: bundle.authenticated_identity.sender_user_id,
    message: input.message,
    context: input.context,
    recipientUsername: bundle.recipient.username,
    llmSubject: bundle.llm.subject,
    authenticatedIdentity: bundle.authenticated_identity,
    llmEvaluator,
    llmUnavailableMode: options.llmUnavailableMode,
    llmErrorMode: options.llmErrorMode,
  });
  const localDecision = toLocalDecision(policyResult, selectorContext.direction);
  const recipientResult = buildRecipientResult(
    bundle.recipient,
    bundle.bundle_metadata.resolution_id,
    [],
    bundle.llm,
    localDecision,
  );
  const transportPayload = buildTransportPayload(
    input,
    bundle.authenticated_identity.sender_connection_id,
    selectorContext,
    bundle.recipient.username,
    "user",
    bundle.bundle_metadata.resolution_id,
  );
  const commitPayload = buildCommitPayload(transportPayload, localDecision);

  return {
    contract_version: bundle.contract_version,
    bundle_type: bundle.bundle_type,
    bundle_metadata: bundle.bundle_metadata,
    authenticated_identity: bundle.authenticated_identity,
    selector_context: selectorContext,
    recipient: bundle.recipient,
    llm: bundle.llm,
    local_decision: localDecision,
    recipient_results: [recipientResult],
    transport_payload: transportPayload,
    commit_payload: commitPayload,
  };
}

export async function evaluateGroupFanoutBundleLocally(
  bundle: GroupFanoutPolicyBundle,
  input: LocalPolicyRuntimeInput,
  options: LocalPolicyEvaluationOptions = {},
): Promise<LocalGroupPolicyRuntimeResult> {
  const selectorContext = normalizeDeclaredSelectors(
    bundle.selector_context,
    "outbound",
  );
  const recipientResults = await Promise.all(
    bundle.members.map(async (member) => {
      const llmEvaluator = await resolveConfiguredLLMEvaluator(options, {
        bundleType: bundle.bundle_type,
        llm: member.llm,
        recipient: member.recipient,
        selectorContext,
      });
      const policyResult = await resolveLocalPolicySet({
        policies: [
          ...member.member_applicable_policies,
          ...bundle.group_overlay_policies,
        ],
        ownerUserId: bundle.authenticated_identity.sender_user_id,
        message: input.message,
        context: input.context,
        recipientUsername: member.recipient.username,
        llmSubject: member.llm.subject,
        authenticatedIdentity: bundle.authenticated_identity,
        llmEvaluator,
        llmUnavailableMode: options.llmUnavailableMode,
        llmErrorMode: options.llmErrorMode,
      });
      const localDecision = toLocalDecision(
        policyResult,
        selectorContext.direction,
      );

      return buildRecipientResult(
        member.recipient,
        member.resolution_id,
        member.roles,
        member.llm,
        localDecision,
      );
    }),
  );
  const aggregate = buildGroupAggregateResult(
    recipientResults,
    bundle.aggregate_metadata,
    selectorContext.direction,
  );
  const transportPayload = buildTransportPayload(
    input,
    bundle.authenticated_identity.sender_connection_id,
    selectorContext,
    bundle.group.id,
    "group",
    bundle.bundle_metadata.resolution_id,
  );

  return {
    contract_version: bundle.contract_version,
    bundle_type: bundle.bundle_type,
    bundle_metadata: bundle.bundle_metadata,
    authenticated_identity: bundle.authenticated_identity,
    selector_context: selectorContext,
    group: bundle.group,
    aggregate_metadata: bundle.aggregate_metadata,
    aggregate,
    recipient_results: recipientResults,
    transport_payload: transportPayload,
  };
}

function toLocalDecision(
  policyResult: Awaited<ReturnType<typeof resolveLocalPolicySet>>,
  direction: DeclaredSelectors["direction"],
): LocalPolicyDecisionDetails {
  const deliveryMode = resolveDeliveryMode(policyResult.effect, direction);

  return {
    decision: policyResult.effect,
    delivery_mode: deliveryMode,
    summary: defaultDecisionSummary(
      policyResult.effect,
      deliveryMode,
      policyResult.reason,
    ),
    reason: policyResult.reason,
    reason_code: policyResult.reason_code,
    resolution_explanation: policyResult.resolution_explanation,
    resolver_layer: policyResult.resolver_layer,
    guardrail_id: policyResult.guardrail_id,
    winning_policy_id: policyResult.winning_policy_id,
    matched_policy_ids: policyResult.matched_policy_ids,
    evaluated_policies: policyResult.evaluated_policies,
  };
}

function resolveDeliveryMode(
  decision: PolicyDecision,
  direction: DeclaredSelectors["direction"],
): LocalDecisionDeliveryMode {
  if (decision === "deny") {
    return "blocked";
  }

  if (decision === "ask") {
    return isInboundSelectorDirection(direction)
      ? "hold_for_approval"
      : "review_required";
  }

  return "full_send";
}

function transportActionForDecision(
  decision: PolicyDecision,
): LocalTransportAction {
  if (decision === "deny") {
    return "block";
  }

  if (decision === "ask") {
    return "hold";
  }

  return "send";
}

function buildRecipientResult(
  recipient: LocalPolicyUserRecipient,
  resolutionId: string,
  roles: string[],
  llm: LocalPolicyLLMContext,
  localDecision: LocalPolicyDecisionDetails,
): LocalPolicyRecipientResult {
  return {
    recipient: recipient.username,
    recipient_id: recipient.id,
    recipient_type: recipient.type,
    resolution_id: resolutionId,
    roles,
    llm,
    local_decision: localDecision,
    should_send: localDecision.decision === "allow",
    transport_action: transportActionForDecision(localDecision.decision),
  };
}

function buildGroupAggregateResult(
  recipientResults: LocalPolicyRecipientResult[],
  metadata: GroupFanoutPolicyBundleAggregateMetadata,
  direction: DeclaredSelectors["direction"],
): LocalGroupAggregateResult {
  const counts: LocalGroupAggregateCounts = {
    delivered: recipientResults.filter(
      (result) => result.local_decision.decision === "allow",
    ).length,
    pending: 0,
    denied: recipientResults.filter(
      (result) => result.local_decision.decision === "deny",
    ).length,
    review_required: recipientResults.filter(
      (result) => result.local_decision.decision === "ask",
    ).length,
    failed: 0,
  };
  const distinctDecisions = new Set(
    recipientResults.map((result) => result.local_decision.decision),
  );
  const partialDelivery =
    recipientResults.length > 0 && distinctDecisions.size > 1;
  const aggregateDecision =
    recipientResults.length === 0
      ? "allow"
      : distinctDecisions.size === 1
        ? recipientResults[0]!.local_decision.decision
        : metadata.mixed_decision_priority.find((candidate) =>
            distinctDecisions.has(candidate),
          ) ?? "allow";
  const representative = recipientResults.find(
    (result) => result.local_decision.decision === aggregateDecision,
  );
  const reasonCode = partialDelivery
    ? metadata.partial_reason_code
    : representative?.local_decision.reason_code ??
      defaultReasonCode(aggregateDecision);
  const summary =
    recipientResults.length === 0
      ? metadata.empty_group_summary
      : partialDelivery
        ? formatAggregateSummary(metadata.partial_summary_template, counts)
        : defaultDecisionSummary(
            aggregateDecision,
            resolveDeliveryMode(aggregateDecision, direction),
          );

  return {
    counts,
    decision: aggregateDecision,
    has_sendable_recipients: recipientResults.some((result) => result.should_send),
    partial_delivery: partialDelivery,
    reason_code: reasonCode,
    summary,
  };
}

function defaultDecisionSummary(
  decision: PolicyDecision,
  deliveryMode: LocalDecisionDeliveryMode,
  reason?: string,
): string {
  if (reason) {
    return reason;
  }

  if (decision === "allow") {
    return "Message allowed by policy.";
  }

  if (decision === "deny") {
    return "Message blocked by policy.";
  }

  return deliveryMode === "hold_for_approval"
    ? "Message requires approval before delivery."
    : "Message requires review before delivery.";
}

function defaultReasonCode(decision: PolicyDecision): string {
  if (decision === "ask") {
    return "policy.ask.resolved";
  }

  if (decision === "deny") {
    return "policy.deny.resolved";
  }

  return "policy.allow.resolved";
}

function formatAggregateSummary(
  template: string,
  counts: LocalGroupAggregateCounts,
): string {
  return template
    .replace("{delivered}", String(counts.delivered))
    .replace("{pending}", String(counts.pending))
    .replace("{denied}", String(counts.denied))
    .replace("{review_required}", String(counts.review_required))
    .replace("{failed}", String(counts.failed));
}

async function resolveConfiguredLLMEvaluator(
  options: LocalPolicyEvaluationOptions,
  context: LocalPolicyLLMEvaluatorContext,
): Promise<LLMPolicyEvaluator | undefined> {
  if (options.llmEvaluator) {
    return options.llmEvaluator;
  }

  if (options.llmEvaluatorFactory) {
    return options.llmEvaluatorFactory(context);
  }

  if (options.llmProviderAdapter) {
    return createLLMPolicyEvaluator({
      providerAdapter: options.llmProviderAdapter,
      normalizeError: options.normalizeLLMError,
      onError: options.onLLMError,
    });
  }

  return undefined;
}

function buildBundleRequestPayload(
  recipientType: LocalPolicyRecipientType,
  input: LocalPolicyRuntimeInput,
  selectors: DeclaredSelectors,
): Record<string, unknown> {
  return compactObject({
    declared_selectors: selectors,
    recipient: input.recipient,
    recipient_type: recipientType,
    sender_connection_id: input.senderConnectionId,
  });
}

function buildTransportPayload(
  input: LocalPolicyRuntimeInput,
  senderConnectionId: string,
  selectorContext: DeclaredSelectors,
  recipient: string,
  recipientType: LocalPolicyRecipientType,
  resolutionId: string,
): LocalPolicyTransportPayload {
  const transportPayload: LocalPolicyTransportPayload = {
    declared_selectors: selectorContext,
    message: input.message,
    payload_type: input.payloadType ?? "text/plain",
    recipient,
    recipient_type: recipientType,
    resolution_id: resolutionId,
    sender_connection_id: senderConnectionId,
  };

  if (input.context !== undefined) {
    transportPayload.context = input.context;
  }

  if (input.correlationId !== undefined) {
    transportPayload.correlation_id = input.correlationId;
  }

  if (input.idempotencyKey !== undefined) {
    transportPayload.idempotency_key = input.idempotencyKey;
  }

  if (input.inResponseTo !== undefined) {
    transportPayload.in_response_to = input.inResponseTo;
  }

  return transportPayload;
}

function buildCommitPayload(
  transportPayload: LocalPolicyTransportPayload,
  localDecision: LocalPolicyDecisionDetails,
): LocalPolicyCommitPayload {
  return {
    ...transportPayload,
    recipient_type: "user",
    local_decision: localDecision,
  };
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
