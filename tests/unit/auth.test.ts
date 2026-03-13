import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  generateApiKey,
  generateInviteToken,
  parseApiKey,
  parseInviteToken,
  validateUsername,
  verifyApiKey,
  verifyInviteToken,
} from "../../src/services/auth";
import {
  cleanupTestDatabase,
  createTestInviteToken,
  createTestUser,
  setupTestDatabase,
} from "../helpers/setup";

describe("Auth Service", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(() => {
    cleanupTestDatabase();
  });

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
      expect(parseApiKey("mhl_onepart")).toBeNull();
      expect(parseApiKey("mhl_abc1234")).toBeNull();
      expect(parseApiKey("mhl_abcdefgh")).toBeNull();
      expect(parseApiKey("mhl_abcdefgh_")).toBeNull();
      expect(parseApiKey("mhl_abcdefghsecret")).toBeNull();
      expect(parseApiKey("")).toBeNull();
    });
  });

  describe("invite tokens", () => {
    it("should generate a token with correct format", async () => {
      const result = await generateInviteToken();

      expect(result.inviteToken).toMatch(
        /^mhinv_[a-zA-Z0-9_-]+_[a-zA-Z0-9_-]+$/,
      );
      expect(result.tokenId).toBeTruthy();
      expect(result.hash).toBeTruthy();
    });

    it("should parse a valid invite token", () => {
      const result = parseInviteToken(
        "mhinv_abc12345_secret123456789012345678",
      );

      expect(result).not.toBeNull();
      expect(result!.prefix).toBe("mhinv");
      expect(result!.tokenId).toBe("abc12345");
      expect(result!.secret).toBe("secret123456789012345678");
    });

    it("should reject invalid invite tokens", () => {
      expect(parseInviteToken("abc12345_secret")).toBeNull();
      expect(parseInviteToken("mhinv_short")).toBeNull();
      expect(parseInviteToken("")).toBeNull();
    });
  });

  describe("verifyApiKey", () => {
    it("should verify a valid API key", async () => {
      const { apiKey, user } = await createTestUser("verifyuser");
      const verified = await verifyApiKey(apiKey);

      expect(verified).not.toBeNull();
      expect(verified!.id).toBe(user.id);
    });

    it("should reject an invalid API key", async () => {
      const verified = await verifyApiKey("mhl_invalid_key_secret");
      expect(verified).toBeNull();
    });
  });

  describe("verifyInviteToken", () => {
    it("should verify a valid invite token", async () => {
      const { inviteToken, record } = await createTestInviteToken();
      const verified = await verifyInviteToken(inviteToken);

      expect(verified).not.toBeNull();
      expect(verified!.id).toBe(record.id);
    });

    it("should reject an invalid invite token", async () => {
      const verified = await verifyInviteToken("mhinv_invalid_token_secret");
      expect(verified).toBeNull();
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
