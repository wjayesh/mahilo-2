import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { inArray } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { nanoid } from "nanoid";

import { ACTIVE_USER_STATUS, generateApiKey } from "../../../src/services/auth";
import {
  canonicalToStorage,
  type CanonicalPolicy,
} from "../../../src/services/policySchema";
import * as schema from "../../../src/db/schema";

interface CliArgs {
  baseUrl: string;
  dbPath: string;
  gatewayPort: number;
  receiverPort: number;
  runtimeStatePath: string;
  summaryPath: string;
}

interface SeededUser {
  apiKey: string;
  callbackUrl: string;
  connectionId: string;
  connectionLabel: string;
  connectionSecret: string;
  displayName: string;
  id: string;
  username: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:18080";
const DEFAULT_GATEWAY_PORT = 19123;
const DEFAULT_RECEIVER_PORT = 19124;
const DEFAULT_GROUP_NAME = "hiking-crew";

async function main() {
  const args = parseArgs(Bun.argv.slice(2));

  const sqlite = new Database(args.dbPath);
  sqlite.exec("PRAGMA foreign_keys = ON");

  const db = drizzle(sqlite, { schema });

  await assertSchemaReady(sqlite);
  await assertFreshSandbox(db);

  const sender = await createUser(db, {
    callbackUrl: `http://127.0.0.1:${args.gatewayPort}/mahilo/incoming`,
    connectionLabel: "primary",
    displayName: "Sandbox OpenClaw",
    username: "sandboxoc",
  });
  const alice = await createUser(db, {
    callbackUrl: `http://127.0.0.1:${args.receiverPort}/alice`,
    connectionLabel: "alice-primary",
    displayName: "Alice",
    username: "alice",
  });
  const bob = await createUser(db, {
    callbackUrl: `http://127.0.0.1:${args.receiverPort}/bob`,
    connectionLabel: "bob-primary",
    displayName: "Bob",
    username: "bob",
  });
  const carol = await createUser(db, {
    callbackUrl: `http://127.0.0.1:${args.receiverPort}/carol`,
    connectionLabel: "carol-primary",
    displayName: "Carol",
    username: "carol",
  });
  const dave = await createUser(db, {
    callbackUrl: `http://127.0.0.1:${args.receiverPort}/dave`,
    connectionLabel: "dave-primary",
    displayName: "Dave",
    username: "dave",
  });

  for (const contact of [alice, bob, carol, dave]) {
    await createFriendship(db, sender.id, contact.id);
  }

  const groupId = await createGroup(db, sender.id, [alice.id, bob.id, carol.id]);

  await createPolicy(
    db,
    sender.id,
    createUserScopedPolicy({
      effect: "ask",
      evaluator: "structured",
      policyContent: { intent: "manual_review" },
      priority: 120,
      targetUserId: bob.id,
    }),
  );

  await createPolicy(
    db,
    sender.id,
    createUserScopedPolicy({
      effect: "deny",
      evaluator: "structured",
      policyContent: {},
      priority: 140,
      targetUserId: carol.id,
    }),
  );

  await createPolicy(
    db,
    sender.id,
    createUserScopedPolicy({
      effect: "deny",
      evaluator: "llm",
      policyContent:
        "Never share a person's exact current location without explicit consent.",
      priority: 160,
      targetUserId: dave.id,
    }),
  );

  await db.insert(schema.userPreferences).values({
    createdAt: new Date(),
    defaultLlmModel: "gpt-4o-mini",
    defaultLlmProvider: "openai",
    quietHoursEnabled: false,
    updatedAt: new Date(),
    urgentBehavior: "preferred_only",
    userId: sender.id,
  });

  const runtimeState = {
    version: 1,
    servers: {
      [args.baseUrl]: {
        apiKey: sender.apiKey,
        callbackConnectionId: sender.connectionId,
        callbackSecret: sender.connectionSecret,
        callbackUrl: sender.callbackUrl,
        username: sender.username,
      },
    },
  };

  mkdirSync(dirname(args.runtimeStatePath), { recursive: true });
  await Bun.write(args.runtimeStatePath, `${JSON.stringify(runtimeState, null, 2)}\n`);

  const summary = {
    baseUrl: args.baseUrl,
    dbPath: args.dbPath,
    gatewayPort: args.gatewayPort,
    group: {
      groupId,
      members: [alice.username, bob.username, carol.username],
      name: DEFAULT_GROUP_NAME,
    },
    receiverPort: args.receiverPort,
    runtimeStatePath: args.runtimeStatePath,
    scenarios: {
      degradedReviewRecipient: dave.username,
      directAllowRecipient: alice.username,
      directAskRecipient: bob.username,
      directDenyRecipient: carol.username,
      groupTarget: groupId,
    },
    users: {
      alice: redactUserSummary(alice),
      bob: redactUserSummary(bob),
      carol: redactUserSummary(carol),
      dave: redactUserSummary(dave),
      sandboxoc: redactUserSummary(sender),
    },
  };

  mkdirSync(dirname(args.summaryPath), { recursive: true });
  await Bun.write(args.summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(JSON.stringify(summary, null, 2));

  sqlite.close();
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) {
      continue;
    }

    if (current === "--help" || current === "-h") {
      printHelpAndExit(0);
    }

    if (!current.startsWith("--")) {
      throw new Error(`Unexpected argument: ${current}`);
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${current}`);
    }

    values.set(current.slice(2), next);
    index += 1;
  }

  const dbPath = readRequiredPath(values, "db-path");
  const runtimeStatePath = readRequiredPath(values, "runtime-state-path");
  const summaryPath =
    readOptionalPath(values, "summary-path") ??
    resolve(dirname(runtimeStatePath), "seed-summary.json");

  return {
    baseUrl: values.get("base-url")?.trim() || DEFAULT_BASE_URL,
    dbPath,
    gatewayPort: parsePositiveInteger(
      values.get("gateway-port"),
      DEFAULT_GATEWAY_PORT,
      "--gateway-port",
    ),
    receiverPort: parsePositiveInteger(
      values.get("receiver-port"),
      DEFAULT_RECEIVER_PORT,
      "--receiver-port",
    ),
    runtimeStatePath,
    summaryPath,
  };
}

function printHelpAndExit(code: number): never {
  console.log(
    [
      "Usage:",
      "  bun run plugins/openclaw-mahilo/scripts/seed-local-policy-sandbox.ts \\",
      "    --db-path <sqlite-db> \\",
      "    --runtime-state-path <runtime-state.json> \\",
      "    [--summary-path <summary.json>] \\",
      "    [--base-url <mahilo-base-url>] \\",
      "    [--gateway-port <19123>] \\",
      "    [--receiver-port <19124>]",
      "",
      "Seeds a fresh sandbox Mahilo DB for local policy validation and writes",
      "the matching OpenClaw runtime bootstrap state plus a JSON summary.",
    ].join("\n"),
  );
  process.exit(code);
}

function readRequiredPath(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) {
    throw new Error(`Missing required argument --${key}`);
  }

  return resolve(value);
}

function readOptionalPath(
  values: Map<string, string>,
  key: string,
): string | undefined {
  const value = values.get(key)?.trim();
  return value ? resolve(value) : undefined;
}

function parsePositiveInteger(
  rawValue: string | undefined,
  fallback: number,
  flagName: string,
): number {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }

  return parsed;
}

async function assertSchemaReady(sqlite: Database) {
  const requiredTables = [
    "users",
    "agent_connections",
    "friendships",
    "groups",
    "group_memberships",
    "policies",
    "user_preferences",
  ];

  const rows = sqlite
    .query("select name from sqlite_master where type = 'table'")
    .all() as Array<{ name: string }>;
  const tableNames = new Set(rows.map((row) => row.name));
  const missing = requiredTables.filter((name) => !tableNames.has(name));

  if (missing.length > 0) {
    throw new Error(
      `Sandbox DB is missing required tables: ${missing.join(", ")}. Start the Mahilo server first so migrations run.`,
    );
  }
}

async function assertFreshSandbox(
  db: ReturnType<typeof drizzle<typeof schema>>,
) {
  const usernames = ["sandboxoc", "alice", "bob", "carol", "dave"];
  const existingUsers = await db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(inArray(schema.users.username, usernames));

  if (existingUsers.length > 0) {
    throw new Error(
      `Sandbox DB already contains seeded users: ${existingUsers
        .map((user) => user.username)
        .join(", ")}`,
    );
  }
}

async function createUser(
  db: ReturnType<typeof drizzle<typeof schema>>,
  options: {
    callbackUrl: string;
    connectionLabel: string;
    displayName: string;
    username: string;
  },
): Promise<SeededUser> {
  const { apiKey, hash, keyId } = await generateApiKey();
  const userId = nanoid();
  const connectionId = nanoid();
  const connectionSecret = nanoid(32);
  const now = new Date();

  await db.insert(schema.users).values({
    apiKeyHash: hash,
    apiKeyId: keyId,
    createdAt: now,
    displayName: options.displayName,
    id: userId,
    registrationSource: "sandbox",
    status: ACTIVE_USER_STATUS,
    username: options.username,
    verifiedAt: now,
  });

  await db.insert(schema.agentConnections).values({
    callbackSecret: connectionSecret,
    callbackUrl: options.callbackUrl,
    createdAt: now,
    description: `${options.displayName} sandbox receiver`,
    framework: "openclaw",
    id: connectionId,
    label: options.connectionLabel,
    lastSeen: now,
    publicKey: null,
    publicKeyAlg: null,
    routingPriority: 0,
    status: "active",
    userId,
  });

  return {
    apiKey,
    callbackUrl: options.callbackUrl,
    connectionId,
    connectionLabel: options.connectionLabel,
    connectionSecret,
    displayName: options.displayName,
    id: userId,
    username: options.username,
  };
}

async function createFriendship(
  db: ReturnType<typeof drizzle<typeof schema>>,
  requesterId: string,
  addresseeId: string,
) {
  await db.insert(schema.friendships).values({
    addresseeId,
    createdAt: new Date(),
    id: nanoid(),
    requesterId,
    status: "accepted",
  });
}

async function createGroup(
  db: ReturnType<typeof drizzle<typeof schema>>,
  ownerUserId: string,
  memberUserIds: string[],
): Promise<string> {
  const groupId = nanoid();
  const now = new Date();

  await db.insert(schema.groups).values({
    createdAt: now,
    description: "Sandbox group for partial fanout validation",
    id: groupId,
    inviteOnly: true,
    name: DEFAULT_GROUP_NAME,
    ownerUserId,
    updatedAt: now,
  });

  await db.insert(schema.groupMemberships).values({
    createdAt: now,
    groupId,
    id: nanoid(),
    role: "owner",
    status: "active",
    userId: ownerUserId,
  });

  for (const memberUserId of memberUserIds) {
    await db.insert(schema.groupMemberships).values({
      createdAt: now,
      groupId,
      id: nanoid(),
      invitedByUserId: ownerUserId,
      role: "member",
      status: "active",
      userId: memberUserId,
    });
  }

  return groupId;
}

function createUserScopedPolicy(options: {
  effect: "ask" | "deny";
  evaluator: "llm" | "structured";
  policyContent: unknown;
  priority: number;
  targetUserId: string;
}): Omit<CanonicalPolicy, "created_at" | "id" | "updated_at"> {
  return {
    action: null,
    derived_from_message_id: null,
    direction: "outbound",
    effective_from: null,
    effect: options.effect,
    enabled: true,
    evaluator: options.evaluator,
    expires_at: null,
    learning_provenance: null,
    max_uses: null,
    policy_content: options.policyContent,
    priority: options.priority,
    remaining_uses: null,
    resource: "location.current",
    scope: "user",
    source: "user_created",
    target_id: options.targetUserId,
  };
}

async function createPolicy(
  db: ReturnType<typeof drizzle<typeof schema>>,
  userId: string,
  policy: Omit<CanonicalPolicy, "created_at" | "id" | "updated_at">,
) {
  const stored = canonicalToStorage(policy);

  await db.insert(schema.policies).values({
    action: stored.action,
    createdAt: new Date(),
    derivedFromMessageId: stored.derivedFromMessageId,
    direction: stored.direction,
    effect: stored.effect,
    effectiveFrom: stored.effectiveFrom,
    enabled: policy.enabled,
    evaluator: stored.evaluator,
    expiresAt: stored.expiresAt,
    id: nanoid(),
    maxUses: stored.maxUses,
    policyContent: stored.policyContent,
    policyType: stored.policyType,
    priority: policy.priority,
    remainingUses: stored.remainingUses,
    resource: stored.resource,
    scope: policy.scope,
    source: stored.source,
    targetId: policy.target_id,
    userId,
  });
}

function redactUserSummary(user: SeededUser) {
  return {
    apiKey: user.apiKey,
    callbackUrl: user.callbackUrl,
    connectionId: user.connectionId,
    connectionLabel: user.connectionLabel,
    displayName: user.displayName,
    userId: user.id,
    username: user.username,
  };
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
