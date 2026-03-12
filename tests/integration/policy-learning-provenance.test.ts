import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server";
import {
  cleanupTestDatabase,
  createAgentConnection,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";
import * as schema from "../../src/db/schema";

let app: ReturnType<typeof createApp>;

describe("Policy learning provenance (SRV-060)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("links policies to source interaction/message and exposes override-to-promotion audit history", async () => {
    const db = getTestDb();
    const { user: owner, apiKey: ownerKey } = await createTestUser(
      "policy_provenance_owner",
    );
    const { user: recipient } = await createTestUser(
      "policy_provenance_recipient",
    );

    await db
      .update(schema.users)
      .set({ status: "active", verifiedAt: new Date() })
      .where(eq(schema.users.id, owner.id));

    const ownerConnection = await createAgentConnection(owner.id, {
      callbackUrl: "polling://policy-provenance-owner",
      framework: "openclaw",
      label: "owner",
    });

    const sourceMessageId = "msg_policy_provenance_source";
    await db.insert(schema.messages).values({
      id: sourceMessageId,
      senderUserId: owner.id,
      senderConnectionId: ownerConnection.id,
      senderAgent: "openclaw",
      recipientType: "user",
      recipientId: recipient.id,
      payload: "Source interaction for policy provenance linkage.",
      status: "delivered",
    });

    const overrideResponse = await app.request("/api/v1/plugin/overrides", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender_connection_id: ownerConnection.id,
        source_resolution_id: "res_policy_override_1",
        kind: "one_time",
        scope: "user",
        target_id: recipient.id,
        selectors: {
          direction: "outbound",
          resource: "location.current",
          action: "share",
        },
        effect: "allow",
        reason: "One-time override before promotion.",
        derived_from_message_id: sourceMessageId,
      }),
    });

    expect(overrideResponse.status).toBe(201);
    const overrideBody = await overrideResponse.json();
    const overridePolicyId = overrideBody.policy_id as string;
    expect(typeof overridePolicyId).toBe("string");

    const promotedResponse = await app.request("/api/v1/policies", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: "user",
        target_id: recipient.id,
        direction: "outbound",
        resource: "location.current",
        action: "share",
        effect: "allow",
        evaluator: "structured",
        policy_content: {
          note: "Promoted durable rule from repeated override behavior.",
        },
        source: "user_confirmed",
        derived_from_message_id: sourceMessageId,
        learning_provenance: {
          source_interaction_id: "res_policy_promote_1",
          promoted_from_policy_ids: [overridePolicyId],
        },
        priority: 60,
      }),
    });

    expect(promotedResponse.status).toBe(201);
    const promotedBody = await promotedResponse.json();
    const promotedPolicyId = promotedBody.policy_id as string;
    expect(typeof promotedPolicyId).toBe("string");

    const listResponse = await app.request("/api/v1/policies", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ownerKey}`,
      },
    });
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as Array<
      Record<string, unknown>
    >;
    const promotedPolicy = listBody.find(
      (entry) => entry.id === promotedPolicyId,
    );
    expect(promotedPolicy).toBeDefined();
    expect(promotedPolicy?.derived_from_message_id).toBe(sourceMessageId);
    expect(promotedPolicy?.learning_provenance).toEqual(
      expect.objectContaining({
        source_interaction_id: "res_policy_promote_1",
        promoted_from_policy_ids: [overridePolicyId],
      }),
    );

    const auditResponse = await app.request(
      `/api/v1/policies/audit/provenance/${promotedPolicyId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${ownerKey}`,
        },
      },
    );
    expect(auditResponse.status).toBe(200);
    const auditBody = await auditResponse.json();

    expect(auditBody.policy).toEqual(
      expect.objectContaining({
        policy_id: promotedPolicyId,
        source: "user_confirmed",
        derived_from_message_id: sourceMessageId,
        source_interaction_id: "res_policy_promote_1",
      }),
    );
    expect(auditBody.source_message).toEqual(
      expect.objectContaining({
        id: sourceMessageId,
      }),
    );
    expect(auditBody.lineage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          policy_id: overridePolicyId,
          source: "override",
        }),
      ]),
    );
    expect(auditBody.override_to_promoted_history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_policy_id: overridePolicyId,
          from_source: "override",
          to_policy_id: promotedPolicyId,
          to_source: "user_confirmed",
          source_interaction_id: "res_policy_promote_1",
        }),
      ]),
    );
  });

  it("rejects promoted_from_policy_ids that do not belong to the policy owner", async () => {
    const { apiKey } = await createTestUser("policy_provenance_invalid");

    const response = await app.request("/api/v1/policies", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: "global",
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "ask",
        evaluator: "structured",
        policy_content: {},
        learning_provenance: {
          source_interaction_id: "res_invalid_promote",
          promoted_from_policy_ids: ["pol_missing_override"],
        },
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("INVALID_POLICY");
  });
});
