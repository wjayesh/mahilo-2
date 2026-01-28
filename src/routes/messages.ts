import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, and, or, desc, gt, ne } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/error";
import { parseCapabilities, validatePayloadSize } from "../services/validation";
import { deliverMessage, deliverToConnection } from "../services/delivery";
import { evaluatePolicies, evaluateGroupPolicies } from "../services/policy";
import { config } from "../config";

export const messageRoutes = new Hono<AppEnv>();

// Use auth middleware for all routes
messageRoutes.use("*", requireAuth());

// Send message
const sendMessageSchema = z.object({
  recipient: z.string().min(1), // username or group_id
  recipient_type: z.enum(["user", "group"]).optional().default("user"),
  recipient_connection_id: z.string().optional(),
  routing_hints: z
    .object({
      labels: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  message: z.string().min(1),
  context: z.string().optional(),
  payload_type: z.string().optional().default("text/plain"),
  encryption: z
    .object({
      alg: z.string(),
      key_id: z.string(),
    })
    .optional(),
  sender_signature: z
    .object({
      alg: z.string(),
      key_id: z.string(),
      signature: z.string(),
    })
    .optional(),
  correlation_id: z.string().optional(),
  idempotency_key: z.string().optional(),
});

messageRoutes.post("/send", zValidator("json", sendMessageSchema), async (c) => {
  const user = c.get("user")!;
  const data = c.req.valid("json");
  const db = getDb();

  // Validate payload size
  const sizeValidation = validatePayloadSize(data.message);
  if (!sizeValidation.valid) {
    throw new AppError(sizeValidation.error!, 400, "PAYLOAD_TOO_LARGE");
  }

  // Check idempotency
  if (data.idempotency_key) {
    const [existing] = await db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.senderUserId, user.id),
          eq(schema.messages.idempotencyKey, data.idempotency_key)
        )
      )
      .limit(1);

    if (existing) {
      return c.json({
        message_id: existing.id,
        status: existing.status,
        deduplicated: true,
      });
    }
  }

  // Resolve recipient
  let recipientUserId: string;
  let recipientConnection: schema.AgentConnection | null = null;

  if (data.recipient_type === "user") {
    // Find recipient user
    const [recipient] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, data.recipient.toLowerCase()))
      .limit(1);

    if (!recipient) {
      throw new AppError("Recipient user not found", 404, "USER_NOT_FOUND");
    }

    recipientUserId = recipient.id;

    // Check friendship
    const [friendship] = await db
      .select()
      .from(schema.friendships)
      .where(
        and(
          or(
            and(
              eq(schema.friendships.requesterId, user.id),
              eq(schema.friendships.addresseeId, recipient.id)
            ),
            and(
              eq(schema.friendships.requesterId, recipient.id),
              eq(schema.friendships.addresseeId, user.id)
            )
          ),
          eq(schema.friendships.status, "accepted")
        )
      )
      .limit(1);

    if (!friendship) {
      throw new AppError("Not friends with recipient", 403, "NOT_FRIENDS");
    }

    // Get recipient connection
    if (data.recipient_connection_id) {
      // Specific connection requested
      const [conn] = await db
        .select()
        .from(schema.agentConnections)
        .where(
          and(
            eq(schema.agentConnections.id, data.recipient_connection_id),
            eq(schema.agentConnections.userId, recipient.id),
            eq(schema.agentConnections.status, "active")
          )
        )
        .limit(1);

      if (!conn) {
        throw new AppError("Recipient connection not found or inactive", 404, "CONNECTION_NOT_FOUND");
      }

      recipientConnection = conn;
    } else {
      // Find best connection based on routing hints or priority
      let connections = await db
        .select()
        .from(schema.agentConnections)
        .where(
          and(
            eq(schema.agentConnections.userId, recipient.id),
            eq(schema.agentConnections.status, "active")
          )
        )
        .orderBy(desc(schema.agentConnections.routingPriority));

      if (connections.length === 0) {
        throw new AppError("Recipient has no active connections", 404, "NO_CONNECTIONS");
      }

      // Apply routing hints if provided
      if (data.routing_hints?.labels?.length) {
        const labelMatch = connections.find((c) =>
          data.routing_hints!.labels!.includes(c.label)
        );
        if (labelMatch) {
          recipientConnection = labelMatch;
        }
      }

      if (!recipientConnection && data.routing_hints?.tags?.length) {
        const tagMatch = connections.find((c) => {
          const caps = parseCapabilities(c.capabilities);
          return data.routing_hints!.tags!.some((t: string) => caps.includes(t));
        });
        if (tagMatch) {
          recipientConnection = tagMatch;
        }
      }

      // Default to highest priority connection
      if (!recipientConnection) {
        recipientConnection = connections[0];
      }
    }
  } else {
    // Group messaging (REG-045, REG-046)
    const groupId = data.recipient;

    // Get the group
    const [group] = await db
      .select()
      .from(schema.groups)
      .where(eq(schema.groups.id, groupId))
      .limit(1);

    if (!group) {
      throw new AppError("Group not found", 404, "GROUP_NOT_FOUND");
    }

    // Check if sender is an active member
    const [senderMembership] = await db
      .select()
      .from(schema.groupMemberships)
      .where(
        and(
          eq(schema.groupMemberships.groupId, groupId),
          eq(schema.groupMemberships.userId, user.id),
          eq(schema.groupMemberships.status, "active")
        )
      )
      .limit(1);

    if (!senderMembership) {
      throw new AppError("Not a member of this group", 403, "NOT_MEMBER");
    }

    // Get sender's agent connection for sender_agent field
    const senderAgent = data.routing_hints?.labels?.[0] || "agent";

    // Get sender username
    const [sender] = await db
      .select({ username: schema.users.username })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .limit(1);

    // Group policy evaluation in trusted mode (REG-044)
    const isEncrypted = data.payload_type === "application/mahilo+ciphertext";
    if (!isEncrypted && config.trustedMode) {
      const policyResult = await evaluateGroupPolicies(
        user.id,
        groupId,
        data.message,
        data.context
      );
      if (!policyResult.allowed) {
        // Create message record for audit with rejected status
        const messageId = nanoid();
        await db.insert(schema.messages).values({
          id: messageId,
          correlationId: data.correlation_id,
          senderUserId: user.id,
          senderAgent,
          recipientType: "group",
          recipientId: groupId,
          recipientConnectionId: null,
          payload: data.message,
          payloadType: data.payload_type,
          encryption: data.encryption ? JSON.stringify(data.encryption) : null,
          senderSignature: data.sender_signature
            ? JSON.stringify(data.sender_signature)
            : null,
          context: data.context,
          status: "rejected",
          rejectionReason: policyResult.reason,
          idempotencyKey: data.idempotency_key,
        });

        return c.json(
          {
            message_id: messageId,
            status: "rejected",
            rejection_reason: policyResult.reason,
          },
          403
        );
      }
    }

    // Create the parent message record
    const messageId = nanoid();
    await db.insert(schema.messages).values({
      id: messageId,
      correlationId: data.correlation_id,
      senderUserId: user.id,
      senderAgent,
      recipientType: "group",
      recipientId: groupId,
      recipientConnectionId: null,
      payload: data.message,
      payloadType: data.payload_type,
      encryption: data.encryption ? JSON.stringify(data.encryption) : null,
      senderSignature: data.sender_signature
        ? JSON.stringify(data.sender_signature)
        : null,
      context: data.context,
      status: "pending",
      idempotencyKey: data.idempotency_key,
    });

    // Get all active group members (excluding sender)
    const members = await db
      .select({
        userId: schema.groupMemberships.userId,
      })
      .from(schema.groupMemberships)
      .where(
        and(
          eq(schema.groupMemberships.groupId, groupId),
          eq(schema.groupMemberships.status, "active"),
          ne(schema.groupMemberships.userId, user.id)
        )
      );

    if (members.length === 0) {
      // No other members - mark as delivered
      await db
        .update(schema.messages)
        .set({ status: "delivered", deliveredAt: new Date() })
        .where(eq(schema.messages.id, messageId));

      return c.json({
        message_id: messageId,
        status: "delivered",
        recipients: 0,
      });
    }

    // Get active connections for each member
    const memberUserIds = members.map((m) => m.userId);
    const memberConnections = await db
      .select()
      .from(schema.agentConnections)
      .where(
        and(
          eq(schema.agentConnections.status, "active")
        )
      );

    // Filter to only include connections for group members
    const memberConnectionsFiltered = memberConnections.filter((c) =>
      memberUserIds.includes(c.userId)
    );

    // Group connections by user and pick highest priority
    const connectionsByUser = new Map<string, schema.AgentConnection>();
    for (const conn of memberConnectionsFiltered) {
      const existing = connectionsByUser.get(conn.userId);
      if (!existing || conn.routingPriority > existing.routingPriority) {
        connectionsByUser.set(conn.userId, conn);
      }
    }

    // Create delivery records and deliver to each recipient
    const deliveryPromises: Promise<void>[] = [];
    let deliveredCount = 0;
    let pendingCount = 0;
    let failedCount = 0;

    for (const member of members) {
      const connection = connectionsByUser.get(member.userId);
      const deliveryId = nanoid();

      if (!connection) {
        // No active connection for this member - mark as failed
        await db.insert(schema.messageDeliveries).values({
          id: deliveryId,
          messageId,
          recipientUserId: member.userId,
          recipientConnectionId: null,
          status: "failed",
          errorMessage: "No active connection",
        });
        failedCount++;
        continue;
      }

      // Create delivery record
      await db.insert(schema.messageDeliveries).values({
        id: deliveryId,
        messageId,
        recipientUserId: member.userId,
        recipientConnectionId: connection.id,
        status: "pending",
      });

      // Deliver asynchronously
      deliveryPromises.push(
        deliverToConnection(connection, {
          message_id: messageId,
          delivery_id: deliveryId,
          correlation_id: data.correlation_id,
          recipient_connection_id: connection.id,
          sender: sender!.username,
          sender_agent: senderAgent,
          message: data.message,
          payload_type: data.payload_type,
          encryption: data.encryption,
          sender_signature: data.sender_signature,
          context: data.context,
          group_id: groupId,
          group_name: group.name,
          timestamp: new Date().toISOString(),
        }).then((result) => {
          if (result.status === "delivered") {
            deliveredCount++;
          } else if (result.status === "pending") {
            pendingCount++;
          } else {
            failedCount++;
          }
        })
      );
    }

    // Wait for all deliveries to complete
    await Promise.all(deliveryPromises);

    // Update parent message status based on delivery results
    let overallStatus: "delivered" | "pending" | "failed" = "delivered";
    if (pendingCount > 0) {
      overallStatus = "pending";
    } else if (failedCount === members.length) {
      overallStatus = "failed";
    }

    await db
      .update(schema.messages)
      .set({
        status: overallStatus,
        deliveredAt: overallStatus === "delivered" ? new Date() : undefined,
      })
      .where(eq(schema.messages.id, messageId));

    return c.json({
      message_id: messageId,
      status: overallStatus,
      recipients: members.length,
      delivered: deliveredCount,
      pending: pendingCount,
      failed: failedCount,
    });
  }

  // Get sender's agent connection for sender_agent field
  // For now, use the framework from routing hints or default to "unknown"
  const senderAgent = data.routing_hints?.labels?.[0] || "agent";

  // Policy evaluation (only in trusted mode with plaintext)
  const isEncrypted = data.payload_type === "application/mahilo+ciphertext";
  if (!isEncrypted && config.trustedMode) {
    const policyResult = await evaluatePolicies(
      user.id,
      recipientUserId,
      data.message,
      data.context
    );
    if (!policyResult.allowed) {
      // Create message record for audit
      const messageId = nanoid();
      await db.insert(schema.messages).values({
        id: messageId,
        correlationId: data.correlation_id,
        senderUserId: user.id,
        senderAgent,
        recipientType: data.recipient_type,
        recipientId: recipientUserId,
        recipientConnectionId: recipientConnection!.id,
        payload: data.message,
        payloadType: data.payload_type,
        encryption: data.encryption ? JSON.stringify(data.encryption) : null,
        senderSignature: data.sender_signature
          ? JSON.stringify(data.sender_signature)
          : null,
        context: data.context,
        status: "rejected",
        rejectionReason: policyResult.reason,
        idempotencyKey: data.idempotency_key,
      });

      return c.json(
        {
          message_id: messageId,
          status: "rejected",
          rejection_reason: policyResult.reason,
        },
        403
      );
    }
  }

  // Create message record
  const messageId = nanoid();
  await db.insert(schema.messages).values({
    id: messageId,
    correlationId: data.correlation_id,
    senderUserId: user.id,
    senderAgent,
    recipientType: data.recipient_type,
    recipientId: recipientUserId,
    recipientConnectionId: recipientConnection!.id,
    payload: data.message,
    payloadType: data.payload_type,
    encryption: data.encryption ? JSON.stringify(data.encryption) : null,
    senderSignature: data.sender_signature
      ? JSON.stringify(data.sender_signature)
      : null,
    context: data.context,
    status: "pending",
    idempotencyKey: data.idempotency_key,
  });

  // Get sender username
  const [sender] = await db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);

  // Deliver message
  const deliveryResult = await deliverMessage(recipientConnection!, {
    message_id: messageId,
    correlation_id: data.correlation_id,
    recipient_connection_id: recipientConnection!.id,
    sender: sender!.username,
    sender_agent: senderAgent,
    message: data.message,
    payload_type: data.payload_type,
    encryption: data.encryption,
    sender_signature: data.sender_signature,
    context: data.context,
    timestamp: new Date().toISOString(),
  });

  return c.json({
    message_id: messageId,
    status: deliveryResult.status,
  });
});

// Get message history
messageRoutes.get("/", async (c) => {
  const user = c.get("user")!;
  const limitParam = parseInt(c.req.query("limit") || "50", 10);
  const direction = c.req.query("direction") as "sent" | "received" | undefined;
  const sinceParam = c.req.query("since");
  const db = getDb();

  // Build where clause based on direction
  let whereClause;
  if (direction === "sent") {
    whereClause = eq(schema.messages.senderUserId, user.id);
  } else if (direction === "received") {
    whereClause = and(
      eq(schema.messages.recipientType, "user"),
      eq(schema.messages.recipientId, user.id)
    );
  } else {
    whereClause = or(
      eq(schema.messages.senderUserId, user.id),
      and(
        eq(schema.messages.recipientType, "user"),
        eq(schema.messages.recipientId, user.id)
      )
    );
  }

  let whereFilters = whereClause;

  if (sinceParam) {
    let sinceMs: number;
    if (/^\d+$/.test(sinceParam)) {
      sinceMs = Number(sinceParam);
      if (sinceMs < 1_000_000_000_000) {
        sinceMs *= 1000;
      }
    } else {
      sinceMs = Date.parse(sinceParam);
    }

    if (Number.isNaN(sinceMs)) {
      throw new AppError("Invalid since parameter", 400, "INVALID_SINCE");
    }
    whereFilters = and(whereFilters, gt(schema.messages.createdAt, new Date(sinceMs)));
  }

  const messages = await db
    .select()
    .from(schema.messages)
    .where(whereFilters)
    .orderBy(desc(schema.messages.createdAt))
    .limit(Math.min(limitParam, 100));

  // Get usernames for senders/recipients
  const userIds = new Set<string>();
  messages.forEach((m) => {
    userIds.add(m.senderUserId);
    if (m.recipientType === "user") {
      userIds.add(m.recipientId);
    }
  });

  const users = await db
    .select({ id: schema.users.id, username: schema.users.username })
    .from(schema.users);

  const usersMap = new Map(users.map((u) => [u.id, u.username]));

  return c.json(
    messages.map((m) => ({
      id: m.id,
      correlation_id: m.correlationId,
      sender: usersMap.get(m.senderUserId),
      sender_agent: m.senderAgent,
      recipient: usersMap.get(m.recipientId),
      recipient_type: m.recipientType,
      message: m.payload,
      context: m.context,
      status: m.status,
      created_at: m.createdAt?.toISOString(),
      delivered_at: m.deliveredAt?.toISOString(),
    }))
  );
});
