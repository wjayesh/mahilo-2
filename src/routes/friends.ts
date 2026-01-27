import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, and, or, sql } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/error";

export const friendRoutes = new Hono<AppEnv>();

// Use auth middleware for all routes
friendRoutes.use("*", requireAuth());

// Send friend request
const requestSchema = z.object({
  username: z.string().min(1),
});

friendRoutes.post("/request", zValidator("json", requestSchema), async (c) => {
  const user = c.get("user")!;
  const { username } = c.req.valid("json");
  const db = getDb();

  // Find addressee by username
  const [addressee] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username.toLowerCase()))
    .limit(1);

  if (!addressee) {
    throw new AppError("User not found", 404, "USER_NOT_FOUND");
  }

  if (addressee.id === user.id) {
    throw new AppError("Cannot send friend request to yourself", 400, "INVALID_REQUEST");
  }

  // Check for existing friendship in either direction
  const [existing] = await db
    .select()
    .from(schema.friendships)
    .where(
      or(
        and(
          eq(schema.friendships.requesterId, user.id),
          eq(schema.friendships.addresseeId, addressee.id)
        ),
        and(
          eq(schema.friendships.requesterId, addressee.id),
          eq(schema.friendships.addresseeId, user.id)
        )
      )
    )
    .limit(1);

  if (existing) {
    if (existing.status === "blocked") {
      throw new AppError("Cannot send request to this user", 403, "BLOCKED");
    }
    if (existing.status === "accepted") {
      throw new AppError("Already friends with this user", 409, "ALREADY_FRIENDS");
    }
    if (existing.status === "pending") {
      // If they sent us a request, auto-accept
      if (existing.requesterId === addressee.id) {
        await db
          .update(schema.friendships)
          .set({ status: "accepted" })
          .where(eq(schema.friendships.id, existing.id));

        return c.json({
          friendship_id: existing.id,
          status: "accepted",
          message: "Friend request accepted (they had already requested)",
        });
      }
      throw new AppError("Friend request already pending", 409, "REQUEST_EXISTS");
    }
  }

  // Create new friend request
  const friendshipId = nanoid();
  await db.insert(schema.friendships).values({
    id: friendshipId,
    requesterId: user.id,
    addresseeId: addressee.id,
    status: "pending",
  });

  return c.json(
    {
      friendship_id: friendshipId,
      status: "pending",
    },
    201
  );
});

// Accept friend request
friendRoutes.post("/:id/accept", async (c) => {
  const user = c.get("user")!;
  const friendshipId = c.req.param("id");
  const db = getDb();

  // Find the friendship where current user is the addressee
  const [friendship] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.id, friendshipId),
        eq(schema.friendships.addresseeId, user.id),
        eq(schema.friendships.status, "pending")
      )
    )
    .limit(1);

  if (!friendship) {
    throw new AppError("Friend request not found or you cannot accept it", 404, "NOT_FOUND");
  }

  // Accept the request
  await db
    .update(schema.friendships)
    .set({ status: "accepted" })
    .where(eq(schema.friendships.id, friendshipId));

  return c.json({
    friendship_id: friendshipId,
    status: "accepted",
  });
});

// Reject friend request
friendRoutes.post("/:id/reject", async (c) => {
  const user = c.get("user")!;
  const friendshipId = c.req.param("id");
  const db = getDb();

  // Find the friendship where current user is the addressee
  const [friendship] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.id, friendshipId),
        eq(schema.friendships.addresseeId, user.id),
        eq(schema.friendships.status, "pending")
      )
    )
    .limit(1);

  if (!friendship) {
    throw new AppError("Friend request not found or you cannot reject it", 404, "NOT_FOUND");
  }

  // Delete the request
  await db.delete(schema.friendships).where(eq(schema.friendships.id, friendshipId));

  return c.json({ success: true });
});

// Block a user
friendRoutes.post("/:id/block", async (c) => {
  const user = c.get("user")!;
  const friendshipId = c.req.param("id");
  const db = getDb();

  // Find the friendship involving current user
  const [friendship] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.id, friendshipId),
        or(
          eq(schema.friendships.requesterId, user.id),
          eq(schema.friendships.addresseeId, user.id)
        )
      )
    )
    .limit(1);

  if (!friendship) {
    throw new AppError("Friendship not found", 404, "NOT_FOUND");
  }

  // Update to blocked status
  await db
    .update(schema.friendships)
    .set({ status: "blocked" })
    .where(eq(schema.friendships.id, friendshipId));

  return c.json({ success: true });
});

// List friends
friendRoutes.get("/", async (c) => {
  const user = c.get("user")!;
  const status = c.req.query("status") || "accepted";
  const db = getDb();

  // Get friendships where user is either requester or addressee
  const friendships = await db
    .select({
      id: schema.friendships.id,
      requesterId: schema.friendships.requesterId,
      addresseeId: schema.friendships.addresseeId,
      status: schema.friendships.status,
      createdAt: schema.friendships.createdAt,
    })
    .from(schema.friendships)
    .where(
      and(
        or(
          eq(schema.friendships.requesterId, user.id),
          eq(schema.friendships.addresseeId, user.id)
        ),
        eq(schema.friendships.status, status)
      )
    );

  // Get user details for the friends
  const friendIds = friendships.map((f) =>
    f.requesterId === user.id ? f.addresseeId : f.requesterId
  );

  if (friendIds.length === 0) {
    return c.json([]);
  }

  const users = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
    })
    .from(schema.users)
    .where(sql`${schema.users.id} IN ${friendIds}`);

  const usersMap = new Map(users.map((u) => [u.id, u]));

  return c.json(
    friendships.map((f) => {
      const friendId = f.requesterId === user.id ? f.addresseeId : f.requesterId;
      const friend = usersMap.get(friendId);
      return {
        id: f.id,
        username: friend?.username,
        display_name: friend?.displayName,
        status: f.status,
        direction: f.requesterId === user.id ? "sent" : "received",
        since: f.createdAt?.toISOString(),
      };
    })
  );
});

// Delete friendship (unfriend)
friendRoutes.delete("/:id", async (c) => {
  const user = c.get("user")!;
  const friendshipId = c.req.param("id");
  const db = getDb();

  // Find the friendship involving current user
  const [friendship] = await db
    .select()
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.id, friendshipId),
        or(
          eq(schema.friendships.requesterId, user.id),
          eq(schema.friendships.addresseeId, user.id)
        )
      )
    )
    .limit(1);

  if (!friendship) {
    throw new AppError("Friendship not found", 404, "NOT_FOUND");
  }

  // Delete the friendship
  await db.delete(schema.friendships).where(eq(schema.friendships.id, friendshipId));

  return c.json({ success: true });
});

// Get friend's agent connections (for routing selection)
friendRoutes.get("/contacts/:username/connections", async (c) => {
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
      capabilities: conn.capabilities ? JSON.parse(conn.capabilities) : [],
      routing_priority: conn.routingPriority,
      public_key: conn.publicKey,
      public_key_alg: conn.publicKeyAlg,
      status: conn.status,
    }))
  );
});
