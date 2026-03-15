import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "../../../src/config";
import * as schema from "../../../src/db/schema";
import { createApp } from "../../../src/server";
import { createDualSandboxBootstrap } from "../scripts/dual-sandbox-bootstrap-lib";
import { connectDualSandboxGateways } from "../scripts/dual-sandbox-connections-lib";
import {
  DUAL_SANDBOX_POLICY_SCENARIO_IDS,
  DUAL_SANDBOX_POLICY_SCENARIOS_CONTRACT_VERSION,
  readDualSandboxPolicyScenarioRunFromRunRoot,
  seedDualSandboxPolicyScenarios,
} from "../scripts/dual-sandbox-policy-scenarios-lib";
import { provisionDualSandboxUsers } from "../scripts/dual-sandbox-provision-lib";
import { setupDualSandboxRelationships } from "../scripts/dual-sandbox-relationships-lib";
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
    mkdtempSync(join(tmpdir(), "mahilo-dual-sandbox-policy-scenarios-")),
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

describe("dual sandbox policy scenarios", () => {
  it("seeds the baseline S2/S3/S4/S5 fixtures and persists an explicit policy summary", async () => {
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
    const relationships = await setupDualSandboxRelationships(connected, {
      fetchImpl,
    });

    const policySummary = await seedDualSandboxPolicyScenarios(relationships, {
      fetchImpl,
    });

    expect(policySummary.provisioning.current_phase).toBe("policy_scenarios");
    expect(policySummary.policy_scenarios).toMatchObject({
      contract_version: DUAL_SANDBOX_POLICY_SCENARIOS_CONTRACT_VERSION,
      current_phase: "policy_scenarios",
      manual_dashboard_required: false,
      scenario_ids: DUAL_SANDBOX_POLICY_SCENARIO_IDS,
      seed_mode: "api",
      sender_preferences: {
        default_llm_model: "gpt-4o-mini",
        default_llm_provider: "openai",
        get_status_code: 200,
        patch_status_code: 200,
      },
    });
    expect(
      policySummary.policy_scenarios.scenario_mapping["S2-allow"],
    ).toMatchObject({
      declared_selectors: {
        action: "share",
        direction: "outbound",
        resource: "profile.basic",
      },
      expected_resolution: {
        decision: "allow",
        delivery_expected: true,
        reason_code: "policy.allow.no_applicable",
        review_surface: "none",
        transport_expected: true,
      },
      seeded_policies: [],
      target: {
        recipient_sandbox_id: "b",
        recipient_username:
          relationships.relationships.participants.receiver.username,
        recipient_user_id: relationships.relationships.participants.receiver.user_id,
      },
    });
    expect(
      policySummary.policy_scenarios.scenario_mapping["S3-ask"],
    ).toMatchObject({
      declared_selectors: {
        resource: "calendar.event",
      },
      expected_resolution: {
        decision: "ask",
        delivery_expected: false,
        reason_code: "policy.ask.user.structured",
        review_surface: "reviews",
        transport_expected: false,
      },
      seeded_policies: [
        {
          action: "share",
          create_status_code: 201,
          direction: "outbound",
          effect: "ask",
          evaluator: "structured",
          priority: 90,
          resource: "calendar.event",
          scope: "user",
          source: "user_created",
          target_id: relationships.relationships.participants.receiver.user_id,
        },
      ],
    });
    expect(
      policySummary.policy_scenarios.scenario_mapping["S4-deny"],
    ).toMatchObject({
      declared_selectors: {
        resource: "location.current",
      },
      expected_resolution: {
        decision: "deny",
        delivery_expected: false,
        reason_code: "policy.deny.user.structured",
        review_surface: "blocked_events",
        transport_expected: false,
      },
      seeded_policies: [
        {
          action: "share",
          create_status_code: 201,
          direction: "outbound",
          effect: "deny",
          evaluator: "structured",
          priority: 91,
          resource: "location.current",
          scope: "user",
          source: "user_created",
          target_id: relationships.relationships.participants.receiver.user_id,
        },
      ],
    });
    expect(
      policySummary.policy_scenarios.scenario_mapping["S5-missing-llm-key"],
    ).toMatchObject({
      declared_selectors: {
        resource: "contact.email",
      },
      expected_resolution: {
        decision: "ask",
        delivery_expected: false,
        reason_code: "policy.ask.llm.unavailable",
        review_surface: "reviews",
        transport_expected: false,
      },
      llm_precondition: {
        default_harness_optional_live_model_configured: false,
        expected_reason_code: "policy.ask.llm.unavailable",
        local_credentials_expected: "absent",
        provider: "openai",
        provider_auth_copy_enabled: false,
        sender_preferences_source: "api_preferences",
        user_preference_model: "gpt-4o-mini",
      },
      seeded_policies: [
        {
          action: "share",
          create_status_code: 201,
          direction: "outbound",
          effect: "deny",
          evaluator: "llm",
          priority: 92,
          resource: "contact.email",
          scope: "user",
          source: "user_created",
          target_id: relationships.relationships.participants.receiver.user_id,
        },
      ],
    });

    expect(
      readJsonFile<typeof policySummary>(bootstrap.paths.runtime_provisioning_path),
    ).toEqual(policySummary);
    expect(
      readJsonFile<Record<string, unknown>>(
        bootstrap.paths.artifact_bootstrap_summary_path,
      ),
    ).toMatchObject({
      provisioning: {
        current_phase: "policy_scenarios",
        sandboxes: {
          a: {
            api_key: "<redacted>",
          },
          b: {
            api_key: "<redacted>",
          },
        },
      },
      policy_scenarios: {
        current_phase: "policy_scenarios",
      },
    });
    expect(
      readJsonFile(
        join(bootstrap.paths.provisioning_dir, "policy-summary.json"),
      ),
    ).toEqual(policySummary.policy_scenarios);
    expect(
      readDualSandboxPolicyScenarioRunFromRunRoot(bootstrap.run_root),
    ).toEqual(policySummary);

    const db = getTestDb();
    const storedPolicies = await db
      .select({
        effect: schema.policies.effect,
        evaluator: schema.policies.evaluator,
        id: schema.policies.id,
        priority: schema.policies.priority,
        resource: schema.policies.resource,
        scope: schema.policies.scope,
        source: schema.policies.source,
        targetId: schema.policies.targetId,
      })
      .from(schema.policies)
      .where(
        inArray(schema.policies.resource, [
          "calendar.event",
          "location.current",
          "contact.email",
        ]),
      );
    expect(storedPolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effect: "ask",
          evaluator: "structured",
          priority: 90,
          resource: "calendar.event",
          scope: "user",
          source: "user_created",
          targetId: relationships.relationships.participants.receiver.user_id,
        }),
        expect.objectContaining({
          effect: "deny",
          evaluator: "structured",
          priority: 91,
          resource: "location.current",
          scope: "user",
          source: "user_created",
          targetId: relationships.relationships.participants.receiver.user_id,
        }),
        expect.objectContaining({
          effect: "deny",
          evaluator: "llm",
          priority: 92,
          resource: "contact.email",
          scope: "user",
          source: "user_created",
          targetId: relationships.relationships.participants.receiver.user_id,
        }),
      ]),
    );

    const [senderPreferences] = await db
      .select({
        defaultLlmModel: schema.userPreferences.defaultLlmModel,
        defaultLlmProvider: schema.userPreferences.defaultLlmProvider,
      })
      .from(schema.userPreferences)
      .where(
        eq(
          schema.userPreferences.userId,
          relationships.relationships.participants.sender.user_id,
        ),
      )
      .limit(1);
    expect(senderPreferences).toEqual({
      defaultLlmModel: "gpt-4o-mini",
      defaultLlmProvider: "openai",
    });

    const preferencePatchRequests = requests.filter(
      (request) => request.method === "PATCH" &&
        request.path === "/api/v1/preferences",
    );
    expect(preferencePatchRequests).toHaveLength(1);
    expect(preferencePatchRequests[0]?.body).toEqual({
      default_llm_model: "gpt-4o-mini",
      default_llm_provider: "openai",
    });

    const preferenceGetRequests = requests.filter(
      (request) => request.method === "GET" &&
        request.path === "/api/v1/preferences",
    );
    expect(preferenceGetRequests).toHaveLength(1);

    const createPolicyRequests = requests.filter(
      (request) => request.method === "POST" &&
        request.path === "/api/v1/policies",
    );
    expect(createPolicyRequests).toHaveLength(3);
    expect(createPolicyRequests.map((request) => request.body)).toEqual([
      expect.objectContaining({
        action: "share",
        direction: "outbound",
        effect: "ask",
        evaluator: "structured",
        priority: 90,
        resource: "calendar.event",
        scope: "user",
        target_id: relationships.relationships.participants.receiver.user_id,
      }),
      expect.objectContaining({
        action: "share",
        direction: "outbound",
        effect: "deny",
        evaluator: "structured",
        priority: 91,
        resource: "location.current",
        scope: "user",
        target_id: relationships.relationships.participants.receiver.user_id,
      }),
      expect.objectContaining({
        action: "share",
        direction: "outbound",
        effect: "deny",
        evaluator: "llm",
        priority: 92,
        resource: "contact.email",
        scope: "user",
        target_id: relationships.relationships.participants.receiver.user_id,
      }),
    ]);

    const listPolicyRequests = requests.filter(
      (request) => request.method === "GET" &&
        request.path === "/api/v1/policies",
    );
    expect(listPolicyRequests).toHaveLength(1);
  });
});
