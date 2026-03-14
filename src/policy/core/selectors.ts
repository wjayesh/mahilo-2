import type { PolicyDirection } from "./types";

export function normalizeSelectorToken(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveDirectionCandidates(
  direction: PolicyDirection | undefined
): PolicyDirection[] | null {
  if (!direction) {
    return null;
  }

  if (direction === "inbound" || direction === "request") {
    return ["inbound", "request"];
  }

  return [direction];
}
