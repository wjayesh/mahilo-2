import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { config } from "../config";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

async function runMigrations() {
  const dbPath = config.databaseUrl;

  // Ensure directory exists
  const dir = dirname(dbPath);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  console.log(`Running migrations on ${dbPath}...`);

  const sqlite = new Database(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");

  const db = drizzle(sqlite);

  migrate(db, { migrationsFolder: "./src/db/migrations" });

  console.log("Migrations complete!");
  sqlite.close();
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
