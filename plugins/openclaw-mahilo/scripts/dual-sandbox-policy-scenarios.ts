import { resolve } from "node:path";

import { readDualSandboxRelationshipRunFromRunRoot } from "./dual-sandbox-relationships-lib";
import {
  redactPolicyScenarioRunSummary,
  seedDualSandboxPolicyScenarios,
  type DualSandboxPolicyScenarioOptions,
} from "./dual-sandbox-policy-scenarios-lib";

interface ParsedCliArgs extends DualSandboxPolicyScenarioOptions {
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
    missingLLMModel: readOptionalString(values, "missing-llm-model"),
    missingLLMProvider: readOptionalString(values, "missing-llm-provider"),
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
      "  bun run plugins/openclaw-mahilo/scripts/dual-sandbox-policy-scenarios.ts \\",
      "    --run-root <fresh-run-root> \\",
      "    [--mahilo-base-url <http://127.0.0.1:18080>] \\",
      "    [--missing-llm-provider <openai>] \\",
      "    [--missing-llm-model <gpt-4o-mini>]",
      "",
      "Reads the dual-sandbox relationship summary from",
      "<run-root>/runtime/provisioning.json, seeds the baseline live-proof policy",
      "fixtures through /api/v1/preferences and /api/v1/policies, updates the",
      "runtime summary, and writes artifacts/provisioning/policy-summary.json",
      "with the explicit S2/S3/S4/S5 scenario mapping. No dashboard steps are",
      "required before the later live-proof runner consumes these fixtures.",
      "",
      "The missing-local-LLM scenario records the provider/model defaults that",
      "should degrade to policy.ask.llm.unavailable when local credentials are",
      "absent on the baseline deterministic path.",
    ].join("\n"),
  );
  process.exit(code);
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const relationships = readDualSandboxRelationshipRunFromRunRoot(args.runRoot);
  const summary = await seedDualSandboxPolicyScenarios(relationships, args);
  console.log(JSON.stringify(redactPolicyScenarioRunSummary(summary), null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
