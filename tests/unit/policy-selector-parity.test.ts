import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { filterPolicyCandidatesBySelectors } from "@mahilo/policy-core";
import { loadApplicablePolicies } from "../../src/services/policy";
import { canonicalToStorage } from "../../src/services/policySchema";
import * as schema from "../../src/db/schema";
import {
  cleanupTestDatabase,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";

describe("loadApplicablePolicies selector parity", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(() => {
    cleanupTestDatabase();
  });

  it("matches the shared selector filter for request aliases and wildcard selector rows", async () => {
    const db = getTestDb();
    const { user: sender } = await createTestUser("selector_parity_sender");
    const { user: recipient } = await createTestUser("selector_parity_recipient");
    const storage = canonicalToStorage({
      scope: "global",
      target_id: null,
      direction: "request",
      resource: "location.current",
      action: "share",
      effect: "ask",
      evaluator: "structured",
      policy_content: {},
      effective_from: null,
      expires_at: null,
      max_uses: null,
      remaining_uses: null,
      source: "user_created",
      derived_from_message_id: null,
      priority: 50,
      enabled: true,
    });
    const candidates = [
      {
        action: "request",
        direction: "inbound",
        id: "pol_inbound_alias",
        resource: "message.general",
      },
      {
        action: "request",
        direction: "request",
        id: "pol_request_exact",
        resource: "message.general",
      },
      {
        action: null,
        direction: "request",
        id: "pol_request_any_action",
        resource: "message.general",
      },
      {
        action: "request",
        direction: "request",
        id: "pol_request_any_resource",
        resource: null,
      },
      {
        action: "request",
        direction: null,
        id: "pol_any_direction",
        resource: "message.general",
      },
      {
        action: "request",
        direction: "outbound",
        id: "pol_outbound_request",
        resource: "message.general",
      },
    ] as const;

    await db.insert(schema.policies).values(
      candidates.map((candidate, index) => ({
        id: candidate.id,
        userId: sender.id,
        scope: "global",
        targetId: null,
        direction: candidate.direction,
        resource: candidate.resource,
        action: candidate.action,
        effect: "ask",
        evaluator: "structured",
        effectiveFrom: null,
        expiresAt: null,
        maxUses: null,
        remainingUses: null,
        source: "user_created",
        derivedFromMessageId: null,
        policyType: storage.policyType,
        policyContent: storage.policyContent,
        priority: 100 - index,
        enabled: true,
        createdAt: new Date(),
      }))
    );

    const selectors = {
      action: "request",
      direction: "request",
      resource: "message.general",
    };
    const serverMatches = await loadApplicablePolicies(
      sender.id,
      recipient.id,
      [],
      undefined,
      selectors
    );
    const sharedMatches = filterPolicyCandidatesBySelectors(candidates, selectors);

    expect(serverMatches.map((policy) => policy.id).sort()).toEqual(
      sharedMatches.map((policy) => policy.id).sort()
    );
    expect(serverMatches.map((policy) => policy.id).sort()).toEqual([
      "pol_any_direction",
      "pol_inbound_alias",
      "pol_request_any_action",
      "pol_request_any_resource",
      "pol_request_exact",
    ]);
  });
});
