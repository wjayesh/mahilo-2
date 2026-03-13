import { nanoid } from "nanoid";
import { hash, verify } from "@node-rs/argon2";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "../db";

const API_KEY_PREFIX = "mhl";
const KEY_ID_LENGTH = 8;
const SECRET_LENGTH = 32;
const INVITE_TOKEN_PREFIX = "mhinv";
const INVITE_TOKEN_ID_LENGTH = 8;
const INVITE_TOKEN_SECRET_LENGTH = 24;

export const ACTIVE_USER_STATUS = "active";
export const PENDING_USER_STATUS = "pending";
export const SUSPENDED_USER_STATUS = "suspended";

// Generate a new API key with format: mhl_<key_id>_<secret>
export async function generateApiKey(): Promise<{
  apiKey: string;
  keyId: string;
  hash: string;
}> {
  const keyId = nanoid(KEY_ID_LENGTH);
  const secret = nanoid(SECRET_LENGTH);
  const apiKey = `${API_KEY_PREFIX}_${keyId}_${secret}`;

  // Hash the full API key for storage
  const keyHash = await hash(apiKey, {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  return {
    apiKey,
    keyId,
    hash: keyHash,
  };
}

// Parse an API key to extract the key ID
export function parseApiKey(
  apiKey: string,
): { prefix: string; keyId: string; secret: string } | null {
  const prefix = `${API_KEY_PREFIX}_`;
  if (!apiKey.startsWith(prefix)) {
    return null;
  }

  const rest = apiKey.slice(prefix.length);
  if (rest.length <= KEY_ID_LENGTH + 1) {
    return null;
  }

  const keyId = rest.slice(0, KEY_ID_LENGTH);
  if (rest[KEY_ID_LENGTH] !== "_") {
    return null;
  }

  const secret = rest.slice(KEY_ID_LENGTH + 1);
  if (!secret) {
    return null;
  }

  return {
    prefix: API_KEY_PREFIX,
    keyId,
    secret,
  };
}

// Generate a one-time invite token with format: mhinv_<token_id>_<secret>
export async function generateInviteToken(): Promise<{
  inviteToken: string;
  tokenId: string;
  hash: string;
}> {
  const tokenId = nanoid(INVITE_TOKEN_ID_LENGTH);
  const secret = nanoid(INVITE_TOKEN_SECRET_LENGTH);
  const inviteToken = `${INVITE_TOKEN_PREFIX}_${tokenId}_${secret}`;
  const tokenHash = await hash(inviteToken, {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  return {
    inviteToken,
    tokenId,
    hash: tokenHash,
  };
}

export function parseInviteToken(
  inviteToken: string,
): { prefix: string; tokenId: string; secret: string } | null {
  const prefix = `${INVITE_TOKEN_PREFIX}_`;
  if (!inviteToken.startsWith(prefix)) {
    return null;
  }

  const rest = inviteToken.slice(prefix.length);
  if (rest.length <= INVITE_TOKEN_ID_LENGTH + 1) {
    return null;
  }

  const tokenId = rest.slice(0, INVITE_TOKEN_ID_LENGTH);
  if (rest[INVITE_TOKEN_ID_LENGTH] !== "_") {
    return null;
  }

  const secret = rest.slice(INVITE_TOKEN_ID_LENGTH + 1);
  if (!secret) {
    return null;
  }

  return {
    prefix: INVITE_TOKEN_PREFIX,
    tokenId,
    secret,
  };
}

export async function verifyInviteToken(
  inviteToken: string,
  db: any = getDb(),
): Promise<schema.InviteToken | null> {
  const parsed = parseInviteToken(inviteToken);
  if (!parsed) {
    return null;
  }

  const [tokenRecord] = await db
    .select()
    .from(schema.inviteTokens)
    .where(eq(schema.inviteTokens.tokenId, parsed.tokenId))
    .limit(1);

  if (!tokenRecord || tokenRecord.revokedAt) {
    return null;
  }

  if (tokenRecord.expiresAt && tokenRecord.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  if (tokenRecord.useCount >= tokenRecord.maxUses) {
    return null;
  }

  const isValid = await verify(tokenRecord.tokenHash, inviteToken);
  if (!isValid) {
    return null;
  }

  return tokenRecord;
}

export async function consumeInviteToken(
  inviteTokenId: string,
  userId: string,
  db: any = getDb(),
): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(schema.inviteTokens)
    .set({
      lastUsedAt: now,
      redeemedByUserId: userId,
      useCount: sql`${schema.inviteTokens.useCount} + 1`,
    })
    .where(
      and(
        eq(schema.inviteTokens.id, inviteTokenId),
        isNull(schema.inviteTokens.revokedAt),
        or(
          isNull(schema.inviteTokens.expiresAt),
          gt(schema.inviteTokens.expiresAt, now),
        ),
        sql`${schema.inviteTokens.useCount} < ${schema.inviteTokens.maxUses}`,
      ),
    )
    .returning({ id: schema.inviteTokens.id });

  return updated.length > 0;
}

// Verify an API key and return the user if valid
export async function verifyApiKey(
  apiKey: string,
): Promise<schema.User | null> {
  const parsed = parseApiKey(apiKey);
  if (!parsed) {
    return null;
  }

  const db = getDb();

  // Find user by key ID (indexed lookup)
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.apiKeyId, parsed.keyId))
    .limit(1);

  if (!user || user.deletedAt) {
    return null;
  }

  // Verify the full key hash
  const isValid = await verify(user.apiKeyHash, apiKey);
  if (!isValid) {
    return null;
  }

  return user;
}

// Generate a callback secret for agent connections
export function generateCallbackSecret(): string {
  return nanoid(32);
}

// Validate username format
export function validateUsername(username: string): {
  valid: boolean;
  error?: string;
} {
  if (!username || typeof username !== "string") {
    return { valid: false, error: "Username is required" };
  }

  if (username.length < 3 || username.length > 30) {
    return {
      valid: false,
      error: "Username must be between 3 and 30 characters",
    };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return {
      valid: false,
      error:
        "Username can only contain letters, numbers, underscores, and hyphens",
    };
  }

  return { valid: true };
}
