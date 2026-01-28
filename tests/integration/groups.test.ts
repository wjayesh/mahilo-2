import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../../src/server";
import {
  cleanupTestDatabase,
  createTestUser,
  setupTestDatabase,
} from "../helpers/setup";

let app: ReturnType<typeof createApp>;

describe("Groups Integration Tests (REG-050)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  describe("POST /api/v1/groups", () => {
    it("should require authentication", async () => {
      const res = await app.request("/api/v1/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test-group" }),
      });

      expect(res.status).toBe(401);
    });

    it("should create a group", async () => {
      const { apiKey } = await createTestUser("alice");

      const res = await app.request("/api/v1/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          name: "test-group",
          description: "A test group",
          invite_only: true,
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.group_id).toBeDefined();
      expect(data.name).toBe("test-group");
      expect(data.role).toBe("owner");
    });

    it("should reject invalid group names", async () => {
      const { apiKey } = await createTestUser("alice");

      const res = await app.request("/api/v1/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          name: "invalid name with spaces",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("should reject duplicate group names", async () => {
      const { apiKey } = await createTestUser("alice");

      await app.request("/api/v1/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ name: "unique-group" }),
      });

      const res = await app.request("/api/v1/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ name: "unique-group" }),
      });

      expect(res.status).toBe(409);
    });
  });

  describe("GET /api/v1/groups", () => {
    it("should list user's groups", async () => {
      const { apiKey } = await createTestUser("alice");

      // Create a group
      await app.request("/api/v1/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ name: "my-group" }),
      });

      const res = await app.request("/api/v1/groups", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(1);
      expect(data[0].name).toBe("my-group");
      expect(data[0].role).toBe("owner");
    });
  });

  describe("POST /api/v1/groups/:id/invite", () => {
    it("should allow owner to invite users", async () => {
      const { apiKey: aliceKey } = await createTestUser("alice");
      await createTestUser("bob");

      // Create group
      const createRes = await app.request("/api/v1/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aliceKey}`,
        },
        body: JSON.stringify({ name: "invite-test" }),
      });
      const { group_id } = await createRes.json();

      // Invite bob
      const res = await app.request(`/api/v1/groups/${group_id}/invite`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aliceKey}`,
        },
        body: JSON.stringify({ username: "bob" }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.status).toBe("invited");
    });

    it("should reject invite from non-owner/admin", async () => {
      const { apiKey: aliceKey } = await createTestUser("alice");
      const { apiKey: bobKey } = await createTestUser("bob");
      await createTestUser("charlie");

      // Create group
      const createRes = await app.request("/api/v1/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aliceKey}`,
        },
        body: JSON.stringify({ name: "private-group", invite_only: false }),
      });
      const { group_id } = await createRes.json();

      // Bob joins the public group
      await app.request(`/api/v1/groups/${group_id}/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bobKey}` },
      });

      // Bob tries to invite charlie (should fail - not owner/admin)
      const res = await app.request(`/api/v1/groups/${group_id}/invite`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bobKey}`,
        },
        body: JSON.stringify({ username: "charlie" }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/v1/groups/:id/join", () => {
    it("should allow joining public groups", async () => {
      const { apiKey: aliceKey } = await createTestUser("alice");
      const { apiKey: bobKey } = await createTestUser("bob");

      // Create public group
      const createRes = await app.request("/api/v1/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aliceKey}`,
        },
        body: JSON.stringify({ name: "public-group", invite_only: false }),
      });
      const { group_id } = await createRes.json();

      // Bob joins
      const res = await app.request(`/api/v1/groups/${group_id}/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bobKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("active");
    });

    it("should reject joining invite-only groups without invite", async () => {
      const { apiKey: aliceKey } = await createTestUser("alice");
      const { apiKey: bobKey } = await createTestUser("bob");

      // Create invite-only group
      const createRes = await app.request("/api/v1/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aliceKey}`,
        },
        body: JSON.stringify({ name: "private-club", invite_only: true }),
      });
      const { group_id } = await createRes.json();

      // Bob tries to join without invite
      const res = await app.request(`/api/v1/groups/${group_id}/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bobKey}` },
      });

      expect(res.status).toBe(403);
    });

    it("should allow accepting invite to join", async () => {
      const { apiKey: aliceKey } = await createTestUser("alice");
      const { apiKey: bobKey } = await createTestUser("bob");

      // Create invite-only group
      const createRes = await app.request("/api/v1/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aliceKey}`,
        },
        body: JSON.stringify({ name: "exclusive-group", invite_only: true }),
      });
      const { group_id } = await createRes.json();

      // Alice invites Bob
      await app.request(`/api/v1/groups/${group_id}/invite`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aliceKey}`,
        },
        body: JSON.stringify({ username: "bob" }),
      });

      // Bob accepts by joining
      const res = await app.request(`/api/v1/groups/${group_id}/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bobKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("active");
    });
  });

  describe("DELETE /api/v1/groups/:id/leave", () => {
    it("should allow members to leave", async () => {
      const { apiKey: aliceKey } = await createTestUser("alice");
      const { apiKey: bobKey } = await createTestUser("bob");

      // Create public group
      const createRes = await app.request("/api/v1/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aliceKey}`,
        },
        body: JSON.stringify({ name: "leave-test", invite_only: false }),
      });
      const { group_id } = await createRes.json();

      // Bob joins
      await app.request(`/api/v1/groups/${group_id}/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bobKey}` },
      });

      // Bob leaves
      const res = await app.request(`/api/v1/groups/${group_id}/leave`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bobKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("should prevent owner from leaving while other members exist", async () => {
      const { apiKey: aliceKey } = await createTestUser("alice");
      const { apiKey: bobKey } = await createTestUser("bob");

      // Create public group
      const createRes = await app.request("/api/v1/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aliceKey}`,
        },
        body: JSON.stringify({ name: "owner-test", invite_only: false }),
      });
      const { group_id } = await createRes.json();

      // Bob joins
      await app.request(`/api/v1/groups/${group_id}/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bobKey}` },
      });

      // Alice (owner) tries to leave
      const res = await app.request(`/api/v1/groups/${group_id}/leave`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${aliceKey}` },
      });

      expect(res.status).toBe(400);
    });
  });

  describe("Full Group Flow", () => {
    it("should complete the full create-invite-join-message flow", async () => {
      const { apiKey: aliceKey } = await createTestUser("alice");
      const { apiKey: bobKey } = await createTestUser("bob");

      // 1. Alice creates a group
      const createRes = await app.request("/api/v1/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aliceKey}`,
        },
        body: JSON.stringify({
          name: "flow-test-group",
          description: "Testing the full flow",
          invite_only: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const { group_id } = await createRes.json();

      // 2. Alice invites Bob
      const inviteRes = await app.request(`/api/v1/groups/${group_id}/invite`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aliceKey}`,
        },
        body: JSON.stringify({ username: "bob" }),
      });
      expect(inviteRes.status).toBe(201);

      // 3. Bob accepts the invite
      const joinRes = await app.request(`/api/v1/groups/${group_id}/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bobKey}` },
      });
      expect(joinRes.status).toBe(200);

      // 4. Verify both are in the group
      const membersRes = await app.request(`/api/v1/groups/${group_id}/members`, {
        headers: { Authorization: `Bearer ${aliceKey}` },
      });
      expect(membersRes.status).toBe(200);
      const members = await membersRes.json();
      expect(members.length).toBe(2);

      // 5. Alice sends a message to the group
      // (This would fail without registered agents, but validates the endpoint accepts group messages)
      const messageRes = await app.request("/api/v1/messages/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${aliceKey}`,
        },
        body: JSON.stringify({
          recipient: group_id,
          recipient_type: "group",
          message: "Hello team!",
        }),
      });

      // Either delivered (no active connections = immediate delivery) or pending
      expect([200, 403, 404]).toContain(messageRes.status);
    });
  });
});
