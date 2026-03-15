import { resolve } from "node:path";

import {
  connectDualSandboxGateways,
  readDualSandboxConnectedRunFromRunRoot,
  redactConnectedRunSummary,
  type DualSandboxConnectOptions,
} from "./dual-sandbox-connections-lib";
import { readDualSandboxProvisionedRunFromRunRoot } from "./dual-sandbox-provision-lib";

interface ParsedCliArgs extends DualSandboxConnectOptions {
  runRoot: string;
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

  return {
    mahiloBaseUrl: readOptionalString(values, "mahilo-base-url"),
    runRoot: readRequiredPath(values, "run-root"),
  };
}

function readRequiredPath(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) {
    throw new Error(`Missing required argument --${key}`);
  }

  return resolve(value);
}

function readOptionalString(
  values: Map<string, string>,
  key: string,
): string | undefined {
  const value = values.get(key)?.trim();
  return value ? value : undefined;
}

function printHelpAndExit(code: number): never {
  console.log(
    [
      "Usage:",
      "  bun run plugins/openclaw-mahilo/scripts/dual-sandbox-connections.ts \\",
      "    --run-root <fresh-run-root> \\",
      "    [--mahilo-base-url <http://127.0.0.1:18080>]",
      "",
      "Reads the dual-sandbox provisioning summary from",
      "<run-root>/runtime/provisioning.json, registers one OpenClaw webhook",
      "connection per sandbox user through /api/v1/agents, writes each",
      "sandbox runtime-state file with the callback connection metadata,",
      "persists redacted runtime-state and agent-registration evidence under",
      "artifacts/sandboxes/, updates the secret-bearing runtime provisioning",
      "summary, and prints the redacted summary to stdout.",
    ].join("\n"),
  );
  process.exit(code);
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const provisioned = readDualSandboxProvisionedRunFromRunRoot(args.runRoot);
  await connectDualSandboxGateways(provisioned, args);
  const connected = readDualSandboxConnectedRunFromRunRoot(args.runRoot);
  console.log(JSON.stringify(redactConnectedRunSummary(connected), null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
