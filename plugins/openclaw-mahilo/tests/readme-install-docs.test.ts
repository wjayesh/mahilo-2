import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  DEFAULT_WEBHOOK_ROUTE_PATH,
  MAHILO_CONTRACT_VERSION,
  MAHILO_PLUGIN_CONFIG_ENTRY_KEY,
  MAHILO_PLUGIN_PACKAGE_NAME,
  MAHILO_RUNTIME_PLUGIN_ID
} from "../src";

function readReadme(): string {
  return readFileSync(join(process.cwd(), "README.md"), "utf8");
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

    expect(opening).toContain("Ask your contacts from OpenClaw");
    expect(opening).toContain("real answers from people you trust");
    expect(opening).toContain("trust and control layer behind the plugin");

    expect(guidedFirstRunIndex).toBeGreaterThan(-1);
    expect(askYourContactsIndex).toBeGreaterThan(-1);
    expect(boundariesAndTrustIndex).toBeGreaterThan(-1);
    expect(buildYourCircleIndex).toBeGreaterThan(-1);
    expect(demoStoryPackIndex).toBeGreaterThan(-1);
    expect(guidedFirstRunIndex).toBeLessThan(askYourContactsIndex);
    expect(askYourContactsIndex).toBeLessThan(boundariesAndTrustIndex);
    expect(boundariesAndTrustIndex).toBeLessThan(buildYourCircleIndex);
    expect(buildYourCircleIndex).toBeLessThan(demoStoryPackIndex);
  });

  it("documents the published npm install flow and minimal OpenClaw config", () => {
    const readme = readReadme();

    expect(readme).toContain(`npm install ${MAHILO_PLUGIN_PACKAGE_NAME}`);
    expect(readme).toContain(`"${MAHILO_PLUGIN_PACKAGE_NAME}"`);
    expect(readme).toContain(MAHILO_PLUGIN_CONFIG_ENTRY_KEY);
    expect(readme).toContain(`"${MAHILO_RUNTIME_PLUGIN_ID}"`);
    expect(readme).toContain('"baseUrl"');
    expect(readme).toContain('"apiKey"');
  });

  it("documents compatibility, connectivity checks, and common failure modes", () => {
    const readme = readReadme();

    expect(readme).toContain("openclaw/plugin-sdk/core");
    expect(readme).toContain(MAHILO_CONTRACT_VERSION);
    expect(readme).toContain("single recommended first-run path");
    expect(readme).toContain("mahilo_message");
    expect(readme).toContain("mahilo_network");
    expect(readme).toContain("mahilo_boundaries");
    expect(readme).toContain("opinions/recommendations");
    expect(readme).toContain("health, financial, and contact details");
    expect(readme).toContain("mahilo setup");
    expect(readme).toContain("mahilo network");
    expect(readme).toContain("mahilo status");
    expect(readme).toContain("mahilo reconnect");
    expect(readme).toContain(DEFAULT_WEBHOOK_ROUTE_PATH);
    expect(readme).toContain("mahilo review");
    expect(readme).toContain("bun run demo:stories");
    expect(readme).toContain("unsupported plugin config key(s)");
    expect(readme).toContain("contractVersion");
    expect(readme).toContain("pluginVersion");
    expect(readme).toContain("callbackSecret");
    expect(readme).toContain("callbackPath must start with '/'");
  });
});
