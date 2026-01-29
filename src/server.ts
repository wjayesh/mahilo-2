import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "hono/bun";
import { config } from "./config";
import { errorHandler } from "./middleware/error";
import { authRoutes } from "./routes/auth";
import { agentRoutes } from "./routes/agents";
import { friendRoutes } from "./routes/friends";
import { groupRoutes } from "./routes/groups";
import { messageRoutes } from "./routes/messages";
import { notificationRoutes } from "./routes/notifications";
import { policyRoutes } from "./routes/policies";
import { preferencesRoutes } from "./routes/preferences";
import { contactRoutes } from "./routes/contacts";

export type AppEnv = {
  Variables: {
    user?: {
      id: string;
      username: string;
    };
  };
};

export function createApp() {
  const app = new Hono<AppEnv>();

  // Global middleware
  app.use("*", logger());
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: "*", // Configure as needed for production
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["X-Request-Id"],
      maxAge: 86400,
    })
  );

  // Error handling
  app.onError(errorHandler);

  // Health check
  app.get("/health", (c) => {
    return c.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      version: "0.1.0",
    });
  });

  // Serve static files (dashboard)
  app.use("/*", serveStatic({ root: "./public" }));

  // API routes
  const api = new Hono<AppEnv>();
  api.route("/auth", authRoutes);
  api.route("/agents", agentRoutes);
  api.route("/contacts", contactRoutes);
  api.route("/friends", friendRoutes);
  api.route("/groups", groupRoutes);
  api.route("/messages", messageRoutes);
  api.route("/notifications", notificationRoutes);
  api.route("/policies", policyRoutes);
  api.route("/preferences", preferencesRoutes);

  app.route(config.apiPrefix, api);

  // 404 handler
  app.notFound((c) => {
    return c.json(
      {
        error: "Not Found",
        message: `Route ${c.req.method} ${c.req.path} not found`,
      },
      404
    );
  });

  return app;
}
