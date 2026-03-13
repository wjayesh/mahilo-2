import type { Policy } from "../db/schema";

export type PolicyScope = "global" | "user" | "role" | "group";
export type PolicyDirection =
  | "outbound"
  | "inbound"
  | "request"
  | "response"
  | "notification"
  | "error";
export type PolicyEffect = "allow" | "ask" | "deny";
export type PolicyEvaluator = "structured" | "heuristic" | "llm";
export type PolicySource =
  | "default"
  | "learned"
  | "user_confirmed"
  | "override"
  | "user_created"
  | "legacy_migrated";

export interface PolicyLearningProvenance {
  source_interaction_id: string | null;
  promoted_from_policy_ids: string[];
}

export interface CanonicalPolicy {
  id: string;
  scope: PolicyScope;
  target_id: string | null;
  direction: PolicyDirection;
  resource: string;
  action: string | null;
  effect: PolicyEffect;
  evaluator: PolicyEvaluator;
  policy_content: unknown;
  effective_from: string | null;
  expires_at: string | null;
  max_uses: number | null;
  remaining_uses: number | null;
  source: PolicySource;
  derived_from_message_id: string | null;
  learning_provenance?: PolicyLearningProvenance | null;
  priority: number;
  enabled: boolean;
  created_at: string | null;
  updated_at: string | null;
}

interface CanonicalPolicyStorageV1 {
  schema_version: "canonical_policy_v1";
  direction: PolicyDirection;
  resource: string;
  action: string | null;
  effect: PolicyEffect;
  evaluator: PolicyEvaluator;
  policy_content: unknown;
  effective_from: string | null;
  expires_at: string | null;
  max_uses: number | null;
  remaining_uses: number | null;
  source: PolicySource;
  derived_from_message_id: string | null;
  learning_provenance?: PolicyLearningProvenance | null;
}

const DEFAULT_DIRECTION: PolicyDirection = "outbound";
const DEFAULT_RESOURCE = "message.general";
const DEFAULT_ACTION = "share";
const DEFAULT_EFFECT: PolicyEffect = "deny";
const DEFAULT_SOURCE: PolicySource = "legacy_migrated";

const VALID_DIRECTIONS: PolicyDirection[] = [
  "outbound",
  "inbound",
  "request",
  "response",
  "notification",
  "error",
];
const VALID_EFFECTS: PolicyEffect[] = ["allow", "ask", "deny"];
const VALID_EVALUATORS: PolicyEvaluator[] = ["structured", "heuristic", "llm"];
const VALID_SOURCES: PolicySource[] = [
  "default",
  "learned",
  "user_confirmed",
  "override",
  "user_created",
  "legacy_migrated",
];

function parseDirection(value: string | null | undefined): PolicyDirection | null {
  if (!value) {
    return null;
  }
  return VALID_DIRECTIONS.includes(value as PolicyDirection) ? (value as PolicyDirection) : null;
}

function parseEffect(value: string | null | undefined): PolicyEffect | null {
  if (!value) {
    return null;
  }
  return VALID_EFFECTS.includes(value as PolicyEffect) ? (value as PolicyEffect) : null;
}

function parseEvaluator(value: string | null | undefined): PolicyEvaluator | null {
  if (!value) {
    return null;
  }
  return VALID_EVALUATORS.includes(value as PolicyEvaluator) ? (value as PolicyEvaluator) : null;
}

function parseSource(value: string | null | undefined): PolicySource | null {
  if (!value) {
    return null;
  }
  return VALID_SOURCES.includes(value as PolicySource) ? (value as PolicySource) : null;
}

function coerceEvaluator(value: string): PolicyEvaluator {
  return parseEvaluator(value) || "llm";
}

function toNullableInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  return null;
}

function toIsoString(value: Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.toISOString();
}

function normalizeLearningProvenance(
  value: unknown
): PolicyLearningProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const sourceInteractionId =
    typeof record.source_interaction_id === "string" &&
    record.source_interaction_id.trim().length > 0
      ? record.source_interaction_id.trim()
      : null;

  const promotedFromRaw = Array.isArray(record.promoted_from_policy_ids)
    ? record.promoted_from_policy_ids
    : [];
  const promotedFromPolicyIds = Array.from(
    new Set(
      promotedFromRaw
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    )
  );

  if (!sourceInteractionId && promotedFromPolicyIds.length === 0) {
    return null;
  }

  return {
    source_interaction_id: sourceInteractionId,
    promoted_from_policy_ids: promotedFromPolicyIds,
  };
}

function toDbTimestamp(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function parseStorage(policyContent: string): CanonicalPolicyStorageV1 | null {
  try {
    const parsed = JSON.parse(policyContent) as Partial<CanonicalPolicyStorageV1> | null;
    if (!parsed || parsed.schema_version !== "canonical_policy_v1") {
      return null;
    }

    return {
      schema_version: "canonical_policy_v1",
      direction: parseDirection(parsed.direction) || DEFAULT_DIRECTION,
      resource: parsed.resource || DEFAULT_RESOURCE,
      action: parsed.action || null,
      effect: parseEffect(parsed.effect) || DEFAULT_EFFECT,
      evaluator: coerceEvaluator(String(parsed.evaluator || "llm")),
      policy_content: parsed.policy_content ?? "",
      effective_from: parsed.effective_from || null,
      expires_at: parsed.expires_at || null,
      max_uses: toNullableInteger(parsed.max_uses),
      remaining_uses: toNullableInteger(parsed.remaining_uses),
      source: parseSource(parsed.source) || DEFAULT_SOURCE,
      derived_from_message_id: parsed.derived_from_message_id || null,
      learning_provenance: normalizeLearningProvenance(parsed.learning_provenance),
    };
  } catch {
    return null;
  }
}

function parseLegacyPolicyContent(evaluator: PolicyEvaluator, policyContent: string): unknown {
  if (evaluator === "heuristic" || evaluator === "structured") {
    try {
      return JSON.parse(policyContent);
    } catch {
      return policyContent;
    }
  }
  return policyContent;
}

function parseLegacyLearningProvenance(content: unknown): PolicyLearningProvenance | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return null;
  }

  return normalizeLearningProvenance(
    (content as Record<string, unknown>)._mahilo_learning_provenance
  );
}

export function canonicalToStorage(policy: Omit<CanonicalPolicy, "id" | "created_at" | "updated_at">): {
  policyType: PolicyEvaluator;
  policyContent: string;
  direction: PolicyDirection;
  resource: string;
  action: string | null;
  effect: PolicyEffect;
  evaluator: PolicyEvaluator;
  effectiveFrom: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  remainingUses: number | null;
  source: PolicySource;
  derivedFromMessageId: string | null;
} {
  const payload: CanonicalPolicyStorageV1 = {
    schema_version: "canonical_policy_v1",
    direction: policy.direction,
    resource: policy.resource,
    action: policy.action,
    effect: policy.effect,
    evaluator: policy.evaluator,
    policy_content: policy.policy_content,
    effective_from: policy.effective_from,
    expires_at: policy.expires_at,
    max_uses: policy.max_uses,
    remaining_uses: policy.remaining_uses,
    source: policy.source,
    derived_from_message_id: policy.derived_from_message_id,
    learning_provenance: normalizeLearningProvenance(policy.learning_provenance),
  };

  return {
    policyType: policy.evaluator,
    policyContent: JSON.stringify(payload),
    direction: policy.direction,
    resource: policy.resource,
    action: policy.action,
    effect: policy.effect,
    evaluator: policy.evaluator,
    effectiveFrom: toDbTimestamp(policy.effective_from),
    expiresAt: toDbTimestamp(policy.expires_at),
    maxUses: policy.max_uses,
    remainingUses: policy.remaining_uses,
    source: policy.source,
    derivedFromMessageId: policy.derived_from_message_id,
  };
}

export function dbPolicyToCanonical(policy: Policy): CanonicalPolicy {
  const payload = parseStorage(policy.policyContent);

  const evaluator =
    parseEvaluator(policy.evaluator) ||
    payload?.evaluator ||
    parseEvaluator(policy.policyType) ||
    "llm";
  const content = payload
    ? payload.policy_content
    : parseLegacyPolicyContent(evaluator, policy.policyContent);

  const direction = parseDirection(policy.direction) || payload?.direction || DEFAULT_DIRECTION;
  const resource = policy.resource || payload?.resource || DEFAULT_RESOURCE;
  const action = policy.action ?? payload?.action ?? DEFAULT_ACTION;
  const effect = parseEffect(policy.effect) || payload?.effect || DEFAULT_EFFECT;
  const source = parseSource(policy.source) || payload?.source || DEFAULT_SOURCE;
  const effectiveFrom = toIsoString(policy.effectiveFrom) || payload?.effective_from || null;
  const expiresAt = toIsoString(policy.expiresAt) || payload?.expires_at || null;
  const maxUses = toNullableInteger(policy.maxUses) ?? payload?.max_uses ?? null;
  const remainingUses = toNullableInteger(policy.remainingUses) ?? payload?.remaining_uses ?? null;
  const learningProvenance =
    normalizeLearningProvenance(payload?.learning_provenance) ||
    parseLegacyLearningProvenance(content);

  return {
    id: policy.id,
    scope: policy.scope as PolicyScope,
    target_id: policy.targetId,
    direction,
    resource,
    action,
    effect,
    evaluator,
    policy_content: content,
    effective_from: effectiveFrom,
    expires_at: expiresAt,
    max_uses: maxUses,
    remaining_uses: remainingUses,
    source,
    derived_from_message_id:
      policy.derivedFromMessageId ?? payload?.derived_from_message_id ?? null,
    learning_provenance: learningProvenance,
    priority: policy.priority,
    enabled: policy.enabled,
    created_at: policy.createdAt ? policy.createdAt.toISOString() : null,
    updated_at: null,
  };
}
