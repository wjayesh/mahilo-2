import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { config } from "../config";
import * as schema from "./schema";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sqlite: Database | null = null;

export function getDb() {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }
  return db;
}

export function getSqlite(): Database {
  if (!sqlite) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }
  return sqlite;
}

export async function initializeDatabase() {
  const dbPath = config.databaseUrl;

  // Ensure directory exists
  const dir = dirname(dbPath);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Create SQLite connection using Bun's native driver
  sqlite = new Database(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");

  // Create Drizzle instance
  db = drizzle(sqlite, { schema });

  // Run migrations in development
  if (config.nodeEnv === "development") {
    await runMigrations();
  }

  return db;
}

async function runMigrations() {
  console.log("Running database migrations...");
  migrate(db, { migrationsFolder: "./src/db/migrations" });
}

export function setDbForTests(
  testDb: ReturnType<typeof drizzle<typeof schema>>,
  testSqlite: Database
) {
  db = testDb;
  sqlite = testSqlite;
}

export function resetDbForTests() {
  if (sqlite) {
    sqlite.close();
  }
  db = null;
  sqlite = null;
}

export function closeDatabase() {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
    db = null;
  }
}

export { schema };
