import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { desc, eq } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { AppError } from "../middleware/error";
import { config } from "../config";
import {
  ACTIVE_USER_STATUS,
  generateApiKey,
  generateInviteToken,
} from "../services/auth";

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
});

adminRoutes.post(
  "/users",
  requireAdmin(),
  zValidator("json", createUserSchema),
  async (c) => {
    const { username, display_name } = c.req.valid("json");

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
      status: ACTIVE_USER_STATUS,
      registrationSource: "admin",
      verifiedAt: new Date(),
    });

    return c.json(
      {
        user_id: userId,
        username: username.toLowerCase(),
        api_key: apiKey, // Only shown once!
        status: ACTIVE_USER_STATUS,
        verified: true,
      },
      201,
    );
  },
);

const createInviteTokenSchema = z.object({
  expires_in_days: z.number().int().positive().max(365).optional(),
  max_uses: z.number().int().positive().max(100).optional().default(1),
  note: z.string().max(200).optional(),
});

adminRoutes.post(
  "/invite-tokens",
  requireAdmin(),
  zValidator("json", createInviteTokenSchema),
  async (c) => {
    const { expires_in_days, max_uses, note } = c.req.valid("json");
    const db = getDb();
    const { inviteToken, tokenId, hash } = await generateInviteToken();
    const expiresAt =
      typeof expires_in_days === "number"
        ? new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000)
        : null;

    await db.insert(schema.inviteTokens).values({
      id: nanoid(),
      createdBy: "admin",
      expiresAt,
      maxUses: max_uses,
      note,
      tokenHash: hash,
      tokenId,
    });

    return c.json(
      {
        expires_at: expiresAt?.toISOString() ?? null,
        invite_token: inviteToken,
        max_uses: max_uses,
        note: note ?? null,
        token_id: tokenId,
      },
      201,
    );
  },
);

adminRoutes.get("/invite-tokens", requireAdmin(), async (c) => {
  const db = getDb();
  const tokens = await db
    .select({
      createdAt: schema.inviteTokens.createdAt,
      expiresAt: schema.inviteTokens.expiresAt,
      lastUsedAt: schema.inviteTokens.lastUsedAt,
      maxUses: schema.inviteTokens.maxUses,
      note: schema.inviteTokens.note,
      redeemedByUserId: schema.inviteTokens.redeemedByUserId,
      revokedAt: schema.inviteTokens.revokedAt,
      tokenId: schema.inviteTokens.tokenId,
      useCount: schema.inviteTokens.useCount,
    })
    .from(schema.inviteTokens)
    .orderBy(desc(schema.inviteTokens.createdAt));

  return c.json({
    invite_tokens: tokens.map((token) => ({
      created_at: token.createdAt?.toISOString(),
      expires_at: token.expiresAt?.toISOString() ?? null,
      last_used_at: token.lastUsedAt?.toISOString() ?? null,
      max_uses: token.maxUses,
      note: token.note ?? null,
      redeemed_by_user_id: token.redeemedByUserId ?? null,
      revoked_at: token.revokedAt?.toISOString() ?? null,
      status: resolveInviteTokenStatus(token),
      token_id: token.tokenId,
      use_count: token.useCount,
    })),
    count: tokens.length,
  });
});

adminRoutes.post(
  "/invite-tokens/:tokenId/revoke",
  requireAdmin(),
  async (c) => {
    const tokenId = c.req.param("tokenId");
    const db = getDb();

    const [token] = await db
      .select({
        id: schema.inviteTokens.id,
        revokedAt: schema.inviteTokens.revokedAt,
      })
      .from(schema.inviteTokens)
      .where(eq(schema.inviteTokens.tokenId, tokenId))
      .limit(1);

    if (!token) {
      throw new AppError(
        "Invite token not found",
        404,
        "INVITE_TOKEN_NOT_FOUND",
      );
    }

    if (!token.revokedAt) {
      await db
        .update(schema.inviteTokens)
        .set({ revokedAt: new Date() })
        .where(eq(schema.inviteTokens.id, token.id));
    }

    return c.json({
      revoked: true,
      token_id: tokenId,
    });
  },
);

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
  await db.delete(schema.users).where(eq(schema.users.id, user.id));

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
    users: users.map((u) => ({
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

function resolveInviteTokenStatus(token: {
  expiresAt: Date | null;
  maxUses: number;
  revokedAt: Date | null;
  useCount: number;
}) {
  if (token.revokedAt) {
    return "revoked";
  }

  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
    return "expired";
  }

  if (token.useCount >= token.maxUses) {
    return "exhausted";
  }

  return "active";
}
