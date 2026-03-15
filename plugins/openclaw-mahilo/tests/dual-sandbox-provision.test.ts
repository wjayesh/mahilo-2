import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";

import { config } from "../../../src/config";
import * as schema from "../../../src/db/schema";
import { createApp } from "../../../src/server";
import {
  createDualSandboxBootstrap,
} from "../scripts/dual-sandbox-bootstrap-lib";
import {
  provisionDualSandboxUsers,
} from "../scripts/dual-sandbox-provision-lib";
import {
  cleanupTestDatabase,
  getTestDb,
  setupTestDatabase,
} from "../../../tests/helpers/setup";

const ADMIN_API_KEY = "sandbox-admin-key";
const cleanupPaths: string[] = [];

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function trackPath(path: string): string {
  cleanupPaths.push(path);
  return path;
}

function createFreshExplicitRoot(): string {
  const parent = trackPath(mkdtempSync(join(tmpdir(), "mahilo-dual-sandbox-")));
  return join(parent, "run-root");
}

function createHarnessFetch(
  app: ReturnType<typeof createApp>,
  requests: Array<{
    body: unknown;
    method: string;
    path: string;
  }>,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init?.method ?? "GET";
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof ArrayBuffer
          ? new TextDecoder().decode(init.body)
          : "";

    requests.push({
      body: bodyText ? JSON.parse(bodyText) : null,
      method,
      path: `${url.pathname}${url.search}`,
    });

    return app.request(`${url.pathname}${url.search}`, init);
  };
}

beforeEach(async () => {
  await setupTestDatabase();
  (config as { adminApiKey: string }).adminApiKey = ADMIN_API_KEY;
});

afterEach(() => {
  (config as { adminApiKey: string }).adminApiKey = "";
  cleanupTestDatabase();

  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (!path) {
      continue;
    }

    rmSync(path, {
      force: true,
      recursive: true,
    });
  }
});

describe("dual sandbox provisioning", () => {
  it("creates two invite-backed active users and writes redacted artifact summaries", async () => {
    const app = createApp();
    const requests: Array<{
      body: unknown;
      method: string;
      path: string;
    }> = [];
    const bootstrap = createDualSandboxBootstrap({
      rootPath: createFreshExplicitRoot(),
    });

    const runtimeSummary = await provisionDualSandboxUsers(bootstrap, {
      adminApiKey: ADMIN_API_KEY,
      fetchImpl: createHarnessFetch(app, requests),
    });

    expect(runtimeSummary.provisioning).toMatchObject({
      current_phase: "users",
      fallback_only: false,
      plugin_protected_route_probe_path: "/api/v1/plugin/reviews?limit=1",
      provisioning_mode: "api",
    });
    expect(runtimeSummary.provisioning.sandboxes.a.registration_flow).toBe(
      "invite_token_register",
    );
    expect(runtimeSummary.provisioning.sandboxes.b.registration_flow).toBe(
      "invite_token_register",
    );
    expect(runtimeSummary.provisioning.sandboxes.a.registration_source).toBe(
      "invite",
    );
    expect(runtimeSummary.provisioning.sandboxes.b.registration_source).toBe(
      "invite",
    );
    expect(runtimeSummary.provisioning.sandboxes.a.status).toBe("active");
    expect(runtimeSummary.provisioning.sandboxes.b.status).toBe("active");
    expect(runtimeSummary.provisioning.sandboxes.a.verified).toBe(true);
    expect(runtimeSummary.provisioning.sandboxes.b.verified).toBe(true);
    expect(runtimeSummary.provisioning.sandboxes.a.api_key).toBeTruthy();
    expect(runtimeSummary.provisioning.sandboxes.b.api_key).toBeTruthy();
    expect(
      runtimeSummary.provisioning.sandboxes.a.plugin_route_probe.status_code,
    ).toBe(200);
    expect(
      runtimeSummary.provisioning.sandboxes.b.plugin_route_probe.status_code,
    ).toBe(200);

    const registerRequests = requests.filter(
      (request) => request.path === "/api/v1/auth/register",
    );
    expect(registerRequests).toHaveLength(2);
    for (const request of registerRequests) {
      expect(request.method).toBe("POST");
      expect(request.body).toEqual(
        expect.objectContaining({
          invite_token: expect.any(String),
          username: expect.any(String),
        }),
      );
    }

    const inviteRequests = requests.filter(
      (request) => request.path === "/api/v1/admin/invite-tokens",
    );
    expect(inviteRequests).toHaveLength(2);
    for (const request of inviteRequests) {
      expect(request.body).toEqual(
        expect.objectContaining({
          max_uses: 1,
          note: expect.stringContaining("SBX-020"),
        }),
      );
    }

    const authMeRequests = requests.filter(
      (request) => request.path === "/api/v1/auth/me",
    );
    expect(authMeRequests).toHaveLength(2);

    expect(readJsonFile(bootstrap.paths.runtime_provisioning_path)).toEqual(
      runtimeSummary,
    );
    expect(readJsonFile(bootstrap.paths.artifact_bootstrap_summary_path)).toMatchObject(
      {
        provisioning: {
          sandboxes: {
            a: {
              api_key: "<redacted>",
            },
            b: {
              api_key: "<redacted>",
            },
          },
        },
      },
    );

    const db = getTestDb();
    const users = await db
      .select({
        registrationSource: schema.users.registrationSource,
        status: schema.users.status,
        username: schema.users.username,
      })
      .from(schema.users)
      .where(
        inArray(schema.users.username, [
          runtimeSummary.provisioning.sandboxes.a.username,
          runtimeSummary.provisioning.sandboxes.b.username,
        ]),
      );

    expect(users).toHaveLength(2);
    for (const user of users) {
      expect(user.registrationSource).toBe("invite");
      expect(user.status).toBe("active");
    }
  });
});
