import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { AppError } from "../middleware/error";

// Hardcoded admin token for demo purposes
const ADMIN_TOKEN = "ADMIN_TOKEN_ZJ";

export const adminRoutes = new Hono<AppEnv>();

// Middleware to check admin token
const requireAdmin = () => {
  return async (c: any, next: any) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError("Missing authorization header", 401, "UNAUTHORIZED");
    }
    
    const token = authHeader.slice(7);
    if (token !== ADMIN_TOKEN) {
      throw new AppError("Invalid admin token", 403, "FORBIDDEN");
    }
    
    await next();
  };
};

// Delete a user by username
const deleteUserSchema = z.object({
  username: z.string().min(1),
});

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
