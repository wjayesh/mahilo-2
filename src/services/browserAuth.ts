import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { customAlphabet, nanoid } from "nanoid";
import { getDb, schema } from "../db";

const SESSION_TOKEN_PREFIX = "mhls";
const SESSION_ID_LENGTH = 12;
const SESSION_SECRET_LENGTH = 32;
const BROWSER_TOKEN_LENGTH = 32;
const APPROVAL_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const APPROVAL_CODE_LENGTH = 6;
const ACTIVE_BROWSER_SESSION_USER_STATUS = "active";

export const BROWSER_LOGIN_ATTEMPT_TTL_MS = 10 * 60 * 1000;
export const BROWSER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const BROWSER_SESSION_COOKIE_NAME = "__Host-mahilo-session";
export const BROWSER_LOGIN_TOKEN_HEADER = "x-browser-login-token";

const generateApprovalCode = customAlphabet(
  APPROVAL_CODE_ALPHABET,
  APPROVAL_CODE_LENGTH,
);

export type BrowserLoginAttemptStatus =
  | "pending"
  | "approved"
  | "denied"
  | "redeemed"
  | "expired";

export type BrowserLoginAttemptFailureState =
  | "denied"
  | "expired"
  | "rate_limited"
  | "replayed"
  | "superseded";

export type BrowserLoginAttemptFailure = {
  at: Date | null;
  code: string | null;
  message: string | null;
  state: BrowserLoginAttemptFailureState | null;
};

function hashOpaqueToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeHashEquals(expectedHash: string, candidateHash: string): boolean {
  const expectedBuffer = Buffer.from(expectedHash, "hex");
  const candidateBuffer = Buffer.from(candidateHash, "hex");

  if (expectedBuffer.length !== candidateBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, candidateBuffer);
}

export function createBrowserLoginAttemptArtifacts() {
  const browserToken = nanoid(BROWSER_TOKEN_LENGTH);

  return {
    approvalCode: generateApprovalCode(),
    browserToken,
    browserTokenHash: hashOpaqueToken(browserToken),
    expiresAt: new Date(Date.now() + BROWSER_LOGIN_ATTEMPT_TTL_MS),
  };
}

export function getBrowserLoginAttemptStatus(
  attempt: Pick<
    schema.BrowserLoginAttempt,
    "approvedAt" | "deniedAt" | "expiresAt" | "redeemedAt"
  >,
  now = new Date(),
): BrowserLoginAttemptStatus {
  if (attempt.redeemedAt) {
    return "redeemed";
  }

  if (attempt.deniedAt) {
    return "denied";
  }

  if (attempt.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }

  if (attempt.approvedAt) {
    return "approved";
  }

  return "pending";
}

export function getBrowserLoginAttemptFailure(
  attempt: Pick<
    schema.BrowserLoginAttempt,
    | "deniedAt"
    | "expiresAt"
    | "failureAt"
    | "failureCode"
    | "failureMessage"
    | "failureState"
    | "approvedAt"
    | "redeemedAt"
  >,
  now = new Date(),
): BrowserLoginAttemptFailure {
  if (
    attempt.failureCode ||
    attempt.failureMessage ||
    attempt.failureState ||
    attempt.failureAt
  ) {
    return {
      at: attempt.failureAt ?? null,
      code: attempt.failureCode ?? null,
      message: attempt.failureMessage ?? null,
      state: (attempt.failureState as BrowserLoginAttemptFailureState | null) ??
        null,
    };
  }

  const status = getBrowserLoginAttemptStatus(attempt, now);
  if (status === "denied") {
    return {
      at: attempt.deniedAt ?? null,
      code: "LOGIN_ATTEMPT_DENIED",
      message: "Configured agent denied this browser sign-in.",
      state: "denied",
    };
  }

  if (status === "expired") {
    return {
      at: attempt.expiresAt ?? null,
      code: "LOGIN_ATTEMPT_EXPIRED",
      message: "Login attempt expired before sign-in finished.",
      state: "expired",
    };
  }

  return {
    at: null,
    code: null,
    message: null,
    state: null,
  };
}

export function clearBrowserLoginAttemptFailure() {
  return {
    failureAt: null,
    failureCode: null,
    failureMessage: null,
    failureState: null,
  };
}

export function verifyBrowserLoginToken(
  expectedHash: string,
  browserToken: string,
): boolean {
  return safeHashEquals(expectedHash, hashOpaqueToken(browserToken));
}

export function generateBrowserSession() {
  const sessionId = nanoid(SESSION_ID_LENGTH);
  const secret = nanoid(SESSION_SECRET_LENGTH);
  const sessionToken = `${SESSION_TOKEN_PREFIX}_${sessionId}_${secret}`;

  return {
    sessionId,
    sessionToken,
    sessionTokenHash: hashOpaqueToken(sessionToken),
    expiresAt: new Date(Date.now() + BROWSER_SESSION_TTL_MS),
  };
}

export function parseBrowserSessionToken(
  sessionToken: string,
): { prefix: string; sessionId: string; secret: string } | null {
  const prefix = `${SESSION_TOKEN_PREFIX}_`;
  if (!sessionToken.startsWith(prefix)) {
    return null;
  }

  const rest = sessionToken.slice(prefix.length);
  if (rest.length <= SESSION_ID_LENGTH + 1) {
    return null;
  }

  const sessionId = rest.slice(0, SESSION_ID_LENGTH);
  if (rest[SESSION_ID_LENGTH] !== "_") {
    return null;
  }

  const secret = rest.slice(SESSION_ID_LENGTH + 1);
  if (!secret) {
    return null;
  }

  return {
    prefix: SESSION_TOKEN_PREFIX,
    sessionId,
    secret,
  };
}

export async function verifyBrowserSessionToken(
  sessionToken: string,
): Promise<{ session: schema.BrowserSession; user: schema.User } | null> {
  const parsed = parseBrowserSessionToken(sessionToken);
  if (!parsed) {
    return null;
  }

  const db = getDb();
  const now = new Date();
  const [session] = await db
    .select()
    .from(schema.browserSessions)
    .where(
      and(
        eq(schema.browserSessions.id, parsed.sessionId),
        isNull(schema.browserSessions.revokedAt),
        gt(schema.browserSessions.expiresAt, now),
      ),
    )
    .limit(1);

  if (!session) {
    return null;
  }

  if (
    !safeHashEquals(session.sessionTokenHash, hashOpaqueToken(sessionToken))
  ) {
    return null;
  }

  const [user] = await db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.id, session.userId),
        eq(schema.users.status, ACTIVE_BROWSER_SESSION_USER_STATUS),
        isNull(schema.users.deletedAt),
      ),
    )
    .limit(1);

  if (!user) {
    return null;
  }

  return {
    session,
    user,
  };
}
