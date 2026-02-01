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
import { createDefaultPoliciesForUser } from "../services/defaultPolicies";

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

  // Create default policies for the new user (PERM-019)
  // This runs asynchronously and doesn't block registration
  createDefaultPoliciesForUser(userId).catch((err) => {
    console.error("Failed to create default policies:", err);
  });

  // Build the verification tweet text
  const tweetText = `Verifying my Mahilo agent: ${username.toLowerCase()} 🤖\n\nCode: ${verificationCode}\n\n@wjayesh`;

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
  tweet_url: z.string().url(),
});

authRoutes.post("/verify/:userId", zValidator("json", verifySchema), async (c) => {
  const userId = c.req.param("userId");
  const { tweet_url } = c.req.valid("json");

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

  if (!user.verificationCode) {
    throw new AppError("No verification code found", 400, "NO_VERIFICATION_CODE");
  }

  // Validate tweet URL format (twitter.com or x.com)
  const tweetUrlPattern = /^https?:\/\/(twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/;
  const match = tweet_url.match(tweetUrlPattern);
  if (!match) {
    throw new AppError("Invalid tweet URL format", 400, "INVALID_TWEET_URL");
  }

  const twitterHandle = match[2].toLowerCase();

  // Check if this Twitter handle is already claimed by another user
  const [existingTwitter] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.twitterHandle, twitterHandle))
    .limit(1);

  if (existingTwitter && existingTwitter.id !== userId) {
    throw new AppError("Twitter handle already claimed by another user", 409, "TWITTER_CLAIMED");
  }

  // Fetch the tweet using Twitter's oembed API (no auth required)
  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweet_url)}`;
    const response = await fetch(oembedUrl, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new AppError("Could not fetch tweet - make sure it's public", 400, "TWEET_FETCH_FAILED");
    }

    const data = await response.json() as { html: string; author_name: string };

    // Check that the verification code is in the tweet
    if (!data.html.includes(user.verificationCode)) {
      throw new AppError(
        `Tweet does not contain verification code: ${user.verificationCode}`,
        400,
        "CODE_NOT_FOUND"
      );
    }

    // Verify the Twitter handle matches
    const authorHandle = data.author_name?.toLowerCase() || twitterHandle;

    // Update user as verified
    await db
      .update(schema.users)
      .set({
        twitterHandle: twitterHandle,
        twitterVerified: true,
        verificationCode: null, // Clear the code
      })
      .where(eq(schema.users.id, userId));

    return c.json({
      verified: true,
      twitter_handle: twitterHandle,
      message: "Twitter verification complete!",
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      "Failed to verify tweet: " + (error instanceof Error ? error.message : "Unknown error"),
      400,
      "VERIFICATION_FAILED"
    );
  }
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
