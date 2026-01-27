import { createApp } from "./server";
import { config } from "./config";
import { initializeDatabase } from "./db";
import { startRetryProcessor, stopRetryProcessor } from "./services/delivery";

async function main() {
  console.log("Starting Mahilo Registry...");

  // Initialize database
  await initializeDatabase();
  console.log(`Database initialized at ${config.databaseUrl}`);

  // Start retry processor for failed message deliveries
  startRetryProcessor();
  console.log("Message retry processor started");

  // Create and start server
  const app = createApp();

  console.log(`Server starting on http://${config.host}:${config.port}`);
  console.log(`API available at http://${config.host}:${config.port}${config.apiPrefix}`);
  console.log(`Health check at http://${config.host}:${config.port}/health`);

  const server = Bun.serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    stopRetryProcessor();
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("\nShutting down...");
    stopRetryProcessor();
    server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
