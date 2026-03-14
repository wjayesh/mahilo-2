import {
  isInboundSelectorDirection,
  normalizeSelectorContext,
  resolvePolicySet,
  stricterEffect,
  type AuthenticatedSenderIdentity,
  type CorePolicy,
  type LLMEvaluationFallbackMode,
  type LLMPolicyEvaluator,
  type PolicyDirection,
  type PolicyEffect,
  type PolicyResolverLayer,
  type PolicyResult,
  type ResolvedPolicySelectorContext,
} from "@mahilo/policy-core";
import type { ReviewMode } from "./config";

// Utility helpers shared across prompt context, response/result shaping, and
// the bundle-based local runtime. Live non-trusted enforcement happens in
// local-policy-runtime.ts from server-issued policy bundles.
export type PolicyDecision = PolicyEffect;
export type SelectorDirection = PolicyDirection;

export interface DeclaredSelectors extends ResolvedPolicySelectorContext {}

export interface SharedLocalPolicyResolverInput {
  policies: ReadonlyArray<CorePolicy>;
  ownerUserId: string;
  message: string;
  context?: string;
  recipientUsername?: string;
  llmSubject?: string;
  llmEvaluator?: LLMPolicyEvaluator;
  llmUnavailableMode?: LLMEvaluationFallbackMode;
  llmErrorMode?: LLMEvaluationFallbackMode;
  llmSkipMode?: LLMEvaluationFallbackMode;
  authenticatedIdentity?: AuthenticatedSenderIdentity;
  resolverLayer?: PolicyResolverLayer;
}

const DECISIONS: PolicyDecision[] = ["allow", "ask", "deny"];
const LOCAL_LLM_FAIL_SAFE_MODE: LLMEvaluationFallbackMode = "ask";
const DEGRADED_LLM_REASON_CODE_PATTERN = /^policy\.ask\.llm\.[a-z0-9_]+$/u;

export function normalizeDeclaredSelectors(
  selectors: Partial<DeclaredSelectors> | undefined,
  fallbackDirection: SelectorDirection = "outbound",
): DeclaredSelectors {
  return normalizeSelectorContext(selectors, {
    fallbackDirection,
    fallbackResource: "message.general",
    normalizeSeparators: true,
    resolveFallbackAction: (direction) =>
      isInboundSelectorDirection(direction) ? "notify" : "share",
  });
}

export function extractDecision(
  value: unknown,
  fallback: PolicyDecision = "allow",
): PolicyDecision {
  const candidates = [
    readDecision((value as Record<string, unknown> | undefined)?.decision),
    readDecision(
      (value as Record<string, unknown> | undefined)?.policy as unknown,
    ),
    readDecision(
      (value as Record<string, unknown> | undefined)?.resolution as unknown,
    ),
    readDecision(
      (value as Record<string, unknown> | undefined)?.result as unknown,
    ),
  ];

  for (const candidate of candidates) {
    if (candidate) {
      return candidate;
    }
  }

  return fallback;
}

export function extractResolutionId(value: unknown): string | undefined {
  const root = readObject(value);
  if (!root) {
    return undefined;
  }

  const rootId =
    readString(root.resolution_id) ?? readString(root.resolutionId);
  if (rootId) {
    return rootId;
  }

  const resolution = readObject(root.resolution);
  if (resolution) {
    return readString(resolution.id) ?? readString(resolution.resolution_id);
  }

  const result = readObject(root.result);
  if (result) {
    return readString(result.resolution_id) ?? readString(result.resolutionId);
  }

  return undefined;
}

export function mergePolicyDecisions(
  ...decisions: PolicyDecision[]
): PolicyDecision {
  let merged: PolicyDecision = "allow";

  for (const decision of decisions) {
    merged = stricterEffect(merged, decision);
  }

  return merged;
}

export function decisionNeedsReview(decision: PolicyDecision): boolean {
  return decision === "ask";
}

export function decisionBlocksSend(decision: PolicyDecision): boolean {
  return decision === "deny";
}

export function isDegradedLLMReasonCode(
  reasonCode: string | undefined,
): boolean {
  return (
    typeof reasonCode === "string" &&
    DEGRADED_LLM_REASON_CODE_PATTERN.test(reasonCode)
  );
}

export function shouldSendForDecision(
  decision: PolicyDecision,
  reviewMode: ReviewMode = "ask",
  reasonCode?: string,
): boolean {
  if (decision === "deny") {
    return false;
  }

  if (decision === "ask") {
    return reviewMode === "auto" && !isDegradedLLMReasonCode(reasonCode);
  }

  return true;
}

export function toToolStatus(
  decision: PolicyDecision,
  reviewMode: ReviewMode = "ask",
  reasonCode?: string,
): "denied" | "review_required" | "sent" {
  if (decision === "deny") {
    return "denied";
  }

  if (
    decision === "ask" &&
    (reviewMode !== "auto" || isDegradedLLMReasonCode(reasonCode))
  ) {
    return "review_required";
  }

  return "sent";
}

export async function resolveLocalPolicySet(
  input: SharedLocalPolicyResolverInput,
): Promise<PolicyResult> {
  return resolvePolicySet({
    policies: input.policies,
    ownerUserId: input.ownerUserId,
    message: input.message,
    context: input.context,
    recipientUsername: input.recipientUsername,
    llmSubject: input.llmSubject ?? input.recipientUsername ?? "unknown",
    llmEvaluator: input.llmEvaluator,
    llmUnavailableMode: input.llmUnavailableMode ?? LOCAL_LLM_FAIL_SAFE_MODE,
    llmErrorMode: input.llmErrorMode ?? LOCAL_LLM_FAIL_SAFE_MODE,
    llmSkipMode: input.llmSkipMode ?? LOCAL_LLM_FAIL_SAFE_MODE,
    authenticatedIdentity: input.authenticatedIdentity,
    resolverLayer: input.resolverLayer ?? "user_policies",
  });
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readDecision(value: unknown): PolicyDecision | undefined {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (DECISIONS.includes(normalized as PolicyDecision)) {
      return normalized as PolicyDecision;
    }
  }

  const objectValue = readObject(value);
  if (!objectValue) {
    return undefined;
  }

  return readDecision(objectValue.decision);
}
