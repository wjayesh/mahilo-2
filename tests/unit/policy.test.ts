import { describe, it, expect } from "bun:test";
import { validatePolicyContent } from "../../src/services/policy";

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
});
