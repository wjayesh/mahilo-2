import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../server";
import { requireAuth } from "../middleware/auth";
import {
  getAvailableRoles,
  createCustomRole,
} from "../services/roles";

// Validation schemas
const createRoleSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_]*$/,
      "Name must start with a letter and contain only alphanumeric characters and underscores"
    ),
  description: z.string().max(500).optional(),
});

// Create router
export const rolesRoutes = new Hono<AppEnv>();

// Apply auth middleware to all routes
rolesRoutes.use("*", requireAuth());

/**
 * GET /api/v1/roles
 * List all available roles (system + user's custom roles)
 * Query params:
 *   - type: 'system' | 'custom' (optional filter)
 */
rolesRoutes.get("/", async (c) => {
  const user = c.get("user")!;
  const typeParam = c.req.query("type");

  // Validate type parameter
  let type: "system" | "custom" | undefined;
  if (typeParam) {
    if (typeParam !== "system" && typeParam !== "custom") {
      return c.json(
        { error: "Invalid type parameter. Must be 'system' or 'custom'" },
        400
      );
    }
    type = typeParam;
  }

  const roles = await getAvailableRoles(user.id, type);

  return c.json({
    roles: roles.map((r) => ({
      name: r.name,
      description: r.description,
      is_system: r.isSystem,
    })),
  });
});

/**
 * POST /api/v1/roles
 * Create a custom role for the authenticated user
 */
rolesRoutes.post(
  "/",
  zValidator("json", createRoleSchema),
  async (c) => {
    const user = c.get("user")!;
    const body = c.req.valid("json");

    try {
      const role = await createCustomRole(user.id, body.name, body.description);

      return c.json(
        {
          id: role.id,
          name: role.name,
          description: role.description,
          is_system: false,
        },
        201
      );
    } catch (error) {
      if (error instanceof Error) {
        if (
          error.message.includes("reserved name") ||
          error.message.includes("already exists")
        ) {
          return c.json({ error: error.message }, 409);
        }
        if (error.message.includes("must start with")) {
          return c.json({ error: error.message }, 400);
        }
      }
      throw error;
    }
  }
);
