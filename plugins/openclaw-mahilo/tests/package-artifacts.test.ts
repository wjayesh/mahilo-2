import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "bun:test";

interface NpmPackFile {
  path?: string;
}

interface NpmPackResult {
  files?: NpmPackFile[];
}

function normalizePackPath(filePath: string): string {
  return filePath.replace(/^\.\//, "");
}

function readPackageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function readPluginManifest(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(process.cwd(), "openclaw.plugin.json"), "utf8")
  ) as Record<string, unknown>;
}

function readPackArtifactPaths(): Set<string> {
  const tempRoot = mkdtempSync(join(tmpdir(), "mahilo-openclaw-pack-"));
  const packageDir = join(tempRoot, "package");
  const bundledPolicyCoreDir = join(tempRoot, "packages", "policy-core");
  const sourcePolicyCoreDir = resolve(process.cwd(), "..", "..", "packages", "policy-core");

  cpSync(process.cwd(), packageDir, { recursive: true });
  if (existsSync(sourcePolicyCoreDir)) {
    cpSync(sourcePolicyCoreDir, bundledPolicyCoreDir, { recursive: true });
  }
  rmSync(join(packageDir, "dist"), { force: true, recursive: true });
  rmSync(join(packageDir, "node_modules"), { force: true, recursive: true });

  const result = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json"],
    {
      cwd: packageDir,
      encoding: "utf8"
    }
  );

  try {
    expect(result.status).toBe(0);

    if (result.status !== 0) {
      throw new Error(result.stderr || "npm pack --dry-run failed");
    }

    const jsonStart = result.stdout.indexOf("[");
    expect(jsonStart).toBeGreaterThanOrEqual(0);

    if (jsonStart < 0) {
      throw new Error("npm pack --dry-run did not return JSON output");
    }

    const payload = JSON.parse(result.stdout.slice(jsonStart)) as NpmPackResult[];
    const files = Array.isArray(payload[0]?.files) ? payload[0].files : [];

    return new Set(
      files
        .map((file) => file.path)
        .filter((filePath): filePath is string => typeof filePath === "string")
    );
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

describe("package artifacts", () => {
  it("rebuilds dist and includes runtime/release files in clean npm pack --dry-run", () => {
    const packageJson = readPackageJson();
    const manifest = readPluginManifest();
    const filePaths = readPackArtifactPaths();
    const exports = packageJson.exports as Record<string, unknown>;
    const rootExport = exports["."] as Record<string, unknown>;

    expect(filePaths.has(normalizePackPath(packageJson.main as string))).toBe(true);
    expect(filePaths.has(normalizePackPath(packageJson.types as string))).toBe(true);
    expect(filePaths.has(normalizePackPath(rootExport.import as string))).toBe(true);
    expect(filePaths.has(normalizePackPath(rootExport.types as string))).toBe(true);
    expect(filePaths.has(normalizePackPath(packageJson.pluginManifest as string))).toBe(true);
    expect(filePaths.has(normalizePackPath(manifest.entry as string))).toBe(true);
    expect(filePaths.has("dist/index.d.ts")).toBe(true);
    expect(filePaths.has("dist/openclaw-plugin-sdk-core.d.ts")).toBe(true);
    expect(filePaths.has("index.d.ts")).toBe(true);
    expect(filePaths.has("openclaw.plugin.json")).toBe(true);
    expect(filePaths.has("README.md")).toBe(true);
    expect(filePaths.has("LICENSE")).toBe(true);
    expect(filePaths.has("RELEASING.md")).toBe(true);
  });
});
