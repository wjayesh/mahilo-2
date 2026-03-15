import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDualSandboxBootstrap,
} from "../scripts/dual-sandbox-bootstrap-lib";
import {
  startDualSandboxProcesses,
} from "../scripts/dual-sandbox-lifecycle-lib";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureScriptPath = resolve(
  pluginRoot,
  "tests",
  "fixtures",
  "lifecycle-http-process.ts",
);

const cleanupPaths: string[] = [];

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function trackPath(path: string): string {
  cleanupPaths.push(path);
  return path;
}

function createFreshExplicitRoot(): string {
  const parent = trackPath(
    mkdtempSync(join(tmpdir(), "mahilo-dual-sandbox-lifecycle-")),
  );
  return join(parent, "run-root");
}

function buildFixtureLaunch(
  kind: "gateway" | "mahilo",
  port: number,
  extraEnv: Record<string, string | undefined> = {},
) {
  return {
    args: ["run", fixtureScriptPath],
    command: process.execPath,
    cwd: pluginRoot,
    env: {
      FIXTURE_KIND: kind,
      PORT: String(port),
      ...extraEnv,
    },
  };
}

async function getFreePort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();

    server.once("error", (error) => {
      reject(error);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to reserve an ephemeral port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolvePort(address.port);
      });
    });
  });
}

async function getFreePorts(count: number): Promise<number[]> {
  const ports: number[] = [];

  while (ports.length < count) {
    const port = await getFreePort();
    if (!ports.includes(port)) {
      ports.push(port);
    }
  }

  return ports;
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

describe("dual sandbox lifecycle", () => {
  it("starts all three processes from a clean bootstrap root and can rerun on the same ports", async () => {
    const [mahiloPort, gatewayAPort, gatewayBPort] = await getFreePorts(3);
    const firstBootstrap = createDualSandboxBootstrap({
      gatewayAPort,
      gatewayBPort,
      mahiloPort,
      rootPath: createFreshExplicitRoot(),
    });

    const firstRuntime = await startDualSandboxProcesses(firstBootstrap, {
      launchOverrides: {
        gateway_a: buildFixtureLaunch("gateway", gatewayAPort),
        gateway_b: buildFixtureLaunch("gateway", gatewayBPort),
        mahilo: buildFixtureLaunch("mahilo", mahiloPort),
      },
      pollIntervalMs: 100,
      requestTimeoutMs: 1_000,
      timeoutMs: 5_000,
    });

    try {
      expect(firstRuntime.readiness.mahilo.status_code).toBe(200);
      expect(firstRuntime.readiness.mahilo.response_json).toEqual({
        status: "healthy",
      });
      expect(firstRuntime.readiness.gateway_a.status_code).toBe(200);
      expect(firstRuntime.readiness.gateway_b.status_code).toBe(200);

      expect(
        readJsonFile(join(firstBootstrap.paths.provisioning_dir, "mahilo-health.json")),
      ).toMatchObject({
        process_id: "mahilo",
        response_json: {
          status: "healthy",
        },
        status_code: 200,
      });
      expect(
        readJsonFile(firstBootstrap.sandboxes.a.artifact_paths.webhook_head_path),
      ).toMatchObject({
        method: "HEAD",
        process_id: "gateway_a",
        status_code: 200,
      });
      expect(
        readJsonFile(firstBootstrap.sandboxes.b.artifact_paths.webhook_head_path),
      ).toMatchObject({
        method: "HEAD",
        process_id: "gateway_b",
        status_code: 200,
      });
      expect(
        readJsonFile(join(firstBootstrap.paths.provisioning_dir, "process-readiness.json")),
      ).toMatchObject({
        gateway_a: {
          status_code: 200,
        },
        gateway_b: {
          status_code: 200,
        },
        mahilo: {
          status_code: 200,
        },
      });
      expect(readFileSync(firstBootstrap.mahilo.log_path, "utf8")).toContain(
        "[fixture:mahilo] listening",
      );
      expect(
        readFileSync(firstBootstrap.sandboxes.a.gateway_log_path, "utf8"),
      ).toContain("[fixture:gateway] listening");
      expect(
        readFileSync(firstBootstrap.sandboxes.b.gateway_log_path, "utf8"),
      ).toContain("[fixture:gateway] listening");
    } finally {
      await firstRuntime.cleanup({
        removeRunRoot: true,
      });
    }

    expect(existsSync(firstBootstrap.run_root)).toBe(false);

    const secondBootstrap = createDualSandboxBootstrap({
      gatewayAPort,
      gatewayBPort,
      mahiloPort,
      rootPath: createFreshExplicitRoot(),
    });
    const secondRuntime = await startDualSandboxProcesses(secondBootstrap, {
      launchOverrides: {
        gateway_a: buildFixtureLaunch("gateway", gatewayAPort),
        gateway_b: buildFixtureLaunch("gateway", gatewayBPort),
        mahilo: buildFixtureLaunch("mahilo", mahiloPort),
      },
      pollIntervalMs: 100,
      requestTimeoutMs: 1_000,
      timeoutMs: 5_000,
    });

    try {
      expect(secondRuntime.readiness.mahilo.status_code).toBe(200);
      expect(secondRuntime.readiness.gateway_a.status_code).toBe(200);
      expect(secondRuntime.readiness.gateway_b.status_code).toBe(200);
    } finally {
      await secondRuntime.cleanup({
        removeRunRoot: true,
      });
    }
  });

  it("stops already-started processes when a later readiness check fails", async () => {
    const [mahiloPort, gatewayAPort, gatewayBPort] = await getFreePorts(3);
    const failedBootstrap = createDualSandboxBootstrap({
      gatewayAPort,
      gatewayBPort,
      mahiloPort,
      rootPath: createFreshExplicitRoot(),
    });

    await expect(
      startDualSandboxProcesses(failedBootstrap, {
        killPollAttempts: 2,
        killPollIntervalMs: 100,
        launchOverrides: {
          gateway_a: buildFixtureLaunch("gateway", gatewayAPort),
          gateway_b: buildFixtureLaunch("gateway", gatewayBPort, {
            READINESS_STATUS_CODE: "503",
          }),
          mahilo: buildFixtureLaunch("mahilo", mahiloPort),
        },
        pollIntervalMs: 100,
        requestTimeoutMs: 500,
        timeoutMs: 1_500,
        waitForPortReleaseMs: 1_000,
      }),
    ).rejects.toThrow("Timed out waiting for OpenClaw gateway B readiness");

    const rerunBootstrap = createDualSandboxBootstrap({
      gatewayAPort,
      gatewayBPort,
      mahiloPort,
      rootPath: createFreshExplicitRoot(),
    });
    const rerunRuntime = await startDualSandboxProcesses(rerunBootstrap, {
      launchOverrides: {
        gateway_a: buildFixtureLaunch("gateway", gatewayAPort),
        gateway_b: buildFixtureLaunch("gateway", gatewayBPort),
        mahilo: buildFixtureLaunch("mahilo", mahiloPort),
      },
      pollIntervalMs: 100,
      requestTimeoutMs: 1_000,
      timeoutMs: 5_000,
    });

    try {
      expect(rerunRuntime.readiness.gateway_b.status_code).toBe(200);
    } finally {
      await rerunRuntime.cleanup({
        removeRunRoot: true,
      });
    }
  });

  it("escalates to SIGKILL when a gateway ignores SIGTERM", async () => {
    const [mahiloPort, gatewayAPort, gatewayBPort] = await getFreePorts(3);
    const bootstrap = createDualSandboxBootstrap({
      gatewayAPort,
      gatewayBPort,
      mahiloPort,
      rootPath: createFreshExplicitRoot(),
    });
    const runtime = await startDualSandboxProcesses(bootstrap, {
      launchOverrides: {
        gateway_a: buildFixtureLaunch("gateway", gatewayAPort),
        gateway_b: buildFixtureLaunch("gateway", gatewayBPort, {
          IGNORE_SIGTERM: "1",
        }),
        mahilo: buildFixtureLaunch("mahilo", mahiloPort),
      },
      pollIntervalMs: 100,
      requestTimeoutMs: 1_000,
      timeoutMs: 5_000,
    });

    try {
      const stopResults = await runtime.stop({
        killPollAttempts: 2,
        killPollIntervalMs: 100,
        waitForPortReleaseMs: 2_000,
      });

      expect(stopResults.gateway_b?.forced_kill).toBe(true);
      expect(stopResults.gateway_b?.signal_sent).toBe("SIGKILL");
      expect(stopResults.gateway_a?.forced_kill).toBe(false);
      expect(stopResults.mahilo?.forced_kill).toBe(false);
    } finally {
      await runtime.cleanup({
        removeRunRoot: true,
      });
    }
  });
});
