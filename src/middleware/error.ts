import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

export class AppError extends Error {
  public details?: Record<string, unknown>;
  public headers?: Record<string, string>;

  constructor(
    message: string,
    public statusCode: ContentfulStatusCode = 500,
    public code?: string,
    details?: Record<string, unknown>,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
    this.details = details;
    this.headers = headers;
  }
}

export function errorHandler(err: Error, c: Context) {
  console.error("Error:", err);

  if (err instanceof HTTPException) {
    return c.json(
      {
        error: err.message,
        code: "HTTP_ERROR",
      },
      err.status
    );
  }

  if (err instanceof ZodError) {
    return c.json(
      {
        error: "Validation Error",
        code: "VALIDATION_ERROR",
        details: err.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      },
      400
    );
  }

  if (err instanceof AppError) {
    Object.entries(err.headers || {}).forEach(([name, value]) => {
      c.header(name, value);
    });

    return c.json(
      {
        error: err.message,
        code: err.code || "APP_ERROR",
        ...(err.details || {}),
      },
      err.statusCode
    );
  }

  // Generic error
  return c.json(
    {
      error: "Internal Server Error",
      code: "INTERNAL_ERROR",
    },
    500
  );
}
