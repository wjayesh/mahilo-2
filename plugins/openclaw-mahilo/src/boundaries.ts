import type { MahiloContractClient } from "./client";
import { normalizeDeclaredSelectors, type DeclaredSelectors } from "./policy-helpers";
import { fetchMahiloPromptContext } from "./prompt-context";
import { createMahiloOverride } from "./tools";

export type MahiloBoundaryAction = "exception" | "set";
export type MahiloBoundaryCategory =
  | "availability"
  | "contact"
  | "financial"
  | "health"
  | "location"
  | "opinions"
  | "private_details";
export type MahiloBoundaryEffect = "allow" | "ask" | "deny";
export type MahiloBoundaryScope = "global" | "group" | "role" | "user";
export type MahiloBoundaryLifetime = "one_time" | "persistent" | "temporary";

export interface MahiloBoundaryChangeInput {
  action?: string;
  audience?: string;
  boundary?: string;
  category?: string;
  derivedFromMessageId?: string;
  durationHours?: number;
  durationMinutes?: number;
  effect?: string;
  expiresAt?: string;
  idempotencyKey?: string;
  kind?: string;
  lifetime?: string;
  maxUses?: number;
  priority?: number;
  reason?: string;
  recipient?: string;
  recipientType?: "group" | "user";
  scope?: string;
  selectors?: Partial<DeclaredSelectors>;
  senderConnectionId?: string;
  sourceResolutionId?: string;
  targetId?: string;
  ttlSeconds?: number;
}

export interface MahiloBoundaryChangeWrite {
  created?: boolean;
  policyId?: string;
  response: unknown;
  selector: DeclaredSelectors;
}

export interface MahiloBoundaryChangeResult {
  action: MahiloBoundaryAction;
  category?: MahiloBoundaryCategory;
  created: boolean;
  effect: MahiloBoundaryEffect;
  kind: MahiloBoundaryLifetime;
  policyIds: string[];
  resolvedTargetId?: string;
  response: unknown[];
  scope: MahiloBoundaryScope;
  selectors: DeclaredSelectors[];
  summary: string;
  targetLabel?: string;
  writes: MahiloBoundaryChangeWrite[];
}

interface MahiloBoundaryPreset {
  defaultEffect: MahiloBoundaryEffect;
  label: string;
  selectors: DeclaredSelectors[];
}

interface NormalizedMahiloBoundaryRequest {
  action: MahiloBoundaryAction;
  category?: MahiloBoundaryCategory;
  categoryLabel: string;
  effect: MahiloBoundaryEffect;
  expiresAt?: string;
  idempotencyKey?: string;
  kind: MahiloBoundaryLifetime;
  maxUses?: number;
  recipient?: string;
  recipientType?: "group" | "user";
  reason: string;
  scope: MahiloBoundaryScope;
  selectors: DeclaredSelectors[];
  senderConnectionId: string;
  targetId?: string;
  targetLabel?: string;
  ttlSeconds?: number;
}

const BOUNDARY_PRESETS: Record<MahiloBoundaryCategory, MahiloBoundaryPreset> = {
  opinions: {
    defaultEffect: "ask",
    label: "opinions and recommendations",
    selectors: [
      {
        action: "recommend",
        direction: "outbound",
        resource: "message.general"
      }
    ]
  },
  availability: {
    defaultEffect: "ask",
    label: "availability and schedule",
    selectors: [
      {
        action: "share",
        direction: "outbound",
        resource: "calendar.availability"
      },
      {
        action: "share",
        direction: "outbound",
        resource: "calendar.event"
      }
    ]
  },
  location: {
    defaultEffect: "ask",
    label: "location",
    selectors: [
      {
        action: "share",
        direction: "outbound",
        resource: "location.current"
      },
      {
        action: "share",
        direction: "outbound",
        resource: "location.history"
      }
    ]
  },
  health: {
    defaultEffect: "deny",
    label: "health details",
    selectors: [
      {
        action: "share",
        direction: "outbound",
        resource: "health.metric"
      },
      {
        action: "share",
        direction: "outbound",
        resource: "health.summary"
      }
    ]
  },
  financial: {
    defaultEffect: "deny",
    label: "financial details",
    selectors: [
      {
        action: "share",
        direction: "outbound",
        resource: "financial.balance"
      },
      {
        action: "share",
        direction: "outbound",
        resource: "financial.transaction"
      }
    ]
  },
  contact: {
    defaultEffect: "deny",
    label: "contact details",
    selectors: [
      {
        action: "share",
        direction: "outbound",
        resource: "contact.email"
      },
      {
        action: "share",
        direction: "outbound",
        resource: "contact.phone"
      }
    ]
  },
  private_details: {
    defaultEffect: "deny",
    label: "private details",
    selectors: [
      {
        action: "share",
        direction: "outbound",
        resource: "contact.email"
      },
      {
        action: "share",
        direction: "outbound",
        resource: "contact.phone"
      },
      {
        action: "share",
        direction: "outbound",
        resource: "financial.balance"
      },
      {
        action: "share",
        direction: "outbound",
        resource: "financial.transaction"
      },
      {
        action: "share",
        direction: "outbound",
        resource: "health.metric"
      },
      {
        action: "share",
        direction: "outbound",
        resource: "health.summary"
      }
    ]
  }
};

export async function createMahiloBoundaryChange(
  client: MahiloContractClient,
  input: MahiloBoundaryChangeInput
): Promise<MahiloBoundaryChangeResult> {
  const normalized = await normalizeBoundaryRequest(client, input);
  const writes: MahiloBoundaryChangeWrite[] = [];

  for (const [index, selector] of normalized.selectors.entries()) {
    const result = await createMahiloOverride(client, {
      derivedFromMessageId: input.derivedFromMessageId,
      effect: normalized.effect,
      expiresAt: normalized.expiresAt,
      idempotencyKey: deriveIdempotencyKey(
        normalized.idempotencyKey,
        index,
        normalized.selectors.length
      ),
      kind: normalized.kind,
      maxUses: normalized.maxUses,
      priority: input.priority,
      reason: normalized.reason,
      recipient: normalized.recipient,
      recipientType: normalized.recipientType,
      scope: normalized.scope,
      selectors: selector,
      senderConnectionId: normalized.senderConnectionId,
      sourceResolutionId: input.sourceResolutionId,
      targetId: normalized.targetId,
      ttlSeconds: normalized.ttlSeconds
    });

    writes.push({
      created: result.created,
      policyId: result.policyId,
      response: result.response,
      selector
    });
  }

  const policyIds = writes.flatMap((write) => (write.policyId ? [write.policyId] : []));

  return {
    action: normalized.action,
    category: normalized.category,
    created: writes.every((write) => write.created !== false),
    effect: normalized.effect,
    kind: normalized.kind,
    policyIds,
    resolvedTargetId: normalized.targetId,
    response: writes.map((write) => write.response),
    scope: normalized.scope,
    selectors: normalized.selectors,
    summary: formatBoundarySummary(normalized, writes),
    targetLabel: normalized.targetLabel,
    writes
  };
}

async function normalizeBoundaryRequest(
  client: MahiloContractClient,
  input: MahiloBoundaryChangeInput
): Promise<NormalizedMahiloBoundaryRequest> {
  const senderConnectionId = readString(input.senderConnectionId);
  if (!senderConnectionId) {
    throw new Error("senderConnectionId is required");
  }

  const action = normalizeBoundaryAction(input.action) ?? inferBoundaryAction(input);
  const category = normalizeBoundaryCategory(input.category);
  const preset = category ? BOUNDARY_PRESETS[category] : undefined;
  const selectors = resolveBoundarySelectors(input.selectors, preset);

  if (selectors.length === 0) {
    throw new Error("category or selectors is required");
  }

  const effect =
    normalizeBoundaryEffect(input.boundary) ??
    normalizeBoundaryEffect(input.effect) ??
    resolveDefaultEffect(action, preset);
  const kind = resolveBoundaryLifetime(input, action);
  const scope = resolveBoundaryScope(input);
  const ttlSeconds = resolveTtlSeconds(input);
  const target = await resolveBoundaryTarget(client, {
    recipient: readString(input.recipient),
    recipientType: input.recipientType,
    scope,
    selectors,
    senderConnectionId,
    targetId: readString(input.targetId)
  });
  const categoryLabel = preset?.label ?? describeCustomSelectors(selectors);
  const targetLabel = readString(input.recipient) ?? target.label;
  const reason =
    readString(input.reason) ??
    buildBoundaryReason({
      action,
      categoryLabel,
      effect,
      kind,
      scope,
      targetLabel,
      ttlSeconds
    });

  return {
    action,
    category,
    categoryLabel,
    effect,
    expiresAt: readString(input.expiresAt),
    idempotencyKey: readString(input.idempotencyKey),
    kind,
    maxUses: normalizePositiveInteger(input.maxUses),
    recipient: readString(input.recipient),
    recipientType: input.recipientType,
    reason,
    scope,
    selectors,
    senderConnectionId,
    targetId: target.id,
    targetLabel,
    ttlSeconds
  };
}

function resolveBoundarySelectors(
  selectors: Partial<DeclaredSelectors> | undefined,
  preset: MahiloBoundaryPreset | undefined
): DeclaredSelectors[] {
  if (preset) {
    return preset.selectors.map((selector) =>
      normalizeDeclaredSelectors(selector, "outbound")
    );
  }

  if (!selectors) {
    return [];
  }

  return [normalizeDeclaredSelectors(selectors, "outbound")];
}

function normalizeBoundaryAction(value: string | undefined): MahiloBoundaryAction | undefined {
  const normalized = normalizeValue(value);
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "set":
    case "change":
    case "update":
    case "boundary":
      return "set";
    case "exception":
    case "grant_exception":
    case "create_override":
    case "override":
      return "exception";
    default:
      return undefined;
  }
}

function inferBoundaryAction(input: MahiloBoundaryChangeInput): MahiloBoundaryAction {
  if (
    readString(input.category) ||
    readString(input.boundary) ||
    readString(input.audience) ||
    readString(input.lifetime)
  ) {
    return "set";
  }

  return "exception";
}

function normalizeBoundaryCategory(
  value: string | undefined
): MahiloBoundaryCategory | undefined {
  const normalized = normalizeValue(value);
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "opinions":
    case "opinion":
    case "recommendation":
    case "recommendations":
    case "opinion_recommendation":
    case "opinions_recommendations":
      return "opinions";
    case "availability":
    case "schedule":
    case "calendar":
    case "availability_schedule":
      return "availability";
    case "location":
    case "whereabouts":
      return "location";
    case "health":
    case "health_details":
    case "medical":
    case "medical_details":
      return "health";
    case "financial":
    case "finance":
    case "financial_details":
    case "money":
      return "financial";
    case "contact":
    case "contact_detail":
    case "contact_details":
    case "contact_information":
    case "contact_info":
      return "contact";
    case "private":
    case "private_detail":
    case "private_details":
    case "sensitive":
    case "sensitive_details":
    case "health_financial_contact_details":
      return "private_details";
    default:
      return undefined;
  }
}

function normalizeBoundaryEffect(value: string | undefined): MahiloBoundaryEffect | undefined {
  const normalized = normalizeValue(value);
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "allow":
    case "open":
    case "permit":
    case "share":
      return "allow";
    case "ask":
    case "ask_first":
    case "check":
    case "check_first":
    case "confirm":
    case "review":
      return "ask";
    case "block":
    case "deny":
    case "never":
    case "withhold":
    case "dont_share":
    case "do_not_share":
      return "deny";
    default:
      return undefined;
  }
}

function resolveDefaultEffect(
  action: MahiloBoundaryAction,
  preset: MahiloBoundaryPreset | undefined
): MahiloBoundaryEffect {
  if (action === "exception") {
    return "allow";
  }

  return preset?.defaultEffect ?? "ask";
}

function resolveBoundaryLifetime(
  input: MahiloBoundaryChangeInput,
  action: MahiloBoundaryAction
): MahiloBoundaryLifetime {
  const explicit =
    normalizeBoundaryLifetime(input.lifetime) ??
    normalizeBoundaryLifetime(input.kind);
  if (explicit) {
    return explicit;
  }

  if (readString(input.expiresAt) || typeof resolveTtlSeconds(input) === "number") {
    return "temporary";
  }

  return action === "set" ? "persistent" : "one_time";
}

function normalizeBoundaryLifetime(
  value: string | undefined
): MahiloBoundaryLifetime | undefined {
  const normalized = normalizeValue(value);
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "always":
    case "persistent":
    case "permanent":
      return "persistent";
    case "once":
    case "one_time":
    case "single":
    case "single_use":
      return "one_time";
    case "expiring":
    case "temporary":
    case "temporary_rule":
      return "temporary";
    default:
      return undefined;
  }
}

function resolveBoundaryScope(input: MahiloBoundaryChangeInput): MahiloBoundaryScope {
  const explicit =
    normalizeBoundaryScope(input.audience) ??
    normalizeBoundaryScope(input.scope);
  if (explicit) {
    return explicit;
  }

  if (input.recipientType === "group") {
    return "group";
  }

  if (readString(input.targetId) || readString(input.recipient)) {
    return "user";
  }

  return "global";
}

function normalizeBoundaryScope(
  value: string | undefined
): MahiloBoundaryScope | undefined {
  const normalized = normalizeValue(value);
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "anyone":
    case "everyone":
    case "global":
      return "global";
    case "contact":
    case "friend":
    case "recipient":
    case "user":
      return "user";
    case "group":
      return "group";
    case "role":
      return "role";
    default:
      return undefined;
  }
}

function resolveTtlSeconds(input: MahiloBoundaryChangeInput): number | undefined {
  const ttlSeconds = normalizePositiveInteger(input.ttlSeconds);
  if (typeof ttlSeconds === "number") {
    return ttlSeconds;
  }

  const durationMinutes = normalizePositiveInteger(input.durationMinutes);
  if (typeof durationMinutes === "number") {
    return durationMinutes * 60;
  }

  const durationHours = normalizePositiveInteger(input.durationHours);
  if (typeof durationHours === "number") {
    return durationHours * 60 * 60;
  }

  return undefined;
}

async function resolveBoundaryTarget(
  client: MahiloContractClient,
  options: {
    recipient?: string;
    recipientType?: "group" | "user";
    scope: MahiloBoundaryScope;
    selectors: DeclaredSelectors[];
    senderConnectionId: string;
    targetId?: string;
  }
): Promise<{ id?: string; label?: string }> {
  if (options.scope === "global") {
    return {};
  }

  if (options.targetId) {
    return {
      id: options.targetId,
      label: options.targetId
    };
  }

  if (options.scope === "user") {
    if (!options.recipient) {
      throw new Error("user-scoped boundaries require recipient or targetId");
    }

    if (options.recipientType === "group") {
      throw new Error("recipientType=group cannot be used for a user-scoped boundary");
    }

    const primarySelector = options.selectors[0];
    const context = await fetchMahiloPromptContext(client, {
      declaredSelectors: primarySelector,
      includeRecentInteractions: false,
      interactionLimit: 1,
      recipient: options.recipient,
      recipientType: "user",
      senderConnectionId: options.senderConnectionId
    });

    const recipientId = context.context?.recipient.id;
    if (context.ok && recipientId) {
      return {
        id: recipientId,
        label: options.recipient
      };
    }

    const detail = context.error ? `: ${context.error}` : "";
    throw new Error(
      `Could not resolve a Mahilo user ID for recipient ${options.recipient}${detail}. Pass targetId explicitly or fetch Mahilo context first.`
    );
  }

  if (options.scope === "group") {
    if (!options.recipient) {
      throw new Error("group-scoped boundaries require group or targetId");
    }

    const groups = await client.listGroups();
    const match = resolveBoundaryGroup(groups, options.recipient);
    if (!match) {
      throw new Error(
        `Could not resolve a Mahilo group for ${options.recipient}. Pass targetId explicitly or use the exact group name.`
      );
    }

    return {
      id: match.groupId,
      label: match.name
    };
  }

  throw new Error(`${options.scope}-scoped boundaries require targetId`);
}

function resolveBoundaryGroup(
  groups: Array<{ groupId: string; name?: string }>,
  rawGroup: string
): { groupId: string; name?: string } | undefined {
  const normalizedGroup = normalizeBoundaryLookupValue(rawGroup);
  const exactMatch = groups.find((group) => {
    return (
      normalizeBoundaryLookupValue(group.groupId) === normalizedGroup ||
      normalizeBoundaryLookupValue(group.name) === normalizedGroup
    );
  });
  if (exactMatch) {
    return exactMatch;
  }

  const partialMatches = groups.filter((group) => {
    const groupId = normalizeBoundaryLookupValue(group.groupId);
    const groupName = normalizeBoundaryLookupValue(group.name);
    return groupId.includes(normalizedGroup) || groupName.includes(normalizedGroup);
  });

  return partialMatches.length === 1 ? partialMatches[0] : undefined;
}

function normalizeBoundaryLookupValue(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function buildBoundaryReason(options: {
  action: MahiloBoundaryAction;
  categoryLabel: string;
  effect: MahiloBoundaryEffect;
  kind: MahiloBoundaryLifetime;
  scope: MahiloBoundaryScope;
  targetLabel?: string;
  ttlSeconds?: number;
}): string {
  const intro =
    options.action === "exception"
      ? "User created a boundary exception to"
      : "User updated sharing boundaries to";
  const effect = describeBoundaryEffect(options.effect);
  const target = formatBoundaryTarget(options.scope, options.targetLabel);
  const lifetime = describeBoundaryLifetime(options.kind, undefined, options.ttlSeconds);
  return [intro, effect, options.categoryLabel, target, lifetime].join(" ").trim() + ".";
}

function formatBoundarySummary(
  normalized: NormalizedMahiloBoundaryRequest,
  writes: MahiloBoundaryChangeWrite[]
): string {
  const prefix =
    normalized.action === "exception"
      ? "Boundary exception saved:"
      : "Boundary updated:";
  const boundaryLine = [
    `${prefix} ${describeBoundaryEffect(normalized.effect)} ${normalized.categoryLabel}`,
    formatBoundaryTarget(normalized.scope, normalized.targetLabel),
    describeBoundaryLifetime(normalized.kind, normalized.expiresAt, normalized.ttlSeconds)
  ]
    .filter((value) => value.length > 0)
    .join(" ");
  const ruleCount = writes.length;
  const ruleNoun = ruleCount === 1 ? "rule" : "rules";
  const policyIds = writes.flatMap((write) => (write.policyId ? [write.policyId] : []));
  const suffix =
    policyIds.length > 0 ? ` [${policyIds.join(", ")}].` : ".";

  return `${boundaryLine}. Wrote ${ruleCount} Mahilo boundary ${ruleNoun}${suffix}`;
}

function describeBoundaryEffect(effect: MahiloBoundaryEffect): string {
  switch (effect) {
    case "allow":
      return "allow sharing";
    case "ask":
      return "ask before sharing";
    case "deny":
      return "stop sharing";
  }
}

function formatBoundaryTarget(
  scope: MahiloBoundaryScope,
  targetLabel?: string
): string {
  if (scope === "global") {
    return "with anyone";
  }

  if (!targetLabel) {
    if (scope === "user") {
      return "with this contact";
    }

    return `for ${scope}`;
  }

  if (scope === "user") {
    return `with ${targetLabel}`;
  }

  return `for ${scope} ${targetLabel}`;
}

function describeBoundaryLifetime(
  kind: MahiloBoundaryLifetime,
  expiresAt?: string,
  ttlSeconds?: number
): string {
  if (kind === "persistent") {
    return "from now on";
  }

  if (kind === "one_time") {
    return "just this once";
  }

  if (expiresAt) {
    return `until ${expiresAt}`;
  }

  if (typeof ttlSeconds === "number") {
    return `for ${formatDuration(ttlSeconds)}`;
  }

  return "for a limited time";
}

function describeCustomSelectors(selectors: DeclaredSelectors[]): string {
  if (selectors.length !== 1) {
    return "these details";
  }

  const selector = selectors[0];
  if (selector.resource === "message.general" && selector.action === "recommend") {
    return "opinions and recommendations";
  }

  const resourceLabel = selector.resource
    .replace(/[._-]+/g, " ")
    .trim();

  if (selector.action === "share") {
    return resourceLabel;
  }

  return `${resourceLabel} (${selector.action})`;
}

function deriveIdempotencyKey(
  base: string | undefined,
  index: number,
  total: number
): string | undefined {
  if (!base) {
    return undefined;
  }

  if (total <= 1) {
    return base;
  }

  return `${base}:${index + 1}`;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds % (60 * 60 * 24) === 0) {
    const days = totalSeconds / (60 * 60 * 24);
    return `${days} day${days === 1 ? "" : "s"}`;
  }

  if (totalSeconds % (60 * 60) === 0) {
    const hours = totalSeconds / (60 * 60);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  if (totalSeconds % 60 === 0) {
    const minutes = totalSeconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeValue(value: string | undefined): string | undefined {
  return readString(value)?.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function readString(value: string | undefined): string | undefined;
function readString(value: unknown): string | undefined;
function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
