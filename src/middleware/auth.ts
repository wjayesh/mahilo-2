import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../server";
import { verifyApiKey } from "../services/auth";

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
