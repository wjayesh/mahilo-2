import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

function readReleasingDoc(): string {
  return readFileSync(join(process.cwd(), "RELEASING.md"), "utf8");
}

describe("release docs", () => {
  it("documents the repeatable tarball smoke-test flow", () => {
    const releasing = readReleasingDoc();

    expect(releasing).toContain("bun run smoke:tarball");
    expect(releasing).toContain("npm pack --dry-run --json");
    expect(releasing).toContain("npm pack --json");
    expect(releasing).toContain("npm install");
    expect(releasing).toContain("openclaw.config.json");
    expect(releasing).toContain("openclaw.extensions");
  });
});
