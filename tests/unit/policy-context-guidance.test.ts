import { describe, expect, it } from "bun:test";

import { resolveContextPolicyGuidance } from "../../src/services/policy";
import type { CanonicalPolicy } from "../../src/services/policySchema";

function createPolicy(
  overrides: Partial<CanonicalPolicy> & Pick<CanonicalPolicy, "id">,
): CanonicalPolicy {
  return {
    id: overrides.id,
    scope: overrides.scope ?? "global",
    target_id: overrides.target_id ?? null,
    direction: overrides.direction ?? "outbound",
    resource: overrides.resource ?? "message.general",
    action: overrides.action ?? "share",
    effect: overrides.effect ?? "deny",
    evaluator: overrides.evaluator ?? "structured",
    policy_content: overrides.policy_content ?? {},
    effective_from: overrides.effective_from ?? null,
    expires_at: overrides.expires_at ?? null,
    max_uses: overrides.max_uses ?? null,
    remaining_uses: overrides.remaining_uses ?? null,
    source: overrides.source ?? "user_created",
    derived_from_message_id: overrides.derived_from_message_id ?? null,
    learning_provenance: overrides.learning_provenance ?? null,
    priority: overrides.priority ?? 1,
    enabled: overrides.enabled ?? true,
    created_at: overrides.created_at ?? null,
    updated_at: overrides.updated_at ?? null,
  };
}

describe("resolveContextPolicyGuidance", () => {
  it("returns allow when no applicable policies exist", () => {
    expect(resolveContextPolicyGuidance([])).toEqual({
      decision: "allow",
      reasonCode: "context.allow.no_applicable",
    });
  });

  it("reuses shared specificity and group-overlay resolution", () => {
    const result = resolveContextPolicyGuidance([
      createPolicy({
        id: "pol_global",
        scope: "global",
        effect: "allow",
      }),
      createPolicy({
        id: "pol_user",
        scope: "user",
        effect: "ask",
      }),
      createPolicy({
        id: "pol_group",
        scope: "group",
        effect: "deny",
      }),
    ]);

    expect(result).toEqual({
      decision: "deny",
      reasonCode: "context.deny.group.structured",
    });
  });
});
