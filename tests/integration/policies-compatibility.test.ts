import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createApp } from "../../src/server";
import * as schema from "../../src/db/schema";
import {
  cleanupTestDatabase,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";

let app: ReturnType<typeof createApp>;

describe("Policy Compatibility Integration", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("lists legacy policy rows in canonical response shape", async () => {
    const db = getTestDb();
    const { user, apiKey } = await createTestUser("legacy_policy_reader");

    await db.insert(schema.policies).values({
      id: nanoid(),
      userId: user.id,
      scope: "global",
      policyType: "llm",
      policyContent: "Legacy policy prompt",
      priority: 55,
      enabled: true,
      createdAt: new Date(),
    });

    const res = await app.request("/api/v1/policies", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].policy_content).toBe("Legacy policy prompt");
    expect(body[0].direction).toBe("outbound");
    expect(body[0].resource).toBe("message.general");
    expect(body[0].action).toBe("share");
    expect(body[0].effect).toBe("deny");
    expect(body[0].evaluator).toBe("llm");
    expect(body[0].source).toBe("legacy_migrated");
  });

  it("writes canonical policy payloads for canonical create requests", async () => {
    const db = getTestDb();
    const { apiKey } = await createTestUser("canonical_policy_writer");

    const createRes = await app.request("/api/v1/policies", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: "global",
        direction: "inbound",
        resource: "message.general",
        action: "request",
        effect: "ask",
        evaluator: "structured",
        policy_content: { blockedPatterns: ["secret"] },
        priority: 60,
      }),
    });

    expect(createRes.status).toBe(201);
    const { policy_id: policyId } = await createRes.json();
    expect(policyId).toBeDefined();

    const [stored] = await db
      .select()
      .from(schema.policies)
      .where(eq(schema.policies.id, policyId))
      .limit(1);

    expect(stored).toBeDefined();
    expect(stored.evaluator).toBe("structured");
    expect(stored.policyType).toBe("structured");
    expect(stored.direction).toBe("inbound");
    expect(stored.resource).toBe("message.general");
    expect(stored.action).toBe("request");
    expect(stored.effect).toBe("ask");

    const payload = JSON.parse(stored.policyContent);
    expect(payload.schema_version).toBe("canonical_policy_v1");
    expect(payload.evaluator).toBe("structured");
    expect(payload.effect).toBe("ask");
    expect(payload.policy_content).toEqual({ blockedPatterns: ["secret"] });
  });

  it("accepts legacy policy_type writes and stores canonical payloads", async () => {
    const db = getTestDb();
    const { apiKey } = await createTestUser("legacy_policy_writer");

    const createRes = await app.request("/api/v1/policies", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: "global",
        policy_type: "heuristic",
        policy_content: { blockedPatterns: ["password"] },
        priority: 77,
      }),
    });

    expect(createRes.status).toBe(201);
    const { policy_id: policyId } = await createRes.json();

    const [stored] = await db
      .select()
      .from(schema.policies)
      .where(eq(schema.policies.id, policyId))
      .limit(1);

    expect(stored).toBeDefined();
    expect(stored.evaluator).toBe("heuristic");
    expect(stored.policyType).toBe("heuristic");
    expect(stored.direction).toBe("outbound");
    expect(stored.resource).toBe("message.general");
    expect(stored.action).toBe("share");

    const payload = JSON.parse(stored.policyContent);
    expect(payload.schema_version).toBe("canonical_policy_v1");
    expect(payload.evaluator).toBe("heuristic");
    expect(payload.policy_content).toEqual({ blockedPatterns: ["password"] });
  });

  it("accepts legacy policy_type updates and rewrites canonical payload", async () => {
    const db = getTestDb();
    const { apiKey } = await createTestUser("legacy_policy_updater");

    const createRes = await app.request("/api/v1/policies", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: "global",
        evaluator: "structured",
        policy_content: { blockedPatterns: ["token"] },
      }),
    });
    expect(createRes.status).toBe(201);

    const { policy_id: policyId } = await createRes.json();

    const patchRes = await app.request(`/api/v1/policies/${policyId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        policy_type: "llm",
        policy_content: "Always ask before sharing this data",
      }),
    });

    expect(patchRes.status).toBe(200);

    const [stored] = await db
      .select()
      .from(schema.policies)
      .where(eq(schema.policies.id, policyId))
      .limit(1);

    expect(stored).toBeDefined();
    expect(stored.evaluator).toBe("llm");
    expect(stored.policyType).toBe("llm");

    const payload = JSON.parse(stored.policyContent);
    expect(payload.schema_version).toBe("canonical_policy_v1");
    expect(payload.evaluator).toBe("llm");
    expect(payload.policy_content).toBe("Always ask before sharing this data");
  });
});
