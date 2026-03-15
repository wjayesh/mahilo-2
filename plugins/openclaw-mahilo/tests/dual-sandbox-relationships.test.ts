import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";

import { config } from "../../../src/config";
import * as schema from "../../../src/db/schema";
import { createApp } from "../../../src/server";
import { createDualSandboxBootstrap } from "../scripts/dual-sandbox-bootstrap-lib";
import { connectDualSandboxGateways } from "../scripts/dual-sandbox-connections-lib";
import { provisionDualSandboxUsers } from "../scripts/dual-sandbox-provision-lib";
import {
  DUAL_SANDBOX_RELATIONSHIP_CONTRACT_VERSION,
  readDualSandboxRelationshipRunFromRunRoot,
  setupDualSandboxRelationships,
} from "../scripts/dual-sandbox-relationships-lib";
import {
  cleanupTestDatabase,
  getTestDb,
  seedTestSystemRoles,
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
  const parent = trackPath(
    mkdtempSync(join(tmpdir(), "mahilo-dual-sandbox-relationships-")),
  );
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
  await seedTestSystemRoles();
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

describe("dual sandbox relationship setup", () => {
  it("creates an accepted friendship, a default shared group, and persists the friendship artifact", async () => {
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

    const relationshipSummary = await setupDualSandboxRelationships(connected, {
      fetchImpl,
    });

    expect(relationshipSummary.provisioning.current_phase).toBe(
      "relationships",
    );
    expect(relationshipSummary.relationships).toMatchObject({
      contract_version: DUAL_SANDBOX_RELATIONSHIP_CONTRACT_VERSION,
      current_phase: "relationships",
      friendship: {
        accepted: true,
        request: {
          requested_by_sandbox: "a",
          requested_username: provisioned.provisioning.sandboxes.b.username,
          status: "pending",
          status_code: 201,
        },
        accept: {
          accepted_by_sandbox: "b",
          handled_by: "explicit_accept",
          status: "accepted",
          status_code: 200,
        },
        roles: {
          assigned: [],
          assignments: [],
          get_available_roles_status_code: null,
          get_friendship_roles_status_code: 200,
        },
      },
      participants: {
        sender: {
          callback_url: bootstrap.sandboxes.a.callback_url,
          connection_id: connected.connections.sandboxes.a.connection_id,
          sandbox_id: "a",
          user_id: provisioned.provisioning.sandboxes.a.user_id,
          username: provisioned.provisioning.sandboxes.a.username,
        },
        receiver: {
          callback_url: bootstrap.sandboxes.b.callback_url,
          connection_id: connected.connections.sandboxes.b.connection_id,
          sandbox_id: "b",
          user_id: provisioned.provisioning.sandboxes.b.user_id,
          username: provisioned.provisioning.sandboxes.b.username,
        },
      },
    });
    expect(relationshipSummary.relationships.group).toMatchObject({
      create_status_code: 201,
      created_by_sandbox: "a",
      invite_only: true,
      invite_status_code: 201,
      invited_username: provisioned.provisioning.sandboxes.b.username,
      join_role: "member",
      join_status: "active",
      join_status_code: 200,
      member_groups_status_code: 200,
      members_status_code: 200,
      owner_groups_status_code: 200,
    });
    expect(relationshipSummary.relationships.group?.name).toStartWith(
      "sandbox-harness-",
    );
    expect(
      relationshipSummary.relationships.friendship.network_views.a.friends,
    ).toEqual([
      expect.objectContaining({
        direction: "sent",
        friendship_id: relationshipSummary.relationships.friendship.friendship_id,
        status: "accepted",
        user_id: provisioned.provisioning.sandboxes.b.user_id,
        username: provisioned.provisioning.sandboxes.b.username,
      }),
    ]);
    expect(
      relationshipSummary.relationships.friendship.network_views.b.friends,
    ).toEqual([
      expect.objectContaining({
        direction: "received",
        friendship_id: relationshipSummary.relationships.friendship.friendship_id,
        status: "accepted",
        user_id: provisioned.provisioning.sandboxes.a.user_id,
        username: provisioned.provisioning.sandboxes.a.username,
      }),
    ]);

    expect(
      readJsonFile<typeof relationshipSummary>(bootstrap.paths.runtime_provisioning_path),
    ).toEqual(relationshipSummary);
    expect(
      readJsonFile<Record<string, unknown>>(
        bootstrap.paths.artifact_bootstrap_summary_path,
      ),
    ).toMatchObject({
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
      relationships: {
        friendship: {
          friendship_id: relationshipSummary.relationships.friendship.friendship_id,
        },
      },
    });
    expect(
      readJsonFile<Record<string, unknown>>(
        join(bootstrap.paths.provisioning_dir, "friendship-summary.json"),
      ),
    ).toEqual(relationshipSummary.relationships);
    expect(readDualSandboxRelationshipRunFromRunRoot(bootstrap.run_root)).toEqual(
      relationshipSummary,
    );

    const db = getTestDb();
    const [friendship] = await db
      .select()
      .from(schema.friendships)
      .where(
        eq(
          schema.friendships.id,
          relationshipSummary.relationships.friendship.friendship_id,
        ),
      )
      .limit(1);
    expect(friendship?.status).toBe("accepted");

    const group = relationshipSummary.relationships.group;
    expect(group).not.toBeNull();
    const [storedGroup] = await db
      .select()
      .from(schema.groups)
      .where(eq(schema.groups.id, group!.group_id))
      .limit(1);
    expect(storedGroup).toMatchObject({
      id: group!.group_id,
      inviteOnly: true,
      name: group!.name,
      ownerUserId: provisioned.provisioning.sandboxes.a.user_id,
    });

    const memberships = await db
      .select()
      .from(schema.groupMemberships)
      .where(
        and(
          eq(schema.groupMemberships.groupId, group!.group_id),
          inArray(schema.groupMemberships.userId, [
            provisioned.provisioning.sandboxes.a.user_id,
            provisioned.provisioning.sandboxes.b.user_id,
          ]),
        ),
      );
    expect(memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "owner",
          status: "active",
          userId: provisioned.provisioning.sandboxes.a.user_id,
        }),
        expect.objectContaining({
          role: "member",
          status: "active",
          userId: provisioned.provisioning.sandboxes.b.user_id,
        }),
      ]),
    );

    expect(requests.map((request) => request.path)).toEqual(
      expect.arrayContaining([
        "/api/v1/friends/request",
        `/api/v1/friends/${relationshipSummary.relationships.friendship.friendship_id}/accept`,
        "/api/v1/friends?status=accepted",
        "/api/v1/groups",
        `/api/v1/groups/${group!.group_id}/invite`,
        `/api/v1/groups/${group!.group_id}/join`,
        `/api/v1/groups/${group!.group_id}/members`,
      ]),
    );
    expect(
      requests.filter((request) => request.path === "/api/v1/groups"),
    ).toHaveLength(3);
  });

  it("supports optional friendship roles, reuses system roles, and creates custom roles when needed", async () => {
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

    const relationshipSummary = await setupDualSandboxRelationships(connected, {
      fetchImpl,
      friendshipRoles: ["close_friends", "trusted_circle"],
      group: {
        setup: false,
      },
    });

    expect(relationshipSummary.relationships.group).toBeNull();
    expect(relationshipSummary.relationships.friendship.roles).toMatchObject({
      assigned: ["close_friends", "trusted_circle"],
      get_available_roles_status_code: 200,
      get_friendship_roles_status_code: 200,
    });
    expect(
      relationshipSummary.relationships.friendship.roles.assignments,
    ).toEqual([
      {
        available_before_assignment: true,
        create_role_status_code: null,
        created_custom_role: false,
        role: "close_friends",
        role_source: "system",
        status_code: 200,
      },
      {
        available_before_assignment: false,
        create_role_status_code: 201,
        created_custom_role: true,
        role: "trusted_circle",
        role_source: "custom",
        status_code: 200,
      },
    ]);
    expect(
      relationshipSummary.relationships.friendship.network_views.a.friends[0]?.roles,
    ).toEqual(["close_friends", "trusted_circle"]);

    const db = getTestDb();
    const storedFriendRoles = await db
      .select()
      .from(schema.friendRoles)
      .where(
        eq(
          schema.friendRoles.friendshipId,
          relationshipSummary.relationships.friendship.friendship_id,
        ),
      );
    expect(storedFriendRoles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          roleName: "close_friends",
        }),
        expect.objectContaining({
          roleName: "trusted_circle",
        }),
      ]),
    );

    const [customRole] = await db
      .select()
      .from(schema.userRoles)
      .where(eq(schema.userRoles.name, "trusted_circle"))
      .limit(1);
    expect(customRole).toMatchObject({
      isSystem: false,
      name: "trusted_circle",
      userId: provisioned.provisioning.sandboxes.a.user_id,
    });

    expect(requests.map((request) => request.path)).toEqual(
      expect.arrayContaining([
        "/api/v1/roles",
        `/api/v1/friends/${relationshipSummary.relationships.friendship.friendship_id}/roles`,
      ]),
    );
    expect(
      requests.find(
        (request) =>
          request.path === "/api/v1/roles" &&
          request.method === "POST" &&
          (request.body as { name?: string } | null)?.name === "trusted_circle",
      ),
    ).toBeDefined();
    expect(
      requests.some((request) => request.path.startsWith("/api/v1/groups")),
    ).toBe(false);
  });
});
