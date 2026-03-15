import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDualSandboxBootstrap,
  DUAL_SANDBOX_SCENARIO_IDS,
} from "../scripts/dual-sandbox-bootstrap-lib";

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

const cleanupPaths: string[] = [];

function trackPath(path: string): string {
  cleanupPaths.push(path);
  return path;
}

function createFreshExplicitRoot(): string {
  const parent = trackPath(mkdtempSync(join(tmpdir(), "mahilo-dual-sandbox-")));
  return join(parent, "run-root");
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

describe("dual sandbox bootstrap", () => {
  it("creates a fresh root with isolated sandbox runtime paths and canonical summaries", () => {
    const summary = createDualSandboxBootstrap();
    trackPath(summary.run_root);

    expect(existsSync(summary.run_root)).toBe(true);
    expect(summary.runtime_dir).toBe(join(summary.run_root, "runtime"));
    expect(summary.artifacts_dir).toBe(join(summary.run_root, "artifacts"));
    expect(summary.mahilo.db_path).toBe(
      join(summary.run_root, "runtime", "mahilo", "mahilo.db"),
    );
    expect(summary.sandboxes.a.openclaw_home).toBe(
      join(summary.run_root, "runtime", "sandbox-a", "openclaw-home"),
    );
    expect(summary.sandboxes.b.openclaw_home).toBe(
      join(summary.run_root, "runtime", "sandbox-b", "openclaw-home"),
    );
    expect(summary.sandboxes.a.openclaw_home).not.toBe(
      summary.sandboxes.b.openclaw_home,
    );
    expect(summary.sandboxes.a.env.OPENCLAW_HOME).toBe(
      summary.sandboxes.a.openclaw_home,
    );
    expect(summary.sandboxes.b.env.OPENCLAW_CONFIG_PATH).toBe(
      summary.sandboxes.b.openclaw_config_path,
    );
    expect(readJsonFile(summary.sandboxes.a.runtime_state_path)).toEqual({
      servers: {},
      version: 1,
    });
    expect(readJsonFile(summary.sandboxes.b.openclaw_config_path)).toEqual({});
    expect(readJsonFile(summary.paths.runtime_provisioning_path)).toEqual(
      summary,
    );
    expect(readJsonFile(summary.paths.artifact_bootstrap_summary_path)).toEqual(
      summary,
    );

    for (const scenarioId of DUAL_SANDBOX_SCENARIO_IDS) {
      expect(existsSync(summary.paths.scenarios[scenarioId])).toBe(true);
    }
  });

  it("supports explicit root and port overrides", () => {
    const rootPath = createFreshExplicitRoot();
    const summary = createDualSandboxBootstrap({
      gatewayAPort: 29123,
      gatewayBPort: 29124,
      mahiloPort: 28080,
      rootPath,
    });

    expect(summary.run_root).toBe(rootPath);
    expect(summary.ports).toEqual({
      gateway_a: 29123,
      gateway_b: 29124,
      mahilo: 28080,
    });
    expect(summary.mahilo.base_url).toBe("http://127.0.0.1:28080");
    expect(summary.sandboxes.a.callback_url).toBe(
      "http://127.0.0.1:29123/mahilo/incoming",
    );
    expect(summary.sandboxes.b.callback_url).toBe(
      "http://127.0.0.1:29124/mahilo/incoming",
    );
  });

  it("rejects duplicate port assignments before creating the root", () => {
    const rootPath = createFreshExplicitRoot();

    expect(() =>
      createDualSandboxBootstrap({
        gatewayAPort: 28080,
        gatewayBPort: 29124,
        mahiloPort: 28080,
        rootPath,
      }),
    ).toThrow("Configured ports must be distinct");
    expect(existsSync(rootPath)).toBe(false);
  });

  it("prints the machine-readable summary from the CLI entrypoint", () => {
    const rootPath = createFreshExplicitRoot();
    const result = spawnSync(
      process.execPath,
      [
        "run",
        "plugins/openclaw-mahilo/scripts/dual-sandbox-bootstrap.ts",
        "--root",
        rootPath,
        "--mahilo-port",
        "38080",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);

    const summary = JSON.parse(result.stdout) as {
      mahilo: { base_url: string };
      paths: { runtime_provisioning_path: string };
      run_root: string;
    };

    expect(summary.run_root).toBe(rootPath);
    expect(summary.mahilo.base_url).toBe("http://127.0.0.1:38080");
    expect(readJsonFile(summary.paths.runtime_provisioning_path)).toEqual(
      summary,
    );
  });
});
