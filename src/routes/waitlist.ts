import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";

export const waitlistRoutes = new Hono<AppEnv>();

waitlistRoutes.post(
  "/",
  zValidator(
    "json",
    z.object({
      email: z.string().email(),
    })
  ),
  async (c) => {
    const { email } = c.req.valid("json");
    const db = getDb();
    const normalizedEmail = email.toLowerCase();

    // Check if already on waitlist
    const existing = await db
      .select()
      .from(schema.waitlistEmails)
      .where(eq(schema.waitlistEmails.email, normalizedEmail))
      .limit(1);

    if (existing.length > 0) {
      return c.json({ message: "You're already on the list" });
    }

    await db.insert(schema.waitlistEmails).values({
      id: nanoid(),
      email: normalizedEmail,
    });

    return c.json({ message: "You're on the list" }, 201);
  }
);
