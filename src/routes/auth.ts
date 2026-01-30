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

// Generate a 6-character verification code
function generateVerificationCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No confusing chars like 0/O, 1/I
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

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

  // Generate API key and verification code
  const { apiKey, keyId, hash } = await generateApiKey();
  const verificationCode = generateVerificationCode();

  // Create user
  const userId = nanoid();
  await db.insert(schema.users).values({
    id: userId,
    username: username.toLowerCase(),
    displayName: display_name,
    apiKeyHash: hash,
    apiKeyId: keyId,
    verificationCode,
    twitterVerified: false,
  });

  // Build the verification tweet text
  const tweetText = `Verifying my Mahilo agent: ${username.toLowerCase()} 🤖\n\nCode: ${verificationCode}\n\n@mahaboreg`;

  return c.json(
    {
      user_id: userId,
      username: username.toLowerCase(),
      api_key: apiKey, // Only shown once!
      verification_code: verificationCode,
      verification_tweet: tweetText,
      claim_url: `/api/v1/auth/verify/${userId}`,
      verified: false,
    },
    201
  );
});

// Verify Twitter - submit tweet URL for verification
const verifySchema = z.object({
  twitter_handle: z.string().min(1).max(50),
  tweet_url: z.string().url().optional(), // Optional - for manual verification
});

authRoutes.post("/verify/:userId", zValidator("json", verifySchema), async (c) => {
  const userId = c.req.param("userId");
  const { twitter_handle, tweet_url } = c.req.valid("json");

  const db = getDb();

  // Get the user
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!user) {
    throw new AppError("User not found", 404, "USER_NOT_FOUND");
  }

  if (user.twitterVerified) {
    throw new AppError("Already verified", 400, "ALREADY_VERIFIED");
  }

  // Check if this Twitter handle is already claimed by another user
  const [existingTwitter] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.twitterHandle, twitter_handle.toLowerCase().replace("@", "")))
    .limit(1);

  if (existingTwitter && existingTwitter.id !== userId) {
    throw new AppError("Twitter handle already claimed by another user", 409, "TWITTER_CLAIMED");
  }

  // Update user with Twitter handle (verification happens via admin or automated check)
  // For MVP: we mark as verified when they submit - admin can revoke if fraudulent
  await db
    .update(schema.users)
    .set({
      twitterHandle: twitter_handle.toLowerCase().replace("@", ""),
      twitterVerified: true,
      verificationCode: null, // Clear the code
    })
    .where(eq(schema.users.id, userId));

  return c.json({
    verified: true,
    twitter_handle: twitter_handle.toLowerCase().replace("@", ""),
    message: "Twitter verification complete!",
  });
});

// Get verification status
authRoutes.get("/verify/:userId", async (c) => {
  const userId = c.req.param("userId");
  const db = getDb();

  const [user] = await db
    .select({
      username: schema.users.username,
      twitterHandle: schema.users.twitterHandle,
      twitterVerified: schema.users.twitterVerified,
      verificationCode: schema.users.verificationCode,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!user) {
    throw new AppError("User not found", 404, "USER_NOT_FOUND");
  }

  return c.json({
    username: user.username,
    twitter_handle: user.twitterHandle,
    verified: user.twitterVerified || false,
    verification_code: user.twitterVerified ? null : user.verificationCode,
  });
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
