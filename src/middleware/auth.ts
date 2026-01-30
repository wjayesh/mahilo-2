import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../server";
import { verifyApiKey } from "../services/auth";
import { config } from "../config";
import { getDb, schema } from "../db";

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const rateLimits = new Map<string, RateLimitEntry>();

function enforceRateLimit(userId: string) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = config.rateLimitPerMinute;

  const entry = rateLimits.get(userId);
  if (!entry || entry.resetAt <= now) {
    rateLimits.set(userId, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (entry.count >= limit) {
    throw new HTTPException(429, { message: "Rate limit exceeded" });
  }

  entry.count += 1;
  rateLimits.set(userId, entry);
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader) {
    throw new HTTPException(401, { message: "Missing Authorization header" });
  }

  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw new HTTPException(401, { message: "Invalid Authorization header format. Use: Bearer <api_key>" });
  }

  // Verify the API key
  const user = await verifyApiKey(token);

  if (!user) {
    throw new HTTPException(401, { message: "Invalid API key" });
  }

  // Enforce per-user rate limit (simple in-memory)
  enforceRateLimit(user.id);

  // Attach user to context
  c.set("user", {
    id: user.id,
    username: user.username,
  });

  await next();
});

export function requireAuth() {
  return authMiddleware;
}

// Middleware that requires Twitter verification
export const verifiedMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user) {
    throw new HTTPException(401, { message: "Authentication required" });
  }

  const db = getDb();
  const [fullUser] = await db
    .select({ twitterVerified: schema.users.twitterVerified })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);

  if (!fullUser?.twitterVerified) {
    throw new HTTPException(403, {
      message: "Twitter verification required. Verify your account at /api/v1/auth/verify/:userId"
    });
  }

  await next();
});

export function requireVerified() {
  return verifiedMiddleware;
}
