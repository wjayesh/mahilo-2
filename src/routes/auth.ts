import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import {
  ACTIVE_USER_STATUS,
  consumeInviteToken,
  generateApiKey,
  validateUsername,
  verifyInviteToken,
} from "../services/auth";
import {
  BROWSER_LOGIN_TOKEN_HEADER,
  BROWSER_SESSION_COOKIE_NAME,
  BROWSER_SESSION_TTL_MS,
  createBrowserLoginAttemptArtifacts,
  generateBrowserSession,
  getBrowserLoginAttemptStatus,
  verifyBrowserLoginToken,
} from "../services/browserAuth";
import { AppError } from "../middleware/error";
import { createDefaultPoliciesForUser } from "../services/defaultPolicies";
import {
  enforceRegisterRateLimit,
  requireActive,
  requireAuth,
} from "../middleware/auth";

export const authRoutes = new Hono<AppEnv>();

const registerSchema = z
  .object({
    username: z.string().min(3).max(30),
    display_name: z.string().max(100).optional(),
    invite_token: z.string().min(1).optional(),
    inviteToken: z.string().min(1).optional(),
  })
  .refine((data) => Boolean(data.invite_token || data.inviteToken), {
    message: "invite_token is required",
    path: ["invite_token"],
  });

const browserLoginStartSchema = z.object({
  username: z.string().min(3).max(30),
});

const browserLoginApproveSchema = z.object({
  attempt_id: z.string().min(1).optional(),
  approval_code: z.string().min(4).max(12),
});

function buildBrowserLoginAttemptPayload(
  attempt: schema.BrowserLoginAttempt,
  options: {
    browserToken?: string;
    includeApprovalCode?: boolean;
  } = {},
) {
  return {
    attempt_id: attempt.id,
    status: getBrowserLoginAttemptStatus(attempt),
    expires_at: attempt.expiresAt.toISOString(),
    approved_at: attempt.approvedAt?.toISOString() ?? null,
    denied_at: attempt.deniedAt?.toISOString() ?? null,
    redeemed_at: attempt.redeemedAt?.toISOString() ?? null,
    ...(options.includeApprovalCode
      ? { approval_code: attempt.approvalCode }
      : {}),
    ...(options.browserToken ? { browser_token: options.browserToken } : {}),
  };
}

async function resolveBrowserLoginAttemptForActor(
  db: ReturnType<typeof getDb>,
  userId: string,
  params: {
    attemptId?: string;
    approvalCode: string;
  },
) {
  if (params.attemptId) {
    const [existingAttempt] = await db
      .select()
      .from(schema.browserLoginAttempts)
      .where(eq(schema.browserLoginAttempts.id, params.attemptId))
      .limit(1);

    if (!existingAttempt) {
      throw new AppError(
        "Login attempt not found",
        404,
        "LOGIN_ATTEMPT_NOT_FOUND",
      );
    }

    if (existingAttempt.userId !== userId) {
      throw new AppError(
        "Login attempt does not belong to the authenticated user",
        403,
        "LOGIN_ATTEMPT_USER_MISMATCH",
      );
    }

    if (existingAttempt.approvalCode !== params.approvalCode) {
      throw new AppError(
        "Approval code does not match the login attempt",
        400,
        "INVALID_APPROVAL_CODE",
      );
    }

    return existingAttempt;
  }

  const matches = await db
    .select()
    .from(schema.browserLoginAttempts)
    .where(
      and(
        eq(schema.browserLoginAttempts.userId, userId),
        eq(schema.browserLoginAttempts.approvalCode, params.approvalCode),
        isNull(schema.browserLoginAttempts.redeemedAt),
        gt(schema.browserLoginAttempts.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(schema.browserLoginAttempts.createdAt))
    .limit(2);

  if (matches.length === 0) {
    throw new AppError(
      "Login attempt not found",
      404,
      "LOGIN_ATTEMPT_NOT_FOUND",
    );
  }

  if (matches.length > 1) {
    throw new AppError(
      "Approval code matches multiple active login attempts",
      409,
      "AMBIGUOUS_APPROVAL_CODE",
    );
  }

  return matches[0];
}

function readBrowserLoginToken(c: {
  req: { header: (name: string) => string | undefined };
}) {
  const browserToken = c.req.header(BROWSER_LOGIN_TOKEN_HEADER);
  if (!browserToken) {
    throw new AppError(
      "Browser login token is required",
      401,
      "BROWSER_LOGIN_TOKEN_REQUIRED",
    );
  }

  return browserToken;
}

function assertBrowserLoginToken(
  attempt: schema.BrowserLoginAttempt,
  browserToken: string,
) {
  if (!verifyBrowserLoginToken(attempt.browserTokenHash, browserToken)) {
    throw new AppError(
      "Invalid browser login token",
      401,
      "INVALID_BROWSER_LOGIN_TOKEN",
    );
  }
}

authRoutes.post(
  "/register",
  async (c, next) => {
    enforceRegisterRateLimit(c);
    await next();
  },
  zValidator("json", registerSchema),
  async (c) => {
    const { username, display_name, invite_token, inviteToken } =
      c.req.valid("json");
    const normalizedUsername = username.toLowerCase();
    const inviteTokenValue = invite_token ?? inviteToken;

    const validation = validateUsername(username);
    if (!validation.valid) {
      throw new AppError(validation.error!, 400, "INVALID_USERNAME");
    }

    if (!inviteTokenValue) {
      throw new AppError(
        "Invite token is required",
        400,
        "INVITE_TOKEN_REQUIRED",
      );
    }

    const db = getDb();
    const userId = nanoid();
    let apiKey = "";

    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.username, normalizedUsername))
        .limit(1);

      if (existing.length > 0) {
        throw new AppError("Username already taken", 409, "USERNAME_EXISTS");
      }

      const inviteRecord = await verifyInviteToken(inviteTokenValue, tx);
      if (!inviteRecord) {
        throw new AppError(
          "Invalid or expired invite token",
          403,
          "INVALID_INVITE_TOKEN",
        );
      }

      const generatedKey = await generateApiKey();
      apiKey = generatedKey.apiKey;

      await tx.insert(schema.users).values({
        id: userId,
        username: normalizedUsername,
        displayName: display_name,
        apiKeyHash: generatedKey.hash,
        apiKeyId: generatedKey.keyId,
        status: ACTIVE_USER_STATUS,
        registrationSource: "invite",
        verifiedAt: new Date(),
      });

      const tokenConsumed = await consumeInviteToken(
        inviteRecord.id,
        userId,
        tx,
      );
      if (!tokenConsumed) {
        throw new AppError(
          "Invite token has already been used",
          409,
          "INVITE_TOKEN_EXHAUSTED",
        );
      }
    });

    createDefaultPoliciesForUser(userId).catch((err) => {
      console.error("Failed to create default policies:", err);
    });

    return c.json(
      {
        user_id: userId,
        username: normalizedUsername,
        api_key: apiKey,
        status: ACTIVE_USER_STATUS,
        verified: true,
      },
      201,
    );
  },
);

authRoutes.post(
  "/browser-login/attempts",
  zValidator("json", browserLoginStartSchema),
  async (c) => {
    const { username } = c.req.valid("json");
    const validation = validateUsername(username);
    if (!validation.valid) {
      throw new AppError(validation.error!, 400, "INVALID_USERNAME");
    }

    const db = getDb();
    const normalizedUsername = username.toLowerCase();
    const [targetUser] = await db
      .select({
        id: schema.users.id,
        username: schema.users.username,
        status: schema.users.status,
      })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.username, normalizedUsername),
          isNull(schema.users.deletedAt),
        ),
      )
      .limit(1);

    if (!targetUser) {
      throw new AppError("User not found", 404, "USER_NOT_FOUND");
    }

    if (targetUser.status !== ACTIVE_USER_STATUS) {
      throw new AppError(
        "Active invite-backed account required",
        403,
        "USER_NOT_ACTIVE",
      );
    }

    const { approvalCode, browserToken, browserTokenHash, expiresAt } =
      createBrowserLoginAttemptArtifacts();
    const attemptId = nanoid();

    await db.insert(schema.browserLoginAttempts).values({
      id: attemptId,
      userId: targetUser.id,
      approvalCode,
      browserTokenHash,
      expiresAt,
      createdAt: new Date(),
    });

    const [attempt] = await db
      .select()
      .from(schema.browserLoginAttempts)
      .where(eq(schema.browserLoginAttempts.id, attemptId))
      .limit(1);

    if (!attempt) {
      throw new AppError(
        "Failed to create browser login attempt",
        500,
        "BROWSER_LOGIN_ATTEMPT_CREATE_FAILED",
      );
    }

    return c.json(
      buildBrowserLoginAttemptPayload(attempt, {
        browserToken,
        includeApprovalCode: true,
      }),
      201,
    );
  },
);

authRoutes.get("/browser-login/attempts/:attemptId", async (c) => {
  const browserToken = readBrowserLoginToken(c);
  const attemptId = c.req.param("attemptId");
  const db = getDb();
  const [attempt] = await db
    .select()
    .from(schema.browserLoginAttempts)
    .where(eq(schema.browserLoginAttempts.id, attemptId))
    .limit(1);

  if (!attempt) {
    throw new AppError(
      "Login attempt not found",
      404,
      "LOGIN_ATTEMPT_NOT_FOUND",
    );
  }

  assertBrowserLoginToken(attempt, browserToken);

  return c.json(buildBrowserLoginAttemptPayload(attempt));
});

authRoutes.post(
  "/browser-login/approve",
  requireAuth(),
  requireActive(),
  zValidator("json", browserLoginApproveSchema),
  async (c) => {
    const user = c.get("user");
    if (!user) {
      throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
    }

    const { attempt_id, approval_code } = c.req.valid("json");
    const approvalCode = approval_code.trim().toUpperCase();
    const db = getDb();
    const now = new Date();
    let attempt = await resolveBrowserLoginAttemptForActor(db, user.id, {
      attemptId: attempt_id,
      approvalCode,
    });

    const status = getBrowserLoginAttemptStatus(attempt, now);
    if (status === "expired") {
      throw new AppError(
        "Login attempt has expired",
        410,
        "LOGIN_ATTEMPT_EXPIRED",
      );
    }

    if (status === "redeemed") {
      throw new AppError(
        "Login attempt has already been redeemed",
        409,
        "LOGIN_ATTEMPT_ALREADY_REDEEMED",
      );
    }

    if (status === "denied") {
      throw new AppError(
        "Login attempt has been denied",
        409,
        "LOGIN_ATTEMPT_DENIED",
      );
    }

    if (status !== "approved") {
      const [approvedAttempt] = await db
        .update(schema.browserLoginAttempts)
        .set({
          approvedAt: now,
          approvedByUserId: user.id,
          deniedAt: null,
          deniedByUserId: null,
        })
        .where(
          and(
            eq(schema.browserLoginAttempts.id, attempt.id),
            isNull(schema.browserLoginAttempts.approvedAt),
            isNull(schema.browserLoginAttempts.deniedAt),
            isNull(schema.browserLoginAttempts.redeemedAt),
            gt(schema.browserLoginAttempts.expiresAt, now),
          ),
        )
        .returning();

      if (!approvedAttempt) {
        const [currentAttempt] = await db
          .select()
          .from(schema.browserLoginAttempts)
          .where(eq(schema.browserLoginAttempts.id, attempt.id))
          .limit(1);

        if (currentAttempt) {
          const currentStatus = getBrowserLoginAttemptStatus(currentAttempt);
          if (currentStatus === "approved") {
            attempt = currentAttempt;
            return c.json(
              buildBrowserLoginAttemptPayload(attempt, {
                includeApprovalCode: true,
              }),
            );
          }

          if (currentStatus === "denied") {
            throw new AppError(
              "Login attempt has been denied",
              409,
              "LOGIN_ATTEMPT_DENIED",
            );
          }

          if (currentStatus === "expired") {
            throw new AppError(
              "Login attempt has expired",
              410,
              "LOGIN_ATTEMPT_EXPIRED",
            );
          }

          if (currentStatus === "redeemed") {
            throw new AppError(
              "Login attempt has already been redeemed",
              409,
              "LOGIN_ATTEMPT_ALREADY_REDEEMED",
            );
          }
        }

        throw new AppError(
          "Login attempt could not be approved",
          409,
          "LOGIN_ATTEMPT_NOT_APPROVABLE",
        );
      }

      attempt = approvedAttempt;
    }

    return c.json(
      buildBrowserLoginAttemptPayload(attempt, { includeApprovalCode: true }),
    );
  },
);

authRoutes.post(
  "/browser-login/deny",
  requireAuth(),
  requireActive(),
  zValidator("json", browserLoginApproveSchema),
  async (c) => {
    const user = c.get("user");
    if (!user) {
      throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
    }

    const { attempt_id, approval_code } = c.req.valid("json");
    const approvalCode = approval_code.trim().toUpperCase();
    const db = getDb();
    const now = new Date();

    let attempt = await resolveBrowserLoginAttemptForActor(db, user.id, {
      attemptId: attempt_id,
      approvalCode,
    });

    const status = getBrowserLoginAttemptStatus(attempt, now);
    if (status === "expired") {
      throw new AppError(
        "Login attempt has expired",
        410,
        "LOGIN_ATTEMPT_EXPIRED",
      );
    }

    if (status === "redeemed") {
      throw new AppError(
        "Login attempt has already been redeemed",
        409,
        "LOGIN_ATTEMPT_ALREADY_REDEEMED",
      );
    }

    if (status === "approved") {
      throw new AppError(
        "Login attempt has already been approved",
        409,
        "LOGIN_ATTEMPT_ALREADY_APPROVED",
      );
    }

    if (status !== "denied") {
      const [deniedAttempt] = await db
        .update(schema.browserLoginAttempts)
        .set({
          deniedAt: now,
          deniedByUserId: user.id,
        })
        .where(
          and(
            eq(schema.browserLoginAttempts.id, attempt.id),
            isNull(schema.browserLoginAttempts.approvedAt),
            isNull(schema.browserLoginAttempts.deniedAt),
            isNull(schema.browserLoginAttempts.redeemedAt),
            gt(schema.browserLoginAttempts.expiresAt, now),
          ),
        )
        .returning();

      if (!deniedAttempt) {
        const [currentAttempt] = await db
          .select()
          .from(schema.browserLoginAttempts)
          .where(eq(schema.browserLoginAttempts.id, attempt.id))
          .limit(1);

        if (currentAttempt) {
          const currentStatus = getBrowserLoginAttemptStatus(currentAttempt, now);
          if (currentStatus === "denied") {
            attempt = currentAttempt;
            return c.json(
              buildBrowserLoginAttemptPayload(attempt, {
                includeApprovalCode: true,
              }),
            );
          }

          if (currentStatus === "approved") {
            throw new AppError(
              "Login attempt has already been approved",
              409,
              "LOGIN_ATTEMPT_ALREADY_APPROVED",
            );
          }

          if (currentStatus === "expired") {
            throw new AppError(
              "Login attempt has expired",
              410,
              "LOGIN_ATTEMPT_EXPIRED",
            );
          }

          if (currentStatus === "redeemed") {
            throw new AppError(
              "Login attempt has already been redeemed",
              409,
              "LOGIN_ATTEMPT_ALREADY_REDEEMED",
            );
          }
        }

        throw new AppError(
          "Login attempt could not be denied",
          409,
          "LOGIN_ATTEMPT_NOT_DENIABLE",
        );
      }

      attempt = deniedAttempt;
    }

    return c.json(
      buildBrowserLoginAttemptPayload(attempt, { includeApprovalCode: true }),
    );
  },
);

authRoutes.post("/browser-login/attempts/:attemptId/redeem", async (c) => {
  const browserToken = readBrowserLoginToken(c);
  const attemptId = c.req.param("attemptId");
  const db = getDb();
  const [attempt] = await db
    .select()
    .from(schema.browserLoginAttempts)
    .where(eq(schema.browserLoginAttempts.id, attemptId))
    .limit(1);

  if (!attempt) {
    throw new AppError(
      "Login attempt not found",
      404,
      "LOGIN_ATTEMPT_NOT_FOUND",
    );
  }

  assertBrowserLoginToken(attempt, browserToken);

  const status = getBrowserLoginAttemptStatus(attempt);
  if (status === "expired") {
    throw new AppError(
      "Login attempt has expired",
      410,
      "LOGIN_ATTEMPT_EXPIRED",
    );
  }

  if (status === "pending") {
    throw new AppError(
      "Login attempt has not been approved",
      409,
      "LOGIN_ATTEMPT_NOT_APPROVED",
    );
  }

  if (status === "denied") {
    throw new AppError(
      "Login attempt has been denied",
      403,
      "LOGIN_ATTEMPT_DENIED",
    );
  }

  if (status === "redeemed") {
    throw new AppError(
      "Login attempt has already been redeemed",
      409,
      "LOGIN_ATTEMPT_ALREADY_REDEEMED",
    );
  }

  const now = new Date();
  const {
    sessionId,
    sessionToken,
    sessionTokenHash,
    expiresAt: sessionExpiresAt,
  } = generateBrowserSession();

  const result = await db.transaction(async (tx) => {
    const [freshAttempt] = await tx
      .select()
      .from(schema.browserLoginAttempts)
      .where(eq(schema.browserLoginAttempts.id, attempt.id))
      .limit(1);

    if (!freshAttempt) {
      throw new AppError(
        "Login attempt not found",
        404,
        "LOGIN_ATTEMPT_NOT_FOUND",
      );
    }

    const freshStatus = getBrowserLoginAttemptStatus(freshAttempt, now);
    if (freshStatus === "expired") {
      throw new AppError(
        "Login attempt has expired",
        410,
        "LOGIN_ATTEMPT_EXPIRED",
      );
    }

    if (freshStatus === "pending") {
      throw new AppError(
        "Login attempt has not been approved",
        409,
        "LOGIN_ATTEMPT_NOT_APPROVED",
      );
    }

    if (freshStatus === "denied") {
      throw new AppError(
        "Login attempt has been denied",
        403,
        "LOGIN_ATTEMPT_DENIED",
      );
    }

    if (freshStatus === "redeemed") {
      throw new AppError(
        "Login attempt has already been redeemed",
        409,
        "LOGIN_ATTEMPT_ALREADY_REDEEMED",
      );
    }

    const [activeUser] = await tx
      .select({
        id: schema.users.id,
        username: schema.users.username,
        displayName: schema.users.displayName,
        status: schema.users.status,
      })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.id, freshAttempt.userId),
          eq(schema.users.status, ACTIVE_USER_STATUS),
          isNull(schema.users.deletedAt),
        ),
      )
      .limit(1);

    if (!activeUser) {
      throw new AppError("User not found", 404, "USER_NOT_FOUND");
    }

    const [redeemedAttempt] = await tx
      .update(schema.browserLoginAttempts)
      .set({
        redeemedAt: now,
      })
      .where(
        and(
          eq(schema.browserLoginAttempts.id, freshAttempt.id),
          isNull(schema.browserLoginAttempts.redeemedAt),
          gt(schema.browserLoginAttempts.expiresAt, now),
        ),
      )
      .returning();

    if (!redeemedAttempt) {
      const [currentAttempt] = await tx
        .select()
        .from(schema.browserLoginAttempts)
        .where(eq(schema.browserLoginAttempts.id, freshAttempt.id))
        .limit(1);

      if (currentAttempt) {
        const currentStatus = getBrowserLoginAttemptStatus(currentAttempt, now);
        if (currentStatus === "expired") {
          throw new AppError(
            "Login attempt has expired",
            410,
            "LOGIN_ATTEMPT_EXPIRED",
          );
        }

        if (currentStatus === "redeemed") {
          throw new AppError(
            "Login attempt has already been redeemed",
            409,
            "LOGIN_ATTEMPT_ALREADY_REDEEMED",
          );
        }
      }

      throw new AppError(
        "Login attempt could not be redeemed",
        409,
        "LOGIN_ATTEMPT_NOT_REDEEMABLE",
      );
    }

    await tx.insert(schema.browserSessions).values({
      id: sessionId,
      userId: activeUser.id,
      sessionTokenHash,
      expiresAt: sessionExpiresAt,
      createdAt: now,
      lastSeenAt: now,
    });

    return {
      attempt: redeemedAttempt,
      user: activeUser,
    };
  });

  setCookie(c, BROWSER_SESSION_COOKIE_NAME, sessionToken, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: Math.floor(BROWSER_SESSION_TTL_MS / 1000),
    expires: sessionExpiresAt,
  });

  return c.json({
    authenticated: true,
    attempt_id: result.attempt.id,
    status: getBrowserLoginAttemptStatus(result.attempt),
    user_id: result.user.id,
    username: result.user.username,
    display_name: result.user.displayName,
    session_expires_at: sessionExpiresAt.toISOString(),
  });
});

authRoutes.post("/rotate-key", requireAuth(), async (c) => {
  const user = c.get("user");
  if (!user) {
    throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
  }

  const db = getDb();
  const { apiKey, keyId, hash } = await generateApiKey();

  await db
    .update(schema.users)
    .set({
      apiKeyHash: hash,
      apiKeyId: keyId,
    })
    .where(eq(schema.users.id, user.id));

  return c.json({
    api_key: apiKey,
  });
});

authRoutes.get("/me", requireAuth(), async (c) => {
  const user = c.get("user");
  if (!user) {
    throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
  }

  const db = getDb();
  const [fullUser] = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      createdAt: schema.users.createdAt,
      registrationSource: schema.users.registrationSource,
      status: schema.users.status,
      verifiedAt: schema.users.verifiedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);

  if (!fullUser) {
    throw new AppError("User not found", 404, "USER_NOT_FOUND");
  }

  return c.json({
    user_id: fullUser.id,
    username: fullUser.username,
    display_name: fullUser.displayName,
    created_at: fullUser.createdAt?.toISOString(),
    registration_source: fullUser.registrationSource,
    status: fullUser.status,
    verified: fullUser.status === ACTIVE_USER_STATUS,
    verified_at: fullUser.verifiedAt?.toISOString() ?? null,
  });
});
