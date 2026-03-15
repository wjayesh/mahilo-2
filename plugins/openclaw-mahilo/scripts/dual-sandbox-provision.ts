import { resolve } from "node:path";

import {
  provisionDualSandboxUsers,
  readDualSandboxBootstrapFromRunRoot,
  redactProvisionedRunSummary,
  type DualSandboxProvisionOptions,
} from "./dual-sandbox-provision-lib";

interface ParsedCliArgs extends DualSandboxProvisionOptions {
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
    activeRouteProbePath: readOptionalString(values, "active-route-probe-path"),
    adminApiKey:
      readOptionalString(values, "admin-api-key") ??
      process.env.ADMIN_API_KEY ??
      "",
    mahiloBaseUrl: readOptionalString(values, "mahilo-base-url"),
    runRoot: readRequiredPath(values, "run-root"),
    sandboxUsers: {
      a: {
        display_name: readOptionalString(values, "sandbox-a-display-name"),
        username: readOptionalString(values, "sandbox-a-username"),
      },
      b: {
        display_name: readOptionalString(values, "sandbox-b-display-name"),
        username: readOptionalString(values, "sandbox-b-username"),
      },
    },
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
      "  bun run plugins/openclaw-mahilo/scripts/dual-sandbox-provision.ts \\",
      "    --run-root <fresh-run-root> \\",
      "    [--admin-api-key <admin-api-key>] \\",
      "    [--mahilo-base-url <http://127.0.0.1:18080>] \\",
      "    [--active-route-probe-path </api/v1/plugin/reviews?limit=1>] \\",
      "    [--sandbox-a-username <sandboxsender>] \\",
      "    [--sandbox-a-display-name <Sandbox Sender>] \\",
      "    [--sandbox-b-username <sandboxreceiver>] \\",
      "    [--sandbox-b-display-name <Sandbox Receiver>]",
      "",
      "Reads the dual-sandbox bootstrap summary from",
      "<run-root>/runtime/provisioning.json, mints one invite token per sandbox",
      "user through /api/v1/admin/invite-tokens, registers both users through",
      "/api/v1/auth/register, verifies plugin-protected route access, writes",
      "minimal auth artifacts to <run-root>/runtime/sandbox-{a,b}/auth.json",
      "plus redacted copies under artifacts/sandboxes/, updates the",
      "secret-bearing runtime provisioning summary, and prints the redacted",
      "artifact-safe summary to stdout.",
      "",
      "If --admin-api-key is omitted, the script falls back to the current",
      "ADMIN_API_KEY environment variable.",
      "",
      "Direct DB seeding remains fallback-only via",
      "plugins/openclaw-mahilo/scripts/seed-local-policy-sandbox.ts.",
    ].join("\n"),
  );
  process.exit(code);
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const bootstrap = readDualSandboxBootstrapFromRunRoot(args.runRoot);
  const summary = await provisionDualSandboxUsers(bootstrap, args);
  console.log(JSON.stringify(redactProvisionedRunSummary(summary), null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
