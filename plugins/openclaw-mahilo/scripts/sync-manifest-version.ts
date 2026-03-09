import { readFileSync, writeFileSync } from "node:fs";

const manifestPath = new URL("../openclaw.plugin.json", import.meta.url);
const packageJsonPath = new URL("../package.json", import.meta.url);

const packageJson = readJsonFile(packageJsonPath);
const manifest = readJsonFile(manifestPath);
const packageVersion = readRequiredString(packageJson.version, "package.json version");
const manifestVersion = readOptionalString(manifest.version);

if (manifestVersion === packageVersion) {
  process.exit(0);
}

manifest.version = packageVersion;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

function readJsonFile(url: URL): Record<string, unknown> {
  const raw = readFileSync(url, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    throw new Error(`${url.pathname} must contain a JSON object`);
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readRequiredString(value: unknown, label: string): string {
  const normalized = readOptionalString(value);
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return normalized;
}
