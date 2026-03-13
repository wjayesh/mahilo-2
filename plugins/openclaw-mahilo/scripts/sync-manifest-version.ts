import { readFileSync, writeFileSync, existsSync } from "node:fs";

const manifestPaths = [
  new URL("../openclaw.plugin.json", import.meta.url),
  new URL("../clawdbot.plugin.json", import.meta.url),
];
const packageJsonPath = new URL("../package.json", import.meta.url);

const packageJson = readJsonFile(packageJsonPath);
const packageVersion = readRequiredString(packageJson.version, "package.json version");

let updated = false;
for (const manifestPath of manifestPaths) {
  if (!existsSync(manifestPath)) continue;
  const manifest = readJsonFile(manifestPath);
  const manifestVersion = readOptionalString(manifest.version);
  if (manifestVersion === packageVersion) continue;
  manifest.version = packageVersion;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  updated = true;
}

if (!updated) {
  process.exit(0);
}

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
