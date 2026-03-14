import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

function readContractDoc(): string {
  return readFileSync(
    join(process.cwd(), "docs", "openclaw-plugin-server-contract.md"),
    "utf8",
  );
}

describe("openclaw plugin server contract docs", () => {
  it("summarizes the live bundle/commit/report flow and local audit semantics", () => {
    const contractDoc = readContractDoc();

    expect(contractDoc).toContain("Bundle/Commit/Report Cheat Sheet");
    expect(contractDoc).toContain(
      "bundle -> local evaluation -> local-decision commit -> transport -> outcome report",
    );
    expect(contractDoc).toContain("member-by-member evaluation");
    expect(contractDoc).toContain("policy.ask.llm.<kind>");
    expect(contractDoc).toContain("plugin_local_pre_delivery");
    expect(contractDoc).toContain("Mahilo never returns provider secrets or host credentials");
    expect(contractDoc).toContain("per committed member artifact");
    expect(contractDoc).toContain("Rollout And Enablement");
    expect(contractDoc).toContain("`trustedMode` remains the only rollout gate");
    expect(contractDoc).toContain("active by default on upgrade");
  });
});
