import { describe, it, expect } from "bun:test";
import { generateApiKey, parseApiKey, validateUsername } from "../../src/services/auth";

describe("Auth Service", () => {
  describe("generateApiKey", () => {
    it("should generate a key with correct format", async () => {
      const result = await generateApiKey();

      expect(result.apiKey).toMatch(/^mhl_[a-zA-Z0-9_-]+_[a-zA-Z0-9_-]+$/);
      expect(result.keyId).toBeTruthy();
      expect(result.hash).toBeTruthy();
    });

    it("should generate unique keys", async () => {
      const key1 = await generateApiKey();
      const key2 = await generateApiKey();

      expect(key1.apiKey).not.toBe(key2.apiKey);
      expect(key1.keyId).not.toBe(key2.keyId);
    });
  });

  describe("parseApiKey", () => {
    it("should parse a valid API key", () => {
      const result = parseApiKey("mhl_abc12345_secret123456789012345678901234");

      expect(result).not.toBeNull();
      expect(result!.prefix).toBe("mhl");
      expect(result!.keyId).toBe("abc12345");
      expect(result!.secret).toBe("secret123456789012345678901234");
    });

    it("should return null for invalid prefix", () => {
      const result = parseApiKey("xyz_abc12345_secret");

      expect(result).toBeNull();
    });

    it("should return null for malformed key", () => {
      expect(parseApiKey("mhl_only_two_parts_here_extra")).toBeNull();
      expect(parseApiKey("mhl_onepart")).toBeNull();
      expect(parseApiKey("")).toBeNull();
    });
  });

  describe("validateUsername", () => {
    it("should accept valid usernames", () => {
      expect(validateUsername("alice").valid).toBe(true);
      expect(validateUsername("bob123").valid).toBe(true);
      expect(validateUsername("user_name").valid).toBe(true);
      expect(validateUsername("user-name").valid).toBe(true);
      expect(validateUsername("ABC").valid).toBe(true);
    });

    it("should reject too short usernames", () => {
      const result = validateUsername("ab");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("3 and 30");
    });

    it("should reject too long usernames", () => {
      const result = validateUsername("a".repeat(31));
      expect(result.valid).toBe(false);
      expect(result.error).toContain("3 and 30");
    });

    it("should reject usernames with invalid characters", () => {
      expect(validateUsername("user@name").valid).toBe(false);
      expect(validateUsername("user.name").valid).toBe(false);
      expect(validateUsername("user name").valid).toBe(false);
      expect(validateUsername("user!name").valid).toBe(false);
    });
  });
});
