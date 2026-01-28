import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { verifyApiKey } from "../services/auth";

// Note: eq is used in notifyGroup function

// Track connected WebSocket clients
const connectedClients = new Map<
  string,
  {
    ws: WebSocket;
    userId: string;
    lastPing: number;
  }
>();

// Event types (REG-049)
export type NotificationEventType =
  | "message_received"
  | "delivery_status"
  | "group_invite"
  | "group_join"
  | "group_leave"
  | "friend_request"
  | "connection";

export interface NotificationEvent {
  type: NotificationEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export const notificationRoutes = new Hono<AppEnv>();

// Helper to authenticate WebSocket connection via query param
async function authenticateWebSocket(apiKey: string): Promise<string | null> {
  if (!apiKey) return null;

  const user = await verifyApiKey(apiKey);
  return user?.id ?? null;
}

// WebSocket endpoint (REG-048)
notificationRoutes.get(
  "/ws",
  upgradeWebSocket((c) => {
    let userId: string | null = null;
    let connectionId: string | null = null;

    return {
      onOpen: async (_event, ws) => {
        // Get API key from query parameter
        const url = new URL(c.req.url);
        const apiKey = url.searchParams.get("api_key");

        if (!apiKey) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Missing api_key query parameter",
            })
          );
          ws.close(4001, "Unauthorized");
          return;
        }

        userId = await authenticateWebSocket(apiKey);

        if (!userId) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Invalid API key",
            })
          );
          ws.close(4001, "Unauthorized");
          return;
        }

        // Generate connection ID
        connectionId = `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store connection
        connectedClients.set(connectionId, {
          ws: ws.raw as unknown as WebSocket,
          userId,
          lastPing: Date.now(),
        });

        // Send connection confirmation
        const event: NotificationEvent = {
          type: "connection",
          timestamp: new Date().toISOString(),
          data: {
            status: "connected",
            connection_id: connectionId,
            user_id: userId,
          },
        };
        ws.send(JSON.stringify(event));

        console.log(`WebSocket connected: ${connectionId} for user ${userId}`);
      },

      onMessage: (event, ws) => {
        // Handle ping/pong for keepalive
        try {
          const message = JSON.parse(event.data.toString());

          if (message.type === "ping") {
            ws.send(
              JSON.stringify({
                type: "pong",
                timestamp: new Date().toISOString(),
              })
            );

            // Update last ping time
            if (connectionId) {
              const client = connectedClients.get(connectionId);
              if (client) {
                client.lastPing = Date.now();
              }
            }
          }
        } catch {
          // Ignore invalid JSON
        }
      },

      onClose: () => {
        if (connectionId) {
          connectedClients.delete(connectionId);
          console.log(`WebSocket disconnected: ${connectionId}`);
        }
      },

      onError: (event) => {
        console.error("WebSocket error:", event);
        if (connectionId) {
          connectedClients.delete(connectionId);
        }
      },
    };
  })
);

// Helper function to send notification to a specific user
export function notifyUser(userId: string, event: NotificationEvent): boolean {
  let sent = false;

  for (const [, client] of connectedClients) {
    if (client.userId === userId) {
      try {
        client.ws.send(JSON.stringify(event));
        sent = true;
      } catch (error) {
        console.error(`Error sending notification to user ${userId}:`, error);
      }
    }
  }

  return sent;
}

// Helper function to send notification to multiple users
export function notifyUsers(userIds: string[], event: NotificationEvent): number {
  let sentCount = 0;

  for (const userId of userIds) {
    if (notifyUser(userId, event)) {
      sentCount++;
    }
  }

  return sentCount;
}

// Helper function to broadcast to all connected users in a group
export async function notifyGroup(
  groupId: string,
  event: NotificationEvent,
  excludeUserId?: string
): Promise<number> {
  const db = getDb();

  // Get all active group members
  const members = await db
    .select({ userId: schema.groupMemberships.userId })
    .from(schema.groupMemberships)
    .where(eq(schema.groupMemberships.groupId, groupId));

  const userIds = members
    .map((m) => m.userId)
    .filter((id) => id !== excludeUserId);

  return notifyUsers(userIds, event);
}

// Cleanup stale connections (call periodically)
export function cleanupStaleConnections(maxIdleMs = 60000): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [connectionId, client] of connectedClients) {
    if (now - client.lastPing > maxIdleMs) {
      try {
        client.ws.close(1000, "Connection timeout");
      } catch {
        // Ignore close errors
      }
      connectedClients.delete(connectionId);
      cleaned++;
    }
  }

  return cleaned;
}

// Get number of connected clients
export function getConnectedClientCount(): number {
  return connectedClients.size;
}

// Check if user has active WebSocket connection
export function isUserConnected(userId: string): boolean {
  for (const [, client] of connectedClients) {
    if (client.userId === userId) {
      return true;
    }
  }
  return false;
}
