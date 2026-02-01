import { eq, and, isNull, or } from "drizzle-orm";
import { getDb } from "../db";
import { userRoles, friendRoles, friendships } from "../db/schema";
import { nanoid } from "nanoid";

// System roles that are available to all users
export const SYSTEM_ROLES = [
  { name: "close_friends", description: "Highest trust tier - share most info" },
  { name: "friends", description: "Standard friends - share general info" },
  { name: "acquaintances", description: "Casual contacts - limited sharing" },
  { name: "work_contacts", description: "Professional context only" },
  { name: "family", description: "Family members - high trust" },
] as const;

export type SystemRoleName = (typeof SYSTEM_ROLES)[number]["name"];

/**
 * Seeds system roles on server startup (idempotent)
 * These roles are available to all users and cannot be modified
 */
export async function seedSystemRoles(): Promise<void> {
  const db = getDb();

  console.log("Seeding system roles...");

  for (const role of SYSTEM_ROLES) {
    // Check if role already exists (system roles have userId = NULL)
    const existing = await db
      .select()
      .from(userRoles)
      .where(and(isNull(userRoles.userId), eq(userRoles.name, role.name)))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(userRoles).values({
        id: `role_${nanoid(12)}`,
        userId: null,
        name: role.name,
        description: role.description,
        isSystem: true,
      });
      console.log(`  Created system role: ${role.name}`);
    }
  }

  console.log("System roles seeded successfully");
}

/**
 * Get all available roles for a user (system + custom)
 */
export async function getAvailableRoles(
  userId: string,
  type?: "system" | "custom"
): Promise<{ name: string; description: string | null; isSystem: boolean }[]> {
  const db = getDb();

  if (type === "system") {
    // Only system roles
    const roles = await db
      .select()
      .from(userRoles)
      .where(eq(userRoles.isSystem, true));
    return roles.map((r) => ({
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
    }));
  } else if (type === "custom") {
    // Only user's custom roles
    const roles = await db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.isSystem, false)));
    return roles.map((r) => ({
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
    }));
  } else {
    // All roles: system + user's custom
    const roles = await db
      .select()
      .from(userRoles)
      .where(or(isNull(userRoles.userId), eq(userRoles.userId, userId)));
    return roles.map((r) => ({
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
    }));
  }
}

/**
 * Create a custom role for a user
 */
export async function createCustomRole(
  userId: string,
  name: string,
  description?: string
): Promise<{ id: string; name: string; description: string | null }> {
  const db = getDb();

  // Validate name format (alphanumeric + underscore only)
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      "Role name must start with a letter and contain only alphanumeric characters and underscores"
    );
  }

  // Check if system role with same name exists
  const systemRole = await db
    .select()
    .from(userRoles)
    .where(and(isNull(userRoles.userId), eq(userRoles.name, name)))
    .limit(1);

  if (systemRole.length > 0) {
    throw new Error(`Cannot create role with reserved name: ${name}`);
  }

  // Check if user already has a role with this name
  const existingRole = await db
    .select()
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.name, name)))
    .limit(1);

  if (existingRole.length > 0) {
    throw new Error(`Role already exists: ${name}`);
  }

  const id = `role_${nanoid(12)}`;
  await db.insert(userRoles).values({
    id,
    userId,
    name,
    description: description || null,
    isSystem: false,
  });

  return { id, name, description: description || null };
}

/**
 * Check if a role name is valid (system or user's custom)
 */
export async function isValidRole(
  userId: string,
  roleName: string
): Promise<boolean> {
  const db = getDb();

  const role = await db
    .select()
    .from(userRoles)
    .where(
      and(
        eq(userRoles.name, roleName),
        or(isNull(userRoles.userId), eq(userRoles.userId, userId))
      )
    )
    .limit(1);

  return role.length > 0;
}

/**
 * Add a role to a friendship
 */
export async function addRoleToFriendship(
  userId: string,
  friendshipId: string,
  roleName: string
): Promise<void> {
  const db = getDb();

  // Verify friendship belongs to user
  const friendship = await db
    .select()
    .from(friendships)
    .where(
      and(
        eq(friendships.id, friendshipId),
        or(
          eq(friendships.requesterId, userId),
          eq(friendships.addresseeId, userId)
        )
      )
    )
    .limit(1);

  if (friendship.length === 0) {
    throw new Error("Friendship not found or access denied");
  }

  // Validate role exists
  const roleValid = await isValidRole(userId, roleName);
  if (!roleValid) {
    throw new Error(`Invalid role: ${roleName}`);
  }

  // Insert (idempotent - ignore if already exists)
  try {
    await db.insert(friendRoles).values({
      friendshipId,
      roleName,
    });
  } catch (e: unknown) {
    // Ignore unique constraint violation (already assigned)
    if (e instanceof Error && !e.message.includes("UNIQUE constraint failed")) {
      throw e;
    }
  }
}

/**
 * Remove a role from a friendship
 */
export async function removeRoleFromFriendship(
  userId: string,
  friendshipId: string,
  roleName: string
): Promise<boolean> {
  const db = getDb();

  // Verify friendship belongs to user
  const friendship = await db
    .select()
    .from(friendships)
    .where(
      and(
        eq(friendships.id, friendshipId),
        or(
          eq(friendships.requesterId, userId),
          eq(friendships.addresseeId, userId)
        )
      )
    )
    .limit(1);

  if (friendship.length === 0) {
    throw new Error("Friendship not found or access denied");
  }

  // Delete the role assignment
  const result = await db
    .delete(friendRoles)
    .where(
      and(
        eq(friendRoles.friendshipId, friendshipId),
        eq(friendRoles.roleName, roleName)
      )
    )
    .returning();

  return result.length > 0;
}

/**
 * Get roles assigned to a friendship
 */
export async function getFriendshipRoles(
  userId: string,
  friendshipId: string
): Promise<string[]> {
  const db = getDb();

  // Verify friendship belongs to user
  const friendship = await db
    .select()
    .from(friendships)
    .where(
      and(
        eq(friendships.id, friendshipId),
        or(
          eq(friendships.requesterId, userId),
          eq(friendships.addresseeId, userId)
        )
      )
    )
    .limit(1);

  if (friendship.length === 0) {
    throw new Error("Friendship not found or access denied");
  }

  const roles = await db
    .select()
    .from(friendRoles)
    .where(eq(friendRoles.friendshipId, friendshipId));

  return roles.map((r) => r.roleName);
}

/**
 * Get roles for a specific friend (by username, for policy evaluation)
 */
export async function getRolesForFriend(
  userId: string,
  friendUserId: string
): Promise<string[]> {
  const db = getDb();

  // Find the friendship between these two users
  const friendship = await db
    .select()
    .from(friendships)
    .where(
      and(
        eq(friendships.status, "accepted"),
        or(
          and(
            eq(friendships.requesterId, userId),
            eq(friendships.addresseeId, friendUserId)
          ),
          and(
            eq(friendships.requesterId, friendUserId),
            eq(friendships.addresseeId, userId)
          )
        )
      )
    )
    .limit(1);

  if (friendship.length === 0) {
    return [];
  }

  const roles = await db
    .select()
    .from(friendRoles)
    .where(eq(friendRoles.friendshipId, friendship[0].id));

  return roles.map((r) => r.roleName);
}
