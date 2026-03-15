import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDualSandboxBootstrap,
  DUAL_SANDBOX_SCENARIO_IDS,
} from "../scripts/dual-sandbox-bootstrap-lib";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapScriptPath = resolve(
  pluginRoot,
  "scripts",
  "dual-sandbox-bootstrap.ts",
);

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
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

function createAuthProfilesSourceFile(): string {
  const directory = trackPath(mkdtempSync(join(tmpdir(), "mahilo-auth-profiles-")));
  const filePath = join(directory, "auth-profiles.json");
  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        default: {
          provider: "openai",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return filePath;
}

function expectedOpenClawConfig(input: {
  callbackUrl: string;
  gatewayPort: number;
  mahiloBaseUrl: string;
  optionalLocalPolicyLLM?: Record<string, unknown>;
  pluginPath: string;
}): Record<string, unknown> {
  return {
    gateway: {
      auth: {
        mode: "none",
      },
      bind: "loopback",
      http: {
        endpoints: {
          chatCompletions: {
            enabled: true,
          },
        },
      },
      mode: "local",
      port: input.gatewayPort,
    },
    plugins: {
      allow: ["mahilo"],
      enabled: true,
      entries: {
        mahilo: {
          config: {
            baseUrl: input.mahiloBaseUrl,
            callbackUrl: input.callbackUrl,
            ...(input.optionalLocalPolicyLLM
              ? {
                  localPolicyLLM: input.optionalLocalPolicyLLM,
                }
              : {}),
          },
          enabled: true,
        },
      },
      load: {
        paths: [input.pluginPath],
      },
    },
  };
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
    expect(summary.proof_inputs).toEqual({
      deterministic: {
        plugin_path: pluginRoot,
        shared_mahilo_base_url: summary.mahilo.base_url,
      },
      optional_live_model: {
        configured: false,
        local_policy_llm: null,
        provider_auth_copy: {
          enabled: false,
        },
      },
    });
    expect(readJsonFile(summary.sandboxes.a.runtime_state_path)).toEqual({
      servers: {},
      version: 1,
    });
    expect(existsSync(summary.sandboxes.a.auth_path)).toBe(false);
    expect(existsSync(summary.sandboxes.b.auth_path)).toBe(false);
    expect(readJsonFile(summary.sandboxes.a.openclaw_config_path)).toEqual(
      expectedOpenClawConfig({
        callbackUrl: summary.sandboxes.a.callback_url,
        gatewayPort: summary.ports.gateway_a,
        mahiloBaseUrl: summary.mahilo.base_url,
        pluginPath: summary.proof_inputs.deterministic.plugin_path,
      }),
    );
    expect(readJsonFile(summary.sandboxes.b.openclaw_config_path)).toEqual(
      expectedOpenClawConfig({
        callbackUrl: summary.sandboxes.b.callback_url,
        gatewayPort: summary.ports.gateway_b,
        mahiloBaseUrl: summary.mahilo.base_url,
        pluginPath: summary.proof_inputs.deterministic.plugin_path,
      }),
    );
    expect(readJsonFile(summary.sandboxes.a.artifact_paths.config_redacted_path)).toEqual(
      readJsonFile(summary.sandboxes.a.openclaw_config_path),
    );
    expect(readJsonFile(summary.sandboxes.b.artifact_paths.config_redacted_path)).toEqual(
      readJsonFile(summary.sandboxes.b.openclaw_config_path),
    );
    expect(existsSync(summary.sandboxes.a.artifact_paths.auth_redacted_path)).toBe(
      false,
    );
    expect(existsSync(summary.sandboxes.b.artifact_paths.auth_redacted_path)).toBe(
      false,
    );
    expect(existsSync(summary.sandboxes.a.provider_auth_profiles_path)).toBe(
      false,
    );
    expect(existsSync(summary.sandboxes.b.provider_auth_profiles_path)).toBe(
      false,
    );
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
    expect(readJsonFile(summary.sandboxes.a.openclaw_config_path)).toEqual(
      expectedOpenClawConfig({
        callbackUrl: summary.sandboxes.a.callback_url,
        gatewayPort: 29123,
        mahiloBaseUrl: "http://127.0.0.1:28080",
        pluginPath: pluginRoot,
      }),
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

  it("adds explicit optional live-model config and copies provider auth only when requested", () => {
    const authProfilesSource = createAuthProfilesSourceFile();
    const summary = createDualSandboxBootstrap({
      optionalLiveModel: {
        apiKeyEnvVar: "OPENAI_API_KEY",
        authProfile: "sandbox-live",
        copyProviderAuthFrom: authProfilesSource,
        model: "gpt-4o-mini",
        provider: "openai",
        timeoutMs: 9000,
      },
    });
    trackPath(summary.run_root);

    expect(summary.proof_inputs.optional_live_model).toEqual({
      configured: true,
      local_policy_llm: {
        api_key_env_var: "OPENAI_API_KEY",
        auth_profile: "sandbox-live",
        model: "gpt-4o-mini",
        provider: "openai",
        timeout_ms: 9000,
      },
      provider_auth_copy: {
        enabled: true,
      },
    });
    expect(readJsonFile(summary.sandboxes.a.openclaw_config_path)).toEqual(
      expectedOpenClawConfig({
        callbackUrl: summary.sandboxes.a.callback_url,
        gatewayPort: summary.ports.gateway_a,
        mahiloBaseUrl: summary.mahilo.base_url,
        optionalLocalPolicyLLM: {
          apiKeyEnvVar: "OPENAI_API_KEY",
          authProfile: "sandbox-live",
          model: "gpt-4o-mini",
          provider: "openai",
          timeout: 9000,
        },
        pluginPath: summary.proof_inputs.deterministic.plugin_path,
      }),
    );
    expect(readFileSync(summary.sandboxes.a.provider_auth_profiles_path, "utf8")).toBe(
      readFileSync(authProfilesSource, "utf8"),
    );
    expect(readFileSync(summary.sandboxes.b.provider_auth_profiles_path, "utf8")).toBe(
      readFileSync(authProfilesSource, "utf8"),
    );
  });

  it("rejects implicit provider auth copying without an explicit auth profile", () => {
    const authProfilesSource = createAuthProfilesSourceFile();

    expect(() =>
      createDualSandboxBootstrap({
        optionalLiveModel: {
          copyProviderAuthFrom: authProfilesSource,
        },
      }),
    ).toThrow("optionalLiveModel.copyProviderAuthFrom requires optionalLiveModel.authProfile");
  });

  it("prints the machine-readable summary from the CLI entrypoint", () => {
    const rootPath = createFreshExplicitRoot();
    const authProfilesSource = createAuthProfilesSourceFile();
    const result = spawnSync(
      process.execPath,
      [
        "run",
        bootstrapScriptPath,
        "--root",
        rootPath,
        "--mahilo-port",
        "38080",
        "--plugin-path",
        pluginRoot,
        "--live-model-provider",
        "openai",
        "--live-model-model",
        "gpt-4o-mini",
        "--live-model-auth-profile",
        "cli-live",
        "--live-model-api-key-env-var",
        "OPENAI_API_KEY",
        "--live-model-timeout-ms",
        "12000",
        "--copy-provider-auth-from",
        authProfilesSource,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);

    const summary = JSON.parse(result.stdout) as {
      proof_inputs: {
        deterministic: { plugin_path: string };
        optional_live_model: {
          configured: boolean;
          local_policy_llm: {
            api_key_env_var?: string;
            auth_profile?: string;
            model?: string;
            provider?: string;
            timeout_ms: number;
          } | null;
          provider_auth_copy: { enabled: boolean };
        };
      };
      mahilo: { base_url: string };
      paths: { runtime_provisioning_path: string };
      sandboxes: {
        a: {
          callback_url: string;
          openclaw_config_path: string;
          provider_auth_profiles_path: string;
        };
      };
      run_root: string;
    };

    expect(summary.run_root).toBe(rootPath);
    expect(summary.mahilo.base_url).toBe("http://127.0.0.1:38080");
    expect(summary.proof_inputs).toEqual({
      deterministic: {
        plugin_path: pluginRoot,
        shared_mahilo_base_url: "http://127.0.0.1:38080",
      },
      optional_live_model: {
        configured: true,
        local_policy_llm: {
          api_key_env_var: "OPENAI_API_KEY",
          auth_profile: "cli-live",
          model: "gpt-4o-mini",
          provider: "openai",
          timeout_ms: 12000,
        },
        provider_auth_copy: {
          enabled: true,
        },
      },
    });
    expect(readJsonFile(summary.sandboxes.a.openclaw_config_path)).toEqual(
      expectedOpenClawConfig({
        callbackUrl: summary.sandboxes.a.callback_url,
        gatewayPort: 19123,
        mahiloBaseUrl: "http://127.0.0.1:38080",
        optionalLocalPolicyLLM: {
          apiKeyEnvVar: "OPENAI_API_KEY",
          authProfile: "cli-live",
          model: "gpt-4o-mini",
          provider: "openai",
          timeout: 12000,
        },
        pluginPath: pluginRoot,
      }),
    );
    expect(readFileSync(summary.sandboxes.a.provider_auth_profiles_path, "utf8")).toBe(
      readFileSync(authProfilesSource, "utf8"),
    );
    expect(readJsonFile(summary.paths.runtime_provisioning_path)).toEqual(
      summary,
    );
  });
});
