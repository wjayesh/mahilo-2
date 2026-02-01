import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../../src/server";
import {
  cleanupTestDatabase,
  createTestUser,
  createFriendship,
  setupTestDatabase,
  seedTestSystemRoles,
  getTestDb,
} from "../helpers/setup";
import * as schema from "../../src/db/schema";
import { nanoid } from "nanoid";

let app: ReturnType<typeof createApp>;

describe("Policy Context Integration", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await seedTestSystemRoles();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  describe("GET /api/v1/policies/context/:username", () => {
    it("should return 401 without authorization", async () => {
      const res = await app.request("/api/v1/policies/context/someone", {
        method: "GET",
      });

      expect(res.status).toBe(401);
    });

    it("should return 404 for non-existent user", async () => {
      const { apiKey } = await createTestUser("context_user1");

      const res = await app.request("/api/v1/policies/context/nonexistent", {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      expect(res.status).toBe(404);
    });

    it("should return 404 when not friends with user", async () => {
      const { apiKey } = await createTestUser("context_user2");
      await createTestUser("context_target2");
      // No friendship created

      const res = await app.request("/api/v1/policies/context/context_target2", {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      expect(res.status).toBe(404);
    });

    it("should return context for a friend", async () => {
      const { user: user1, apiKey } = await createTestUser("context_user3");
      const { user: user2 } = await createTestUser("context_target3");
      await createFriendship(user1.id, user2.id, "accepted");

      const res = await app.request("/api/v1/policies/context/context_target3", {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.recipient).toBeDefined();
      expect(data.recipient.username).toBe("context_target3");
      expect(data.recipient.relationship).toBe("friend");
      expect(data.recipient.roles).toEqual([]);
      expect(data.applicable_policies).toEqual([]);
    });

    it("should include roles in context", async () => {
      const db = getTestDb();
      const { user: user1, apiKey } = await createTestUser("context_user4");
      const { user: user2 } = await createTestUser("context_target4");
      const friendship = await createFriendship(user1.id, user2.id, "accepted");

      // Add a role to the friendship
      await db.insert(schema.friendRoles).values({
        friendshipId: friendship.id,
        roleName: "close_friends",
        assignedAt: new Date(),
      });

      const res = await app.request("/api/v1/policies/context/context_target4", {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.recipient.roles).toContain("close_friends");
    });

    it("should include applicable global policies", async () => {
      const db = getTestDb();
      const { user: user1, apiKey } = await createTestUser("context_user5");
      const { user: user2 } = await createTestUser("context_target5");
      await createFriendship(user1.id, user2.id, "accepted");

      // Create a global policy
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: user1.id,
        scope: "global",
        policyType: "llm",
        policyContent: "Never share exact addresses",
        priority: 90,
        enabled: true,
        createdAt: new Date(),
      });

      const res = await app.request("/api/v1/policies/context/context_target5", {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.applicable_policies.length).toBe(1);
      expect(data.applicable_policies[0].scope).toBe("global");
      expect(data.applicable_policies[0].policy_content).toBe("Never share exact addresses");
    });

    it("should include role-scoped policies when recipient has the role", async () => {
      const db = getTestDb();
      const { user: user1, apiKey } = await createTestUser("context_user6");
      const { user: user2 } = await createTestUser("context_target6");
      const friendship = await createFriendship(user1.id, user2.id, "accepted");

      // Assign role
      await db.insert(schema.friendRoles).values({
        friendshipId: friendship.id,
        roleName: "close_friends",
        assignedAt: new Date(),
      });

      // Create role-scoped policy
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: user1.id,
        scope: "role",
        targetId: "close_friends",
        policyType: "llm",
        policyContent: "Can share calendar event details",
        priority: 70,
        enabled: true,
        createdAt: new Date(),
      });

      const res = await app.request("/api/v1/policies/context/context_target6", {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.applicable_policies.some((p: { scope: string }) => p.scope === "role")).toBe(true);
      expect(data.applicable_policies.find((p: { scope: string }) => p.scope === "role").target_id).toBe("close_friends");
    });

    it("should NOT include role-scoped policies when recipient lacks the role", async () => {
      const db = getTestDb();
      const { user: user1, apiKey } = await createTestUser("context_user7");
      const { user: user2 } = await createTestUser("context_target7");
      await createFriendship(user1.id, user2.id, "accepted");
      // No role assigned

      // Create role-scoped policy for work_contacts
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: user1.id,
        scope: "role",
        targetId: "work_contacts",
        policyType: "llm",
        policyContent: "Keep messages professional",
        priority: 70,
        enabled: true,
        createdAt: new Date(),
      });

      const res = await app.request("/api/v1/policies/context/context_target7", {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      // Should NOT include the work_contacts policy
      expect(data.applicable_policies.some((p: { scope: string }) => p.scope === "role")).toBe(false);
    });

    it("should include user-specific policies", async () => {
      const db = getTestDb();
      const { user: user1, apiKey } = await createTestUser("context_user8");
      const { user: user2 } = await createTestUser("context_target8");
      await createFriendship(user1.id, user2.id, "accepted");

      // Create user-specific policy
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: user1.id,
        scope: "user",
        targetId: user2.id,
        policyType: "llm",
        policyContent: "Special rules for this friend",
        priority: 60,
        enabled: true,
        createdAt: new Date(),
      });

      const res = await app.request("/api/v1/policies/context/context_target8", {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.applicable_policies.some((p: { scope: string }) => p.scope === "user")).toBe(true);
    });

    it("should order policies by priority", async () => {
      const db = getTestDb();
      const { user: user1, apiKey } = await createTestUser("context_user9");
      const { user: user2 } = await createTestUser("context_target9");
      const friendship = await createFriendship(user1.id, user2.id, "accepted");

      await db.insert(schema.friendRoles).values({
        friendshipId: friendship.id,
        roleName: "friends",
        assignedAt: new Date(),
      });

      // Create policies with different priorities
      await db.insert(schema.policies).values([
        {
          id: nanoid(),
          userId: user1.id,
          scope: "global",
          policyType: "heuristic",
          policyContent: JSON.stringify({ maxLength: 1000 }),
          priority: 100,
          enabled: true,
          createdAt: new Date(),
        },
        {
          id: nanoid(),
          userId: user1.id,
          scope: "role",
          targetId: "friends",
          policyType: "llm",
          policyContent: "Role policy",
          priority: 50,
          enabled: true,
          createdAt: new Date(),
        },
        {
          id: nanoid(),
          userId: user1.id,
          scope: "user",
          targetId: user2.id,
          policyType: "llm",
          policyContent: "User policy",
          priority: 20,
          enabled: true,
          createdAt: new Date(),
        },
      ]);

      const res = await app.request("/api/v1/policies/context/context_target9", {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.applicable_policies.length).toBe(3);
      // Should be ordered by priority (highest first)
      expect(data.applicable_policies[0].priority).toBe(100);
      expect(data.applicable_policies[1].priority).toBe(50);
      expect(data.applicable_policies[2].priority).toBe(20);
    });

    it("should not include disabled policies", async () => {
      const db = getTestDb();
      const { user: user1, apiKey } = await createTestUser("context_user10");
      const { user: user2 } = await createTestUser("context_target10");
      await createFriendship(user1.id, user2.id, "accepted");

      // Create disabled policy
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: user1.id,
        scope: "global",
        policyType: "llm",
        policyContent: "Disabled policy",
        priority: 90,
        enabled: false,
        createdAt: new Date(),
      });

      const res = await app.request("/api/v1/policies/context/context_target10", {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.applicable_policies.length).toBe(0);
    });
  });

  describe("Full Flow: Register → Befriend → Assign Role → Create Policy → Get Context", () => {
    it("should complete the full policy context flow", async () => {
      const db = getTestDb();

      // Step 1: Create two users
      const { user: alice, apiKey: aliceKey } = await createTestUser("alice_flow");
      const { user: bob } = await createTestUser("bob_flow");

      // Step 2: Create friendship
      const friendship = await createFriendship(alice.id, bob.id, "accepted");

      // Step 3: Assign role via API
      const roleRes = await app.request(`/api/v1/friends/${friendship.id}/roles`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "close_friends" }),
      });
      expect(roleRes.status).toBe(200);

      // Step 4: Create policy via API
      const policyRes = await app.request("/api/v1/policies", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          scope: "role",
          target_id: "close_friends",
          policy_type: "llm",
          policy_content: "With close friends, share detailed calendar info",
          priority: 70,
        }),
      });
      expect(policyRes.status).toBe(201);

      // Step 5: Get context
      const contextRes = await app.request("/api/v1/policies/context/bob_flow", {
        method: "GET",
        headers: { Authorization: `Bearer ${aliceKey}` },
      });

      expect(contextRes.status).toBe(200);
      const context = await contextRes.json();

      // Verify context
      expect(context.recipient.username).toBe("bob_flow");
      expect(context.recipient.roles).toContain("close_friends");
      expect(context.applicable_policies.length).toBe(1);
      expect(context.applicable_policies[0].scope).toBe("role");
      expect(context.applicable_policies[0].target_id).toBe("close_friends");
    });
  });
});
