import { describe, it, expect } from "bun:test";
import { generateCallbackSignature } from "../../src/services/delivery";

describe("Delivery Service", () => {
  describe("generateCallbackSignature", () => {
    it("should generate a deterministic HMAC signature", () => {
      const body = JSON.stringify({ message: "Hello, World!" });
      const secret = "test-secret-key";
      const timestamp = 1706284800;

      const signature1 = generateCallbackSignature(body, secret, timestamp);
      const signature2 = generateCallbackSignature(body, secret, timestamp);

      expect(signature1).toBe(signature2);
    });

    it("should generate different signatures for different bodies", () => {
      const body1 = JSON.stringify({ message: "Hello" });
      const body2 = JSON.stringify({ message: "World" });
      const secret = "test-secret-key";
      const timestamp = 1706284800;

      const sig1 = generateCallbackSignature(body1, secret, timestamp);
      const sig2 = generateCallbackSignature(body2, secret, timestamp);

      expect(sig1).not.toBe(sig2);
    });

    it("should generate different signatures for different secrets", () => {
      const body = JSON.stringify({ message: "Hello" });
      const secret1 = "secret-1";
      const secret2 = "secret-2";
      const timestamp = 1706284800;

      const sig1 = generateCallbackSignature(body, secret1, timestamp);
      const sig2 = generateCallbackSignature(body, secret2, timestamp);

      expect(sig1).not.toBe(sig2);
    });

    it("should generate different signatures for different timestamps", () => {
      const body = JSON.stringify({ message: "Hello" });
      const secret = "test-secret-key";

      const sig1 = generateCallbackSignature(body, secret, 1706284800);
      const sig2 = generateCallbackSignature(body, secret, 1706284801);

      expect(sig1).not.toBe(sig2);
    });

    it("should produce a 64-character hex string", () => {
      const body = JSON.stringify({ message: "Hello" });
      const secret = "test-secret-key";
      const timestamp = 1706284800;

      const signature = generateCallbackSignature(body, secret, timestamp);

      // SHA256 produces 32 bytes = 64 hex characters
      expect(signature.length).toBe(64);
      expect(signature).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
