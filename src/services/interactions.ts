/**
 * Interaction tracking service (PERM-020, PERM-021)
 *
 * Provides functions to count and retrieve interactions between users.
 */

import { eq, and, or, desc, sql } from "drizzle-orm";
import { getDb, schema } from "../db";

export interface InteractionCount {
  userId: string;
  count: number;
}

export interface RecentInteraction {
  direction: "sent" | "received";
  message: string;
  timestamp: string;
}

/**
 * Get the count of messages exchanged with a specific user
 *
 * @param userId - The current user's ID
 * @param friendUserId - The friend's user ID
 * @returns The count of messages (sent + received)
 */
export async function getInteractionCount(
  userId: string,
  friendUserId: string
): Promise<number> {
  const db = getDb();

  // Count messages in both directions
  const result = await db
    .select({
      count: sql<number>`count(*)`,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.recipientType, "user"),
        or(
          // Messages sent by user to friend
          and(
            eq(schema.messages.senderUserId, userId),
            eq(schema.messages.recipientId, friendUserId)
          ),
          // Messages received by user from friend
          and(
            eq(schema.messages.senderUserId, friendUserId),
            eq(schema.messages.recipientId, userId)
          )
        )
      )
    );

  return result[0]?.count ?? 0;
}

/**
 * Get interaction counts for multiple friends in a single query
 *
 * @param userId - The current user's ID
 * @param friendUserIds - Array of friend user IDs
 * @returns Map of friend user ID to interaction count
 */
export async function getInteractionCountsForFriends(
  userId: string,
  friendUserIds: string[]
): Promise<Map<string, number>> {
  if (friendUserIds.length === 0) {
    return new Map();
  }

  const db = getDb();

  // Get counts for messages where user is sender and friend is recipient
  const sentCounts = await db
    .select({
      friendId: schema.messages.recipientId,
      count: sql<number>`count(*)`,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.senderUserId, userId),
        eq(schema.messages.recipientType, "user"),
        sql`${schema.messages.recipientId} IN ${friendUserIds}`
      )
    )
    .groupBy(schema.messages.recipientId);

  // Get counts for messages where friend is sender and user is recipient
  const receivedCounts = await db
    .select({
      friendId: schema.messages.senderUserId,
      count: sql<number>`count(*)`,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.recipientId, userId),
        eq(schema.messages.recipientType, "user"),
        sql`${schema.messages.senderUserId} IN ${friendUserIds}`
      )
    )
    .groupBy(schema.messages.senderUserId);

  // Combine counts
  const countMap = new Map<string, number>();

  for (const { friendId, count } of sentCounts) {
    countMap.set(friendId, count);
  }

  for (const { friendId, count } of receivedCounts) {
    const existing = countMap.get(friendId) || 0;
    countMap.set(friendId, existing + count);
  }

  return countMap;
}

/**
 * Get recent interactions with a specific user
 *
 * @param userId - The current user's ID
 * @param friendUserId - The friend's user ID
 * @param limit - Maximum number of interactions to return (default 5)
 * @returns Array of recent interactions, ordered by timestamp (newest last)
 */
export async function getRecentInteractions(
  userId: string,
  friendUserId: string,
  limit: number = 5
): Promise<RecentInteraction[]> {
  const db = getDb();

  // Get recent messages in both directions
  const messages = await db
    .select({
      id: schema.messages.id,
      senderUserId: schema.messages.senderUserId,
      payload: schema.messages.payload,
      createdAt: schema.messages.createdAt,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.recipientType, "user"),
        or(
          // Messages sent by user to friend
          and(
            eq(schema.messages.senderUserId, userId),
            eq(schema.messages.recipientId, friendUserId)
          ),
          // Messages received by user from friend
          and(
            eq(schema.messages.senderUserId, friendUserId),
            eq(schema.messages.recipientId, userId)
          )
        )
      )
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(limit);

  // Convert to RecentInteraction format and reverse order (newest last)
  return messages
    .map((msg) => ({
      direction: (msg.senderUserId === userId ? "sent" : "received") as "sent" | "received",
      message: msg.payload,
      timestamp: msg.createdAt?.toISOString() ?? new Date().toISOString(),
    }))
    .reverse();
}
