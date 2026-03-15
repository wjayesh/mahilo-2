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
  DUAL_SANDBOX_AUTH_ARTIFACT_CONTRACT_VERSION,
  provisionDualSandboxUsers,
  readDualSandboxProvisionedRunFromRunRoot,
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
    expect(
      readJsonFile(bootstrap.sandboxes.a.auth_path),
    ).toEqual({
      api_key: runtimeSummary.provisioning.sandboxes.a.api_key,
      contract_version: DUAL_SANDBOX_AUTH_ARTIFACT_CONTRACT_VERSION,
      created_at: runtimeSummary.provisioning.created_at,
      registration_flow:
        runtimeSummary.provisioning.sandboxes.a.registration_flow,
      registration_source:
        runtimeSummary.provisioning.sandboxes.a.registration_source,
      status: runtimeSummary.provisioning.sandboxes.a.status,
      user_id: runtimeSummary.provisioning.sandboxes.a.user_id,
      username: runtimeSummary.provisioning.sandboxes.a.username,
      verified: runtimeSummary.provisioning.sandboxes.a.verified,
    });
    expect(
      readJsonFile(bootstrap.sandboxes.b.auth_path),
    ).toEqual({
      api_key: runtimeSummary.provisioning.sandboxes.b.api_key,
      contract_version: DUAL_SANDBOX_AUTH_ARTIFACT_CONTRACT_VERSION,
      created_at: runtimeSummary.provisioning.created_at,
      registration_flow:
        runtimeSummary.provisioning.sandboxes.b.registration_flow,
      registration_source:
        runtimeSummary.provisioning.sandboxes.b.registration_source,
      status: runtimeSummary.provisioning.sandboxes.b.status,
      user_id: runtimeSummary.provisioning.sandboxes.b.user_id,
      username: runtimeSummary.provisioning.sandboxes.b.username,
      verified: runtimeSummary.provisioning.sandboxes.b.verified,
    });
    expect(
      readJsonFile(bootstrap.sandboxes.a.artifact_paths.auth_redacted_path),
    ).toMatchObject({
      api_key: "<redacted>",
      contract_version: DUAL_SANDBOX_AUTH_ARTIFACT_CONTRACT_VERSION,
      username: runtimeSummary.provisioning.sandboxes.a.username,
    });
    expect(
      readJsonFile(bootstrap.sandboxes.b.artifact_paths.auth_redacted_path),
    ).toMatchObject({
      api_key: "<redacted>",
      contract_version: DUAL_SANDBOX_AUTH_ARTIFACT_CONTRACT_VERSION,
      username: runtimeSummary.provisioning.sandboxes.b.username,
    });

    const registerRequests = requests.filter(
      (request) => request.path === "/api/v1/auth/register",
    );
    expect(registerRequests).toHaveLength(2);
    const inviteTokens: string[] = [];
    for (const request of registerRequests) {
      expect(request.method).toBe("POST");
      expect(request.body).toEqual(
        expect.objectContaining({
          invite_token: expect.any(String),
          username: expect.any(String),
        }),
      );
      inviteTokens.push(
        (request.body as { invite_token: string }).invite_token,
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
          note: expect.stringContaining("SBX-021"),
        }),
      );
    }

    const authMeRequests = requests.filter(
      (request) => request.path === "/api/v1/auth/me",
    );
    expect(authMeRequests).toHaveLength(2);

    const savedRuntimeSummary = readJsonFile<typeof runtimeSummary>(
      bootstrap.paths.runtime_provisioning_path,
    );
    const savedArtifactSummary = readJsonFile<typeof runtimeSummary>(
      bootstrap.paths.artifact_bootstrap_summary_path,
    );
    const savedSandboxAAuth = readJsonFile<Record<string, unknown>>(
      bootstrap.sandboxes.a.auth_path,
    );
    const savedSandboxBAuth = readJsonFile<Record<string, unknown>>(
      bootstrap.sandboxes.b.auth_path,
    );
    const savedSandboxARedactedAuth = readJsonFile<Record<string, unknown>>(
      bootstrap.sandboxes.a.artifact_paths.auth_redacted_path,
    );
    const savedSandboxBRedactedAuth = readJsonFile<Record<string, unknown>>(
      bootstrap.sandboxes.b.artifact_paths.auth_redacted_path,
    );

    expect(savedRuntimeSummary).toEqual(runtimeSummary);
    expect(savedArtifactSummary).toMatchObject({
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
    });

    const persistedRuntimeText = JSON.stringify(savedRuntimeSummary);
    const persistedArtifactText = JSON.stringify(savedArtifactSummary);
    const sandboxAAuthText = JSON.stringify(savedSandboxAAuth);
    const sandboxBAuthText = JSON.stringify(savedSandboxBAuth);
    const sandboxARedactedAuthText = JSON.stringify(savedSandboxARedactedAuth);
    const sandboxBRedactedAuthText = JSON.stringify(savedSandboxBRedactedAuth);
    for (const inviteToken of inviteTokens) {
      expect(persistedRuntimeText).not.toContain(inviteToken);
      expect(persistedArtifactText).not.toContain(inviteToken);
      expect(sandboxAAuthText).not.toContain(inviteToken);
      expect(sandboxBAuthText).not.toContain(inviteToken);
      expect(sandboxARedactedAuthText).not.toContain(inviteToken);
      expect(sandboxBRedactedAuthText).not.toContain(inviteToken);
    }

    expect(
      readDualSandboxProvisionedRunFromRunRoot(bootstrap.run_root),
    ).toEqual(runtimeSummary);

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

  it("fails with a clear error when later phases try to load auth artifacts before provisioning", () => {
    const bootstrap = createDualSandboxBootstrap({
      rootPath: createFreshExplicitRoot(),
    });

    expect(() =>
      readDualSandboxProvisionedRunFromRunRoot(bootstrap.run_root),
    ).toThrow(
      `File ${bootstrap.paths.runtime_provisioning_path} does not contain a valid dual-sandbox provisioning summary.`,
    );
  });

  it("fails with a clear error when a persisted sandbox auth artifact is missing", async () => {
    const app = createApp();
    const bootstrap = createDualSandboxBootstrap({
      rootPath: createFreshExplicitRoot(),
    });

    await provisionDualSandboxUsers(bootstrap, {
      adminApiKey: ADMIN_API_KEY,
      fetchImpl: createHarnessFetch(app, []),
    });
    rmSync(bootstrap.sandboxes.a.auth_path);

    expect(() =>
      readDualSandboxProvisionedRunFromRunRoot(bootstrap.run_root),
    ).toThrow(
      `Expected sandbox a auth artifact at ${bootstrap.sandboxes.a.auth_path} referenced by ${bootstrap.paths.runtime_provisioning_path}.`,
    );
  });
});
