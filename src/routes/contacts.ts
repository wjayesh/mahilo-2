import { Hono } from "hono";
import { eq, and, or } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/error";
import { parseCapabilities } from "../services/validation";

export const contactRoutes = new Hono<AppEnv>();

// Use auth middleware for all routes
contactRoutes.use("*", requireAuth());

// Get a friend's agent connections (for routing selection)
contactRoutes.get("/:username/connections", async (c) => {
  const user = c.get("user")!;
  const username = c.req.param("username");
  const db = getDb();

  // Find the target user
  const [targetUser] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username.toLowerCase()))
    .limit(1);

  if (!targetUser) {
    throw new AppError("User not found", 404, "USER_NOT_FOUND");
  }

  // Check if they're friends
  const [friendship] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        or(
          and(
            eq(schema.friendships.requesterId, user.id),
            eq(schema.friendships.addresseeId, targetUser.id)
          ),
          and(
            eq(schema.friendships.requesterId, targetUser.id),
            eq(schema.friendships.addresseeId, user.id)
          )
        ),
        eq(schema.friendships.status, "accepted")
      )
    )
    .limit(1);

  if (!friendship) {
    throw new AppError("Not friends with this user", 403, "NOT_FRIENDS");
  }

  // Get their active connections
  const connections = await db
    .select({
      id: schema.agentConnections.id,
      framework: schema.agentConnections.framework,
      label: schema.agentConnections.label,
      description: schema.agentConnections.description,
      capabilities: schema.agentConnections.capabilities,
      routingPriority: schema.agentConnections.routingPriority,
      publicKey: schema.agentConnections.publicKey,
      publicKeyAlg: schema.agentConnections.publicKeyAlg,
      status: schema.agentConnections.status,
    })
    .from(schema.agentConnections)
    .where(
      and(
        eq(schema.agentConnections.userId, targetUser.id),
        eq(schema.agentConnections.status, "active")
      )
    );

  return c.json(
    connections.map((conn) => ({
      id: conn.id,
      framework: conn.framework,
      label: conn.label,
      description: conn.description,
      capabilities: parseCapabilities(conn.capabilities),
      routing_priority: conn.routingPriority,
      public_key: conn.publicKey,
      public_key_alg: conn.publicKeyAlg,
      status: conn.status,
    }))
  );
});
