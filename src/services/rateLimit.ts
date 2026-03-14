type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export type FixedWindowRateLimitResult = {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

const DEFAULT_WINDOW_MS = 60 * 1000;

export function consumeFixedWindowRateLimit(
  rateLimits: Map<string, RateLimitEntry>,
  key: string,
  limit: number,
  options: {
    now?: number;
    windowMs?: number;
  } = {},
): FixedWindowRateLimitResult {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const existingEntry = rateLimits.get(key);

  if (!existingEntry || existingEntry.resetAt <= now) {
    const resetAt = now + windowMs;
    rateLimits.set(key, {
      count: 1,
      resetAt,
    });

    return {
      allowed: true,
      count: 1,
      limit,
      remaining: Math.max(0, limit - 1),
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)),
    };
  }

  if (existingEntry.count >= limit) {
    return {
      allowed: false,
      count: existingEntry.count,
      limit,
      remaining: 0,
      resetAt: existingEntry.resetAt,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((existingEntry.resetAt - now) / 1000),
      ),
    };
  }

  existingEntry.count += 1;
  rateLimits.set(key, existingEntry);

  return {
    allowed: true,
    count: existingEntry.count,
    limit,
    remaining: Math.max(0, limit - existingEntry.count),
    resetAt: existingEntry.resetAt,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((existingEntry.resetAt - now) / 1000),
    ),
  };
}

export function readClientRateLimitKey(c: {
  req: { header: (name: string) => string | undefined };
}): string | null {
  const headerCandidates = [
    c.req.header("cf-connecting-ip"),
    c.req.header("x-real-ip"),
    c.req.header("x-forwarded-for")?.split(",")[0],
  ];

  for (const candidate of headerCandidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return `ip:${trimmed}`;
    }
  }

  return null;
}
