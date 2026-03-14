import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { AppEnv } from "../server";
import { getDb, schema } from "../db";
import { config } from "../config";
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
  clearBrowserLoginAttemptFailure,
  generateBrowserSession,
  getBrowserLoginAttemptFailure,
  getBrowserLoginAttemptStatus,
  parseBrowserSessionToken,
  verifyBrowserLoginToken,
  verifyBrowserSessionToken,
} from "../services/browserAuth";
import { AppError } from "../middleware/error";
import { createDefaultPoliciesForUser } from "../services/defaultPolicies";
import {
  consumeFixedWindowRateLimit,
  readClientRateLimitKey,
} from "../services/rateLimit";
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

type RateLimitStore = Map<
  string,
  {
    count: number;
    resetAt: number;
  }
>;

const browserLoginStartRateLimits: RateLimitStore = new Map();
const browserLoginApproveRateLimits: RateLimitStore = new Map();
const browserLoginRedeemRateLimits: RateLimitStore = new Map();

function browserLoginErrorDetails(
  failureState: string,
  extra: Record<string, unknown> = {},
) {
  return {
    failure_state: failureState,
    ...extra,
  };
}

function browserLoginRateLimitDetails(
  scope: string,
  result: ReturnType<typeof consumeFixedWindowRateLimit>,
) {
  return browserLoginErrorDetails("rate_limited", {
    limit: result.limit,
    rate_limit_scope: scope,
    retry_after_seconds: result.retryAfterSeconds,
  });
}

async function updateBrowserLoginAttemptFailure(
  db: ReturnType<typeof getDb>,
  attemptId: string,
  update: {
    at?: Date;
    code: string;
    message: string;
    state: string;
  },
) {
  await db
    .update(schema.browserLoginAttempts)
    .set({
      failureAt: update.at ?? new Date(),
      failureCode: update.code,
      failureMessage: update.message,
      failureState: update.state,
    })
    .where(eq(schema.browserLoginAttempts.id, attemptId));
}

function buildBrowserLoginAttemptPayload(
  attempt: schema.BrowserLoginAttempt,
  options: {
    browserToken?: string;
    includeApprovalCode?: boolean;
  } = {},
) {
  const failure = getBrowserLoginAttemptFailure(attempt);

  return {
    attempt_id: attempt.id,
    created_at: attempt.createdAt.toISOString(),
    status: getBrowserLoginAttemptStatus(attempt),
    expires_at: attempt.expiresAt.toISOString(),
    approved_at: attempt.approvedAt?.toISOString() ?? null,
    denied_at: attempt.deniedAt?.toISOString() ?? null,
    redeemed_at: attempt.redeemedAt?.toISOString() ?? null,
    failure_state: failure.state,
    failure_code: failure.code,
    failure_message: failure.message,
    failure_at: failure.at?.toISOString() ?? null,
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
    const startRateLimit = consumeFixedWindowRateLimit(
      browserLoginStartRateLimits,
      readClientRateLimitKey(c) || `browser-login-start:${normalizedUsername}`,
      config.authBrowserLoginStartRateLimitPerMinute,
    );
    if (!startRateLimit.allowed) {
      throw new AppError(
        "Too many browser sign-in attempts. Wait before requesting another code.",
        429,
        "BROWSER_LOGIN_START_RATE_LIMITED",
        browserLoginRateLimitDetails("browser_login_start", startRateLimit),
        {
          "Retry-After": String(startRateLimit.retryAfterSeconds),
        },
      );
    }

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
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx
        .update(schema.browserLoginAttempts)
        .set({
          expiresAt: now,
          failureAt: now,
          failureCode: "LOGIN_ATTEMPT_SUPERSEDED",
          failureMessage:
            "A newer browser sign-in code was issued for this account.",
          failureState: "superseded",
        })
        .where(
          and(
            eq(schema.browserLoginAttempts.userId, targetUser.id),
            isNull(schema.browserLoginAttempts.deniedAt),
            isNull(schema.browserLoginAttempts.redeemedAt),
            gt(schema.browserLoginAttempts.expiresAt, now),
          ),
        );

      await tx.insert(schema.browserLoginAttempts).values({
        id: attemptId,
        userId: targetUser.id,
        approvalCode,
        browserTokenHash,
        expiresAt,
        createdAt: now,
      });
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

authRoutes.get(
  "/browser-login/diagnostics",
  requireAuth(),
  requireActive(),
  async (c) => {
    const user = c.get("user");
    if (!user) {
      throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
    }

    const limitValue = Number.parseInt(c.req.query("limit") || "8", 10);
    const limit =
      Number.isFinite(limitValue) && limitValue > 0
        ? Math.min(limitValue, 20)
        : 8;

    const db = getDb();
    const attempts = await db
      .select()
      .from(schema.browserLoginAttempts)
      .where(eq(schema.browserLoginAttempts.userId, user.id))
      .orderBy(desc(schema.browserLoginAttempts.createdAt))
      .limit(limit);

    return c.json({
      attempts: attempts.map((attempt) =>
        buildBrowserLoginAttemptPayload(attempt, {
          includeApprovalCode: true,
        }),
      ),
      retrieved_at: new Date().toISOString(),
    });
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
        browserLoginErrorDetails("expired"),
      );
    }

    if (status === "redeemed") {
      await updateBrowserLoginAttemptFailure(db, attempt.id, {
        at: now,
        code: "LOGIN_ATTEMPT_ALREADY_REDEEMED",
        message: "Login attempt has already been redeemed",
        state: "replayed",
      });
      throw new AppError(
        "Login attempt has already been redeemed",
        409,
        "LOGIN_ATTEMPT_ALREADY_REDEEMED",
        browserLoginErrorDetails("replayed"),
      );
    }

    if (status === "denied") {
      throw new AppError(
        "Login attempt has been denied",
        409,
        "LOGIN_ATTEMPT_DENIED",
        browserLoginErrorDetails("denied"),
      );
    }

    if (status === "approved") {
      await updateBrowserLoginAttemptFailure(db, attempt.id, {
        at: now,
        code: "LOGIN_ATTEMPT_ALREADY_APPROVED",
        message: "Login attempt has already been approved",
        state: "replayed",
      });
      throw new AppError(
        "Login attempt has already been approved",
        409,
        "LOGIN_ATTEMPT_ALREADY_APPROVED",
        browserLoginErrorDetails("replayed"),
      );
    }

    const approvalRateLimit = consumeFixedWindowRateLimit(
      browserLoginApproveRateLimits,
      user.id,
      config.authBrowserLoginApproveRateLimitPerMinute,
    );
    if (!approvalRateLimit.allowed) {
      await updateBrowserLoginAttemptFailure(db, attempt.id, {
        at: now,
        code: "BROWSER_LOGIN_APPROVE_RATE_LIMITED",
        message: "Too many approval attempts. Wait before approving again.",
        state: "rate_limited",
      });
      throw new AppError(
        "Too many approval attempts. Wait before approving again.",
        429,
        "BROWSER_LOGIN_APPROVE_RATE_LIMITED",
        browserLoginRateLimitDetails("browser_login_approve", approvalRateLimit),
        {
          "Retry-After": String(approvalRateLimit.retryAfterSeconds),
        },
      );
    }

    const [approvedAttempt] = await db
      .update(schema.browserLoginAttempts)
      .set({
        approvedAt: now,
        approvedByUserId: user.id,
        deniedAt: null,
        deniedByUserId: null,
        ...clearBrowserLoginAttemptFailure(),
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
        const currentStatus = getBrowserLoginAttemptStatus(currentAttempt, now);
        if (currentStatus === "approved") {
          await updateBrowserLoginAttemptFailure(db, attempt.id, {
            at: now,
            code: "LOGIN_ATTEMPT_ALREADY_APPROVED",
            message: "Login attempt has already been approved",
            state: "replayed",
          });
          throw new AppError(
            "Login attempt has already been approved",
            409,
            "LOGIN_ATTEMPT_ALREADY_APPROVED",
            browserLoginErrorDetails("replayed"),
          );
        }

        if (currentStatus === "denied") {
          throw new AppError(
            "Login attempt has been denied",
            409,
            "LOGIN_ATTEMPT_DENIED",
            browserLoginErrorDetails("denied"),
          );
        }

        if (currentStatus === "expired") {
          throw new AppError(
            "Login attempt has expired",
            410,
            "LOGIN_ATTEMPT_EXPIRED",
            browserLoginErrorDetails("expired"),
          );
        }

        if (currentStatus === "redeemed") {
          await updateBrowserLoginAttemptFailure(db, attempt.id, {
            at: now,
            code: "LOGIN_ATTEMPT_ALREADY_REDEEMED",
            message: "Login attempt has already been redeemed",
            state: "replayed",
          });
          throw new AppError(
            "Login attempt has already been redeemed",
            409,
            "LOGIN_ATTEMPT_ALREADY_REDEEMED",
            browserLoginErrorDetails("replayed"),
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
        browserLoginErrorDetails("expired"),
      );
    }

    if (status === "redeemed") {
      throw new AppError(
        "Login attempt has already been redeemed",
        409,
        "LOGIN_ATTEMPT_ALREADY_REDEEMED",
        browserLoginErrorDetails("replayed"),
      );
    }

    if (status === "approved") {
      throw new AppError(
        "Login attempt has already been approved",
        409,
        "LOGIN_ATTEMPT_ALREADY_APPROVED",
        browserLoginErrorDetails("replayed"),
      );
    }

    if (status !== "denied") {
      const [deniedAttempt] = await db
        .update(schema.browserLoginAttempts)
        .set({
          deniedAt: now,
          deniedByUserId: user.id,
          failureAt: now,
          failureCode: "LOGIN_ATTEMPT_DENIED",
          failureMessage: "Configured agent denied this browser sign-in.",
          failureState: "denied",
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
              browserLoginErrorDetails("replayed"),
            );
          }

          if (currentStatus === "expired") {
            throw new AppError(
              "Login attempt has expired",
              410,
              "LOGIN_ATTEMPT_EXPIRED",
              browserLoginErrorDetails("expired"),
            );
          }

          if (currentStatus === "redeemed") {
            throw new AppError(
              "Login attempt has already been redeemed",
              409,
              "LOGIN_ATTEMPT_ALREADY_REDEEMED",
              browserLoginErrorDetails("replayed"),
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

  const now = new Date();
  const status = getBrowserLoginAttemptStatus(attempt, now);
  if (status === "expired") {
    throw new AppError(
      "Login attempt has expired",
      410,
      "LOGIN_ATTEMPT_EXPIRED",
      browserLoginErrorDetails("expired"),
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
      browserLoginErrorDetails("denied"),
    );
  }

  if (status === "redeemed") {
    await updateBrowserLoginAttemptFailure(db, attempt.id, {
      at: now,
      code: "LOGIN_ATTEMPT_ALREADY_REDEEMED",
      message: "Login attempt has already been redeemed",
      state: "replayed",
    });
    throw new AppError(
      "Login attempt has already been redeemed",
      409,
      "LOGIN_ATTEMPT_ALREADY_REDEEMED",
      browserLoginErrorDetails("replayed"),
    );
  }

  const redeemRateLimit = consumeFixedWindowRateLimit(
    browserLoginRedeemRateLimits,
    readClientRateLimitKey(c) || `browser-login-redeem:${attempt.id}`,
    config.authBrowserLoginRedeemRateLimitPerMinute,
  );
  if (!redeemRateLimit.allowed) {
    await updateBrowserLoginAttemptFailure(db, attempt.id, {
      at: now,
      code: "BROWSER_LOGIN_REDEEM_RATE_LIMITED",
      message: "Too many redeem attempts. Wait before trying again.",
      state: "rate_limited",
    });
    throw new AppError(
      "Too many redeem attempts. Wait before trying again.",
      429,
      "BROWSER_LOGIN_REDEEM_RATE_LIMITED",
      browserLoginRateLimitDetails("browser_login_redeem", redeemRateLimit),
      {
        "Retry-After": String(redeemRateLimit.retryAfterSeconds),
      },
    );
  }

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
        ...clearBrowserLoginAttemptFailure(),
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
            browserLoginErrorDetails("expired"),
          );
        }

        if (currentStatus === "redeemed") {
          await updateBrowserLoginAttemptFailure(tx, freshAttempt.id, {
            at: now,
            code: "LOGIN_ATTEMPT_ALREADY_REDEEMED",
            message: "Login attempt has already been redeemed",
            state: "replayed",
          });
          throw new AppError(
            "Login attempt has already been redeemed",
            409,
            "LOGIN_ATTEMPT_ALREADY_REDEEMED",
            browserLoginErrorDetails("replayed"),
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

authRoutes.post("/logout", async (c) => {
  const sessionToken = getCookie(c, BROWSER_SESSION_COOKIE_NAME);
  const now = new Date();
  let revoked = false;

  if (sessionToken) {
    const parsedSession = parseBrowserSessionToken(sessionToken);
    const verifiedSession = await verifyBrowserSessionToken(sessionToken);

    if (parsedSession && verifiedSession) {
      const db = getDb();
      const [revokedSession] = await db
        .update(schema.browserSessions)
        .set({
          revokedAt: now,
          lastSeenAt: now,
        })
        .where(
          and(
            eq(schema.browserSessions.id, parsedSession.sessionId),
            isNull(schema.browserSessions.revokedAt),
          ),
        )
        .returning();

      revoked = Boolean(revokedSession);
    }
  }

  setCookie(c, BROWSER_SESSION_COOKIE_NAME, "", {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 0,
    expires: new Date(0),
  });

  return c.json({
    authenticated: false,
    revoked,
    session_cleared: Boolean(sessionToken),
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
