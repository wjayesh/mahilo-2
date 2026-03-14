import type {
  PolicyDirection,
  PolicySelectorContext,
  PolicySelectorInput,
  ResolvedPolicySelectorContext,
  SelectorFilterCandidate,
} from "./types";

export const SELECTOR_DIRECTIONS = [
  "outbound",
  "inbound",
  "request",
  "response",
  "notification",
  "error",
] as const satisfies readonly PolicyDirection[];

export const DEFAULT_SELECTOR_DIRECTION: PolicyDirection = "outbound";
export const DEFAULT_SELECTOR_RESOURCE = "message.general";
export const DEFAULT_SELECTOR_ACTION = "share";

const selectorDirectionSet = new Set<string>(SELECTOR_DIRECTIONS);

export interface NormalizeSelectorTokenOptions {
  normalizeSeparators?: boolean;
}

export interface NormalizeSelectorContextOptions extends NormalizeSelectorTokenOptions {
  fallbackAction?: string;
  fallbackDirection?: PolicyDirection;
  fallbackResource?: string;
  resolveFallbackAction?: (direction: PolicyDirection) => string;
}

export function normalizeSelectorToken(
  value: string | null | undefined,
  fallback?: string,
  options: NormalizeSelectorTokenOptions = {}
): string | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized.length === 0) {
    return fallback;
  }

  if (!options.normalizeSeparators) {
    return normalized;
  }

  const collapsed = normalized
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");

  return collapsed.length > 0 ? collapsed : fallback;
}

export function normalizeSelectorDirection(
  value: string | null | undefined,
  fallback?: PolicyDirection
): PolicyDirection | undefined {
  const normalized = normalizeSelectorToken(value);
  if (!normalized) {
    return fallback;
  }

  return selectorDirectionSet.has(normalized)
    ? (normalized as PolicyDirection)
    : fallback;
}

export function isInboundSelectorDirection(direction: string | null | undefined): boolean {
  const normalized = normalizeSelectorDirection(direction);
  return normalized === "inbound" || normalized === "request";
}

export function selectorDirectionsEquivalent(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const normalizedLeft = normalizeSelectorDirection(left);
  const normalizedRight = normalizeSelectorDirection(right);
  if (!normalizedLeft || !normalizedRight) {
    return normalizedLeft === normalizedRight;
  }

  return resolveDirectionCandidates(normalizedLeft)?.includes(normalizedRight) ?? false;
}

export function resolveDirectionCandidates(
  direction: string | null | undefined
): PolicyDirection[] | null {
  const normalized = normalizeSelectorDirection(direction);
  if (!normalized) {
    return null;
  }

  if (normalized === "inbound" || normalized === "request") {
    return ["inbound", "request"];
  }

  return [normalized];
}

export function normalizePartialSelectorContext(
  selectors: PolicySelectorInput | undefined,
  options: NormalizeSelectorTokenOptions = {}
): PolicySelectorContext | undefined {
  if (!selectors) {
    return undefined;
  }

  const normalized: PolicySelectorContext = {};
  const direction = normalizeSelectorDirection(selectors.direction);
  const resource = normalizeSelectorToken(selectors.resource, undefined, options);
  const action = normalizeSelectorToken(selectors.action, undefined, options);

  if (direction) {
    normalized.direction = direction;
  }

  if (resource) {
    normalized.resource = resource;
  }

  if (action) {
    normalized.action = action;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeSelectorContext(
  selectors: PolicySelectorInput | undefined,
  options: NormalizeSelectorContextOptions = {}
): ResolvedPolicySelectorContext {
  const direction = normalizeSelectorDirection(
    selectors?.direction,
    options.fallbackDirection ?? DEFAULT_SELECTOR_DIRECTION
  )!;
  const resource = normalizeSelectorToken(
    selectors?.resource,
    options.fallbackResource ?? DEFAULT_SELECTOR_RESOURCE,
    options
  )!;
  const action = normalizeSelectorToken(
    selectors?.action,
    options.resolveFallbackAction?.(direction) ??
      options.fallbackAction ??
      DEFAULT_SELECTOR_ACTION,
    options
  )!;

  return {
    action,
    direction,
    resource,
  };
}

export function candidateMatchesSelectorContext(
  candidate: SelectorFilterCandidate,
  selectors: PolicySelectorInput | undefined
): boolean {
  const directionCandidates = resolveDirectionCandidates(selectors?.direction);
  const resourceSelector = normalizeSelectorToken(selectors?.resource);
  const actionSelector = normalizeSelectorToken(selectors?.action);

  if (
    directionCandidates &&
    candidate.direction &&
    !directionCandidates.includes(candidate.direction as PolicyDirection)
  ) {
    return false;
  }

  if (
    resourceSelector &&
    candidate.resource !== null &&
    candidate.resource !== undefined &&
    candidate.resource !== resourceSelector
  ) {
    return false;
  }

  if (
    actionSelector &&
    candidate.action !== null &&
    candidate.action !== undefined &&
    candidate.action !== actionSelector
  ) {
    return false;
  }

  return true;
}

export function filterPolicyCandidatesBySelectors<T extends SelectorFilterCandidate>(
  candidates: ReadonlyArray<T>,
  selectors: PolicySelectorInput | undefined
): T[] {
  return candidates.filter((candidate) =>
    candidateMatchesSelectorContext(candidate, selectors)
  );
}
