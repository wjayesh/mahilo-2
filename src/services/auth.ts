import { nanoid } from "nanoid";
import { hash, verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";

const API_KEY_PREFIX = "mhl";
const KEY_ID_LENGTH = 8;
const SECRET_LENGTH = 32;

// Generate a new API key with format: mhl_<key_id>_<secret>
export async function generateApiKey(): Promise<{ apiKey: string; keyId: string; hash: string }> {
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
export function parseApiKey(apiKey: string): { prefix: string; keyId: string; secret: string } | null {
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

// Verify an API key and return the user if valid
export async function verifyApiKey(apiKey: string): Promise<schema.User | null> {
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
export function validateUsername(username: string): { valid: boolean; error?: string } {
  if (!username || typeof username !== "string") {
    return { valid: false, error: "Username is required" };
  }

  if (username.length < 3 || username.length > 30) {
    return { valid: false, error: "Username must be between 3 and 30 characters" };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return { valid: false, error: "Username can only contain letters, numbers, underscores, and hyphens" };
  }

  return { valid: true };
}
