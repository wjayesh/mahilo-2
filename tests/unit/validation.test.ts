import { describe, it, expect } from "bun:test";
import {
  normalizeCapabilities,
  parseCapabilities,
  validateCallbackUrl,
  validatePayloadSize,
} from "../../src/services/validation";

describe("Validation Service", () => {
  describe("validateCallbackUrl", () => {
    it("should accept HTTPS URLs", async () => {
      expect((await validateCallbackUrl("https://example.com/callback")).valid).toBe(true);
      expect((await validateCallbackUrl("https://api.example.com:8443/hook")).valid).toBe(true);
    });

    it("should accept localhost in development", async () => {
      // In development mode (default), localhost is allowed
      expect((await validateCallbackUrl("http://localhost:3000/callback")).valid).toBe(true);
      expect((await validateCallbackUrl("http://127.0.0.1:3000/callback")).valid).toBe(true);
    });

    it("should reject private IPs in hosted mode", async () => {
      const result = await validateCallbackUrl("https://10.0.0.1/callback");
      expect(result.valid).toBe(false);
    });

    it("should reject invalid URLs", async () => {
      expect((await validateCallbackUrl("not-a-url")).valid).toBe(false);
      expect((await validateCallbackUrl("")).valid).toBe(false);
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

  describe("capabilities helpers", () => {
    it("should normalize array capabilities", () => {
      const result = normalizeCapabilities(["a", "b"]);
      expect(result.valid).toBe(true);
      expect(JSON.parse(result.value)).toEqual(["a", "b"]);
    });

    it("should normalize JSON string capabilities", () => {
      const result = normalizeCapabilities("[\"a\",\"b\"]");
      expect(result.valid).toBe(true);
      expect(JSON.parse(result.value)).toEqual(["a", "b"]);
    });

    it("should reject non-array capability strings", () => {
      const result = normalizeCapabilities("not-json");
      expect(result.valid).toBe(false);
    });

    it("should parse stored capability strings", () => {
      expect(parseCapabilities("[\"x\",\"y\"]")).toEqual(["x", "y"]);
      expect(parseCapabilities("invalid")).toEqual([]);
    });
  });
});
