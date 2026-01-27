import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { generateApiKey, validateUsername } from "../services/auth";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/error";

export const authRoutes = new Hono<AppEnv>();

// Register a new user
const registerSchema = z.object({
  username: z.string().min(3).max(30),
  display_name: z.string().max(100).optional(),
});

authRoutes.post("/register", zValidator("json", registerSchema), async (c) => {
  const { username, display_name } = c.req.valid("json");

  // Validate username format
  const validation = validateUsername(username);
  if (!validation.valid) {
    throw new AppError(validation.error!, 400, "INVALID_USERNAME");
  }

  const db = getDb();

  // Check if username already exists (case-insensitive)
  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username.toLowerCase()))
    .limit(1);

  if (existing.length > 0) {
    throw new AppError("Username already taken", 409, "USERNAME_EXISTS");
  }

  // Generate API key
  const { apiKey, keyId, hash } = await generateApiKey();

  // Create user
  const userId = nanoid();
  await db.insert(schema.users).values({
    id: userId,
    username: username.toLowerCase(),
    displayName: display_name,
    apiKeyHash: hash,
    apiKeyId: keyId,
  });

  return c.json(
    {
      user_id: userId,
      username: username.toLowerCase(),
      api_key: apiKey, // Only shown once!
    },
    201
  );
});

// Rotate API key (requires authentication)
authRoutes.post("/rotate-key", requireAuth(), async (c) => {
  const user = c.get("user");
  if (!user) {
    throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
  }

  const db = getDb();

  // Generate new API key
  const { apiKey, keyId, hash } = await generateApiKey();

  // Update user's API key
  await db
    .update(schema.users)
    .set({
      apiKeyHash: hash,
      apiKeyId: keyId,
    })
    .where(eq(schema.users.id, user.id));

  return c.json({
    api_key: apiKey, // Only shown once!
  });
});

// Get current user info (requires authentication)
authRoutes.get("/me", requireAuth(), async (c) => {
  const user = c.get("user");
  if (!user) {
    throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
  }

  const db = getDb();
  const [fullUser] = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);

  return c.json({
    user_id: fullUser.id,
    username: fullUser.username,
    display_name: fullUser.displayName,
    created_at: fullUser.createdAt?.toISOString(),
  });
});
