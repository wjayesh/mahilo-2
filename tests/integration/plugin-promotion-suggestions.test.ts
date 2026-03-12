import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createApp } from "../../src/server";
import { canonicalToStorage } from "../../src/services/policySchema";
import {
  cleanupTestDatabase,
  createAgentConnection,
  createFriendship,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";
import * as schema from "../../src/db/schema";

let app: ReturnType<typeof createApp>;

describe("Plugin promotion suggestions endpoint (SRV-061)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("requires authentication and active accounts", async () => {
    const db = getTestDb();
    const { apiKey, user } = await createTestUser(
      "promotion_suggestions_unverified",
    );
    await db
      .update(schema.users)
      .set({ status: "pending", verifiedAt: null })
      .where(eq(schema.users.id, user.id));

    const unauthenticated = await app.request(
      "/api/v1/plugin/suggestions/promotions",
      {
        method: "GET",
      },
    );
    expect(unauthenticated.status).toBe(401);

    const unverified = await app.request(
      "/api/v1/plugin/suggestions/promotions",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );
    expect(unverified.status).toBe(403);
  });

  it("detects repeated temporary override patterns and suggests durable policy promotion", async () => {
    const db = getTestDb();
    const { owner, ownerKey, ownerConnection, recipient } =
      await setupParticipants("promotion_suggestions_detect");

    const repeatedPolicyIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await app.request("/api/v1/plugin/overrides", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender_connection_id: ownerConnection.id,
          source_resolution_id: `res_promote_repeat_${index}`,
          kind: "one_time",
          scope: "user",
          target_id: recipient.id,
          selectors: {
            direction: "outbound",
            resource: "location.current",
            action: "share",
          },
          effect: "allow",
          reason:
            "User repeatedly approved one-time city-level location sharing.",
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      repeatedPolicyIds.push(body.policy_id as string);
    }

    const persistentResponse = await app.request("/api/v1/plugin/overrides", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: ownerConnection.id,
        source_resolution_id: "res_promote_persistent",
        kind: "persistent",
        scope: "user",
        target_id: recipient.id,
        selectors: {
          direction: "outbound",
          resource: "location.current",
          action: "share",
        },
        effect: "allow",
        reason: "Persistent override should not count as temporary repetition.",
      }),
    });
    expect(persistentResponse.status).toBe(201);
    const persistentBody = await persistentResponse.json();
    const persistentPolicyId = persistentBody.policy_id as string;

    const oldStorage = canonicalToStorage({
      scope: "user",
      target_id: recipient.id,
      direction: "outbound",
      resource: "location.current",
      action: "share",
      effect: "allow",
      evaluator: "structured",
      policy_content: {
        _mahilo_override: {
          kind: "one_time",
          reason: "Out-of-window one-time override should not be counted",
          source_resolution_id: "res_promote_old_window",
        },
      },
      effective_from: null,
      expires_at: null,
      max_uses: 1,
      remaining_uses: 0,
      source: "override",
      derived_from_message_id: null,
      learning_provenance: {
        source_interaction_id: "res_promote_old_window",
        promoted_from_policy_ids: [],
      },
      priority: 90,
      enabled: true,
    });

    await db.insert(schema.policies).values({
      id: nanoid(),
      userId: owner.id,
      scope: "user",
      targetId: recipient.id,
      direction: oldStorage.direction,
      resource: oldStorage.resource,
      action: oldStorage.action,
      effect: oldStorage.effect,
      evaluator: oldStorage.evaluator,
      effectiveFrom: oldStorage.effectiveFrom,
      expiresAt: oldStorage.expiresAt,
      maxUses: oldStorage.maxUses,
      remainingUses: oldStorage.remainingUses,
      source: oldStorage.source,
      derivedFromMessageId: oldStorage.derivedFromMessageId,
      policyType: oldStorage.policyType,
      policyContent: oldStorage.policyContent,
      priority: 90,
      enabled: true,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    });

    const response = await app.request(
      "/api/v1/plugin/suggestions/promotions?min_repetitions=3&lookback_days=60",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${ownerKey}`,
        },
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.contract_version).toBe("1.0.0");
    expect(body.learning).toEqual(
      expect.objectContaining({
        min_repetitions: 3,
        lookback_days: 60,
      }),
    );
    expect(Array.isArray(body.promotion_suggestions)).toBe(true);
    expect(body.promotion_suggestions).toHaveLength(1);

    const suggestion = body.promotion_suggestions[0];
    expect(suggestion.selectors).toEqual({
      direction: "outbound",
      resource: "location.current",
      action: "share",
    });
    expect(suggestion.repeated_override_pattern).toEqual(
      expect.objectContaining({
        count: 3,
      }),
    );
    expect(suggestion.repeated_override_pattern.override_policy_ids).toEqual(
      expect.arrayContaining(repeatedPolicyIds),
    );
    expect(
      suggestion.repeated_override_pattern.override_policy_ids,
    ).not.toContain(persistentPolicyId);
    expect(suggestion.suggested_policy).toEqual(
      expect.objectContaining({
        scope: "user",
        target_id: recipient.id,
        direction: "outbound",
        resource: "location.current",
        action: "share",
        effect: "allow",
        evaluator: "structured",
        source: "user_confirmed",
      }),
    );
    expect(
      suggestion.suggested_policy.learning_provenance.promoted_from_policy_ids,
    ).toEqual(expect.arrayContaining(repeatedPolicyIds));
  });

  it("validates numeric query parameters", async () => {
    const db = getTestDb();
    const { user, apiKey } = await createTestUser(
      "promotion_suggestions_query",
    );
    await db
      .update(schema.users)
      .set({ status: "active", verifiedAt: new Date() })
      .where(eq(schema.users.id, user.id));

    const response = await app.request(
      "/api/v1/plugin/suggestions/promotions?min_repetitions=1",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("INVALID_QUERY");
  });
});

async function setupParticipants(suffix: string) {
  const db = getTestDb();
  const { user: owner, apiKey: ownerKey } = await createTestUser(
    `promotion_owner_${suffix}`,
  );
  const { user: recipient } = await createTestUser(
    `promotion_recipient_${suffix}`,
  );

  await db
    .update(schema.users)
    .set({ status: "active", verifiedAt: new Date() })
    .where(eq(schema.users.id, owner.id));
  await db
    .update(schema.users)
    .set({ status: "active", verifiedAt: new Date() })
    .where(eq(schema.users.id, recipient.id));

  await createFriendship(owner.id, recipient.id, "accepted");

  const ownerConnection = await createAgentConnection(owner.id, {
    callbackUrl: `polling://promotion_owner_${suffix}`,
    framework: "openclaw",
    label: `owner_${suffix}`,
  });

  return {
    owner,
    ownerKey,
    ownerConnection,
    recipient,
  };
}
