import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { evaluatePolicies, validatePolicyContent } from "../../src/services/policy";
import { cleanupTestDatabase, createTestUser, getTestDb, setupTestDatabase } from "../helpers/setup";
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
});
