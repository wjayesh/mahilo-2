import { describe, it, expect } from "bun:test";
import { validateCallbackUrl, validatePayloadSize } from "../../src/services/validation";

describe("Validation Service", () => {
  describe("validateCallbackUrl", () => {
    it("should accept HTTPS URLs", () => {
      expect(validateCallbackUrl("https://example.com/callback").valid).toBe(true);
      expect(validateCallbackUrl("https://api.example.com:8443/hook").valid).toBe(true);
    });

    it("should accept localhost in development", () => {
      // In development mode (default), localhost is allowed
      expect(validateCallbackUrl("http://localhost:3000/callback").valid).toBe(true);
      expect(validateCallbackUrl("http://127.0.0.1:3000/callback").valid).toBe(true);
    });

    it("should reject invalid URLs", () => {
      expect(validateCallbackUrl("not-a-url").valid).toBe(false);
      expect(validateCallbackUrl("").valid).toBe(false);
    });
  });

  describe("validatePayloadSize", () => {
    it("should accept payloads within size limit", () => {
      const smallPayload = "Hello, World!";
      expect(validatePayloadSize(smallPayload).valid).toBe(true);
    });

    it("should reject payloads exceeding size limit", () => {
      const largePayload = "x".repeat(100000); // 100KB
      const result = validatePayloadSize(largePayload);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds maximum size");
    });
  });
});
