import {
  normalizeDeclaredSelectors,
  type DeclaredSelectors,
  type PolicyDecision
} from "./policy-helpers";
import type { MahiloPendingLearningSuggestion } from "./state";
import { summarizeMahiloSendOutcome } from "./tools";

const MAHILO_SEND_MESSAGE_TOOL_NAME = "send_message";

type MahiloSendTargetType = "group" | "user";
type SendToolName = typeof MAHILO_SEND_MESSAGE_TOOL_NAME;

export interface MahiloPostSendFailure {
  error: string;
  recipient: string;
  recipientType: MahiloSendTargetType;
  selectors: DeclaredSelectors;
  senderConnectionId?: string;
  toolName: SendToolName;
}

export interface MahiloPostSendObservation extends MahiloPendingLearningSuggestion {}

export type MahiloPostSendEvent =
  | {
      failure: MahiloPostSendFailure;
      kind: "failure";
    }
  | {
      kind: "outcome";
      observation: MahiloPostSendObservation;
    };

export function extractMahiloPostSendEvent(event: {
  error?: string;
  params: Record<string, unknown>;
  result?: unknown;
  toolName: string;
}): MahiloPostSendEvent | undefined {
  const toolName = readToolName(event.toolName);
  if (!toolName) {
    return undefined;
  }

  const recipientType = resolveRecipientType(event.params);
  const recipient = resolveRecipient(event.params, recipientType);
  if (!recipient) {
    return undefined;
  }

  const selectors = normalizeDeclaredSelectors(
    readObject(event.params.declaredSelectors) ??
      readObject(event.params.declared_selectors) ??
      undefined,
    "outbound"
  );
  const senderConnectionId =
    readString(event.params.senderConnectionId) ??
    readString(event.params.sender_connection_id);
  const details = readObject(readObject(event.result)?.details);

  const failure =
    readString(event.error) ??
    readString(details?.error) ??
    (readString(details?.status) === "error" ? "Mahilo send failed" : undefined);

  if (failure) {
    return {
      failure: {
        error: failure,
        recipient,
        recipientType,
        selectors,
        senderConnectionId,
        toolName
      },
      kind: "failure"
    };
  }

  const decision = readDecision(details?.decision);
  if (!decision) {
    return undefined;
  }

  const status = readStatus(details?.status);
  if (!status) {
    return undefined;
  }

  const outcomeSummary = summarizeMahiloSendOutcome(
    details?.response,
    decision,
    recipient
  );

  return {
    kind: "outcome",
    observation: {
      decision,
      fingerprint: buildDecisionFingerprint({
        decision,
        outcome: outcomeSummary.outcome,
        recipient,
        recipientType,
        selectors,
        senderConnectionId,
        toolName
      }),
      messageId: readString(details?.messageId) ?? readString(details?.message_id),
      outcome: outcomeSummary.outcome,
      reason: outcomeSummary.reason ?? readString(details?.reason),
      recipient,
      recipientType,
      resolutionId:
        readString(details?.resolutionId) ?? readString(details?.resolution_id),
      selectors,
      senderConnectionId,
      status,
      toolName
    }
  };
}

export function formatMahiloOutcomeSystemEvent(event: MahiloPostSendEvent): string {
  if (event.kind === "failure") {
    const targetLabel = formatTargetLabel(event.failure.recipientType, event.failure.recipient);
    const selectorLabel = formatSelectorLabel(event.failure.selectors);
    return `Mahilo outcome: send failed for ${targetLabel} (${selectorLabel}). ${event.failure.error}`;
  }

  const { observation } = event;
  const targetLabel = formatObservationTargetLabel(observation);
  const selectorLabel = formatSelectorLabel(observation.selectors);
  const messageIdSuffix = observation.messageId
    ? ` [message ${observation.messageId}]`
    : "";

  let headline = `Mahilo outcome: sent to ${targetLabel} (${selectorLabel})${messageIdSuffix}.`;

  if (observation.outcome === "partial_sent") {
    headline = `Mahilo outcome: partially sent to ${targetLabel} (${selectorLabel})${messageIdSuffix}.`;
  } else if (observation.outcome === "review_requested") {
    headline = `Mahilo outcome: review required for ${targetLabel} (${selectorLabel}).`;
  } else if (
    observation.outcome === "blocked" ||
    observation.outcome === "review_rejected" ||
    observation.outcome === "withheld"
  ) {
    headline = `Mahilo outcome: blocked for ${targetLabel} (${selectorLabel}).`;
  } else if (observation.outcome === "send_failed") {
    headline = `Mahilo outcome: send failed for ${targetLabel} (${selectorLabel}).`;
  }

  return observation.reason ? `${headline} ${observation.reason}` : headline;
}

export function shouldQueueMahiloLearningSuggestion(
  observation: MahiloPostSendObservation
): boolean {
  if (observation.outcome === "send_failed") {
    return false;
  }

  if (
    observation.outcome === "sent" &&
    observation.decision === "allow" &&
    observation.selectors.resource === "message.general"
  ) {
    return false;
  }

  return true;
}

export function formatMahiloLearningSuggestion(
  observation: MahiloPostSendObservation
): string {
  const targetLabel = formatObservationTargetLabel(observation);
  const selectorLabel = formatSelectorLabel(observation.selectors);
  const actionSummary = describeLearningDecision(observation);
  const reasonLine = observation.reason ? ` ${observation.reason}` : "";

  return [
    "Mahilo learning opportunity:",
    `${actionSummary} for ${targetLabel} on ${selectorLabel}.${reasonLine}`,
    `Decide whether this should apply just once, for a short time, for ${targetLabel}, for similar contacts, or as your normal rule.`,
    "Use `set_boundaries` to adjust boundaries or create a temporary boundary exception."
  ].join(" ");
}

function buildDecisionFingerprint(options: {
  decision: PolicyDecision;
  outcome: MahiloPendingLearningSuggestion["outcome"];
  recipient: string;
  recipientType: MahiloSendTargetType;
  selectors: DeclaredSelectors;
  senderConnectionId?: string;
  toolName: SendToolName;
}): string {
  return [
    options.senderConnectionId ?? "default",
    options.toolName,
    options.recipientType,
    options.recipient.toLowerCase(),
    options.selectors.direction,
    options.selectors.resource,
    options.selectors.action,
    options.decision,
    options.outcome
  ].join("|");
}

function describeLearningDecision(observation: MahiloPostSendObservation): string {
  const targetLabel = formatObservationTargetLabel(observation);

  if (observation.outcome === "review_requested") {
    return `Mahilo asked for review before sending to ${targetLabel}`;
  }

  if (
    observation.outcome === "blocked" ||
    observation.outcome === "review_rejected" ||
    observation.outcome === "withheld"
  ) {
    return `Mahilo blocked a send to ${targetLabel}`;
  }

  if (observation.outcome === "partial_sent") {
    return `Mahilo only sent part of the message to ${targetLabel}`;
  }

  return `Mahilo just shared new information with ${targetLabel}`;
}

function formatTargetLabel(recipientType: MahiloSendTargetType, recipient: string): string {
  return recipientType === "group" ? `group ${recipient}` : recipient;
}

function formatObservationTargetLabel(observation: MahiloPostSendObservation): string {
  const recipientType =
    observation.recipientType ?? readLegacyRecipientType(observation.toolName) ?? "user";
  return formatTargetLabel(recipientType, observation.recipient);
}

function formatSelectorLabel(selectors: DeclaredSelectors): string {
  return `${selectors.resource}/${selectors.action}`;
}

function readToolName(value: string): SendToolName | undefined {
  if (value === MAHILO_SEND_MESSAGE_TOOL_NAME) {
    return MAHILO_SEND_MESSAGE_TOOL_NAME;
  }

  return undefined;
}

function resolveRecipient(
  params: Record<string, unknown>,
  recipientType: MahiloSendTargetType
): string | undefined {
  return (
    readString(params.target) ??
    readString(params.recipient) ??
    (recipientType === "group"
      ? readString(params.group) ??
        readString(params.groupId) ??
        readString(params.group_id)
      : undefined)
  );
}

function resolveRecipientType(params: Record<string, unknown>): MahiloSendTargetType {
  return (
    readTargetType(params.targetType) ??
    readTargetType(params.target_type) ??
    readRecipientType(params.recipientType) ??
    readRecipientType(params.recipient_type) ??
    (readString(params.group) ?? readString(params.groupId) ?? readString(params.group_id)
      ? "group"
      : "user")
  );
}

function readLegacyRecipientType(value: string): MahiloSendTargetType | undefined {
  if (value === "talk_to_group") {
    return "group";
  }

  if (value === "talk_to_agent") {
    return "user";
  }

  return undefined;
}

function readDecision(value: unknown): PolicyDecision | undefined {
  return value === "allow" || value === "ask" || value === "deny" ? value : undefined;
}

function readStatus(
  value: unknown
): MahiloPendingLearningSuggestion["status"] | undefined {
  return value === "denied" || value === "review_required" || value === "sent"
    ? value
    : undefined;
}

function readRecipientType(value: unknown): MahiloSendTargetType | undefined {
  return value === "group" || value === "user" ? value : undefined;
}

function readTargetType(value: unknown): MahiloSendTargetType | undefined {
  return value === "group"
    ? "group"
    : value === "person" || value === "user"
      ? "user"
      : undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
