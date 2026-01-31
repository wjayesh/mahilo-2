import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { AppError } from "../middleware/error";
import { config } from "../config";
import { generateApiKey } from "../services/auth";

export const adminRoutes = new Hono<AppEnv>();

// Middleware to check admin token (read from environment variable)
const requireAdmin = () => {
  return async (c: any, next: any) => {
    // Admin endpoints are disabled if ADMIN_API_KEY is not set
    if (!config.adminApiKey) {
      throw new AppError("Admin endpoints are disabled", 503, "ADMIN_DISABLED");
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError("Missing authorization header", 401, "UNAUTHORIZED");
    }

    const token = authHeader.slice(7);
    if (token !== config.adminApiKey) {
      throw new AppError("Invalid admin token", 403, "FORBIDDEN");
    }

    await next();
  };
};

// Create a user (pre-verified, for testing)
const createUserSchema = z.object({
  username: z.string().min(3).max(30),
  display_name: z.string().max(100).optional(),
  twitter_handle: z.string().max(50).optional(),
});

adminRoutes.post("/users", requireAdmin(), zValidator("json", createUserSchema), async (c) => {
  const { username, display_name, twitter_handle } = c.req.valid("json");

  const db = getDb();

  // Check if username already exists
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

  // Create user (pre-verified)
  const userId = nanoid();
  await db.insert(schema.users).values({
    id: userId,
    username: username.toLowerCase(),
    displayName: display_name,
    apiKeyHash: hash,
    apiKeyId: keyId,
    twitterHandle: twitter_handle?.toLowerCase(),
    twitterVerified: true, // Pre-verified for admin-created users
    verificationCode: null,
  });

  return c.json({
    user_id: userId,
    username: username.toLowerCase(),
    api_key: apiKey, // Only shown once!
    verified: true,
  }, 201);
});

// Delete a user by username
adminRoutes.delete("/users/:username", requireAdmin(), async (c) => {
  const username = c.req.param("username").toLowerCase();
  
  const db = getDb();
  
  // Find the user
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);
  
  if (!user) {
    throw new AppError("User not found", 404, "USER_NOT_FOUND");
  }
  
  // Delete messages where user is sender (not cascaded)
  await db
    .delete(schema.messages)
    .where(eq(schema.messages.senderUserId, user.id));
  
  // Delete message deliveries where user is recipient (not cascaded)
  await db
    .delete(schema.messageDeliveries)
    .where(eq(schema.messageDeliveries.recipientUserId, user.id));
  
  // Delete the user (cascades to: agentConnections, friendships, policies, groups, groupMemberships, userPreferences)
  await db
    .delete(schema.users)
    .where(eq(schema.users.id, user.id));
  
  return c.json({
    success: true,
    message: `User '${username}' and all related data deleted`,
    deleted_user_id: user.id,
  });
});

// List all users (for debugging)
adminRoutes.get("/users", requireAdmin(), async (c) => {
  const db = getDb();
  
  const users = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users);
  
  return c.json({
    users: users.map(u => ({
      user_id: u.id,
      username: u.username,
      display_name: u.displayName,
      created_at: u.createdAt?.toISOString(),
    })),
    count: users.length,
  });
});

// Reset API key for a user (generates new key, returns it)
adminRoutes.post("/users/:username/reset-key", requireAdmin(), async (c) => {
  const username = c.req.param("username").toLowerCase();

  const db = getDb();

  // Find the user
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);

  if (!user) {
    throw new AppError("User not found", 404, "USER_NOT_FOUND");
  }

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
    user_id: user.id,
    username: user.username,
    api_key: apiKey, // New key - only shown once!
    message: "API key has been reset. The old key is now invalid.",
  });
});

// Delete all users (nuclear option for demo reset)
adminRoutes.delete("/users", requireAdmin(), async (c) => {
  const db = getDb();
  
  // Get count before deletion
  const users = await db.select({ id: schema.users.id }).from(schema.users);
  const count = users.length;
  
  // Delete all messages first (not cascaded)
  await db.delete(schema.messages);
  await db.delete(schema.messageDeliveries);
  
  // Delete all users (cascades everything else)
  await db.delete(schema.users);
  
  return c.json({
    success: true,
    message: `All ${count} users and related data deleted`,
    deleted_count: count,
  });
});
