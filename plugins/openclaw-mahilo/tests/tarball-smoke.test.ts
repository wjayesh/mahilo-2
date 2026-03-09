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
        "dist/index.js",
        "openclaw.plugin.json",
        "package.json"
      ])
    );
    expect(summary.extensionName).toBe("@mahilo/openclaw-mahilo");
    expect(summary.packageExtensionEntry).toBe("./dist/index.js");
    expect(summary.manifestEntry).toBe("./dist/index.js");
    expect(summary.requiredConfigKeys).toEqual(["apiKey", "baseUrl"]);
    expect(summary.toolNames).toEqual([
      "create_mahilo_override",
      "get_mahilo_context",
      "list_mahilo_contacts",
      "manage_mahilo_relationships",
      "preview_mahilo_send",
      "talk_to_agent",
      "talk_to_group"
    ]);
    expect(summary.commandNames).toEqual([
      "mahilo override",
      "mahilo reconnect",
      "mahilo relationships",
      "mahilo review",
      "mahilo setup",
      "mahilo status"
    ]);
    expect(summary.hookNames).toEqual([
      "after_tool_call",
      "agent_end",
      "before_prompt_build"
    ]);
    expect(summary.routePaths).toEqual(["/mahilo/incoming"]);
  });
});
