import { resolve } from "node:path";

import { createDualSandboxBootstrap } from "./dual-sandbox-bootstrap-lib";

interface ParsedCliArgs {
  gatewayAPort?: number;
  gatewayBPort?: number;
  mahiloPort?: number;
  rootPath?: string;
  tempRootParent?: string;
}

function parseArgs(argv: string[]): ParsedCliArgs {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) {
      continue;
    }

    if (current === "--help" || current === "-h") {
      printHelpAndExit(0);
    }

    if (!current.startsWith("--")) {
      throw new Error(`Unexpected argument: ${current}`);
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${current}`);
    }

    values.set(current.slice(2), next);
    index += 1;
  }

  if (values.has("root") && values.has("root-parent")) {
    throw new Error("Use either --root or --root-parent, not both.");
  }

  return {
    gatewayAPort: parseOptionalPort(values.get("gateway-a-port"), "--gateway-a-port"),
    gatewayBPort: parseOptionalPort(values.get("gateway-b-port"), "--gateway-b-port"),
    mahiloPort: parseOptionalPort(values.get("mahilo-port"), "--mahilo-port"),
    rootPath: readOptionalPath(values, "root"),
    tempRootParent: readOptionalPath(values, "root-parent"),
  };
}

function readOptionalPath(
  values: Map<string, string>,
  key: string,
): string | undefined {
  const value = values.get(key)?.trim();
  return value ? resolve(value) : undefined;
}

function parseOptionalPort(
  rawValue: string | undefined,
  flagName: string,
): number | undefined {
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${flagName} must be an integer between 1 and 65535`);
  }

  return parsed;
}

function printHelpAndExit(code: number): never {
  console.log(
    [
      "Usage:",
      "  bun run plugins/openclaw-mahilo/scripts/dual-sandbox-bootstrap.ts \\",
      "    [--root <fresh-root-path>] \\",
      "    [--root-parent <fresh-root-parent>] \\",
      "    [--mahilo-port <18080>] \\",
      "    [--gateway-a-port <19123>] \\",
      "    [--gateway-b-port <19124>]",
      "",
      "Creates a fresh two-sandbox Mahilo/OpenClaw harness root, writes the",
      "canonical provisioning summaries, and prints the machine-readable summary",
      "to stdout.",
    ].join("\n"),
  );
  process.exit(code);
}

async function main() {
  const summary = createDualSandboxBootstrap(parseArgs(Bun.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
