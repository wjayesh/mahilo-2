import { resolve } from "node:path";

import {
  readDualSandboxConnectedRunFromRunRoot,
} from "./dual-sandbox-connections-lib";
import {
  redactRelationshipRunSummary,
  setupDualSandboxRelationships,
  type DualSandboxRelationshipOptions,
} from "./dual-sandbox-relationships-lib";

interface ParsedCliArgs extends DualSandboxRelationshipOptions {
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
    friendshipRoles: parseOptionalList(values.get("friendship-roles")),
    group: {
      description: readOptionalString(values, "group-description"),
      inviteOnly: parseOptionalBoolean(
        values.get("group-invite-only"),
        "--group-invite-only",
      ),
      name: readOptionalString(values, "group-name"),
      setup: parseOptionalBoolean(values.get("setup-group"), "--setup-group"),
    },
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

function parseOptionalBoolean(
  rawValue: string | undefined,
  flagName: string,
): boolean | undefined {
  if (!rawValue) {
    return undefined;
  }

  if (rawValue === "true") {
    return true;
  }
  if (rawValue === "false") {
    return false;
  }

  throw new Error(`${flagName} must be either true or false`);
}

function parseOptionalList(rawValue: string | undefined): string[] | undefined {
  if (!rawValue) {
    return undefined;
  }

  const values = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return values.length > 0 ? values : undefined;
}

function printHelpAndExit(code: number): never {
  console.log(
    [
      "Usage:",
      "  bun run plugins/openclaw-mahilo/scripts/dual-sandbox-relationships.ts \\",
      "    --run-root <fresh-run-root> \\",
      "    [--mahilo-base-url <http://127.0.0.1:18080>] \\",
      "    [--friendship-roles <close_friends,custom_role>] \\",
      "    [--setup-group <true|false>] \\",
      "    [--group-name <sandbox-harness-group>] \\",
      "    [--group-description <description>] \\",
      "    [--group-invite-only <true|false>]",
      "",
      "Reads the connected dual-sandbox run summary from",
      "<run-root>/runtime/provisioning.json, sends the sandbox A -> sandbox B",
      "friend request, accepts it from sandbox B, optionally assigns one or",
      "more friendship roles from sandbox A, creates a shared group by default,",
      "writes the updated runtime summary, and persists",
      "artifacts/provisioning/friendship-summary.json for later scenario steps.",
      "",
      "Group setup is enabled by default. Pass --setup-group false to skip it.",
      "Friendship roles are optional and should be provided as a comma-separated",
      "list.",
    ].join("\n"),
  );
  process.exit(code);
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const connected = readDualSandboxConnectedRunFromRunRoot(args.runRoot);
  const summary = await setupDualSandboxRelationships(connected, args);
  console.log(JSON.stringify(redactRelationshipRunSummary(summary), null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
