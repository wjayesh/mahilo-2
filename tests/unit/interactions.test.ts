/**
 * Unit tests for interactions service (PERM-020, PERM-021)
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import {
  getInteractionCount,
  getInteractionCountsForFriends,
  getRecentInteractions,
} from "../../src/services/interactions";
import {
  cleanupTestDatabase,
  createTestUser,
  getTestDb,
  setupTestDatabase,
  createFriendship,
} from "../helpers/setup";
import * as schema from "../../src/db/schema";
import { nanoid } from "nanoid";

describe("Interactions Service", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(() => {
    cleanupTestDatabase();
  });

  describe("getInteractionCount", () => {
    it("should return 0 for users with no messages", async () => {
      const { user: user1 } = await createTestUser("interaction_user1");
      const { user: user2 } = await createTestUser("interaction_user2");

      const count = await getInteractionCount(user1.id, user2.id);
      expect(count).toBe(0);
    });

    it("should count sent messages", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("interaction_sender1");
      const { user: recipient } = await createTestUser("interaction_recipient1");

      // Create some messages
      for (let i = 0; i < 3; i++) {
        await db.insert(schema.messages).values({
          id: nanoid(),
          senderUserId: sender.id,
          senderAgent: "test-agent",
          recipientType: "user",
          recipientId: recipient.id,
          payload: `Test message ${i}`,
          status: "delivered",
        });
      }

      const count = await getInteractionCount(sender.id, recipient.id);
      expect(count).toBe(3);
    });

    it("should count received messages", async () => {
      const db = getTestDb();
      const { user: user1 } = await createTestUser("interaction_user3");
      const { user: user2 } = await createTestUser("interaction_user4");

      // Create messages from user2 to user1
      for (let i = 0; i < 2; i++) {
        await db.insert(schema.messages).values({
          id: nanoid(),
          senderUserId: user2.id,
          senderAgent: "test-agent",
          recipientType: "user",
          recipientId: user1.id,
          payload: `Test message ${i}`,
          status: "delivered",
        });
      }

      // Count from user1's perspective (received messages)
      const count = await getInteractionCount(user1.id, user2.id);
      expect(count).toBe(2);
    });

    it("should count both sent and received messages", async () => {
      const db = getTestDb();
      const { user: user1 } = await createTestUser("interaction_user5");
      const { user: user2 } = await createTestUser("interaction_user6");

      // Messages from user1 to user2
      for (let i = 0; i < 2; i++) {
        await db.insert(schema.messages).values({
          id: nanoid(),
          senderUserId: user1.id,
          senderAgent: "test-agent",
          recipientType: "user",
          recipientId: user2.id,
          payload: `Sent message ${i}`,
          status: "delivered",
        });
      }

      // Messages from user2 to user1
      for (let i = 0; i < 3; i++) {
        await db.insert(schema.messages).values({
          id: nanoid(),
          senderUserId: user2.id,
          senderAgent: "test-agent",
          recipientType: "user",
          recipientId: user1.id,
          payload: `Received message ${i}`,
          status: "delivered",
        });
      }

      const count = await getInteractionCount(user1.id, user2.id);
      expect(count).toBe(5); // 2 sent + 3 received
    });
  });

  describe("getInteractionCountsForFriends", () => {
    it("should return empty map for empty friend list", async () => {
      const { user } = await createTestUser("interaction_user7");

      const counts = await getInteractionCountsForFriends(user.id, []);
      expect(counts.size).toBe(0);
    });

    it("should return counts for multiple friends", async () => {
      const db = getTestDb();
      const { user: mainUser } = await createTestUser("interaction_main");
      const { user: friend1 } = await createTestUser("interaction_friend1");
      const { user: friend2 } = await createTestUser("interaction_friend2");

      // Messages with friend1
      for (let i = 0; i < 4; i++) {
        await db.insert(schema.messages).values({
          id: nanoid(),
          senderUserId: mainUser.id,
          senderAgent: "test-agent",
          recipientType: "user",
          recipientId: friend1.id,
          payload: `Message to friend1 ${i}`,
          status: "delivered",
        });
      }

      // Messages with friend2
      for (let i = 0; i < 2; i++) {
        await db.insert(schema.messages).values({
          id: nanoid(),
          senderUserId: friend2.id,
          senderAgent: "test-agent",
          recipientType: "user",
          recipientId: mainUser.id,
          payload: `Message from friend2 ${i}`,
          status: "delivered",
        });
      }

      const counts = await getInteractionCountsForFriends(mainUser.id, [
        friend1.id,
        friend2.id,
      ]);

      expect(counts.get(friend1.id)).toBe(4);
      expect(counts.get(friend2.id)).toBe(2);
    });

    it("should return 0 for friends with no messages", async () => {
      const { user: mainUser } = await createTestUser("interaction_main2");
      const { user: friend } = await createTestUser("interaction_friend3");

      const counts = await getInteractionCountsForFriends(mainUser.id, [friend.id]);
      expect(counts.get(friend.id)).toBeUndefined();
    });
  });

  describe("getRecentInteractions", () => {
    it("should return empty array for users with no messages", async () => {
      const { user: user1 } = await createTestUser("interaction_user8");
      const { user: user2 } = await createTestUser("interaction_user9");

      const interactions = await getRecentInteractions(user1.id, user2.id);
      expect(interactions).toHaveLength(0);
    });

    it("should return recent interactions in chronological order (oldest first)", async () => {
      const db = getTestDb();
      const { user: user1 } = await createTestUser("interaction_user10");
      const { user: user2 } = await createTestUser("interaction_user11");

      // Create messages with timestamps
      const now = Date.now();
      const messages = [
        { sender: user1.id, recipient: user2.id, payload: "First message", time: now - 4000 },
        { sender: user2.id, recipient: user1.id, payload: "Reply", time: now - 3000 },
        { sender: user1.id, recipient: user2.id, payload: "Thanks", time: now - 2000 },
        { sender: user2.id, recipient: user1.id, payload: "No problem", time: now - 1000 },
        { sender: user1.id, recipient: user2.id, payload: "Latest", time: now },
      ];

      for (const msg of messages) {
        await db.insert(schema.messages).values({
          id: nanoid(),
          senderUserId: msg.sender,
          senderAgent: "test-agent",
          recipientType: "user",
          recipientId: msg.recipient,
          payload: msg.payload,
          status: "delivered",
          createdAt: new Date(msg.time),
        });
      }

      const interactions = await getRecentInteractions(user1.id, user2.id, 5);

      expect(interactions).toHaveLength(5);
      // Should be in chronological order (oldest first)
      expect(interactions[0].message).toBe("First message");
      expect(interactions[0].direction).toBe("sent");
      expect(interactions[1].message).toBe("Reply");
      expect(interactions[1].direction).toBe("received");
      expect(interactions[4].message).toBe("Latest");
      expect(interactions[4].direction).toBe("sent");
    });

    it("should respect the limit parameter", async () => {
      const db = getTestDb();
      const { user: user1 } = await createTestUser("interaction_user12");
      const { user: user2 } = await createTestUser("interaction_user13");

      // Create 10 messages
      for (let i = 0; i < 10; i++) {
        await db.insert(schema.messages).values({
          id: nanoid(),
          senderUserId: user1.id,
          senderAgent: "test-agent",
          recipientType: "user",
          recipientId: user2.id,
          payload: `Message ${i}`,
          status: "delivered",
        });
      }

      const interactions = await getRecentInteractions(user1.id, user2.id, 3);
      expect(interactions).toHaveLength(3);
    });

    it("should include correct direction for each message", async () => {
      const db = getTestDb();
      const { user: user1 } = await createTestUser("interaction_user14");
      const { user: user2 } = await createTestUser("interaction_user15");

      // Create mixed messages
      await db.insert(schema.messages).values({
        id: nanoid(),
        senderUserId: user1.id,
        senderAgent: "test-agent",
        recipientType: "user",
        recipientId: user2.id,
        payload: "From user1",
        status: "delivered",
      });

      await db.insert(schema.messages).values({
        id: nanoid(),
        senderUserId: user2.id,
        senderAgent: "test-agent",
        recipientType: "user",
        recipientId: user1.id,
        payload: "From user2",
        status: "delivered",
      });

      const interactions = await getRecentInteractions(user1.id, user2.id);

      const sentInteraction = interactions.find((i) => i.message === "From user1");
      const receivedInteraction = interactions.find((i) => i.message === "From user2");

      expect(sentInteraction?.direction).toBe("sent");
      expect(receivedInteraction?.direction).toBe("received");
    });
  });
});
