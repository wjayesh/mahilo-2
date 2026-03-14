import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "bun:test";

function readReadme(): string {
  return readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
}

function readPackageJson(): {
  name?: string;
} {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
  ) as { name?: string };
}

function readSourceFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function readStringConstant(source: string, constantName: string): string {
  const pattern = new RegExp(`export const ${constantName} = "([^"]+)";`);
  const match = source.match(pattern);
  expect(match).not.toBeNull();

  if (!match) {
    throw new Error(`Missing constant ${constantName}`);
  }

  return match[1];
}

describe("README install docs", () => {
  it("opens with the positioning promise, guided first run, and persona entry links", () => {
    const readme = readReadme();
    const opening = readme.split("\n").slice(0, 24).join("\n");
    const guidedFirstRunIndex = readme.indexOf("./docs/guided-first-run.md");
    const askYourContactsIndex = readme.indexOf("./docs/ask-your-contacts.md");
    const boundariesAndTrustIndex = readme.indexOf("./docs/boundaries-and-trust.md");
    const buildYourCircleIndex = readme.indexOf("./docs/build-your-circle.md");
    const demoStoryPackIndex = readme.indexOf("./docs/demo-story-pack.md");
    const operatorProofIndex = readme.indexOf("./docs/trust-and-operations-proof.md");

    expect(opening).toContain("Ask your contacts from OpenClaw");
    expect(opening).toContain("real answers from people you trust");
    expect(opening).toContain("trust and control layer behind the plugin");
    expect(readme).toContain("server-issued policy bundles");

    expect(guidedFirstRunIndex).toBeGreaterThan(-1);
    expect(askYourContactsIndex).toBeGreaterThan(-1);
    expect(boundariesAndTrustIndex).toBeGreaterThan(-1);
    expect(buildYourCircleIndex).toBeGreaterThan(-1);
    expect(demoStoryPackIndex).toBeGreaterThan(-1);
    expect(operatorProofIndex).toBeGreaterThan(-1);
    expect(guidedFirstRunIndex).toBeLessThan(askYourContactsIndex);
    expect(askYourContactsIndex).toBeLessThan(boundariesAndTrustIndex);
    expect(boundariesAndTrustIndex).toBeLessThan(buildYourCircleIndex);
    expect(buildYourCircleIndex).toBeLessThan(demoStoryPackIndex);
    expect(demoStoryPackIndex).toBeLessThan(operatorProofIndex);
  });

  it("documents the published npm install flow and minimal OpenClaw config", () => {
    const readme = readReadme();
    const packageJson = readPackageJson();
    const identitySource = readSourceFile("../src/identity.ts");
    const runtimePluginId = readStringConstant(identitySource, "MAHILO_RUNTIME_PLUGIN_ID");
    const packageName = packageJson.name;
    const pluginConfigEntryKey = `plugins.entries.${runtimePluginId}.config`;

    expect(typeof packageName).toBe("string");
    expect(readme).toContain(`npm install ${packageName}`);
    expect(readme).toContain(`"${packageName}"`);
    expect(readme).toContain(pluginConfigEntryKey);
    expect(readme).toContain(`"${runtimePluginId}"`);
    expect(readme).toContain("baseUrl");
    expect(readme).toContain('"apiKey"');
    expect(readme).toContain("localPolicyLLM");
    expect(readme).toContain("apiKeyEnvVar");
    expect(readme).toContain("OPENAI_API_KEY");
    expect(readme).toContain("callbackUrl");
    expect(readme).toContain("https://mahilo.io");
    expect(readme).toContain("local runtime store");
  });

  it("documents compatibility, connectivity checks, and common failure modes", () => {
    const readme = readReadme();
    const contractSource = readSourceFile("../src/contract.ts");
    const webhookRouteSource = readSourceFile("../src/webhook-route.ts");
    const contractVersion = readStringConstant(contractSource, "MAHILO_CONTRACT_VERSION");
    const defaultWebhookRoutePath = readStringConstant(
      webhookRouteSource,
      "DEFAULT_WEBHOOK_ROUTE_PATH"
    );

    expect(readme).toContain("openclaw/plugin-sdk/core");
    expect(readme).toContain(contractVersion);
    expect(readme).toContain("single recommended first-run path");
    expect(readme).toContain("send_message");
    expect(readme).toContain("manage_network");
    expect(readme).toContain("set_boundaries");
    expect(readme).toContain("dry-run only, not live authorization");
    expect(readme).toContain("preview `resolution_id` values are never reused");
    expect(readme).toContain("advisory only");
    expect(readme).toContain("evaluated locally before transport");
    expect(readme).toContain("live outbound path is always");
    expect(readme).toContain("Fetch a direct-send or group-fanout bundle from Mahilo.");
    expect(readme).toContain("Local `ask` commits appear in `mahilo review`.");
    expect(readme).toContain("Local `deny` commits appear in blocked-event surfaces.");
    expect(readme).toContain("Group sends are per-recipient all the way through.");
    expect(readme).toContain("policy.ask.llm.<kind>");
    expect(readme).toContain("does not auto-send degraded local LLM review outcomes");
    expect(readme).toContain("opinions/recommendations");
    expect(readme).toContain("health, financial, and contact details");
    expect(readme).toContain("mahilo setup");
    expect(readme).toContain("invite token");
    expect(readme).toContain(`"invite_token":"mhinv_..."`);
    expect(readme).toContain("mahilo network");
    expect(readme).toContain("mahilo status");
    expect(readme).toContain("mahilo reconnect");
    expect(readme).toContain(defaultWebhookRoutePath);
    expect(readme).toContain("mahilo review");
    expect(readme).toContain("bun run demo:stories");
    expect(readme).toContain("rollout confidence");
    expect(readme).toContain("unsupported plugin config key(s)");
    expect(readme).toContain("unsupported localPolicyLLM config key(s)");
    expect(readme).toContain("contractVersion");
    expect(readme).toContain("pluginVersion");
    expect(readme).toContain("callbackSecret");
    expect(readme).toContain("callbackPath must start with '/'");
    expect(readme).toContain("localPolicyLLM.timeout must be a positive integer");
  });
});
