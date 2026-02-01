/**
 * Integration tests for reply_policies in received messages
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../../src/server";
import {
  cleanupTestDatabase,
  createTestUser,
  createFriendship,
  setupTestDatabase,
  seedTestSystemRoles,
  getTestDb,
  addRoleToFriendship,
} from "../helpers/setup";
import * as schema from "../../src/db/schema";
import { nanoid } from "nanoid";

let app: ReturnType<typeof createApp>;

describe("Message Reply Policies Integration", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await seedTestSystemRoles();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  describe("GET /api/v1/messages with direction=received", () => {
    it("should include reply_policies for received messages", async () => {
      const db = getTestDb();
      const { user: alice, apiKey: aliceKey } = await createTestUser("alice_msg");
      const { user: bob, apiKey: bobKey } = await createTestUser("bob_msg");

      // Create friendship
      const friendship = await createFriendship(alice.id, bob.id, "accepted");

      // Alice creates a policy
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: alice.id,
        scope: "global",
        policyType: "llm",
        policyContent: "Never share exact addresses",
        priority: 90,
        enabled: true,
        createdAt: new Date(),
      });

      // Bob sends a message to Alice
      await db.insert(schema.messages).values({
        id: nanoid(),
        senderUserId: bob.id,
        senderAgent: "test-agent",
        recipientType: "user",
        recipientId: alice.id,
        payload: "Hey Alice, what's your address?",
        status: "delivered",
        createdAt: new Date(),
      });

      // Alice polls for received messages
      const res = await app.request("/api/v1/messages?direction=received", {
        method: "GET",
        headers: { Authorization: `Bearer ${aliceKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);

      // Check that reply_policies is included
      const message = data[0];
      expect(message.reply_policies).toBeDefined();
      expect(message.reply_policies.applicable_policies).toBeDefined();
      expect(Array.isArray(message.reply_policies.applicable_policies)).toBe(true);
      expect(message.reply_policies.summary).toBeDefined();
    });

    it("should include sender roles in reply_policies", async () => {
      const db = getTestDb();
      const { user: alice, apiKey: aliceKey } = await createTestUser("alice_roles");
      const { user: bob } = await createTestUser("bob_roles");

      // Create friendship and add role
      const friendship = await createFriendship(alice.id, bob.id, "accepted");
      await addRoleToFriendship(friendship.id, "close_friends");

      // Bob sends a message to Alice
      await db.insert(schema.messages).values({
        id: nanoid(),
        senderUserId: bob.id,
        senderAgent: "test-agent",
        recipientType: "user",
        recipientId: alice.id,
        payload: "Hey Alice!",
        status: "delivered",
        createdAt: new Date(),
      });

      // Alice polls for received messages
      const res = await app.request("/api/v1/messages?direction=received", {
        method: "GET",
        headers: { Authorization: `Bearer ${aliceKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      const message = data[0];

      expect(message.reply_policies.sender_roles).toBeDefined();
      expect(message.reply_policies.sender_roles).toContain("close_friends");
    });

    it("should include role-scoped policies when sender has role", async () => {
      const db = getTestDb();
      const { user: alice, apiKey: aliceKey } = await createTestUser("alice_role_pol");
      const { user: bob } = await createTestUser("bob_role_pol");

      // Create friendship and add role
      const friendship = await createFriendship(alice.id, bob.id, "accepted");
      await addRoleToFriendship(friendship.id, "close_friends");

      // Alice creates a role-scoped policy
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: alice.id,
        scope: "role",
        targetId: "close_friends",
        policyType: "llm",
        policyContent: "With close friends, calendar details are okay",
        priority: 70,
        enabled: true,
        createdAt: new Date(),
      });

      // Bob sends a message to Alice
      await db.insert(schema.messages).values({
        id: nanoid(),
        senderUserId: bob.id,
        senderAgent: "test-agent",
        recipientType: "user",
        recipientId: alice.id,
        payload: "When are you free?",
        status: "delivered",
        createdAt: new Date(),
      });

      // Alice polls for received messages
      const res = await app.request("/api/v1/messages?direction=received", {
        method: "GET",
        headers: { Authorization: `Bearer ${aliceKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      const message = data[0];

      // Should include the role-scoped policy
      const rolePolicy = message.reply_policies.applicable_policies.find(
        (p: any) => p.scope === "role" && p.target_id === "close_friends"
      );
      expect(rolePolicy).toBeDefined();
      expect(rolePolicy.policy_content).toContain("close friends");
    });

    it("should NOT include reply_policies for sent messages", async () => {
      const db = getTestDb();
      const { user: alice, apiKey: aliceKey } = await createTestUser("alice_sent");
      const { user: bob } = await createTestUser("bob_sent");

      // Create friendship
      await createFriendship(alice.id, bob.id, "accepted");

      // Alice sends a message to Bob
      await db.insert(schema.messages).values({
        id: nanoid(),
        senderUserId: alice.id,
        senderAgent: "test-agent",
        recipientType: "user",
        recipientId: bob.id,
        payload: "Hey Bob!",
        status: "delivered",
        createdAt: new Date(),
      });

      // Alice polls for sent messages
      const res = await app.request("/api/v1/messages?direction=sent", {
        method: "GET",
        headers: { Authorization: `Bearer ${aliceKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.length).toBeGreaterThan(0);

      // Sent messages should NOT have reply_policies
      const message = data[0];
      expect(message.reply_policies).toBeUndefined();
    });

    it("should generate summary in reply_policies", async () => {
      const db = getTestDb();
      const { user: alice, apiKey: aliceKey } = await createTestUser("alice_sum");
      const { user: bob } = await createTestUser("bob_sum");

      // Create friendship
      await createFriendship(alice.id, bob.id, "accepted");

      // Alice creates a heuristic policy with blocked patterns
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: alice.id,
        scope: "global",
        policyType: "heuristic",
        policyContent: JSON.stringify({
          blockedPatterns: ["\\b\\d{16}\\b", "password"],
        }),
        priority: 100,
        enabled: true,
        createdAt: new Date(),
      });

      // Bob sends a message to Alice
      await db.insert(schema.messages).values({
        id: nanoid(),
        senderUserId: bob.id,
        senderAgent: "test-agent",
        recipientType: "user",
        recipientId: alice.id,
        payload: "Hey!",
        status: "delivered",
        createdAt: new Date(),
      });

      // Alice polls for received messages
      const res = await app.request("/api/v1/messages?direction=received", {
        method: "GET",
        headers: { Authorization: `Bearer ${aliceKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      const message = data[0];

      // Summary should mention the restrictions
      expect(message.reply_policies.summary).toBeDefined();
      expect(message.reply_policies.summary.length).toBeGreaterThan(0);
    });
  });
});
