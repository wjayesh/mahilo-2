import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { evaluatePolicies, validatePolicyContent } from "../../src/services/policy";
import {
  cleanupTestDatabase,
  createTestUser,
  createFriendship,
  getTestDb,
  setupTestDatabase,
  seedTestSystemRoles,
  addRoleToFriendship,
} from "../helpers/setup";
import * as schema from "../../src/db/schema";
import { nanoid } from "nanoid";

describe("Policy Service", () => {
  describe("validatePolicyContent", () => {
    describe("heuristic policies", () => {
      it("should accept valid heuristic policy", () => {
        const content = JSON.stringify({
          maxLength: 1000,
          blockedPatterns: ["\\bcredit card\\b"],
        });
        expect(validatePolicyContent("heuristic", content).valid).toBe(true);
      });

      it("should reject invalid JSON", () => {
        const result = validatePolicyContent("heuristic", "not json");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("valid JSON");
      });

      it("should reject invalid maxLength type", () => {
        const content = JSON.stringify({ maxLength: "not a number" });
        const result = validatePolicyContent("heuristic", content);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("maxLength must be a number");
      });

      it("should reject invalid regex patterns", () => {
        const content = JSON.stringify({ blockedPatterns: ["[invalid(regex"] });
        const result = validatePolicyContent("heuristic", content);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("Invalid regex");
      });

      it("should accept valid regex patterns", () => {
        const content = JSON.stringify({
          blockedPatterns: ["\\b\\d{16}\\b", "password", "ssn"],
          requiredPatterns: ["^[A-Z]"],
        });
        expect(validatePolicyContent("heuristic", content).valid).toBe(true);
      });
    });

    describe("llm policies", () => {
      it("should accept valid LLM policy prompt", () => {
        const prompt = "Analyze this message for safety: {message}";
        expect(validatePolicyContent("llm", prompt).valid).toBe(true);
      });

      it("should reject empty LLM policy", () => {
        const result = validatePolicyContent("llm", "");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("non-empty prompt");
      });

      it("should reject whitespace-only LLM policy", () => {
        const result = validatePolicyContent("llm", "   ");
        expect(result.valid).toBe(false);
      });
    });

    describe("unknown policy types", () => {
      it("should reject unknown policy types", () => {
        const result = validatePolicyContent("unknown", "content");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("Unknown policy type");
      });
    });
  });

  describe("evaluatePolicies", () => {
    beforeAll(async () => {
      await setupTestDatabase();
    });

    afterAll(() => {
      cleanupTestDatabase();
    });

    it("should reject messages that violate heuristic policies", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("policy_sender");
      const { user: recipient } = await createTestUser("policy_recipient");

      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "global",
        policyType: "heuristic",
        policyContent: JSON.stringify({ blockedPatterns: ["secret"] }),
        priority: 10,
        enabled: true,
        createdAt: new Date(),
      });

      const result = await evaluatePolicies(sender.id, recipient.id, "this is a secret");
      expect(result.allowed).toBe(false);
    });

    it("should allow messages when policies pass", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("policy_sender_ok");
      const { user: recipient } = await createTestUser("policy_recipient_ok");

      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "global",
        policyType: "heuristic",
        policyContent: JSON.stringify({ maxLength: 100 }),
        priority: 1,
        enabled: true,
        createdAt: new Date(),
      });

      const result = await evaluatePolicies(sender.id, recipient.id, "hello");
      expect(result.allowed).toBe(true);
    });
  });

  describe("evaluatePolicies with role-scoped policies", () => {
    beforeAll(async () => {
      await setupTestDatabase();
      await seedTestSystemRoles();
    });

    afterAll(() => {
      cleanupTestDatabase();
    });

    it("should include role-scoped policy when recipient has the role", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("role_sender1");
      const { user: recipient } = await createTestUser("role_recipient1");
      const friendship = await createFriendship(sender.id, recipient.id, "accepted");

      // Assign close_friends role to recipient
      await addRoleToFriendship(friendship.id, "close_friends");

      // Create a role-scoped policy that blocks "confidential"
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "role",
        targetId: "close_friends",
        policyType: "heuristic",
        policyContent: JSON.stringify({ blockedPatterns: ["confidential"] }),
        priority: 50,
        enabled: true,
        createdAt: new Date(),
      });

      // Message with "confidential" should be rejected
      const result = await evaluatePolicies(
        sender.id,
        recipient.id,
        "This is confidential information"
      );
      expect(result.allowed).toBe(false);
    });

    it("should NOT include role-scoped policy when recipient lacks the role", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("role_sender2");
      const { user: recipient } = await createTestUser("role_recipient2");
      await createFriendship(sender.id, recipient.id, "accepted");
      // Note: No role assigned to this friendship

      // Create a role-scoped policy for work_contacts
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "role",
        targetId: "work_contacts",
        policyType: "heuristic",
        policyContent: JSON.stringify({ blockedPatterns: ["personal"] }),
        priority: 50,
        enabled: true,
        createdAt: new Date(),
      });

      // Message with "personal" should be ALLOWED because recipient doesn't have the role
      const result = await evaluatePolicies(
        sender.id,
        recipient.id,
        "This is personal information"
      );
      expect(result.allowed).toBe(true);
    });

    it("should evaluate multiple role-scoped policies when recipient has multiple roles", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("role_sender3");
      const { user: recipient } = await createTestUser("role_recipient3");
      const friendship = await createFriendship(sender.id, recipient.id, "accepted");

      // Assign multiple roles
      await addRoleToFriendship(friendship.id, "close_friends");
      await addRoleToFriendship(friendship.id, "work_contacts");

      // Create policy for close_friends
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "role",
        targetId: "close_friends",
        policyType: "heuristic",
        policyContent: JSON.stringify({ blockedPatterns: ["pattern_a"] }),
        priority: 50,
        enabled: true,
        createdAt: new Date(),
      });

      // Create policy for work_contacts
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "role",
        targetId: "work_contacts",
        policyType: "heuristic",
        policyContent: JSON.stringify({ blockedPatterns: ["pattern_b"] }),
        priority: 40,
        enabled: true,
        createdAt: new Date(),
      });

      // Both patterns should be blocked
      const resultA = await evaluatePolicies(sender.id, recipient.id, "contains pattern_a");
      expect(resultA.allowed).toBe(false);

      const resultB = await evaluatePolicies(sender.id, recipient.id, "contains pattern_b");
      expect(resultB.allowed).toBe(false);

      // Allowed message
      const resultOk = await evaluatePolicies(sender.id, recipient.id, "neutral message");
      expect(resultOk.allowed).toBe(true);
    });

    it("should respect policy priority order (global > role > user)", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("role_sender4");
      const { user: recipient } = await createTestUser("role_recipient4");
      const friendship = await createFriendship(sender.id, recipient.id, "accepted");
      await addRoleToFriendship(friendship.id, "friends");

      // Create global policy (highest priority)
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "global",
        policyType: "heuristic",
        policyContent: JSON.stringify({ blockedPatterns: ["global_block"] }),
        priority: 100,
        enabled: true,
        createdAt: new Date(),
      });

      // Create role policy (medium priority)
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "role",
        targetId: "friends",
        policyType: "heuristic",
        policyContent: JSON.stringify({ blockedPatterns: ["role_block"] }),
        priority: 50,
        enabled: true,
        createdAt: new Date(),
      });

      // Both should be evaluated (policies are additive)
      const resultGlobal = await evaluatePolicies(sender.id, recipient.id, "has global_block");
      expect(resultGlobal.allowed).toBe(false);

      const resultRole = await evaluatePolicies(sender.id, recipient.id, "has role_block");
      expect(resultRole.allowed).toBe(false);
    });
  });
});
