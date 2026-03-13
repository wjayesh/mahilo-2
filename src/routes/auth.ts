import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import {
  ACTIVE_USER_STATUS,
  consumeInviteToken,
  generateApiKey,
  validateUsername,
  verifyInviteToken,
} from "../services/auth";
import { AppError } from "../middleware/error";
import { createDefaultPoliciesForUser } from "../services/defaultPolicies";
import { enforceRegisterRateLimit, requireAuth } from "../middleware/auth";

export const authRoutes = new Hono<AppEnv>();

const registerSchema = z
  .object({
    username: z.string().min(3).max(30),
    display_name: z.string().max(100).optional(),
    invite_token: z.string().min(1).optional(),
    inviteToken: z.string().min(1).optional(),
  })
  .refine((data) => Boolean(data.invite_token || data.inviteToken), {
    message: "invite_token is required",
    path: ["invite_token"],
  });

authRoutes.post(
  "/register",
  async (c, next) => {
    enforceRegisterRateLimit(c);
    await next();
  },
  zValidator("json", registerSchema),
  async (c) => {
    const { username, display_name, invite_token, inviteToken } =
      c.req.valid("json");
    const normalizedUsername = username.toLowerCase();
    const inviteTokenValue = invite_token ?? inviteToken;

    const validation = validateUsername(username);
    if (!validation.valid) {
      throw new AppError(validation.error!, 400, "INVALID_USERNAME");
    }

    if (!inviteTokenValue) {
      throw new AppError(
        "Invite token is required",
        400,
        "INVITE_TOKEN_REQUIRED",
      );
    }

    const db = getDb();
    const userId = nanoid();
    let apiKey = "";

    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.username, normalizedUsername))
        .limit(1);

      if (existing.length > 0) {
        throw new AppError("Username already taken", 409, "USERNAME_EXISTS");
      }

      const inviteRecord = await verifyInviteToken(inviteTokenValue, tx);
      if (!inviteRecord) {
        throw new AppError(
          "Invalid or expired invite token",
          403,
          "INVALID_INVITE_TOKEN",
        );
      }

      const generatedKey = await generateApiKey();
      apiKey = generatedKey.apiKey;

      await tx.insert(schema.users).values({
        id: userId,
        username: normalizedUsername,
        displayName: display_name,
        apiKeyHash: generatedKey.hash,
        apiKeyId: generatedKey.keyId,
        status: ACTIVE_USER_STATUS,
        registrationSource: "invite",
        verifiedAt: new Date(),
      });

      const tokenConsumed = await consumeInviteToken(
        inviteRecord.id,
        userId,
        tx,
      );
      if (!tokenConsumed) {
        throw new AppError(
          "Invite token has already been used",
          409,
          "INVITE_TOKEN_EXHAUSTED",
        );
      }
    });

    createDefaultPoliciesForUser(userId).catch((err) => {
      console.error("Failed to create default policies:", err);
    });

    return c.json(
      {
        user_id: userId,
        username: normalizedUsername,
        api_key: apiKey,
        status: ACTIVE_USER_STATUS,
        verified: true,
      },
      201,
    );
  },
);

authRoutes.post("/rotate-key", requireAuth(), async (c) => {
  const user = c.get("user");
  if (!user) {
    throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
  }

  const db = getDb();
  const { apiKey, keyId, hash } = await generateApiKey();

  await db
    .update(schema.users)
    .set({
      apiKeyHash: hash,
      apiKeyId: keyId,
    })
    .where(eq(schema.users.id, user.id));

  return c.json({
    api_key: apiKey,
  });
});

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
      registrationSource: schema.users.registrationSource,
      status: schema.users.status,
      verifiedAt: schema.users.verifiedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);

  if (!fullUser) {
    throw new AppError("User not found", 404, "USER_NOT_FOUND");
  }

  return c.json({
    user_id: fullUser.id,
    username: fullUser.username,
    display_name: fullUser.displayName,
    created_at: fullUser.createdAt?.toISOString(),
    registration_source: fullUser.registrationSource,
    status: fullUser.status,
    verified: fullUser.status === ACTIVE_USER_STATUS,
    verified_at: fullUser.verifiedAt?.toISOString() ?? null,
  });
});
