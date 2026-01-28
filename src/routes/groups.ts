import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, and, sql, inArray } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/error";

export const groupRoutes = new Hono<AppEnv>();

// Use auth middleware for all routes
groupRoutes.use("*", requireAuth());

// Create a new group (REG-038)
const createGroupSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, "Group name must be alphanumeric with underscores and hyphens"),
  description: z.string().max(500).optional(),
  invite_only: z.boolean().optional().default(true),
});

groupRoutes.post("/", zValidator("json", createGroupSchema), async (c) => {
  const user = c.get("user")!;
  const data = c.req.valid("json");
  const db = getDb();

  // Check if group name already exists (case-insensitive)
  const [existing] = await db
    .select()
    .from(schema.groups)
    .where(sql`lower(${schema.groups.name}) = lower(${data.name})`)
    .limit(1);

  if (existing) {
    throw new AppError("Group name already exists", 409, "GROUP_EXISTS");
  }

  const groupId = nanoid();
  const membershipId = nanoid();
  const now = new Date();

  // Create group and owner membership in a transaction
  await db.insert(schema.groups).values({
    id: groupId,
    name: data.name,
    description: data.description,
    ownerUserId: user.id,
    inviteOnly: data.invite_only,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.groupMemberships).values({
    id: membershipId,
    groupId,
    userId: user.id,
    role: "owner",
    status: "active",
    createdAt: now,
  });

  return c.json(
    {
      group_id: groupId,
      name: data.name,
      description: data.description,
      invite_only: data.invite_only,
      role: "owner",
    },
    201
  );
});

// List user's groups (REG-039)
groupRoutes.get("/", async (c) => {
  const user = c.get("user")!;
  const db = getDb();

  // Get all groups the user is a member of (active status)
  const memberships = await db
    .select({
      groupId: schema.groupMemberships.groupId,
      role: schema.groupMemberships.role,
      status: schema.groupMemberships.status,
      groupName: schema.groups.name,
      groupDescription: schema.groups.description,
      inviteOnly: schema.groups.inviteOnly,
      ownerUserId: schema.groups.ownerUserId,
      createdAt: schema.groups.createdAt,
    })
    .from(schema.groupMemberships)
    .innerJoin(schema.groups, eq(schema.groupMemberships.groupId, schema.groups.id))
    .where(eq(schema.groupMemberships.userId, user.id));

  // Get member counts for each group
  const groupIds = memberships.map((m) => m.groupId);
  const memberCounts =
    groupIds.length > 0
      ? await db
          .select({
            groupId: schema.groupMemberships.groupId,
            count: sql<number>`count(*)`.as("count"),
          })
          .from(schema.groupMemberships)
          .where(
            and(
              inArray(schema.groupMemberships.groupId, groupIds),
              eq(schema.groupMemberships.status, "active")
            )
          )
          .groupBy(schema.groupMemberships.groupId)
      : [];

  const countMap = new Map(memberCounts.map((mc) => [mc.groupId, mc.count]));

  return c.json(
    memberships.map((m) => ({
      group_id: m.groupId,
      name: m.groupName,
      description: m.groupDescription,
      invite_only: m.inviteOnly,
      role: m.role,
      status: m.status,
      member_count: countMap.get(m.groupId) || 0,
      created_at: m.createdAt?.toISOString(),
    }))
  );
});

// Get group details
groupRoutes.get("/:id", async (c) => {
  const user = c.get("user")!;
  const groupId = c.req.param("id");
  const db = getDb();

  // Check membership
  const [membership] = await db
    .select()
    .from(schema.groupMemberships)
    .where(
      and(
        eq(schema.groupMemberships.groupId, groupId),
        eq(schema.groupMemberships.userId, user.id)
      )
    )
    .limit(1);

  if (!membership) {
    throw new AppError("Group not found or not a member", 404, "NOT_FOUND");
  }

  const [group] = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .limit(1);

  if (!group) {
    throw new AppError("Group not found", 404, "NOT_FOUND");
  }

  // Get member count
  const [memberCount] = await db
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(schema.groupMemberships)
    .where(
      and(
        eq(schema.groupMemberships.groupId, groupId),
        eq(schema.groupMemberships.status, "active")
      )
    );

  return c.json({
    group_id: group.id,
    name: group.name,
    description: group.description,
    invite_only: group.inviteOnly,
    role: membership.role,
    status: membership.status,
    member_count: memberCount?.count || 0,
    created_at: group.createdAt?.toISOString(),
  });
});

// Invite a user to a group (REG-040)
const inviteUserSchema = z.object({
  username: z.string().min(1),
});

groupRoutes.post("/:id/invite", zValidator("json", inviteUserSchema), async (c) => {
  const user = c.get("user")!;
  const groupId = c.req.param("id");
  const data = c.req.valid("json");
  const db = getDb();

  // Check if user is owner or admin of the group
  const [membership] = await db
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

  if (!membership) {
    throw new AppError("Group not found or not a member", 404, "NOT_FOUND");
  }

  if (membership.role !== "owner" && membership.role !== "admin") {
    throw new AppError("Only owners and admins can invite users", 403, "FORBIDDEN");
  }

  // Find the user to invite
  const [targetUser] = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.username}) = lower(${data.username})`)
    .limit(1);

  if (!targetUser) {
    throw new AppError("User not found", 404, "USER_NOT_FOUND");
  }

  // Check if user is already a member
  const [existingMembership] = await db
    .select()
    .from(schema.groupMemberships)
    .where(
      and(
        eq(schema.groupMemberships.groupId, groupId),
        eq(schema.groupMemberships.userId, targetUser.id)
      )
    )
    .limit(1);

  if (existingMembership) {
    if (existingMembership.status === "active") {
      throw new AppError("User is already a member", 409, "ALREADY_MEMBER");
    }
    if (existingMembership.status === "invited") {
      throw new AppError("User already has a pending invite", 409, "ALREADY_INVITED");
    }
  }

  // Create invite membership
  const membershipId = nanoid();
  await db.insert(schema.groupMemberships).values({
    id: membershipId,
    groupId,
    userId: targetUser.id,
    role: "member",
    status: "invited",
    invitedByUserId: user.id,
    createdAt: new Date(),
  });

  return c.json(
    {
      membership_id: membershipId,
      group_id: groupId,
      user_id: targetUser.id,
      username: targetUser.username,
      status: "invited",
    },
    201
  );
});

// Join a group (REG-041)
groupRoutes.post("/:id/join", async (c) => {
  const user = c.get("user")!;
  const groupId = c.req.param("id");
  const db = getDb();

  // Get the group
  const [group] = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .limit(1);

  if (!group) {
    throw new AppError("Group not found", 404, "NOT_FOUND");
  }

  // Check for existing membership
  const [existingMembership] = await db
    .select()
    .from(schema.groupMemberships)
    .where(
      and(
        eq(schema.groupMemberships.groupId, groupId),
        eq(schema.groupMemberships.userId, user.id)
      )
    )
    .limit(1);

  if (existingMembership) {
    if (existingMembership.status === "active") {
      throw new AppError("Already a member of this group", 409, "ALREADY_MEMBER");
    }

    // If user has an invite, accept it
    if (existingMembership.status === "invited") {
      await db
        .update(schema.groupMemberships)
        .set({ status: "active" })
        .where(eq(schema.groupMemberships.id, existingMembership.id));

      return c.json({
        group_id: groupId,
        name: group.name,
        status: "active",
        role: existingMembership.role,
      });
    }
  }

  // If group is invite_only and no invite exists, reject
  if (group.inviteOnly) {
    throw new AppError("This group requires an invitation to join", 403, "INVITE_REQUIRED");
  }

  // Join public group
  const membershipId = nanoid();
  await db.insert(schema.groupMemberships).values({
    id: membershipId,
    groupId,
    userId: user.id,
    role: "member",
    status: "active",
    createdAt: new Date(),
  });

  return c.json({
    group_id: groupId,
    name: group.name,
    status: "active",
    role: "member",
  });
});

// Leave a group (REG-042)
groupRoutes.delete("/:id/leave", async (c) => {
  const user = c.get("user")!;
  const groupId = c.req.param("id");
  const db = getDb();

  // Get the membership
  const [membership] = await db
    .select()
    .from(schema.groupMemberships)
    .where(
      and(
        eq(schema.groupMemberships.groupId, groupId),
        eq(schema.groupMemberships.userId, user.id)
      )
    )
    .limit(1);

  if (!membership) {
    throw new AppError("Not a member of this group", 404, "NOT_FOUND");
  }

  // Owner cannot leave without transferring ownership or deleting the group
  if (membership.role === "owner") {
    // Check if there are other active members to transfer to
    const [otherMember] = await db
      .select()
      .from(schema.groupMemberships)
      .where(
        and(
          eq(schema.groupMemberships.groupId, groupId),
          eq(schema.groupMemberships.status, "active"),
          sql`${schema.groupMemberships.userId} != ${user.id}`
        )
      )
      .limit(1);

    if (otherMember) {
      throw new AppError(
        "Owner cannot leave while other members exist. Transfer ownership first or delete the group.",
        400,
        "OWNER_CANNOT_LEAVE"
      );
    }

    // If owner is the only member, delete the group
    await db.delete(schema.groups).where(eq(schema.groups.id, groupId));

    return c.json({ success: true, group_deleted: true });
  }

  // Remove membership
  await db
    .delete(schema.groupMemberships)
    .where(eq(schema.groupMemberships.id, membership.id));

  return c.json({ success: true });
});

// List group members
groupRoutes.get("/:id/members", async (c) => {
  const user = c.get("user")!;
  const groupId = c.req.param("id");
  const db = getDb();

  // Check if user is a member
  const [membership] = await db
    .select()
    .from(schema.groupMemberships)
    .where(
      and(
        eq(schema.groupMemberships.groupId, groupId),
        eq(schema.groupMemberships.userId, user.id)
      )
    )
    .limit(1);

  if (!membership) {
    throw new AppError("Group not found or not a member", 404, "NOT_FOUND");
  }

  // Get all members
  const members = await db
    .select({
      membershipId: schema.groupMemberships.id,
      userId: schema.groupMemberships.userId,
      role: schema.groupMemberships.role,
      status: schema.groupMemberships.status,
      createdAt: schema.groupMemberships.createdAt,
      username: schema.users.username,
      displayName: schema.users.displayName,
    })
    .from(schema.groupMemberships)
    .innerJoin(schema.users, eq(schema.groupMemberships.userId, schema.users.id))
    .where(eq(schema.groupMemberships.groupId, groupId));

  return c.json(
    members.map((m) => ({
      membership_id: m.membershipId,
      user_id: m.userId,
      username: m.username,
      display_name: m.displayName,
      role: m.role,
      status: m.status,
      joined_at: m.createdAt?.toISOString(),
    }))
  );
});

// Transfer ownership (admin endpoint)
const transferOwnershipSchema = z.object({
  new_owner_user_id: z.string().min(1),
});

groupRoutes.post("/:id/transfer", zValidator("json", transferOwnershipSchema), async (c) => {
  const user = c.get("user")!;
  const groupId = c.req.param("id");
  const data = c.req.valid("json");
  const db = getDb();

  // Check if user is owner
  const [membership] = await db
    .select()
    .from(schema.groupMemberships)
    .where(
      and(
        eq(schema.groupMemberships.groupId, groupId),
        eq(schema.groupMemberships.userId, user.id),
        eq(schema.groupMemberships.role, "owner")
      )
    )
    .limit(1);

  if (!membership) {
    throw new AppError("Only the owner can transfer ownership", 403, "FORBIDDEN");
  }

  // Check if new owner is an active member
  const [newOwnerMembership] = await db
    .select()
    .from(schema.groupMemberships)
    .where(
      and(
        eq(schema.groupMemberships.groupId, groupId),
        eq(schema.groupMemberships.userId, data.new_owner_user_id),
        eq(schema.groupMemberships.status, "active")
      )
    )
    .limit(1);

  if (!newOwnerMembership) {
    throw new AppError("New owner must be an active member", 400, "INVALID_NEW_OWNER");
  }

  // Transfer ownership
  await db
    .update(schema.groupMemberships)
    .set({ role: "member" })
    .where(eq(schema.groupMemberships.id, membership.id));

  await db
    .update(schema.groupMemberships)
    .set({ role: "owner" })
    .where(eq(schema.groupMemberships.id, newOwnerMembership.id));

  await db
    .update(schema.groups)
    .set({ ownerUserId: data.new_owner_user_id, updatedAt: new Date() })
    .where(eq(schema.groups.id, groupId));

  return c.json({ success: true, new_owner_user_id: data.new_owner_user_id });
});

// Delete a group (owner only)
groupRoutes.delete("/:id", async (c) => {
  const user = c.get("user")!;
  const groupId = c.req.param("id");
  const db = getDb();

  // Check if user is owner
  const [membership] = await db
    .select()
    .from(schema.groupMemberships)
    .where(
      and(
        eq(schema.groupMemberships.groupId, groupId),
        eq(schema.groupMemberships.userId, user.id),
        eq(schema.groupMemberships.role, "owner")
      )
    )
    .limit(1);

  if (!membership) {
    throw new AppError("Only the owner can delete the group", 403, "FORBIDDEN");
  }

  // Delete the group (memberships will be cascade deleted)
  await db.delete(schema.groups).where(eq(schema.groups.id, groupId));

  return c.json({ success: true });
});
