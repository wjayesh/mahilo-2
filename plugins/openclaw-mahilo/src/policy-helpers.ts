import type { ReviewMode } from "./config";

export type PolicyDecision = "allow" | "ask" | "deny";
export type SelectorDirection = "inbound" | "outbound";

export interface DeclaredSelectors {
  action: string;
  direction: SelectorDirection;
  resource: string;
}

export interface LocalPolicyGuardInput {
  message: string;
  selectors: DeclaredSelectors;
}

export interface LocalPolicyGuardResult {
  decision: PolicyDecision;
  reason?: string;
}

const DECISIONS: PolicyDecision[] = ["allow", "ask", "deny"];
const DECISION_PRIORITY: Record<PolicyDecision, number> = {
  allow: 0,
  ask: 1,
  deny: 2
};

const SENSITIVE_RESOURCES = ["calendar.", "contact.", "financial.", "health.", "location."];
const SENSITIVE_MESSAGE_PATTERNS = [/\b\d{3}-\d{2}-\d{4}\b/u, /\baccount number\b/iu, /\bpassword\b/iu, /\bpin\b/iu];

export function normalizeDeclaredSelectors(
  selectors: Partial<DeclaredSelectors> | undefined,
  fallbackDirection: SelectorDirection = "outbound"
): DeclaredSelectors {
  const direction = parseDirection(selectors?.direction, fallbackDirection);
  const resource = normalizeToken(selectors?.resource, "message.general");
  const action = normalizeToken(selectors?.action, direction === "outbound" ? "share" : "notify");

  return {
    action,
    direction,
    resource
  };
}

export function extractDecision(value: unknown, fallback: PolicyDecision = "allow"): PolicyDecision {
  const candidates = [
    readDecision((value as Record<string, unknown> | undefined)?.decision),
    readDecision((value as Record<string, unknown> | undefined)?.policy as unknown),
    readDecision((value as Record<string, unknown> | undefined)?.resolution as unknown),
    readDecision((value as Record<string, unknown> | undefined)?.result as unknown)
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

  const rootId = readString(root.resolution_id) ?? readString(root.resolutionId);
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

export function mergePolicyDecisions(...decisions: PolicyDecision[]): PolicyDecision {
  let merged: PolicyDecision = "allow";

  for (const decision of decisions) {
    if (DECISION_PRIORITY[decision] > DECISION_PRIORITY[merged]) {
      merged = decision;
    }
  }

  return merged;
}

export function decisionNeedsReview(decision: PolicyDecision): boolean {
  return decision === "ask";
}

export function decisionBlocksSend(decision: PolicyDecision): boolean {
  return decision === "deny";
}

export function shouldSendForDecision(decision: PolicyDecision, reviewMode: ReviewMode = "ask"): boolean {
  if (decision === "deny") {
    return false;
  }

  if (decision === "ask") {
    return reviewMode === "auto";
  }

  return true;
}

export function toToolStatus(decision: PolicyDecision, reviewMode: ReviewMode = "ask"): "denied" | "review_required" | "sent" {
  if (decision === "deny") {
    return "denied";
  }

  if (decision === "ask" && reviewMode !== "auto") {
    return "review_required";
  }

  return "sent";
}

export function applyLocalPolicyGuard(input: LocalPolicyGuardInput): LocalPolicyGuardResult {
  const normalizedMessage = input.message.trim();
  if (normalizedMessage.length === 0) {
    return {
      decision: "ask",
      reason: "message body is empty"
    };
  }

  const isSensitiveResource = SENSITIVE_RESOURCES.some((prefix) => input.selectors.resource.startsWith(prefix));
  const hasSensitivePattern = SENSITIVE_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalizedMessage));

  if (isSensitiveResource && hasSensitivePattern) {
    return {
      decision: "ask",
      reason: "sensitive resource with risky payload pattern"
    };
  }

  return {
    decision: "allow"
  };
}

function parseDirection(value: unknown, fallback: SelectorDirection): SelectorDirection {
  if (value === "inbound" || value === "outbound") {
    return value;
  }

  return fallback;
}

function normalizeToken(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9.]+/giu, ".");
  const collapsed = normalized.replace(/\.+/gu, ".").replace(/^\.|\.$/gu, "");
  return collapsed.length > 0 ? collapsed : fallback;
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
