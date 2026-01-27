import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { config } from "../config";
import * as schema from "./schema";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

let db: ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database;

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
  // For now, we'll use push-based schema sync in development
  // In production, use proper migrations
  console.log("Running database migrations...");
  // Migrations will be handled by drizzle-kit
}

export function closeDatabase() {
  if (sqlite) {
    sqlite.close();
  }
}

export { schema };
