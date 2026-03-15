import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type FixtureKind = "gateway" | "mahilo";

const kind = readFixtureKind(process.env.FIXTURE_KIND);
const port = readRequiredInteger(process.env.PORT, "PORT");
const readinessStatusCode = readOptionalInteger(
  process.env.READINESS_STATUS_CODE,
  200,
  "READINESS_STATUS_CODE",
);
const startupDelayMs = readOptionalInteger(
  process.env.STARTUP_DELAY_MS,
  0,
  "STARTUP_DELAY_MS",
);
const ignoreSigterm = process.env.IGNORE_SIGTERM === "1";

let server:
  | ReturnType<typeof createServer>
  | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;

startupTimer = setTimeout(() => {
  server = createServer((request, response) => {
    handleRequest(kind, request, response);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[fixture:${kind}] listening on ${port}`);
  });
}, startupDelayMs);

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  if (ignoreSigterm) {
    console.log(`[fixture:${kind}] ignoring SIGTERM`);
    return;
  }

  shutdown("SIGTERM");
});

function handleRequest(
  currentKind: FixtureKind,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if (currentKind === "mahilo" && request.url === "/health") {
    const body = JSON.stringify({
      status: readinessStatusCode === 200 ? "healthy" : "unhealthy",
    });

    response.writeHead(readinessStatusCode, {
      "content-type": "application/json",
    });
    response.end(body);
    return;
  }

  if (
    currentKind === "gateway" &&
    request.url === "/mahilo/incoming" &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    response.writeHead(readinessStatusCode, {
      "content-type": "application/json",
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    response.end(
      JSON.stringify({
        status: readinessStatusCode === 200 ? "ready" : "not_ready",
      }),
    );
    return;
  }

  response.writeHead(404, {
    "content-type": "application/json",
  });
  response.end(
    JSON.stringify({
      error: "not_found",
    }),
  );
}

function shutdown(signal: string): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  console.log(`[fixture:${kind}] shutting down via ${signal}`);

  if (!server) {
    process.exit(0);
    return;
  }

  server.close(() => {
    process.exit(0);
  });
}

function readFixtureKind(value: string | undefined): FixtureKind {
  if (value === "mahilo") {
    return "mahilo";
  }

  return "gateway";
}

function readRequiredInteger(
  value: string | undefined,
  label: string,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function readOptionalInteger(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  return parsed;
}
