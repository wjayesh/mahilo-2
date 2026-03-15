import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";

import { config } from "../../../src/config";
import * as schema from "../../../src/db/schema";
import { createApp } from "../../../src/server";
import { MahiloRuntimeBootstrapStore } from "../src";
import { createDualSandboxBootstrap } from "../scripts/dual-sandbox-bootstrap-lib";
import {
  connectDualSandboxGateways,
  DUAL_SANDBOX_CONNECTIONS_CONTRACT_VERSION,
  readDualSandboxConnectedRunFromRunRoot,
  redactConnectedRunSummary,
} from "../scripts/dual-sandbox-connections-lib";
import { provisionDualSandboxUsers } from "../scripts/dual-sandbox-provision-lib";
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
    authorization: string | null;
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
    const headers = new Headers(init?.headers);

    requests.push({
      authorization: headers.get("Authorization"),
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

describe("dual sandbox connection registration", () => {
  it("registers one OpenClaw webhook connection per sandbox and writes runtime bootstrap artifacts", async () => {
    const app = createApp();
    const requests: Array<{
      authorization: string | null;
      body: unknown;
      method: string;
      path: string;
    }> = [];
    const fetchImpl = createHarnessFetch(app, requests);
    const bootstrap = createDualSandboxBootstrap({
      rootPath: createFreshExplicitRoot(),
    });
    const provisioned = await provisionDualSandboxUsers(bootstrap, {
      adminApiKey: ADMIN_API_KEY,
      fetchImpl,
    });

    const connected = await connectDualSandboxGateways(provisioned, {
      fetchImpl,
    });

    expect(connected.provisioning.current_phase).toBe("connections");
    expect(connected.connections).toMatchObject({
      contract_version: DUAL_SANDBOX_CONNECTIONS_CONTRACT_VERSION,
      current_phase: "connections",
      mahilo_base_url: bootstrap.mahilo.base_url,
      sandboxes: {
        a: {
          callback_url: bootstrap.sandboxes.a.callback_url,
          connection_id: expect.any(String),
          framework: "openclaw",
          get_agents_status_code: 200,
          label: "default",
          mode: "webhook",
          post_agents_status_code: 201,
          runtime_bootstrap_path: bootstrap.sandboxes.a.runtime_state_path,
          status: "active",
          updated_existing_connection: false,
        },
        b: {
          callback_url: bootstrap.sandboxes.b.callback_url,
          connection_id: expect.any(String),
          framework: "openclaw",
          get_agents_status_code: 200,
          label: "default",
          mode: "webhook",
          post_agents_status_code: 201,
          runtime_bootstrap_path: bootstrap.sandboxes.b.runtime_state_path,
          status: "active",
          updated_existing_connection: false,
        },
      },
    });

    expect(
      readJsonFile(bootstrap.sandboxes.a.runtime_state_path),
    ).toMatchObject({
      version: 1,
      servers: {
        [bootstrap.mahilo.base_url]: {
          apiKey: provisioned.provisioning.sandboxes.a.api_key,
          callbackConnectionId: connected.connections.sandboxes.a.connection_id,
          callbackSecret: expect.any(String),
          callbackUrl: bootstrap.sandboxes.a.callback_url,
          username: provisioned.provisioning.sandboxes.a.username,
        },
      },
    });
    expect(
      readJsonFile(bootstrap.sandboxes.b.runtime_state_path),
    ).toMatchObject({
      version: 1,
      servers: {
        [bootstrap.mahilo.base_url]: {
          apiKey: provisioned.provisioning.sandboxes.b.api_key,
          callbackConnectionId: connected.connections.sandboxes.b.connection_id,
          callbackSecret: expect.any(String),
          callbackUrl: bootstrap.sandboxes.b.callback_url,
          username: provisioned.provisioning.sandboxes.b.username,
        },
      },
    });

    const sandboxAStore = new MahiloRuntimeBootstrapStore({
      path: bootstrap.sandboxes.a.runtime_state_path,
    });
    const sandboxBStore = new MahiloRuntimeBootstrapStore({
      path: bootstrap.sandboxes.b.runtime_state_path,
    });
    expect(sandboxAStore.diagnose(bootstrap.mahilo.base_url).kind).toBe("ok");
    expect(sandboxBStore.diagnose(bootstrap.mahilo.base_url).kind).toBe("ok");
    expect(sandboxAStore.read(bootstrap.mahilo.base_url)).toMatchObject({
      apiKey: provisioned.provisioning.sandboxes.a.api_key,
      callbackConnectionId: connected.connections.sandboxes.a.connection_id,
      callbackSecret: expect.any(String),
      callbackUrl: bootstrap.sandboxes.a.callback_url,
      username: provisioned.provisioning.sandboxes.a.username,
    });
    expect(sandboxBStore.read(bootstrap.mahilo.base_url)).toMatchObject({
      apiKey: provisioned.provisioning.sandboxes.b.api_key,
      callbackConnectionId: connected.connections.sandboxes.b.connection_id,
      callbackSecret: expect.any(String),
      callbackUrl: bootstrap.sandboxes.b.callback_url,
      username: provisioned.provisioning.sandboxes.b.username,
    });

    expect(
      readJsonFile(
        bootstrap.sandboxes.a.artifact_paths.runtime_state_redacted_path,
      ),
    ).toMatchObject({
      version: 1,
      servers: {
        [bootstrap.mahilo.base_url]: {
          apiKey: "<redacted>",
          callbackConnectionId: connected.connections.sandboxes.a.connection_id,
          callbackSecret: "<redacted>",
          callbackUrl: bootstrap.sandboxes.a.callback_url,
          username: provisioned.provisioning.sandboxes.a.username,
        },
      },
    });
    expect(
      readJsonFile(
        bootstrap.sandboxes.b.artifact_paths.runtime_state_redacted_path,
      ),
    ).toMatchObject({
      version: 1,
      servers: {
        [bootstrap.mahilo.base_url]: {
          apiKey: "<redacted>",
          callbackConnectionId: connected.connections.sandboxes.b.connection_id,
          callbackSecret: "<redacted>",
          callbackUrl: bootstrap.sandboxes.b.callback_url,
          username: provisioned.provisioning.sandboxes.b.username,
        },
      },
    });

    expect(
      readJsonFile(bootstrap.sandboxes.a.artifact_paths.agent_connections_path),
    ).toMatchObject({
      connections: [
        expect.objectContaining({
          callback_url: bootstrap.sandboxes.a.callback_url,
          framework: "openclaw",
          id: connected.connections.sandboxes.a.connection_id,
          label: "default",
          status: "active",
        }),
      ],
      status_code: 200,
    });
    expect(
      readJsonFile(bootstrap.sandboxes.b.artifact_paths.agent_connections_path),
    ).toMatchObject({
      connections: [
        expect.objectContaining({
          callback_url: bootstrap.sandboxes.b.callback_url,
          framework: "openclaw",
          id: connected.connections.sandboxes.b.connection_id,
          label: "default",
          status: "active",
        }),
      ],
      status_code: 200,
    });

    expect(
      readJsonFile<typeof connected>(bootstrap.paths.runtime_provisioning_path),
    ).toEqual(connected);
    expect(
      readJsonFile<typeof connected>(
        bootstrap.paths.artifact_bootstrap_summary_path,
      ),
    ).toEqual(redactConnectedRunSummary(connected));
    expect(readDualSandboxConnectedRunFromRunRoot(bootstrap.run_root)).toEqual(
      connected,
    );

    const postAgentRequests = requests.filter(
      (request) =>
        request.method === "POST" && request.path === "/api/v1/agents",
    );
    const getAgentRequests = requests.filter(
      (request) =>
        request.method === "GET" && request.path === "/api/v1/agents",
    );
    expect(postAgentRequests).toHaveLength(2);
    expect(getAgentRequests).toHaveLength(2);
    expect(postAgentRequests).toEqual([
      expect.objectContaining({
        authorization: `Bearer ${provisioned.provisioning.sandboxes.a.api_key}`,
        body: expect.objectContaining({
          callback_url: bootstrap.sandboxes.a.callback_url,
          capabilities: ["chat"],
          framework: "openclaw",
          label: "default",
          mode: "webhook",
          rotate_secret: true,
        }),
      }),
      expect.objectContaining({
        authorization: `Bearer ${provisioned.provisioning.sandboxes.b.api_key}`,
        body: expect.objectContaining({
          callback_url: bootstrap.sandboxes.b.callback_url,
          capabilities: ["chat"],
          framework: "openclaw",
          label: "default",
          mode: "webhook",
          rotate_secret: true,
        }),
      }),
    ]);

    const db = getTestDb();
    const activeConnections = await db
      .select({
        callbackUrl: schema.agentConnections.callbackUrl,
        framework: schema.agentConnections.framework,
        id: schema.agentConnections.id,
        label: schema.agentConnections.label,
        status: schema.agentConnections.status,
        userId: schema.agentConnections.userId,
      })
      .from(schema.agentConnections)
      .where(
        and(
          eq(schema.agentConnections.framework, "openclaw"),
          inArray(schema.agentConnections.userId, [
            provisioned.provisioning.sandboxes.a.user_id,
            provisioned.provisioning.sandboxes.b.user_id,
          ]),
          eq(schema.agentConnections.status, "active"),
        ),
      );

    expect(activeConnections).toHaveLength(2);
    expect(activeConnections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callbackUrl: bootstrap.sandboxes.a.callback_url,
          framework: "openclaw",
          id: connected.connections.sandboxes.a.connection_id,
          label: "default",
          status: "active",
          userId: provisioned.provisioning.sandboxes.a.user_id,
        }),
        expect.objectContaining({
          callbackUrl: bootstrap.sandboxes.b.callback_url,
          framework: "openclaw",
          id: connected.connections.sandboxes.b.connection_id,
          label: "default",
          status: "active",
          userId: provisioned.provisioning.sandboxes.b.user_id,
        }),
      ]),
    );
  });

  it("fails clearly before the connection-registration stage runs", async () => {
    const app = createApp();
    const bootstrap = createDualSandboxBootstrap({
      rootPath: createFreshExplicitRoot(),
    });
    await provisionDualSandboxUsers(bootstrap, {
      adminApiKey: ADMIN_API_KEY,
      fetchImpl: createHarnessFetch(app, []),
    });

    expect(() =>
      readDualSandboxConnectedRunFromRunRoot(bootstrap.run_root),
    ).toThrow(
      `File ${bootstrap.paths.runtime_provisioning_path} does not contain a valid dual-sandbox connection summary.`,
    );
  });
});
