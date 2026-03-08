import { createHash } from "crypto";
import { and, eq, gte } from "drizzle-orm";
import { getDb, schema } from "../db";
import { dbPolicyToCanonical, type CanonicalPolicy } from "./policySchema";

const DEFAULT_MIN_REPETITIONS = 3;
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_LIMIT = 20;

interface OverrideMetadata {
  kind: string | null;
  reason: string | null;
  source_resolution_id: string | null;
}

interface PatternKey {
  scope: CanonicalPolicy["scope"];
  target_id: string | null;
  direction: CanonicalPolicy["direction"];
  resource: string;
  action: string | null;
  effect: CanonicalPolicy["effect"];
}

interface PatternBucket {
  key: PatternKey;
  override_policy_ids: string[];
  reasons: Set<string>;
  kinds: Set<string>;
  source_resolution_ids: Set<string>;
  first_seen_at: string | null;
  last_seen_at: string | null;
  count: number;
}

export interface PromotionSuggestionQuery {
  min_repetitions?: number;
  lookback_days?: number;
  limit?: number;
  now?: Date;
}

export interface PromotionSuggestion {
  suggestion_id: string;
  repeated_override_pattern: {
    count: number;
    first_seen_at: string | null;
    last_seen_at: string | null;
    override_policy_ids: string[];
    kinds: string[];
    sample_reasons: string[];
    source_resolution_ids: string[];
  };
  selectors: {
    direction: CanonicalPolicy["direction"];
    resource: string;
    action: string | null;
  };
  suggested_policy: {
    scope: CanonicalPolicy["scope"];
    target_id: string | null;
    direction: CanonicalPolicy["direction"];
    resource: string;
    action: string | null;
    effect: CanonicalPolicy["effect"];
    evaluator: "structured";
    source: "user_confirmed";
    learning_provenance: {
      source_interaction_id: null;
      promoted_from_policy_ids: string[];
    };
  };
}

export interface PromotionSuggestionReport {
  min_repetitions: number;
  lookback_days: number;
  evaluated_override_count: number;
  total_pattern_count: number;
  suggestions: PromotionSuggestion[];
}

function normalizeQuery(query: PromotionSuggestionQuery) {
  const min_repetitions =
    typeof query.min_repetitions === "number" && Number.isFinite(query.min_repetitions)
      ? Math.max(2, Math.trunc(query.min_repetitions))
      : DEFAULT_MIN_REPETITIONS;

  const lookback_days =
    typeof query.lookback_days === "number" && Number.isFinite(query.lookback_days)
      ? Math.min(365, Math.max(1, Math.trunc(query.lookback_days)))
      : DEFAULT_LOOKBACK_DAYS;

  const limit =
    typeof query.limit === "number" && Number.isFinite(query.limit)
      ? Math.min(50, Math.max(1, Math.trunc(query.limit)))
      : DEFAULT_LIMIT;

  return {
    min_repetitions,
    lookback_days,
    limit,
    now: query.now ?? new Date(),
  };
}

function parseOverrideMetadata(policyContent: unknown): OverrideMetadata {
  if (!policyContent || typeof policyContent !== "object" || Array.isArray(policyContent)) {
    return {
      kind: null,
      reason: null,
      source_resolution_id: null,
    };
  }

  const metadata = (policyContent as Record<string, unknown>)._mahilo_override;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {
      kind: null,
      reason: null,
      source_resolution_id: null,
    };
  }

  const record = metadata as Record<string, unknown>;
  return {
    kind: typeof record.kind === "string" && record.kind.length > 0 ? record.kind : null,
    reason: typeof record.reason === "string" && record.reason.length > 0 ? record.reason : null,
    source_resolution_id:
      typeof record.source_resolution_id === "string" && record.source_resolution_id.length > 0
        ? record.source_resolution_id
        : null,
  };
}

function isTemporaryOverride(policy: CanonicalPolicy, metadata: OverrideMetadata): boolean {
  if (metadata.kind === "persistent") {
    return false;
  }

  if (metadata.kind === "one_time" || metadata.kind === "temporary") {
    return true;
  }

  return policy.max_uses !== null || policy.expires_at !== null;
}

function buildPatternKey(key: PatternKey): string {
  return [
    key.scope,
    key.target_id ?? "*",
    key.direction,
    key.resource,
    key.action ?? "*",
    key.effect,
  ].join("::");
}

function buildSuggestionId(userId: string, key: PatternKey): string {
  const digest = createHash("sha256")
    .update(`${userId}:${buildPatternKey(key)}`)
    .digest("hex")
    .slice(0, 16);
  return `sugg_promote_${digest}`;
}

function compareIso(a: string | null, b: string | null): number {
  const aTs = a ? Date.parse(a) : 0;
  const bTs = b ? Date.parse(b) : 0;
  return aTs - bTs;
}

function toSuggestion(userId: string, bucket: PatternBucket): PromotionSuggestion {
  const overridePolicyIds = [...bucket.override_policy_ids];
  const kinds = [...bucket.kinds].sort();
  const reasons = [...bucket.reasons].slice(0, 3);
  const sourceResolutionIds = [...bucket.source_resolution_ids].slice(0, 10);

  return {
    suggestion_id: buildSuggestionId(userId, bucket.key),
    repeated_override_pattern: {
      count: bucket.count,
      first_seen_at: bucket.first_seen_at,
      last_seen_at: bucket.last_seen_at,
      override_policy_ids: overridePolicyIds,
      kinds,
      sample_reasons: reasons,
      source_resolution_ids: sourceResolutionIds,
    },
    selectors: {
      direction: bucket.key.direction,
      resource: bucket.key.resource,
      action: bucket.key.action,
    },
    suggested_policy: {
      scope: bucket.key.scope,
      target_id: bucket.key.target_id,
      direction: bucket.key.direction,
      resource: bucket.key.resource,
      action: bucket.key.action,
      effect: bucket.key.effect,
      evaluator: "structured",
      source: "user_confirmed",
      learning_provenance: {
        source_interaction_id: null,
        promoted_from_policy_ids: overridePolicyIds,
      },
    },
  };
}

export async function detectPromotionSuggestions(
  userId: string,
  query: PromotionSuggestionQuery = {}
): Promise<PromotionSuggestionReport> {
  const { min_repetitions, lookback_days, limit, now } = normalizeQuery(query);
  const db = getDb();
  const lookbackStart = new Date(now.getTime() - lookback_days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select()
    .from(schema.policies)
    .where(
      and(
        eq(schema.policies.userId, userId),
        eq(schema.policies.source, "override"),
        eq(schema.policies.enabled, true),
        gte(schema.policies.createdAt, lookbackStart)
      )
    );

  const temporaryOverrides = rows
    .map((row) => dbPolicyToCanonical(row))
    .map((policy) => ({ policy, metadata: parseOverrideMetadata(policy.policy_content) }))
    .filter(({ policy, metadata }) => isTemporaryOverride(policy, metadata));

  const buckets = new Map<string, PatternBucket>();

  for (const { policy, metadata } of temporaryOverrides) {
    const key: PatternKey = {
      scope: policy.scope,
      target_id: policy.target_id,
      direction: policy.direction,
      resource: policy.resource,
      action: policy.action,
      effect: policy.effect,
    };
    const keyString = buildPatternKey(key);

    const existing = buckets.get(keyString);
    if (!existing) {
      buckets.set(keyString, {
        key,
        override_policy_ids: [policy.id],
        reasons: new Set(metadata.reason ? [metadata.reason] : []),
        kinds: new Set(metadata.kind ? [metadata.kind] : []),
        source_resolution_ids: new Set(
          metadata.source_resolution_id ? [metadata.source_resolution_id] : []
        ),
        first_seen_at: policy.created_at,
        last_seen_at: policy.created_at,
        count: 1,
      });
      continue;
    }

    existing.count += 1;
    existing.override_policy_ids.push(policy.id);
    if (metadata.reason) {
      existing.reasons.add(metadata.reason);
    }
    if (metadata.kind) {
      existing.kinds.add(metadata.kind);
    }
    if (metadata.source_resolution_id) {
      existing.source_resolution_ids.add(metadata.source_resolution_id);
    }

    if (compareIso(policy.created_at, existing.first_seen_at) < 0) {
      existing.first_seen_at = policy.created_at;
    }
    if (compareIso(policy.created_at, existing.last_seen_at) > 0) {
      existing.last_seen_at = policy.created_at;
    }
  }

  const orderedBuckets = [...buckets.values()].sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return compareIso(b.last_seen_at, a.last_seen_at);
  });

  const suggestions = orderedBuckets
    .filter((bucket) => bucket.count >= min_repetitions)
    .slice(0, limit)
    .map((bucket) => toSuggestion(userId, bucket));

  return {
    min_repetitions,
    lookback_days,
    evaluated_override_count: temporaryOverrides.length,
    total_pattern_count: orderedBuckets.length,
    suggestions,
  };
}
