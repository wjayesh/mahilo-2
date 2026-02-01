import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  cleanupTestDatabase,
  createTestUser,
  createFriendship,
  setupTestDatabase,
  seedTestSystemRoles,
  addRoleToFriendship,
  getTestDb,
} from "../helpers/setup";
import {
  seedSystemRoles,
  getAvailableRoles,
  createCustomRole,
  isValidRole,
  addRoleToFriendship as serviceAddRoleToFriendship,
  removeRoleFromFriendship,
  getFriendshipRoles,
  getRolesForFriend,
  SYSTEM_ROLES,
} from "../../src/services/roles";

describe("Roles Service", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(() => {
    cleanupTestDatabase();
  });

  describe("seedSystemRoles", () => {
    it("should create all system roles", async () => {
      await seedSystemRoles();
      const roles = await getAvailableRoles("any_user_id", "system");

      expect(roles.length).toBe(SYSTEM_ROLES.length);
      expect(roles.map((r) => r.name).sort()).toEqual(
        SYSTEM_ROLES.map((r) => r.name).sort()
      );
      roles.forEach((role) => {
        expect(role.isSystem).toBe(true);
      });
    });

    it("should be idempotent (no duplicates on repeat calls)", async () => {
      await seedSystemRoles();
      await seedSystemRoles();

      const roles = await getAvailableRoles("any_user_id", "system");
      expect(roles.length).toBe(SYSTEM_ROLES.length);
    });
  });

  describe("getAvailableRoles", () => {
    it("should return system roles", async () => {
      const roles = await getAvailableRoles("any_user", "system");

      expect(roles.length).toBeGreaterThan(0);
      roles.forEach((role) => {
        expect(role.isSystem).toBe(true);
      });
    });

    it("should return custom roles for user", async () => {
      const { user } = await createTestUser("rolesuser1");
      await createCustomRole(user.id, "test_custom_role", "My custom role");

      const roles = await getAvailableRoles(user.id, "custom");

      expect(roles.length).toBe(1);
      expect(roles[0].name).toBe("test_custom_role");
      expect(roles[0].isSystem).toBe(false);
    });

    it("should return all roles when no filter", async () => {
      const { user } = await createTestUser("rolesuser2");
      await createCustomRole(user.id, "another_custom", "Another custom role");

      const roles = await getAvailableRoles(user.id);

      // Should include system roles + user's custom role
      expect(roles.length).toBeGreaterThan(SYSTEM_ROLES.length);
      expect(roles.some((r) => r.name === "another_custom")).toBe(true);
      expect(roles.some((r) => r.name === "close_friends")).toBe(true);
    });
  });

  describe("createCustomRole", () => {
    it("should create a custom role", async () => {
      const { user } = await createTestUser("rolesuser3");
      const role = await createCustomRole(user.id, "book_club", "Book club friends");

      expect(role.name).toBe("book_club");
      expect(role.description).toBe("Book club friends");
    });

    it("should reject reserved system role names", async () => {
      const { user } = await createTestUser("rolesuser4");

      await expect(createCustomRole(user.id, "close_friends")).rejects.toThrow(
        "reserved name"
      );
    });

    it("should reject duplicate role names for same user", async () => {
      const { user } = await createTestUser("rolesuser5");
      await createCustomRole(user.id, "unique_role");

      await expect(createCustomRole(user.id, "unique_role")).rejects.toThrow(
        "already exists"
      );
    });

    it("should reject invalid role name format", async () => {
      const { user } = await createTestUser("rolesuser6");

      await expect(createCustomRole(user.id, "123invalid")).rejects.toThrow(
        "must start with a letter"
      );
      await expect(createCustomRole(user.id, "has spaces")).rejects.toThrow(
        "must start with a letter"
      );
    });
  });

  describe("isValidRole", () => {
    it("should return true for system roles", async () => {
      const { user } = await createTestUser("rolesuser7");

      expect(await isValidRole(user.id, "close_friends")).toBe(true);
      expect(await isValidRole(user.id, "family")).toBe(true);
    });

    it("should return true for user's custom roles", async () => {
      const { user } = await createTestUser("rolesuser8");
      await createCustomRole(user.id, "my_valid_role");

      expect(await isValidRole(user.id, "my_valid_role")).toBe(true);
    });

    it("should return false for non-existent roles", async () => {
      const { user } = await createTestUser("rolesuser9");

      expect(await isValidRole(user.id, "nonexistent_role")).toBe(false);
    });

    it("should return false for another user's custom role", async () => {
      const { user: user1 } = await createTestUser("rolesuser10");
      const { user: user2 } = await createTestUser("rolesuser11");
      await createCustomRole(user1.id, "user1_only_role");

      expect(await isValidRole(user2.id, "user1_only_role")).toBe(false);
    });
  });

  describe("Friend Role Management", () => {
    it("should add role to friendship", async () => {
      const { user: user1 } = await createTestUser("rolesfriend1");
      const { user: user2 } = await createTestUser("rolesfriend2");
      const friendship = await createFriendship(user1.id, user2.id, "accepted");

      await serviceAddRoleToFriendship(user1.id, friendship.id, "close_friends");
      const roles = await getFriendshipRoles(user1.id, friendship.id);

      expect(roles).toContain("close_friends");
    });

    it("should be idempotent when adding same role twice", async () => {
      const { user: user1 } = await createTestUser("rolesfriend3");
      const { user: user2 } = await createTestUser("rolesfriend4");
      const friendship = await createFriendship(user1.id, user2.id, "accepted");

      await serviceAddRoleToFriendship(user1.id, friendship.id, "friends");
      await serviceAddRoleToFriendship(user1.id, friendship.id, "friends");
      const roles = await getFriendshipRoles(user1.id, friendship.id);

      expect(roles.filter((r) => r === "friends").length).toBe(1);
    });

    it("should reject invalid role names", async () => {
      const { user: user1 } = await createTestUser("rolesfriend5");
      const { user: user2 } = await createTestUser("rolesfriend6");
      const friendship = await createFriendship(user1.id, user2.id, "accepted");

      await expect(
        serviceAddRoleToFriendship(user1.id, friendship.id, "nonexistent")
      ).rejects.toThrow("Invalid role");
    });

    it("should remove role from friendship", async () => {
      const { user: user1 } = await createTestUser("rolesfriend7");
      const { user: user2 } = await createTestUser("rolesfriend8");
      const friendship = await createFriendship(user1.id, user2.id, "accepted");

      await serviceAddRoleToFriendship(user1.id, friendship.id, "work_contacts");
      await removeRoleFromFriendship(user1.id, friendship.id, "work_contacts");
      const roles = await getFriendshipRoles(user1.id, friendship.id);

      expect(roles).not.toContain("work_contacts");
    });

    it("should return false when removing non-assigned role", async () => {
      const { user: user1 } = await createTestUser("rolesfriend9");
      const { user: user2 } = await createTestUser("rolesfriend10");
      const friendship = await createFriendship(user1.id, user2.id, "accepted");

      const result = await removeRoleFromFriendship(
        user1.id,
        friendship.id,
        "family"
      );
      expect(result).toBe(false);
    });

    it("should reject operations on non-existent friendship", async () => {
      const { user } = await createTestUser("rolesfriend11");

      await expect(
        serviceAddRoleToFriendship(user.id, "nonexistent_friendship", "friends")
      ).rejects.toThrow("not found");
    });
  });

  describe("getRolesForFriend", () => {
    it("should return roles for a friend by user ID", async () => {
      const { user: user1 } = await createTestUser("getrolesuser1");
      const { user: user2 } = await createTestUser("getrolesuser2");
      const friendship = await createFriendship(user1.id, user2.id, "accepted");

      await serviceAddRoleToFriendship(user1.id, friendship.id, "close_friends");
      await serviceAddRoleToFriendship(user1.id, friendship.id, "family");

      const roles = await getRolesForFriend(user1.id, user2.id);

      expect(roles).toContain("close_friends");
      expect(roles).toContain("family");
      expect(roles.length).toBe(2);
    });

    it("should return empty array when not friends", async () => {
      const { user: user1 } = await createTestUser("getrolesuser3");
      const { user: user2 } = await createTestUser("getrolesuser4");
      // No friendship created

      const roles = await getRolesForFriend(user1.id, user2.id);

      expect(roles).toEqual([]);
    });

    it("should return empty array when friendship is pending", async () => {
      const { user: user1 } = await createTestUser("getrolesuser5");
      const { user: user2 } = await createTestUser("getrolesuser6");
      await createFriendship(user1.id, user2.id, "pending");

      const roles = await getRolesForFriend(user1.id, user2.id);

      expect(roles).toEqual([]);
    });
  });
});
