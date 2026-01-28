import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../../src/server";
import {
  cleanupTestDatabase,
  createTestUser,
  setupTestDatabase,
} from "../helpers/setup";

let app: ReturnType<typeof createApp>;

describe("Auth Routes Integration", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  describe("POST /api/v1/auth/register", () => {
    it("should reject registration with missing username", async () => {
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it("should reject registration with invalid username format", async () => {
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "ab" }), // Too short
      });

      expect(res.status).toBe(400);
    });

    it("should reject registration with username containing special characters", async () => {
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "user@name" }),
      });

      expect(res.status).toBe(400);
    });

    it("should register a valid user", async () => {
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice" }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.api_key).toBeDefined();
      expect(data.username).toBe("alice");
    });

    it("should reject duplicate usernames", async () => {
      await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "bob" }),
      });

      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "bob" }),
      });

      expect(res.status).toBe(409);
    });
  });

  describe("POST /api/v1/auth/rotate-key", () => {
    it("should reject without authorization", async () => {
      const res = await app.request("/api/v1/auth/rotate-key", {
        method: "POST",
      });

      expect(res.status).toBe(401);
    });

    it("should reject with invalid API key", async () => {
      const res = await app.request("/api/v1/auth/rotate-key", {
        method: "POST",
        headers: { Authorization: "Bearer invalid-key" },
      });

      expect(res.status).toBe(401);
    });

    it("should rotate the API key for a valid user", async () => {
      const { apiKey } = await createTestUser("rotate_user");

      const res = await app.request("/api/v1/auth/rotate-key", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.api_key).toBeDefined();
      expect(data.api_key).not.toBe(apiKey);
    });
  });

  describe("GET /api/v1/auth/me", () => {
    it("should reject without authorization", async () => {
      const res = await app.request("/api/v1/auth/me");

      expect(res.status).toBe(401);
    });

    it("should return user info with a valid key", async () => {
      const { apiKey, user } = await createTestUser("me_user");

      const res = await app.request("/api/v1/auth/me", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.user_id).toBe(user.id);
      expect(data.username).toBe("me_user");
    });
  });
});

describe("Protected Routes - Auth Required", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("GET /api/v1/agents should require auth", async () => {
    const res = await app.request("/api/v1/agents");
    expect(res.status).toBe(401);
  });

  it("POST /api/v1/agents should require auth", async () => {
    const res = await app.request("/api/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ framework: "clawdbot" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/friends should require auth", async () => {
    const res = await app.request("/api/v1/friends");
    expect(res.status).toBe(401);
  });

  it("POST /api/v1/friends/request should require auth", async () => {
    const res = await app.request("/api/v1/friends/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/v1/messages/send should require auth", async () => {
    const res = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: "alice", message: "hello" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/policies should require auth", async () => {
    const res = await app.request("/api/v1/policies");
    expect(res.status).toBe(401);
  });
});

describe("General API Tests", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("should return health check", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe("healthy");
    expect(data.version).toBe("0.1.0");
  });

  it("should return 404 for unknown routes", async () => {
    const res = await app.request("/api/v1/unknown");
    expect(res.status).toBe(404);
  });
});
