import type { Policy } from "../db/schema";

export type PolicyScope = "global" | "user" | "role" | "group";
export type PolicyDirection = "outbound" | "inbound" | "request" | "response" | "notification" | "error";
export type PolicyEffect = "allow" | "ask" | "deny";
export type PolicyEvaluator = "structured" | "heuristic" | "llm";
export type PolicySource =
  | "default"
  | "learned"
  | "user_confirmed"
  | "override"
  | "user_created"
  | "legacy_migrated";

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
}

const DEFAULT_DIRECTION: PolicyDirection = "outbound";
const DEFAULT_RESOURCE = "message.general";
const DEFAULT_ACTION = "share";
const DEFAULT_EFFECT: PolicyEffect = "deny";
const DEFAULT_SOURCE: PolicySource = "legacy_migrated";

function coerceEvaluator(value: string): PolicyEvaluator {
  if (value === "structured" || value === "heuristic" || value === "llm") {
    return value;
  }
  return "llm";
}

function parseStorage(policyContent: string): CanonicalPolicyStorageV1 | null {
  try {
    const parsed = JSON.parse(policyContent) as Partial<CanonicalPolicyStorageV1> | null;
    if (!parsed || parsed.schema_version !== "canonical_policy_v1") {
      return null;
    }

    return {
      schema_version: "canonical_policy_v1",
      direction: (parsed.direction as PolicyDirection) || DEFAULT_DIRECTION,
      resource: parsed.resource || DEFAULT_RESOURCE,
      action: parsed.action || null,
      effect: (parsed.effect as PolicyEffect) || DEFAULT_EFFECT,
      evaluator: coerceEvaluator(String(parsed.evaluator || "llm")),
      policy_content: parsed.policy_content ?? "",
      effective_from: parsed.effective_from || null,
      expires_at: parsed.expires_at || null,
      max_uses:
        typeof parsed.max_uses === "number" && Number.isFinite(parsed.max_uses)
          ? Math.trunc(parsed.max_uses)
          : null,
      remaining_uses:
        typeof parsed.remaining_uses === "number" && Number.isFinite(parsed.remaining_uses)
          ? Math.trunc(parsed.remaining_uses)
          : null,
      source: (parsed.source as PolicySource) || DEFAULT_SOURCE,
      derived_from_message_id: parsed.derived_from_message_id || null,
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

export function canonicalToStorage(policy: Omit<CanonicalPolicy, "id" | "created_at" | "updated_at">): {
  policyType: PolicyEvaluator;
  policyContent: string;
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
  };

  return {
    policyType: policy.evaluator,
    policyContent: JSON.stringify(payload),
  };
}

export function dbPolicyToCanonical(policy: Policy): CanonicalPolicy {
  const payload = parseStorage(policy.policyContent);
  const evaluator = payload ? payload.evaluator : coerceEvaluator(policy.policyType);
  const content = payload
    ? payload.policy_content
    : parseLegacyPolicyContent(evaluator, policy.policyContent);

  return {
    id: policy.id,
    scope: policy.scope as PolicyScope,
    target_id: policy.targetId,
    direction: payload?.direction || DEFAULT_DIRECTION,
    resource: payload?.resource || DEFAULT_RESOURCE,
    action: payload?.action || DEFAULT_ACTION,
    effect: payload?.effect || DEFAULT_EFFECT,
    evaluator,
    policy_content: content,
    effective_from: payload?.effective_from || null,
    expires_at: payload?.expires_at || null,
    max_uses: payload?.max_uses || null,
    remaining_uses: payload?.remaining_uses || null,
    source: payload?.source || DEFAULT_SOURCE,
    derived_from_message_id: payload?.derived_from_message_id || null,
    priority: policy.priority,
    enabled: policy.enabled,
    created_at: policy.createdAt ? policy.createdAt.toISOString() : null,
    updated_at: null,
  };
}
