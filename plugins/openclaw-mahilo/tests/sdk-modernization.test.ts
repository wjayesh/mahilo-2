import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

const PUBLIC_PLUGIN_FILES = [
  "README.md",
  "openclaw.plugin.json",
  "package.json",
  "src/index.ts",
  "src/openclaw-plugin.ts"
];

const LEGACY_NAMES = [/\bclawdbot\b/i, /\bmoltbot\b/i];

describe("SDK modernization", () => {
  it("uses current OpenClaw plugin SDK import paths", () => {
    const source = readFileSync(
      join(process.cwd(), "src/openclaw-plugin.ts"),
      "utf8"
    );

    expect(source).toContain(`from "openclaw/plugin-sdk/core"`);
  });

  it("keeps legacy framework naming out of public-facing plugin files", () => {
    for (const filePath of PUBLIC_PLUGIN_FILES) {
      const content = readFileSync(join(process.cwd(), filePath), "utf8");

      for (const pattern of LEGACY_NAMES) {
        if (pattern.test(content)) {
          throw new Error(
            `legacy name ${pattern.source} found in ${filePath}`
          );
        }
      }
    }
  });
});
