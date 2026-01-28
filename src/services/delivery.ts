import { createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { config } from "../config";

interface DeliveryPayload {
  message_id: string;
  delivery_id?: string; // For group fan-out tracking
  correlation_id?: string;
  recipient_connection_id: string;
  sender: string;
  sender_agent: string;
  message: string;
  payload_type: string;
  encryption?: { alg: string; key_id: string };
  sender_signature?: { alg: string; key_id: string; signature: string };
  context?: string;
  group_id?: string;
  group_name?: string;
  timestamp: string;
}

interface DeliveryResult {
  success: boolean;
  status: "delivered" | "pending" | "failed";
  error?: string;
}

// Simple in-memory retry queue for MVP
interface RetryItem {
  messageId: string;
  connectionId: string;
  payload: DeliveryPayload;
  secret: string;
  retryCount: number;
  nextRetryAt: number;
}

const retryQueue: Map<string, RetryItem> = new Map();

export function generateCallbackSignature(body: string, secret: string, timestamp: number): string {
  const payload = `${timestamp}.${body}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export async function deliverMessage(
  connection: schema.AgentConnection,
  payload: DeliveryPayload
): Promise<DeliveryResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyString = JSON.stringify(payload);
  const signature = generateCallbackSignature(bodyString, connection.callbackSecret, timestamp);

  try {
    const response = await fetch(connection.callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mahilo-Signature": `sha256=${signature}`,
        "X-Mahilo-Timestamp": timestamp.toString(),
        "X-Mahilo-Message-Id": payload.message_id,
      },
      body: bodyString,
      signal: AbortSignal.timeout(config.callbackTimeoutMs),
    });

    if (response.ok) {
      // Update message status to delivered
      const db = getDb();
      await db
        .update(schema.messages)
        .set({
          status: "delivered",
          deliveredAt: new Date(),
        })
        .where(eq(schema.messages.id, payload.message_id));

      // Update connection last_seen
      await db
        .update(schema.agentConnections)
        .set({ lastSeen: new Date() })
        .where(eq(schema.agentConnections.id, connection.id));

      return { success: true, status: "delivered" };
    }

    // Non-2xx response - queue for retry
    queueForRetry(payload.message_id, connection.id, payload, connection.callbackSecret);
    return {
      success: false,
      status: "pending",
      error: `Callback returned ${response.status}`,
    };
  } catch (error) {
    // Network error or timeout - queue for retry
    queueForRetry(payload.message_id, connection.id, payload, connection.callbackSecret);
    return {
      success: false,
      status: "pending",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Deliver to a specific connection (for group fan-out)
// Updates message_deliveries table instead of messages table
export async function deliverToConnection(
  connection: schema.AgentConnection,
  payload: DeliveryPayload
): Promise<DeliveryResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyString = JSON.stringify(payload);
  const signature = generateCallbackSignature(bodyString, connection.callbackSecret, timestamp);

  try {
    const response = await fetch(connection.callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mahilo-Signature": `sha256=${signature}`,
        "X-Mahilo-Timestamp": timestamp.toString(),
        "X-Mahilo-Message-Id": payload.message_id,
        ...(payload.delivery_id && { "X-Mahilo-Delivery-Id": payload.delivery_id }),
        ...(payload.group_id && { "X-Mahilo-Group-Id": payload.group_id }),
      },
      body: bodyString,
      signal: AbortSignal.timeout(config.callbackTimeoutMs),
    });

    if (response.ok) {
      // Update delivery status to delivered
      if (payload.delivery_id) {
        const db = getDb();
        await db
          .update(schema.messageDeliveries)
          .set({
            status: "delivered",
            deliveredAt: new Date(),
          })
          .where(eq(schema.messageDeliveries.id, payload.delivery_id));
      }

      // Update connection last_seen
      const db = getDb();
      await db
        .update(schema.agentConnections)
        .set({ lastSeen: new Date() })
        .where(eq(schema.agentConnections.id, connection.id));

      return { success: true, status: "delivered" };
    }

    // Non-2xx response - queue for retry
    if (payload.delivery_id) {
      queueDeliveryForRetry(
        payload.delivery_id,
        connection.id,
        payload,
        connection.callbackSecret
      );
    }
    return {
      success: false,
      status: "pending",
      error: `Callback returned ${response.status}`,
    };
  } catch (error) {
    // Network error or timeout - queue for retry
    if (payload.delivery_id) {
      queueDeliveryForRetry(
        payload.delivery_id,
        connection.id,
        payload,
        connection.callbackSecret
      );
    }
    return {
      success: false,
      status: "pending",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Retry item for delivery records (group fan-out)
interface DeliveryRetryItem {
  deliveryId: string;
  connectionId: string;
  payload: DeliveryPayload;
  secret: string;
  retryCount: number;
  nextRetryAt: number;
}

const deliveryRetryQueue: Map<string, DeliveryRetryItem> = new Map();

function queueDeliveryForRetry(
  deliveryId: string,
  connectionId: string,
  payload: DeliveryPayload,
  secret: string
) {
  const existing = deliveryRetryQueue.get(deliveryId);
  const retryCount = existing ? existing.retryCount + 1 : 1;

  if (retryCount > config.maxRetries) {
    // Max retries exceeded - mark as failed
    markDeliveryFailed(deliveryId, "Max retries exceeded");
    deliveryRetryQueue.delete(deliveryId);
    return;
  }

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s
  const delayMs = Math.pow(2, retryCount - 1) * 1000;

  deliveryRetryQueue.set(deliveryId, {
    deliveryId,
    connectionId,
    payload,
    secret,
    retryCount,
    nextRetryAt: Date.now() + delayMs,
  });

  // Update retry count in database
  const db = getDb();
  db.update(schema.messageDeliveries)
    .set({ retryCount })
    .where(eq(schema.messageDeliveries.id, deliveryId))
    .then(() => {})
    .catch(console.error);
}

async function markDeliveryFailed(deliveryId: string, reason: string) {
  const db = getDb();
  await db
    .update(schema.messageDeliveries)
    .set({
      status: "failed",
      errorMessage: reason,
    })
    .where(eq(schema.messageDeliveries.id, deliveryId));
}

function queueForRetry(
  messageId: string,
  connectionId: string,
  payload: DeliveryPayload,
  secret: string
) {
  const existing = retryQueue.get(messageId);
  const retryCount = existing ? existing.retryCount + 1 : 1;

  if (retryCount > config.maxRetries) {
    // Max retries exceeded - mark as failed
    markMessageFailed(messageId, "Max retries exceeded");
    retryQueue.delete(messageId);
    return;
  }

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s
  const delayMs = Math.pow(2, retryCount - 1) * 1000;

  retryQueue.set(messageId, {
    messageId,
    connectionId,
    payload,
    secret,
    retryCount,
    nextRetryAt: Date.now() + delayMs,
  });

  // Update retry count in database
  const db = getDb();
  db.update(schema.messages)
    .set({ retryCount })
    .where(eq(schema.messages.id, messageId))
    .then(() => {})
    .catch(console.error);
}

async function markMessageFailed(messageId: string, reason: string) {
  const db = getDb();
  await db
    .update(schema.messages)
    .set({
      status: "failed",
      rejectionReason: reason,
    })
    .where(eq(schema.messages.id, messageId));
}

// Process retry queue (call this periodically)
export async function processRetryQueue() {
  const now = Date.now();
  const db = getDb();

  // Process message retries
  for (const [messageId, item] of retryQueue.entries()) {
    if (item.nextRetryAt > now) {
      continue;
    }

    // Get connection
    const [connection] = await db
      .select()
      .from(schema.agentConnections)
      .where(eq(schema.agentConnections.id, item.connectionId))
      .limit(1);

    if (!connection) {
      markMessageFailed(messageId, "Connection not found");
      retryQueue.delete(messageId);
      continue;
    }

    // Attempt delivery
    const result = await deliverMessage(connection, item.payload);

    if (result.success) {
      retryQueue.delete(messageId);
    }
    // If failed, queueForRetry will update the entry
  }

  // Process delivery retries (for group fan-out)
  for (const [deliveryId, item] of deliveryRetryQueue.entries()) {
    if (item.nextRetryAt > now) {
      continue;
    }

    // Get connection
    const [connection] = await db
      .select()
      .from(schema.agentConnections)
      .where(eq(schema.agentConnections.id, item.connectionId))
      .limit(1);

    if (!connection) {
      markDeliveryFailed(deliveryId, "Connection not found");
      deliveryRetryQueue.delete(deliveryId);
      continue;
    }

    // Attempt delivery
    const result = await deliverToConnection(connection, item.payload);

    if (result.success) {
      deliveryRetryQueue.delete(deliveryId);
    }
    // If failed, queueDeliveryForRetry will update the entry
  }
}

// Start retry processor (simple interval for MVP)
let retryInterval: ReturnType<typeof setInterval> | null = null;

export function startRetryProcessor() {
  if (retryInterval) return;

  retryInterval = setInterval(() => {
    processRetryQueue().catch(console.error);
  }, 1000); // Check every second
}

export function stopRetryProcessor() {
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
  }
}
