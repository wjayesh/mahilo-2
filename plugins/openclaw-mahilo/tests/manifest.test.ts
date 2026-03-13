import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "bun:test";
import {
  MAHILO_PLUGIN_CONFIG_KEYS,
  MAHILO_PLUGIN_PACKAGE_NAME,
  MAHILO_PLUGIN_RELEASE_VERSION,
  MAHILO_RUNTIME_PLUGIN_ID,
  MAHILO_RUNTIME_PLUGIN_NAME
} from "../src";

const manifestPath = new URL("../openclaw.plugin.json", import.meta.url);
const packageJsonPath = new URL("../package.json", import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function expectPackagedFileExists(baseUrl: URL, filePath: unknown): void {
  expect(typeof filePath).toBe("string");

  if (typeof filePath !== "string") {
    return;
  }

  expect(existsSync(fileURLToPath(new URL(filePath, baseUrl)))).toBe(true);
}

describe("openclaw.plugin.json", () => {
  it("loads package metadata with chosen package identity", async () => {
    const packageJson = (await Bun.file(packageJsonPath).json()) as unknown;

    expect(isRecord(packageJson)).toBe(true);
    if (!isRecord(packageJson)) {
      return;
    }

    expect(packageJson.name).toBe(MAHILO_PLUGIN_PACKAGE_NAME);
    expect(packageJson.version).toBe(MAHILO_PLUGIN_RELEASE_VERSION);
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.description).toBe(
      "Ask your contacts from OpenClaw and get attributed answers with boundaries built in."
    );
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.author).toBe("Jayesh Sharma <wjayesh@outlook.com>");
    expect(packageJson.homepage).toBe("https://github.com/wjayesh/mahilo-2#readme");
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.module).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./index.d.ts");
    expect(packageJson.pluginManifest).toBe("./openclaw.plugin.json");
    expect(packageJson.files).toEqual([
      "dist",
      "docs",
      "index.d.ts",
      "LICENSE",
      "openclaw.plugin.json",
      "clawdbot.plugin.json",
      "PUBLISH-CHECKLIST.md",
      "README.md",
      "RELEASING.md"
    ]);
    expect(packageJson.keywords).toEqual([
      "mahilo",
      "openclaw",
      "plugin",
      "ask-around",
      "trust-network",
      "boundaries"
    ]);

    expectPackagedFileExists(packageJsonPath, packageJson.main);
    expectPackagedFileExists(packageJsonPath, packageJson.types);
    expectPackagedFileExists(packageJsonPath, packageJson.pluginManifest);

    const repository = packageJson.repository;
    expect(isRecord(repository)).toBe(true);

    if (!isRecord(repository)) {
      return;
    }

    expect(repository.type).toBe("git");
    expect(repository.url).toBe("git+https://github.com/wjayesh/mahilo-2.git");
    expect(repository.directory).toBe("plugins/openclaw-mahilo");

    const bugs = packageJson.bugs;
    expect(isRecord(bugs)).toBe(true);

    if (!isRecord(bugs)) {
      return;
    }

    expect(bugs.url).toBe("https://github.com/wjayesh/mahilo-2/issues");

    const publishConfig = packageJson.publishConfig;
    expect(isRecord(publishConfig)).toBe(true);

    if (!isRecord(publishConfig)) {
      return;
    }

    expect(publishConfig.access).toBe("public");

    const exports = packageJson.exports;
    expect(isRecord(exports)).toBe(true);

    if (!isRecord(exports)) {
      return;
    }

    const rootExport = exports["."];
    expect(isRecord(rootExport)).toBe(true);

    if (!isRecord(rootExport)) {
      return;
    }

    expect(rootExport.types).toBe("./index.d.ts");
    expect(rootExport.import).toBe("./dist/index.js");
    expect(rootExport.default).toBe("./dist/index.js");
    expect(exports["./openclaw.plugin.json"]).toBe("./openclaw.plugin.json");
    expect(exports["./package.json"]).toBe("./package.json");

    const scripts = packageJson.scripts;
    expect(isRecord(scripts)).toBe(true);

    if (!isRecord(scripts)) {
      return;
    }

    expect(scripts.prepare).toBe("bun run build");
    expect(scripts.prepack).toBe("bun run build");
    expect(scripts.prepublishOnly).toBe("bun run check");

    const openclaw = packageJson.openclaw;
    expect(isRecord(openclaw)).toBe(true);

    if (!isRecord(openclaw)) {
      return;
    }

    const extensions = openclaw.extensions;
    expect(Array.isArray(extensions)).toBe(true);

    if (!Array.isArray(extensions)) {
      return;
    }

    expect(extensions).toEqual(["./dist/index.js"]);
    expectPackagedFileExists(packageJsonPath, extensions[0]);
  });

  it("loads manifest metadata", async () => {
    const manifest = (await Bun.file(manifestPath).json()) as unknown;
    const packageJson = (await Bun.file(packageJsonPath).json()) as unknown;

    expect(isRecord(manifest)).toBe(true);
    if (!isRecord(manifest)) {
      return;
    }

    expect(isRecord(packageJson)).toBe(true);
    if (!isRecord(packageJson)) {
      return;
    }

    expect(manifest.id).toBe(MAHILO_RUNTIME_PLUGIN_ID);
    expect(manifest.name).toBe(MAHILO_RUNTIME_PLUGIN_NAME);
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.description).toBe(
      "Ask your contacts from OpenClaw and get attributed answers with boundaries built in."
    );
    expect(manifest.entry).toBe("./dist/index.js");
    expectPackagedFileExists(manifestPath, manifest.entry);
  });

  it("loads config schema with clear plugin-local boundaries", async () => {
    const manifest = (await Bun.file(manifestPath).json()) as unknown;

    expect(isRecord(manifest)).toBe(true);
    if (!isRecord(manifest)) {
      return;
    }

    const configSchema = manifest.configSchema;
    expect(isRecord(configSchema)).toBe(true);

    if (!isRecord(configSchema)) {
      return;
    }

    expect(configSchema.type).toBe("object");
    expect(configSchema.additionalProperties).toBe(false);
    expect(configSchema.description).toContain("Plugin-local runtime configuration only");
    expect(configSchema.description).toContain("source of truth");

    const required = configSchema.required;
    expect(Array.isArray(required)).toBe(true);

    if (!Array.isArray(required)) {
      return;
    }

    expect(required).toEqual([]);

    const properties = configSchema.properties;
    expect(isRecord(properties)).toBe(true);

    if (!isRecord(properties)) {
      return;
    }

    expect(Object.keys(properties).sort()).toEqual([...MAHILO_PLUGIN_CONFIG_KEYS].sort());

    const baseUrl = properties.baseUrl;
    const apiKey = properties.apiKey;
    const callbackPath = properties.callbackPath;
    const promptContextEnabled = properties.promptContextEnabled;

    expect(isRecord(baseUrl)).toBe(true);
    expect(isRecord(apiKey)).toBe(true);
    expect(isRecord(callbackPath)).toBe(true);
    expect(isRecord(promptContextEnabled)).toBe(true);

    if (
      !isRecord(baseUrl) ||
      !isRecord(apiKey) ||
      !isRecord(callbackPath) ||
      !isRecord(promptContextEnabled)
    ) {
      return;
    }

    expect(baseUrl.type).toBe("string");
    expect(apiKey.type).toBe("string");
    expect(apiKey.format).toBeUndefined();
    expect(apiKey.writeOnly).toBe(true);
    expect(apiKey["x-sensitive"]).toBe(true);
    expect(callbackPath.pattern).toBe("^\\/.*");
    expect(promptContextEnabled.type).toBe("boolean");
    expect(promptContextEnabled.default).toBe(true);
  });
});
