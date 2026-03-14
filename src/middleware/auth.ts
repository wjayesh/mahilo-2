import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../server";
import { verifyApiKey } from "../services/auth";
import {
  BROWSER_SESSION_COOKIE_NAME,
  verifyBrowserSessionToken,
} from "../services/browserAuth";
import { config } from "../config";
import { ACTIVE_USER_STATUS, SUSPENDED_USER_STATUS } from "../services/auth";
import {
  consumeFixedWindowRateLimit,
  readClientRateLimitKey,
} from "../services/rateLimit";

const authenticatedRateLimits = new Map<
  string,
  {
    count: number;
    resetAt: number;
  }
>();
const registrationRateLimits = new Map<
  string,
  {
    count: number;
    resetAt: number;
  }
>();

function enforceRateLimit(
  rateLimits: Map<
    string,
    {
      count: number;
      resetAt: number;
    }
  >,
  key: string,
  limit: number,
) {
  const result = consumeFixedWindowRateLimit(rateLimits, key, limit);
  if (!result.allowed) {
    throw new HTTPException(429, { message: "Rate limit exceeded" });
  }
}

export function enforceAuthenticatedRateLimit(userId: string) {
  enforceRateLimit(
    authenticatedRateLimits,
    userId,
    config.rateLimitPerMinute,
  );
}

export function enforceRegisterRateLimit(c: {
  req: { header: (name: string) => string | undefined };
}) {
  const clientKey = readClientRateLimitKey(c);
  if (!clientKey) {
    return;
  }

  enforceRateLimit(
    registrationRateLimits,
    clientKey,
    config.authRegisterRateLimitPerMinute,
  );
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const browserSessionToken = getCookie(c, BROWSER_SESSION_COOKIE_NAME);

  if (authHeader) {
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      throw new HTTPException(401, {
        message: "Invalid Authorization header format. Use: Bearer <api_key>",
      });
    }

    // Verify the API key
    const user = await verifyApiKey(token);

    if (!user) {
      throw new HTTPException(401, { message: "Invalid API key" });
    }

    // Enforce per-user rate limit (simple in-memory)
    enforceAuthenticatedRateLimit(user.id);

    if (user.status === SUSPENDED_USER_STATUS) {
      throw new HTTPException(403, { message: "Account is suspended" });
    }

    // Attach user to context
    c.set("user", {
      id: user.id,
      status: user.status,
      username: user.username,
    });

    await next();
    return;
  }

  if (!browserSessionToken) {
    throw new HTTPException(401, { message: "Missing Authorization header" });
  }

  const session = await verifyBrowserSessionToken(browserSessionToken);

  if (!session) {
    throw new HTTPException(401, { message: "Invalid browser session" });
  }

  const user = session.user;

  // Enforce per-user rate limit (simple in-memory)
  enforceAuthenticatedRateLimit(user.id);

  if (user.status === SUSPENDED_USER_STATUS) {
    throw new HTTPException(403, { message: "Account is suspended" });
  }

  // Attach user to context
  c.set("user", {
    id: user.id,
    status: user.status,
    username: user.username,
  });

  await next();
});

export function requireAuth() {
  return authMiddleware;
}

// Middleware that requires an active Mahilo account.
export const activeMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user) {
    throw new HTTPException(401, { message: "Authentication required" });
  }

  if (user.status !== ACTIVE_USER_STATUS) {
    throw new HTTPException(403, {
      message: "Active invite-backed account required",
    });
  }

  await next();
});

export function requireActive() {
  return activeMiddleware;
}

export function requireVerified() {
  return activeMiddleware;
}
