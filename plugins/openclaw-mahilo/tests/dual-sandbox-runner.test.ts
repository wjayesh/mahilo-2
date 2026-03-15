import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runDualSandboxHarness,
  type DualSandboxRunOptions,
  type DualSandboxRunnerDeps,
} from "../scripts/dual-sandbox-run";
import {
  createDualSandboxBootstrap,
  type DualSandboxBootstrapSummary,
} from "../scripts/dual-sandbox-bootstrap-lib";
import type { DualSandboxConnectedRunSummary } from "../scripts/dual-sandbox-connections-lib";
import type { DualSandboxPolicyScenarioRunSummary } from "../scripts/dual-sandbox-policy-scenarios-lib";
import type { DualSandboxProvisionedRunSummary } from "../scripts/dual-sandbox-provision-lib";
import type { DualSandboxRelationshipRunSummary } from "../scripts/dual-sandbox-relationships-lib";

const cleanupPaths: string[] = [];

function trackPath(path: string): string {
  cleanupPaths.push(path);
  return path;
}

function createFreshExplicitRoot(): string {
  const parent = trackPath(
    mkdtempSync(join(tmpdir(), "mahilo-dual-sandbox-runner-")),
  );
  return join(parent, "run-root");
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildProvisionedSummary(
  bootstrap: DualSandboxBootstrapSummary,
): DualSandboxProvisionedRunSummary {
  return {
    ...bootstrap,
    provisioning: {
      contract_version: 1,
      created_at: "2026-03-15T12:00:00.000Z",
      current_phase: "users",
      fallback_only: false,
      mahilo_base_url: bootstrap.mahilo.base_url,
      plugin_protected_route_probe_path: "/api/v1/plugin/reviews?limit=1",
      provisioning_mode: "api",
      sandboxes: {
        a: {
          api_key: "mhl_a",
          display_name: "Sandbox Sender",
          invite: {
            expires_at: null,
            max_uses: 1,
            note: "a",
            token_id: "tok_a",
          },
          plugin_route_probe: {
            path: "/api/v1/plugin/reviews?limit=1",
            review_count: 0,
            status_code: 200,
          },
          registration_flow: "invite_token_register",
          registration_source: "invite",
          status: "active",
          user_id: "user_a",
          username: "sandboxsender",
          verified: true,
        },
        b: {
          api_key: "mhl_b",
          display_name: "Sandbox Receiver",
          invite: {
            expires_at: null,
            max_uses: 1,
            note: "b",
            token_id: "tok_b",
          },
          plugin_route_probe: {
            path: "/api/v1/plugin/reviews?limit=1",
            review_count: 0,
            status_code: 200,
          },
          registration_flow: "invite_token_register",
          registration_source: "invite",
          status: "active",
          user_id: "user_b",
          username: "sandboxreceiver",
          verified: true,
        },
      },
    },
  };
}

function buildConnectedSummary(
  provisioned: DualSandboxProvisionedRunSummary,
): DualSandboxConnectedRunSummary {
  return {
    ...provisioned,
    connections: {
      contract_version: 1,
      created_at: "2026-03-15T12:05:00.000Z",
      current_phase: "connections",
      mahilo_base_url: provisioned.mahilo.base_url,
      sandboxes: {
        a: {
          callback_url: provisioned.sandboxes.a.callback_url,
          connection_id: "conn_a",
          framework: "openclaw",
          get_agents_status_code: 200,
          label: "default",
          mode: "webhook",
          post_agents_status_code: 200,
          runtime_bootstrap_path: provisioned.sandboxes.a.runtime_state_path,
          status: "active",
          updated_existing_connection: false,
        },
        b: {
          callback_url: provisioned.sandboxes.b.callback_url,
          connection_id: "conn_b",
          framework: "openclaw",
          get_agents_status_code: 200,
          label: "default",
          mode: "webhook",
          post_agents_status_code: 200,
          runtime_bootstrap_path: provisioned.sandboxes.b.runtime_state_path,
          status: "active",
          updated_existing_connection: false,
        },
      },
    },
    provisioning: {
      ...provisioned.provisioning,
      current_phase: "connections",
    },
  };
}

function buildRelationshipSummary(
  connected: DualSandboxConnectedRunSummary,
): DualSandboxRelationshipRunSummary {
  return {
    ...connected,
    relationships: {
      contract_version: 1,
      created_at: "2026-03-15T12:10:00.000Z",
      current_phase: "relationships",
      friendship: {
        accept: {
          accepted_by_sandbox: "b",
          friendship_id: "friend_123",
          handled_by: "explicit_accept",
          status: "accepted",
          status_code: 200,
        },
        accepted: true,
        friendship_id: "friend_123",
        network_views: {
          a: {
            friends: [],
            status_code: 200,
          },
          b: {
            friends: [],
            status_code: 200,
          },
        },
        request: {
          friendship_id: "friend_123",
          requested_by_sandbox: "a",
          requested_username: "sandboxreceiver",
          status: "accepted",
          status_code: 201,
        },
        roles: {
          assigned: [],
          assignments: [],
          get_available_roles_status_code: 200,
          get_friendship_roles_status_code: 200,
        },
      },
      group: null,
      mahilo_base_url: connected.mahilo.base_url,
      participants: {
        receiver: {
          callback_url: connected.sandboxes.b.callback_url,
          connection_id: "conn_b",
          sandbox_id: "b",
          user_id: "user_b",
          username: "sandboxreceiver",
        },
        sender: {
          callback_url: connected.sandboxes.a.callback_url,
          connection_id: "conn_a",
          sandbox_id: "a",
          user_id: "user_a",
          username: "sandboxsender",
        },
      },
    },
  };
}

function buildPolicySummary(
  relationships: DualSandboxRelationshipRunSummary,
): DualSandboxPolicyScenarioRunSummary {
  return {
    ...relationships,
    policy_scenarios: {
      contract_version: 1,
      created_at: "2026-03-15T12:15:00.000Z",
      current_phase: "policy_scenarios",
      mahilo_base_url: relationships.mahilo.base_url,
      manual_dashboard_required: false,
      scenario_ids: ["S2-allow", "S3-ask", "S4-deny", "S5-missing-llm-key"],
      scenario_mapping: {
        "S2-allow": {
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
          id: "S2-allow",
          note: "allow",
          seeded_policies: [],
          send_fixture: {
            context: null,
            message: "allow",
            payload_type: "text/plain",
          },
          target: {
            recipient_sandbox_id: "b",
            recipient_user_id: "user_b",
            recipient_username: "sandboxreceiver",
          },
        },
        "S3-ask": {
          declared_selectors: {
            action: "share",
            direction: "outbound",
            resource: "calendar.event",
          },
          expected_resolution: {
            decision: "ask",
            delivery_expected: false,
            reason_code: "policy.ask.user.structured",
            review_surface: "reviews",
            transport_expected: false,
          },
          id: "S3-ask",
          note: "ask",
          seeded_policies: [],
          send_fixture: {
            context: null,
            message: "ask",
            payload_type: "text/plain",
          },
          target: {
            recipient_sandbox_id: "b",
            recipient_user_id: "user_b",
            recipient_username: "sandboxreceiver",
          },
        },
        "S4-deny": {
          declared_selectors: {
            action: "share",
            direction: "outbound",
            resource: "location.current",
          },
          expected_resolution: {
            decision: "deny",
            delivery_expected: false,
            reason_code: "policy.deny.user.structured",
            review_surface: "blocked_events",
            transport_expected: false,
          },
          id: "S4-deny",
          note: "deny",
          seeded_policies: [],
          send_fixture: {
            context: null,
            message: "deny",
            payload_type: "text/plain",
          },
          target: {
            recipient_sandbox_id: "b",
            recipient_user_id: "user_b",
            recipient_username: "sandboxreceiver",
          },
        },
        "S5-missing-llm-key": {
          declared_selectors: {
            action: "share",
            direction: "outbound",
            resource: "contact.email",
          },
          expected_resolution: {
            decision: "ask",
            delivery_expected: false,
            reason_code: "policy.ask.llm.unavailable",
            review_surface: "reviews",
            transport_expected: false,
          },
          id: "S5-missing-llm-key",
          note: "llm",
          seeded_policies: [],
          send_fixture: {
            context: null,
            message: "llm",
            payload_type: "text/plain",
          },
          target: {
            recipient_sandbox_id: "b",
            recipient_user_id: "user_b",
            recipient_username: "sandboxreceiver",
          },
        },
      },
      seed_mode: "api",
      sender_preferences: {
        default_llm_model: "gpt-4o-mini",
        default_llm_provider: "openai",
        get_status_code: 200,
        patch_status_code: 200,
      },
    },
    provisioning: {
      ...relationships.provisioning,
      current_phase: "policy_scenarios",
    },
  };
}

function buildFakeProcessHandle(id: string) {
  return {
    child: { pid: id.length } as never,
    closeLogs: async () => {},
    entry: {
      id,
    },
    exit_code: null,
    exit_signal: null,
    pid: id.length,
    ready_at: "2026-03-15T12:00:00.000Z",
    readiness: {
      attempt_count: 1,
      checked_at: "2026-03-15T12:00:00.000Z",
      duration_ms: 10,
      method: "GET",
      process_id: id,
      response_json: { status: "healthy" },
      status_code: 200,
      url: "http://127.0.0.1/health",
    },
    spawn_error: null,
    stop: async () => ({
      forced_kill: false,
      signal_sent: "SIGTERM",
      stopped_at: "2026-03-15T12:30:00.000Z",
    }),
    stop_result: null,
    waitForExit: async () => {},
    waitForReadiness: async function () {
      return this.readiness;
    },
  } as never;
}

afterEach(() => {
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

describe("dual sandbox runner", () => {
  it("orchestrates the runner stages, writes summaries, and always stops started processes", async () => {
    const stageOrder: string[] = [];
    const stopCalls: string[][] = [];
    const rootPath = createFreshExplicitRoot();
    const options: DualSandboxRunOptions = {
      entryCommand: ["bun", "run", "dual-sandbox-run.ts"],
      rootPath,
      skipAgentTurn: false,
    };

    const deps: Partial<DualSandboxRunnerDeps> = {
      buildPlugin: async ({ bootstrap }) => {
        stageOrder.push("build");
        writeFileSync(
          join(bootstrap.paths.logs_dir, "plugin-build.log"),
          "ok\n",
          "utf8",
        );
      },
      createProcessPlan: (bootstrap) => {
        stageOrder.push("plan");
        return {
          gateway_a: {
            id: "gateway_a",
            label: "OpenClaw gateway A",
            launch: {
              args: ["gateway-a"],
              command: "fixture",
              cwd: bootstrap.run_root,
              env: {},
            },
            log_path: bootstrap.sandboxes.a.gateway_log_path,
            port: bootstrap.ports.gateway_a,
            readiness: {
              artifact_path:
                bootstrap.sandboxes.a.artifact_paths.webhook_head_path,
              method: "HEAD",
              url: bootstrap.sandboxes.a.callback_url,
            },
          },
          gateway_b: {
            id: "gateway_b",
            label: "OpenClaw gateway B",
            launch: {
              args: ["gateway-b"],
              command: "fixture",
              cwd: bootstrap.run_root,
              env: {},
            },
            log_path: bootstrap.sandboxes.b.gateway_log_path,
            port: bootstrap.ports.gateway_b,
            readiness: {
              artifact_path:
                bootstrap.sandboxes.b.artifact_paths.webhook_head_path,
              method: "HEAD",
              url: bootstrap.sandboxes.b.callback_url,
            },
          },
          mahilo: {
            id: "mahilo",
            label: "Mahilo server",
            launch: {
              args: ["mahilo"],
              command: "fixture",
              cwd: bootstrap.run_root,
              env: {},
            },
            log_path: bootstrap.mahilo.log_path,
            port: bootstrap.ports.mahilo,
            readiness: {
              artifact_path: join(
                bootstrap.paths.provisioning_dir,
                "mahilo-health.json",
              ),
              expected_json_status: "healthy",
              method: "GET",
              url: `${bootstrap.mahilo.base_url}/health`,
            },
          },
        };
      },
      startProcess: async (entry) => {
        stageOrder.push(`start:${entry.id}`);
        writeJsonFile(entry.readiness.artifact_path, {
          process_id: entry.id,
          status_code: 200,
        });
        return buildFakeProcessHandle(entry.id);
      },
      provision: async (bootstrap) => {
        stageOrder.push("provision");
        const provisioned = buildProvisionedSummary(bootstrap);
        writeJsonFile(bootstrap.paths.runtime_provisioning_path, provisioned);
        return provisioned;
      },
      connect: async (summary) => {
        stageOrder.push("connect");
        const connected = buildConnectedSummary(summary);
        writeJsonFile(
          summary.sandboxes.a.artifact_paths.runtime_state_redacted_path,
          {
            servers: {},
            version: 1,
          },
        );
        writeJsonFile(
          summary.sandboxes.b.artifact_paths.runtime_state_redacted_path,
          {
            servers: {},
            version: 1,
          },
        );
        writeJsonFile(
          summary.sandboxes.a.artifact_paths.agent_connections_path,
          {
            connections: [],
            status_code: 200,
          },
        );
        writeJsonFile(
          summary.sandboxes.b.artifact_paths.agent_connections_path,
          {
            connections: [],
            status_code: 200,
          },
        );
        writeJsonFile(
          join(summary.paths.provisioning_dir, "process-readiness.json"),
          { ok: true },
        );
        writeJsonFile(summary.paths.runtime_provisioning_path, connected);
        return connected;
      },
      setupRelationships: async (summary) => {
        stageOrder.push("relationships");
        const relationships = buildRelationshipSummary(summary);
        writeJsonFile(
          join(summary.paths.provisioning_dir, "friendship-summary.json"),
          relationships.relationships,
        );
        writeJsonFile(summary.paths.runtime_provisioning_path, relationships);
        return relationships;
      },
      seedPolicyScenarios: async (summary) => {
        stageOrder.push("policy");
        const policySummary = buildPolicySummary(summary);
        writeJsonFile(
          join(summary.paths.provisioning_dir, "policy-summary.json"),
          policySummary.policy_scenarios,
        );
        writeJsonFile(summary.paths.runtime_provisioning_path, policySummary);
        return policySummary;
      },
      verifyPluginLoad: async ({ bootstrap }) => {
        stageOrder.push("verify-plugin-load");
        writeJsonFile(bootstrap.sandboxes.a.artifact_paths.plugin_list_path, {
          plugins: [
            "mahilo",
            "manage_network",
            "send_message",
            "ask_network",
            "set_boundaries",
          ],
        });
        writeJsonFile(bootstrap.sandboxes.b.artifact_paths.plugin_list_path, {
          plugins: [
            "mahilo",
            "manage_network",
            "send_message",
            "ask_network",
            "set_boundaries",
          ],
        });
        return {
          evidence: [
            {
              path: "artifacts/sandboxes/sandbox-a/plugin-list.json",
              role: "plugin_list_sandbox_a",
              source_kind: "artifact",
            },
          ],
          finished_at: "2026-03-15T12:20:00.000Z",
          id: "plugin-load",
          profile: "baseline",
          started_at: "2026-03-15T12:19:00.000Z",
          status: "passed",
          summary: "plugin load ok",
        };
      },
      runDeterministicSmoke: async ({ bootstrap }) => {
        stageOrder.push("deterministic");
        writeJsonFile(
          join(bootstrap.sandboxes.a.artifact_dir, "manage-network-list.json"),
          {
            status_code: 200,
          },
        );
        writeJsonFile(
          join(bootstrap.sandboxes.b.artifact_dir, "manage-network-list.json"),
          {
            status_code: 200,
          },
        );
        return {
          evidence: [
            {
              path: "artifacts/sandboxes/sandbox-a/manage-network-list.json",
              role: "manage_network_sandbox_a",
              source_kind: "artifact",
            },
            {
              path: "artifacts/sandboxes/sandbox-b/manage-network-list.json",
              role: "manage_network_sandbox_b",
              source_kind: "artifact",
            },
          ],
          finished_at: "2026-03-15T12:21:00.000Z",
          id: "deterministic-smoke",
          profile: "baseline",
          started_at: "2026-03-15T12:20:30.000Z",
          status: "passed",
          summary: "deterministic ok",
        };
      },
      runAgentTurnSmoke: async () => {
        stageOrder.push("agent-turn");
        return {
          evidence: [],
          finished_at: null,
          id: "agent-turn-smoke",
          profile: "optional",
          started_at: null,
          status: "skipped_optional",
          summary: "skipped",
        };
      },
      stopProcesses: async (processes) => {
        const ids = Object.keys(processes).sort();
        stageOrder.push("stop");
        stopCalls.push(ids);
        return {};
      },
    };

    const result = await runDualSandboxHarness(options, deps);

    expect(result.exit_code).toBe(0);
    expect(stageOrder).toEqual([
      "build",
      "plan",
      "start:mahilo",
      "provision",
      "connect",
      "relationships",
      "policy",
      "start:gateway_a",
      "start:gateway_b",
      "verify-plugin-load",
      "deterministic",
      "agent-turn",
      "stop",
    ]);
    expect(stopCalls).toEqual([["gateway_a", "gateway_b", "mahilo"]]);

    const verificationSummary = readJsonFile<{
      overall: {
        agent_turn_smoke: string;
        deterministic_smoke: string;
        runner: string;
      };
      scenarios: Array<{ id: string; status: string }>;
    }>(result.verification_summary_path);
    expect(verificationSummary.overall).toEqual({
      agent_turn_smoke: "skipped_optional",
      deterministic_smoke: "passed",
      runner: "passed",
    });
    expect(
      verificationSummary.scenarios.find((scenario) => scenario.id === "G1"),
    ).toMatchObject({
      id: "G1",
      status: "passed",
    });
    expect(
      verificationSummary.scenarios.find(
        (scenario) => scenario.id === "S2-allow",
      ),
    ).toMatchObject({
      id: "S2-allow",
      status: "pending",
    });

    const operatorSummary = readFileSync(result.operator_summary_path, "utf8");
    expect(operatorSummary).toContain("Runner status: passed");
    expect(operatorSummary).toContain("Deterministic smoke: passed");
    expect(operatorSummary).toContain(
      "Optional agent-turn smoke: skipped_optional",
    );

    const runContext = readJsonFile<{ status: string }>(
      join(rootPath, "artifacts", "run-context.json"),
    );
    expect(runContext.status).toBe("passed");
  });

  it("exits non-zero on baseline failure and still stops already-started processes", async () => {
    const stageOrder: string[] = [];
    const stopCalls: string[][] = [];
    const rootPath = createFreshExplicitRoot();

    const deps: Partial<DualSandboxRunnerDeps> = {
      buildPlugin: async ({ bootstrap }) => {
        stageOrder.push("build");
        writeFileSync(
          join(bootstrap.paths.logs_dir, "plugin-build.log"),
          "ok\n",
          "utf8",
        );
      },
      createProcessPlan: (bootstrap) => {
        stageOrder.push("plan");
        return {
          gateway_a: {
            id: "gateway_a",
            label: "OpenClaw gateway A",
            launch: {
              args: [],
              command: "fixture",
              cwd: bootstrap.run_root,
              env: {},
            },
            log_path: bootstrap.sandboxes.a.gateway_log_path,
            port: bootstrap.ports.gateway_a,
            readiness: {
              artifact_path:
                bootstrap.sandboxes.a.artifact_paths.webhook_head_path,
              method: "HEAD",
              url: bootstrap.sandboxes.a.callback_url,
            },
          },
          gateway_b: {
            id: "gateway_b",
            label: "OpenClaw gateway B",
            launch: {
              args: [],
              command: "fixture",
              cwd: bootstrap.run_root,
              env: {},
            },
            log_path: bootstrap.sandboxes.b.gateway_log_path,
            port: bootstrap.ports.gateway_b,
            readiness: {
              artifact_path:
                bootstrap.sandboxes.b.artifact_paths.webhook_head_path,
              method: "HEAD",
              url: bootstrap.sandboxes.b.callback_url,
            },
          },
          mahilo: {
            id: "mahilo",
            label: "Mahilo server",
            launch: {
              args: [],
              command: "fixture",
              cwd: bootstrap.run_root,
              env: {},
            },
            log_path: bootstrap.mahilo.log_path,
            port: bootstrap.ports.mahilo,
            readiness: {
              artifact_path: join(
                bootstrap.paths.provisioning_dir,
                "mahilo-health.json",
              ),
              expected_json_status: "healthy",
              method: "GET",
              url: `${bootstrap.mahilo.base_url}/health`,
            },
          },
        };
      },
      startProcess: async (entry) => {
        stageOrder.push(`start:${entry.id}`);
        writeJsonFile(entry.readiness.artifact_path, {
          process_id: entry.id,
          status_code: 200,
        });
        return buildFakeProcessHandle(entry.id);
      },
      provision: async () => {
        stageOrder.push("provision");
        throw new Error("provision failed");
      },
      stopProcesses: async (processes) => {
        stageOrder.push("stop");
        stopCalls.push(Object.keys(processes).sort());
        return {};
      },
    };

    const result = await runDualSandboxHarness(
      {
        entryCommand: ["bun", "run", "dual-sandbox-run.ts"],
        rootPath,
      },
      deps,
    );

    expect(result.exit_code).toBe(1);
    expect(stageOrder).toEqual([
      "build",
      "plan",
      "start:mahilo",
      "provision",
      "stop",
    ]);
    expect(stopCalls).toEqual([["mahilo"]]);

    const verificationSummary = readJsonFile<{
      error: { message: string; stage: string } | null;
      overall: { runner: string };
    }>(result.verification_summary_path);
    expect(verificationSummary.overall.runner).toBe("failed");
    expect(verificationSummary.error).toEqual({
      message: "provision failed",
      stage: "provision",
    });

    const operatorSummary = readFileSync(result.operator_summary_path, "utf8");
    expect(operatorSummary).toContain("Runner status: failed");
    expect(operatorSummary).toContain("Baseline failure: provision failed");
  });
});
