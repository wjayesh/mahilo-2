import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, and } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { requireAuth } from "../middleware/auth";
import { generateCallbackSecret } from "../services/auth";
import { AppError } from "../middleware/error";
import { normalizeCapabilities, parseCapabilities, validateCallbackUrl } from "../services/validation";

export const agentRoutes = new Hono<AppEnv>();

// Use auth middleware for all routes
agentRoutes.use("*", requireAuth());

// Register or update an agent connection
const registerAgentSchema = z.object({
  framework: z.string().min(1).max(50),
  label: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
  capabilities: z.union([z.array(z.string()), z.string()]).optional(),
  routing_priority: z.number().int().min(0).max(100).optional().default(0),
  callback_url: z.string().url(),
  callback_secret: z.string().min(16).max(64).optional(),
  public_key: z.string().min(1),
  public_key_alg: z.enum(["ed25519", "x25519"]),
  rotate_secret: z.boolean().optional().default(false),
});

agentRoutes.post("/", zValidator("json", registerAgentSchema), async (c) => {
  const user = c.get("user")!;
  const data = c.req.valid("json");

  // Validate callback URL
  const urlValidation = await validateCallbackUrl(data.callback_url);
  if (!urlValidation.valid) {
    throw new AppError(urlValidation.error!, 400, "INVALID_CALLBACK_URL");
  }

  const db = getDb();

  // Check for existing connection with same user/framework/label
  const [existing] = await db
    .select()
    .from(schema.agentConnections)
    .where(
      and(
        eq(schema.agentConnections.userId, user.id),
        eq(schema.agentConnections.framework, data.framework),
        eq(schema.agentConnections.label, data.label)
      )
    )
    .limit(1);

  // Normalize capabilities to JSON string
  const capabilitiesResult = normalizeCapabilities(data.capabilities);
  if (!capabilitiesResult.valid) {
    throw new AppError(capabilitiesResult.error!, 400, "INVALID_CAPABILITIES");
  }
  const capabilities = capabilitiesResult.value;

  if (existing) {
    // Update existing connection
    const callbackSecret =
      data.rotate_secret || data.callback_secret
        ? data.callback_secret || generateCallbackSecret()
        : existing.callbackSecret;

    await db
      .update(schema.agentConnections)
      .set({
        description: data.description,
        capabilities,
        routingPriority: data.routing_priority,
        callbackUrl: data.callback_url,
        callbackSecret,
        publicKey: data.public_key,
        publicKeyAlg: data.public_key_alg,
        status: "active",
        lastSeen: new Date(),
      })
      .where(eq(schema.agentConnections.id, existing.id));

    return c.json({
      connection_id: existing.id,
      callback_secret: data.rotate_secret ? callbackSecret : undefined,
      updated: true,
    });
  }

  // Create new connection
  const connectionId = nanoid();
  const callbackSecret = data.callback_secret || generateCallbackSecret();

  await db.insert(schema.agentConnections).values({
    id: connectionId,
    userId: user.id,
    framework: data.framework,
    label: data.label,
    description: data.description,
    capabilities,
    routingPriority: data.routing_priority || 0,
    callbackUrl: data.callback_url,
    callbackSecret,
    publicKey: data.public_key,
    publicKeyAlg: data.public_key_alg,
    status: "active",
    lastSeen: new Date(),
  });

  return c.json(
    {
      connection_id: connectionId,
      callback_secret: callbackSecret, // Only shown once unless rotated
    },
    201
  );
});

// List user's agent connections
agentRoutes.get("/", async (c) => {
  const user = c.get("user")!;
  const db = getDb();

  const connections = await db
    .select({
      id: schema.agentConnections.id,
      framework: schema.agentConnections.framework,
      label: schema.agentConnections.label,
      description: schema.agentConnections.description,
      capabilities: schema.agentConnections.capabilities,
      routingPriority: schema.agentConnections.routingPriority,
      callbackUrl: schema.agentConnections.callbackUrl,
      publicKey: schema.agentConnections.publicKey,
      publicKeyAlg: schema.agentConnections.publicKeyAlg,
      status: schema.agentConnections.status,
      lastSeen: schema.agentConnections.lastSeen,
      createdAt: schema.agentConnections.createdAt,
    })
    .from(schema.agentConnections)
    .where(eq(schema.agentConnections.userId, user.id));

  return c.json(
    connections.map((conn) => ({
      id: conn.id,
      framework: conn.framework,
      label: conn.label,
      description: conn.description,
      capabilities: parseCapabilities(conn.capabilities),
      routing_priority: conn.routingPriority,
      callback_url: conn.callbackUrl,
      public_key: conn.publicKey,
      public_key_alg: conn.publicKeyAlg,
      status: conn.status,
      last_seen: conn.lastSeen?.toISOString(),
      created_at: conn.createdAt?.toISOString(),
    }))
  );
});

// Delete an agent connection
agentRoutes.delete("/:id", async (c) => {
  const user = c.get("user")!;
  const connectionId = c.req.param("id");
  const db = getDb();

  // Verify ownership
  const [connection] = await db
    .select()
    .from(schema.agentConnections)
    .where(
      and(
        eq(schema.agentConnections.id, connectionId),
        eq(schema.agentConnections.userId, user.id)
      )
    )
    .limit(1);

  if (!connection) {
    throw new AppError("Agent connection not found", 404, "NOT_FOUND");
  }

  // Delete the connection
  await db
    .delete(schema.agentConnections)
    .where(eq(schema.agentConnections.id, connectionId));

  return c.json({ success: true });
});

// Ping/health check an agent connection
agentRoutes.post("/:id/ping", async (c) => {
  const user = c.get("user")!;
  const connectionId = c.req.param("id");
  const db = getDb();

  // Verify ownership
  const [connection] = await db
    .select()
    .from(schema.agentConnections)
    .where(
      and(
        eq(schema.agentConnections.id, connectionId),
        eq(schema.agentConnections.userId, user.id)
      )
    )
    .limit(1);

  if (!connection) {
    throw new AppError("Agent connection not found", 404, "NOT_FOUND");
  }

  // Test callback URL
  const startTime = Date.now();
  try {
    const response = await fetch(connection.callbackUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });

    const latencyMs = Date.now() - startTime;

    // Update last_seen
    await db
      .update(schema.agentConnections)
      .set({ lastSeen: new Date() })
      .where(eq(schema.agentConnections.id, connectionId));

    return c.json({
      success: response.ok,
      latency_ms: latencyMs,
      status_code: response.status,
    });
  } catch (error) {
    return c.json({
      success: false,
      latency_ms: Date.now() - startTime,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
