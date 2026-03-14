import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server";
import { schema } from "../../src/db";
import { config } from "../../src/config";
import {
  BROWSER_LOGIN_TOKEN_HEADER,
  BROWSER_SESSION_COOKIE_NAME,
  verifyBrowserSessionToken,
} from "../../src/services/browserAuth";
import {
  cleanupTestDatabase,
  createTestInviteToken,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";

let app: ReturnType<typeof createApp>;

function extractCookieValue(
  setCookieHeader: string,
  cookieName: string,
): string | null {
  const [cookiePair] = setCookieHeader.split(";");
  const prefix = `${cookieName}=`;

  if (!cookiePair.startsWith(prefix)) {
    return null;
  }

  return cookiePair.slice(prefix.length);
}

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
      const { inviteToken } = await createTestInviteToken();
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invite_token: inviteToken }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it("should reject registration with missing invite token", async () => {
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice" }),
      });

      expect(res.status).toBe(400);
    });

    it("should reject registration with invalid username format", async () => {
      const { inviteToken } = await createTestInviteToken();
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "ab", invite_token: inviteToken }), // Too short
      });

      expect(res.status).toBe(400);
    });

    it("should reject registration with username containing special characters", async () => {
      const { inviteToken } = await createTestInviteToken();
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "user@name",
          invite_token: inviteToken,
        }),
      });

      expect(res.status).toBe(400);
    });

    it("should reject registration with an invalid invite token", async () => {
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "alice",
          invite_token: "mhinv_invalid_token_secret",
        }),
      });

      expect(res.status).toBe(403);
    });

    it("should register a valid user", async () => {
      const { inviteToken } = await createTestInviteToken();
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", invite_token: inviteToken }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.api_key).toBeDefined();
      expect(data.username).toBe("alice");
      expect(data.verified).toBe(true);
    });

    it("should reject duplicate usernames", async () => {
      const firstInvite = await createTestInviteToken();
      await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "bob",
          invite_token: firstInvite.inviteToken,
        }),
      });

      const secondInvite = await createTestInviteToken();
      const res = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "bob",
          invite_token: secondInvite.inviteToken,
        }),
      });

      expect(res.status).toBe(409);
    });

    it("should reject reusing an invite token", async () => {
      const { inviteToken } = await createTestInviteToken();
      const first = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "bob", invite_token: inviteToken }),
      });
      expect(first.status).toBe(201);

      const second = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", invite_token: inviteToken }),
      });
      expect(second.status).toBe(403);
    });

    it("should rate limit repeated registration attempts from the same forwarded IP", async () => {
      const originalLimit = config.authRegisterRateLimitPerMinute;
      (config as any).authRegisterRateLimitPerMinute = 2;

      try {
        const headers = {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.10",
        };

        const first = await app.request("/api/v1/auth/register", {
          method: "POST",
          headers,
          body: JSON.stringify({
            username: "alice1",
            invite_token: "mhinv_invalid_token_secret",
          }),
        });
        expect(first.status).toBe(403);

        const second = await app.request("/api/v1/auth/register", {
          method: "POST",
          headers,
          body: JSON.stringify({
            username: "alice2",
            invite_token: "mhinv_invalid_token_secret",
          }),
        });
        expect(second.status).toBe(403);

        const third = await app.request("/api/v1/auth/register", {
          method: "POST",
          headers,
          body: JSON.stringify({
            username: "alice3",
            invite_token: "mhinv_invalid_token_secret",
          }),
        });
        expect(third.status).toBe(429);
      } finally {
        (config as any).authRegisterRateLimitPerMinute = originalLimit;
      }
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

    it("should return user info with a valid browser session cookie", async () => {
      const { user, apiKey } = await createTestUser("me_browser_user");

      const start = await app.request("/api/v1/auth/browser-login/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user.username }),
      });
      const started = await start.json();

      const approve = await app.request("/api/v1/auth/browser-login/approve", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attempt_id: started.attempt_id,
          approval_code: started.approval_code,
        }),
      });
      expect(approve.status).toBe(200);

      const redeem = await app.request(
        `/api/v1/auth/browser-login/attempts/${started.attempt_id}/redeem`,
        {
          method: "POST",
          headers: {
            [BROWSER_LOGIN_TOKEN_HEADER]: started.browser_token,
          },
        },
      );
      expect(redeem.status).toBe(200);

      const sessionToken = extractCookieValue(
        redeem.headers.get("set-cookie")!,
        BROWSER_SESSION_COOKIE_NAME,
      );

      const res = await app.request("/api/v1/auth/me", {
        headers: {
          Cookie: `${BROWSER_SESSION_COOKIE_NAME}=${sessionToken}`,
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.user_id).toBe(user.id);
      expect(data.username).toBe(user.username);
    });
  });

  describe("Browser login contract (DASH-071)", () => {
    it("starts, approves, polls, and redeems an agent-approved browser login exactly once", async () => {
      const { user, apiKey } = await createTestUser(
        "browser_login_user",
        "Browser Login User",
      );

      const start = await app.request("/api/v1/auth/browser-login/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user.username }),
      });

      expect(start.status).toBe(201);
      const started = await start.json();
      expect(started).toEqual(
        expect.objectContaining({
          attempt_id: expect.any(String),
          approval_code: expect.stringMatching(/^[A-Z2-9]{6}$/),
          browser_token: expect.any(String),
          expires_at: expect.any(String),
          status: "pending",
        }),
      );

      const pendingStatus = await app.request(
        `/api/v1/auth/browser-login/attempts/${started.attempt_id}`,
        {
          headers: {
            [BROWSER_LOGIN_TOKEN_HEADER]: started.browser_token,
          },
        },
      );

      expect(pendingStatus.status).toBe(200);
      expect(await pendingStatus.json()).toEqual(
        expect.objectContaining({
          attempt_id: started.attempt_id,
          status: "pending",
        }),
      );

      const approve = await app.request("/api/v1/auth/browser-login/approve", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attempt_id: started.attempt_id,
          approval_code: started.approval_code,
        }),
      });

      expect(approve.status).toBe(200);
      const approved = await approve.json();
      expect(approved).toEqual(
        expect.objectContaining({
          attempt_id: started.attempt_id,
          approval_code: started.approval_code,
          status: "approved",
        }),
      );
      expect(approved.approved_at).toBeTruthy();

      const approvedStatus = await app.request(
        `/api/v1/auth/browser-login/attempts/${started.attempt_id}`,
        {
          headers: {
            [BROWSER_LOGIN_TOKEN_HEADER]: started.browser_token,
          },
        },
      );

      expect(approvedStatus.status).toBe(200);
      expect(await approvedStatus.json()).toEqual(
        expect.objectContaining({
          attempt_id: started.attempt_id,
          status: "approved",
        }),
      );

      const redeem = await app.request(
        `/api/v1/auth/browser-login/attempts/${started.attempt_id}/redeem`,
        {
          method: "POST",
          headers: {
            [BROWSER_LOGIN_TOKEN_HEADER]: started.browser_token,
          },
        },
      );

      expect(redeem.status).toBe(200);
      const redeemed = await redeem.json();
      expect(redeemed).toEqual(
        expect.objectContaining({
          attempt_id: started.attempt_id,
          authenticated: true,
          status: "redeemed",
          user_id: user.id,
          username: user.username,
        }),
      );

      const setCookieHeader = redeem.headers.get("set-cookie");
      expect(setCookieHeader).toContain(`${BROWSER_SESSION_COOKIE_NAME}=`);
      expect(setCookieHeader).toContain("HttpOnly");
      expect(setCookieHeader).toContain("Secure");
      expect(setCookieHeader).toContain("SameSite=Lax");
      expect(setCookieHeader).toContain("Path=/");

      const sessionToken = extractCookieValue(
        setCookieHeader!,
        BROWSER_SESSION_COOKIE_NAME,
      );
      expect(sessionToken).toBeTruthy();

      const verifiedSession = await verifyBrowserSessionToken(sessionToken!);
      expect(verifiedSession?.user.id).toBe(user.id);

      const db = getTestDb();
      const sessions = await db.select().from(schema.browserSessions);
      expect(sessions).toHaveLength(1);

      const replay = await app.request(
        `/api/v1/auth/browser-login/attempts/${started.attempt_id}/redeem`,
        {
          method: "POST",
          headers: {
            [BROWSER_LOGIN_TOKEN_HEADER]: started.browser_token,
          },
        },
      );

      expect(replay.status).toBe(409);
      const replayed = await replay.json();
      expect(replayed.code).toBe("LOGIN_ATTEMPT_ALREADY_REDEEMED");
    });

    it("reports denied attempts over polling and blocks redeem cleanly", async () => {
      const { user, apiKey } = await createTestUser("browser_denied");

      const start = await app.request("/api/v1/auth/browser-login/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user.username }),
      });
      const started = await start.json();

      const deny = await app.request("/api/v1/auth/browser-login/deny", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attempt_id: started.attempt_id,
          approval_code: started.approval_code,
        }),
      });

      expect(deny.status).toBe(200);
      const denied = await deny.json();
      expect(denied).toEqual(
        expect.objectContaining({
          attempt_id: started.attempt_id,
          approval_code: started.approval_code,
          status: "denied",
        }),
      );
      expect(denied.denied_at).toBeTruthy();

      const status = await app.request(
        `/api/v1/auth/browser-login/attempts/${started.attempt_id}`,
        {
          headers: {
            [BROWSER_LOGIN_TOKEN_HEADER]: started.browser_token,
          },
        },
      );

      expect(status.status).toBe(200);
      expect(await status.json()).toEqual(
        expect.objectContaining({
          attempt_id: started.attempt_id,
          status: "denied",
        }),
      );

      const redeem = await app.request(
        `/api/v1/auth/browser-login/attempts/${started.attempt_id}/redeem`,
        {
          method: "POST",
          headers: {
            [BROWSER_LOGIN_TOKEN_HEADER]: started.browser_token,
          },
        },
      );

      expect(redeem.status).toBe(403);
      const redeemData = await redeem.json();
      expect(redeemData.code).toBe("LOGIN_ATTEMPT_DENIED");
    });

    it("rejects approval by an authenticated user who does not own the attempt", async () => {
      const { user: targetUser } = await createTestUser("browser_owner");
      const { apiKey: otherApiKey } = await createTestUser("browser_other");

      const start = await app.request("/api/v1/auth/browser-login/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: targetUser.username }),
      });

      const started = await start.json();
      const approve = await app.request("/api/v1/auth/browser-login/approve", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${otherApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attempt_id: started.attempt_id,
          approval_code: started.approval_code,
        }),
      });

      expect(approve.status).toBe(403);
      const data = await approve.json();
      expect(data.code).toBe("LOGIN_ATTEMPT_USER_MISMATCH");
    });

    it("reports expired attempts over status polling and blocks redeem cleanly", async () => {
      const { user, apiKey } = await createTestUser("browser_expired");

      const start = await app.request("/api/v1/auth/browser-login/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user.username }),
      });
      const started = await start.json();

      const approve = await app.request("/api/v1/auth/browser-login/approve", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attempt_id: started.attempt_id,
          approval_code: started.approval_code,
        }),
      });
      expect(approve.status).toBe(200);

      const db = getTestDb();
      await db
        .update(schema.browserLoginAttempts)
        .set({
          expiresAt: new Date(Date.now() - 1_000),
        })
        .where(eq(schema.browserLoginAttempts.id, started.attempt_id));

      const status = await app.request(
        `/api/v1/auth/browser-login/attempts/${started.attempt_id}`,
        {
          headers: {
            [BROWSER_LOGIN_TOKEN_HEADER]: started.browser_token,
          },
        },
      );

      expect(status.status).toBe(200);
      expect(await status.json()).toEqual(
        expect.objectContaining({
          attempt_id: started.attempt_id,
          status: "expired",
        }),
      );

      const redeem = await app.request(
        `/api/v1/auth/browser-login/attempts/${started.attempt_id}/redeem`,
        {
          method: "POST",
          headers: {
            [BROWSER_LOGIN_TOKEN_HEADER]: started.browser_token,
          },
        },
      );

      expect(redeem.status).toBe(410);
      const data = await redeem.json();
      expect(data.code).toBe("LOGIN_ATTEMPT_EXPIRED");
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
