import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { requireAuth } from "../middleware/auth";

export const preferencesRoutes = new Hono<AppEnv>();

// Use auth middleware for all routes
preferencesRoutes.use("*", requireAuth());

// Get user preferences
preferencesRoutes.get("/", async (c) => {
  const user = c.get("user")!;
  const db = getDb();

  const [prefs] = await db
    .select()
    .from(schema.userPreferences)
    .where(eq(schema.userPreferences.userId, user.id))
    .limit(1);

  if (!prefs) {
    // Return defaults if no preferences exist
    return c.json({
      preferred_channel: null,
      urgent_behavior: "preferred_only",
      quiet_hours: {
        enabled: false,
        start: "22:00",
        end: "07:00",
        timezone: "UTC",
      },
      default_llm_provider: null,
      default_llm_model: null,
    });
  }

  return c.json({
    preferred_channel: prefs.preferredChannel,
    urgent_behavior: prefs.urgentBehavior,
    quiet_hours: {
      enabled: prefs.quietHoursEnabled,
      start: prefs.quietHoursStart,
      end: prefs.quietHoursEnd,
      timezone: prefs.quietHoursTimezone,
    },
    default_llm_provider: prefs.defaultLlmProvider,
    default_llm_model: prefs.defaultLlmModel,
  });
});

// Update user preferences (partial update via PATCH)
const updatePreferencesSchema = z.object({
  preferred_channel: z.string().max(50).nullable().optional(),
  urgent_behavior: z.enum(["all_channels", "preferred_only"]).optional(),
  quiet_hours: z
    .object({
      enabled: z.boolean().optional(),
      start: z
        .string()
        .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Must be HH:MM format")
        .optional(),
      end: z
        .string()
        .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Must be HH:MM format")
        .optional(),
      timezone: z.string().max(50).optional(),
    })
    .optional(),
  default_llm_provider: z.string().max(50).nullable().optional(),
  default_llm_model: z.string().max(100).nullable().optional(),
});

preferencesRoutes.patch("/", zValidator("json", updatePreferencesSchema), async (c) => {
  const user = c.get("user")!;
  const data = c.req.valid("json");
  const db = getDb();

  // Check if preferences exist
  const [existing] = await db
    .select()
    .from(schema.userPreferences)
    .where(eq(schema.userPreferences.userId, user.id))
    .limit(1);

  // Build update object
  const updates: Partial<typeof schema.userPreferences.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (data.preferred_channel !== undefined) {
    updates.preferredChannel = data.preferred_channel;
  }
  if (data.urgent_behavior !== undefined) {
    updates.urgentBehavior = data.urgent_behavior;
  }
  if (data.quiet_hours) {
    if (data.quiet_hours.enabled !== undefined) {
      updates.quietHoursEnabled = data.quiet_hours.enabled;
    }
    if (data.quiet_hours.start !== undefined) {
      updates.quietHoursStart = data.quiet_hours.start;
    }
    if (data.quiet_hours.end !== undefined) {
      updates.quietHoursEnd = data.quiet_hours.end;
    }
    if (data.quiet_hours.timezone !== undefined) {
      updates.quietHoursTimezone = data.quiet_hours.timezone;
    }
  }
  if (data.default_llm_provider !== undefined) {
    updates.defaultLlmProvider = data.default_llm_provider;
  }
  if (data.default_llm_model !== undefined) {
    updates.defaultLlmModel = data.default_llm_model;
  }

  if (existing) {
    // Update existing preferences
    await db
      .update(schema.userPreferences)
      .set(updates)
      .where(eq(schema.userPreferences.userId, user.id));
  } else {
    // Create new preferences with defaults + updates
    await db.insert(schema.userPreferences).values({
      userId: user.id,
      preferredChannel: updates.preferredChannel ?? null,
      urgentBehavior: updates.urgentBehavior ?? "preferred_only",
      quietHoursEnabled: updates.quietHoursEnabled ?? false,
      quietHoursStart: updates.quietHoursStart ?? "22:00",
      quietHoursEnd: updates.quietHoursEnd ?? "07:00",
      quietHoursTimezone: updates.quietHoursTimezone ?? "UTC",
      defaultLlmProvider: updates.defaultLlmProvider ?? null,
      defaultLlmModel: updates.defaultLlmModel ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // Return updated preferences
  const [prefs] = await db
    .select()
    .from(schema.userPreferences)
    .where(eq(schema.userPreferences.userId, user.id))
    .limit(1);

  return c.json({
    preferred_channel: prefs.preferredChannel,
    urgent_behavior: prefs.urgentBehavior,
    quiet_hours: {
      enabled: prefs.quietHoursEnabled,
      start: prefs.quietHoursStart,
      end: prefs.quietHoursEnd,
      timezone: prefs.quietHoursTimezone,
    },
    default_llm_provider: prefs.defaultLlmProvider,
    default_llm_model: prefs.defaultLlmModel,
  });
});
