import { describe, expect, it } from "bun:test";

import { runTarballSmokeTest } from "../scripts/tarball-smoke-test";

describe("tarball smoke test", () => {
  it("installs and registers from the packed artifact in a clean OpenClaw-style scratch setup", async () => {
    const summary = await runTarballSmokeTest(process.cwd());

    expect(summary.dryRunFiles).toEqual(
      expect.arrayContaining([
        "LICENSE",
        "README.md",
        "RELEASING.md",
        "docs/ask-your-contacts.md",
        "docs/boundaries-and-trust.md",
        "docs/build-your-circle.md",
        "docs/demo-fixtures/boundaries-story.json",
        "docs/demo-fixtures/guided-first-run.json",
        "docs/demo-fixtures/restaurant-question.json",
        "docs/demo-fixtures/weekend-plan-coordination.json",
        "docs/demo-story-pack.md",
        "docs/guided-first-run.md",
        "docs/launch-collateral.md",
        "docs/listing-copy.md",
        "docs/trust-and-operations-proof.md",
        "dist/index.js",
        "openclaw.plugin.json",
        "PUBLISH-CHECKLIST.md",
        "package.json"
      ])
    );
    expect(summary.extensionName).toBe("@mahilo/openclaw-mahilo");
    expect(summary.packageExtensionEntry).toBe("./dist/index.js");
    expect(summary.manifestEntry).toBe("./dist/index.js");
    expect(summary.requiredConfigKeys).toEqual(["baseUrl"]);
    expect(summary.toolNames).toEqual([
      "mahilo_boundaries",
      "mahilo_message",
      "mahilo_network"
    ]);
    expect(summary.commandNames).toEqual(["mahilo"]);
    expect(summary.hookNames).toEqual([
      "after_tool_call",
      "agent_end",
      "before_prompt_build"
    ]);
    expect(summary.routePaths).toEqual(["/mahilo/incoming"]);
  }, 30_000);
});
