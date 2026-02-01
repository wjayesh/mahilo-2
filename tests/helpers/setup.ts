import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { createApp } from "../../src/server";
import { generateApiKey } from "../../src/services/auth";
import { resetDbForTests, setDbForTests } from "../../src/db";
import { nanoid } from "nanoid";

let testDb: ReturnType<typeof drizzle<typeof schema>>;
let testSqlite: Database;

export function getTestDb() {
  if (!testDb) {
    throw new Error("Test database not initialized. Call setupTestDatabase() first.");
  }
  return testDb;
}

export async function setupTestDatabase() {
  // Create in-memory database for tests
  testSqlite = new Database(":memory:");
  testSqlite.exec("PRAGMA foreign_keys = ON");

  testDb = drizzle(testSqlite, { schema });

  setDbForTests(testDb, testSqlite);

  // Create tables
  testSqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      api_key_hash TEXT NOT NULL,
      api_key_id TEXT NOT NULL,
      twitter_handle TEXT,
      twitter_verified INTEGER DEFAULT 0,
      verification_code TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_api_key_id ON users(api_key_id);
    CREATE INDEX IF NOT EXISTS idx_users_twitter ON users(twitter_handle);

    CREATE TABLE IF NOT EXISTS agent_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      framework TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      capabilities TEXT,
      public_key TEXT,
      public_key_alg TEXT,
      routing_priority INTEGER NOT NULL DEFAULT 0,
      callback_url TEXT NOT NULL,
      callback_secret TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_seen INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, framework, label)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_connections_user ON agent_connections(user_id);
    CREATE INDEX IF NOT EXISTS idx_agent_connections_status ON agent_connections(status);

    CREATE TABLE IF NOT EXISTS friendships (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(requester_id, addressee_id)
    );
    CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id);
    CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id);
    CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships(status);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      correlation_id TEXT,
      sender_user_id TEXT NOT NULL REFERENCES users(id),
      sender_agent TEXT NOT NULL,
      recipient_type TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      recipient_connection_id TEXT REFERENCES agent_connections(id),
      payload TEXT NOT NULL,
      payload_type TEXT NOT NULL DEFAULT 'text/plain',
      encryption TEXT,
      sender_signature TEXT,
      context TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      rejection_reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      delivered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_type, recipient_id);
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
    CREATE INDEX IF NOT EXISTS idx_messages_idempotency ON messages(idempotency_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency_sender ON messages(sender_user_id, idempotency_key);

    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      target_id TEXT,
      policy_type TEXT NOT NULL,
      policy_content TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_policies_user ON policies(user_id);
    CREATE INDEX IF NOT EXISTS idx_policies_scope ON policies(scope, target_id);

    CREATE TABLE IF NOT EXISTS user_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);

    CREATE TABLE IF NOT EXISTS friend_roles (
      friendship_id TEXT NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,
      role_name TEXT NOT NULL,
      assigned_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (friendship_id, role_name)
    );
    CREATE INDEX IF NOT EXISTS idx_friend_roles_role ON friend_roles(role_name);
  `);

  return testDb;
}

export function cleanupTestDatabase() {
  resetDbForTests();
}

export function createTestApp() {
  return createApp();
}

// Helper to create a test user and get their API key
export async function createTestUser(username: string, displayName?: string): Promise<{
  user: schema.User;
  apiKey: string;
}> {
  const db = getTestDb();
  const { apiKey, keyId, hash } = await generateApiKey();

  const user: schema.NewUser = {
    id: nanoid(),
    username: username.toLowerCase(),
    displayName: displayName || null,
    apiKeyHash: hash,
    apiKeyId: keyId,
    createdAt: new Date(),
  };

  await db.insert(schema.users).values(user);

  const [createdUser] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);

  return {
    user: createdUser,
    apiKey,
  };
}

// Helper to create a friendship between two users
export async function createFriendship(
  requesterId: string,
  addresseeId: string,
  status: "pending" | "accepted" | "blocked" = "accepted"
): Promise<schema.Friendship> {
  const db = getTestDb();

  const friendship: schema.NewFriendship = {
    id: nanoid(),
    requesterId,
    addresseeId,
    status,
    createdAt: new Date(),
  };

  await db.insert(schema.friendships).values(friendship);

  const [created] = await db
    .select()
    .from(schema.friendships)
    .where(eq(schema.friendships.id, friendship.id))
    .limit(1);

  return created;
}

// Helper to create an agent connection
export async function createAgentConnection(
  userId: string,
  options: Partial<{
    framework: string;
    label: string;
    callbackUrl: string;
    publicKey: string;
  }> = {}
): Promise<schema.AgentConnection> {
  const db = getTestDb();

  const connection: schema.NewAgentConnection = {
    id: nanoid(),
    userId,
    framework: options.framework || "clawdbot",
    label: options.label || "default",
    callbackUrl: options.callbackUrl || "https://example.com/callback",
    callbackSecret: nanoid(32),
    publicKey: options.publicKey || "test-public-key",
    publicKeyAlg: "ed25519",
    status: "active",
    createdAt: new Date(),
  };

  await db.insert(schema.agentConnections).values(connection);

  const [created] = await db
    .select()
    .from(schema.agentConnections)
    .where(eq(schema.agentConnections.id, connection.id))
    .limit(1);

  return created;
}

// Helper to seed system roles for tests
export async function seedTestSystemRoles(): Promise<void> {
  const db = getTestDb();

  const systemRoles = [
    { name: "close_friends", description: "Highest trust tier" },
    { name: "friends", description: "Standard friends" },
    { name: "acquaintances", description: "Casual contacts" },
    { name: "work_contacts", description: "Professional context" },
    { name: "family", description: "Family members" },
  ];

  for (const role of systemRoles) {
    await db.insert(schema.userRoles).values({
      id: `role_${nanoid(12)}`,
      userId: null,
      name: role.name,
      description: role.description,
      isSystem: true,
      createdAt: new Date(),
    });
  }
}

// Helper to add a role to a friendship
export async function addRoleToFriendship(
  friendshipId: string,
  roleName: string
): Promise<void> {
  const db = getTestDb();

  await db.insert(schema.friendRoles).values({
    friendshipId,
    roleName,
    assignedAt: new Date(),
  });
}
