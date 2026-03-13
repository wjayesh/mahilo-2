import { readFileSync } from "node:fs";

const packageJsonPath = new URL("../package.json", import.meta.url);

export const MAHILO_PLUGIN_RELEASE_VERSION = readPackageVersion();

function readPackageVersion(): string {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };

  if (typeof packageJson.version !== "string" || packageJson.version.trim().length === 0) {
    throw new Error("package.json version must be a non-empty string");
  }

  return packageJson.version.trim();
}
