import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

function readDoc(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("documentation surface", () => {
  it("ships persona docs for the first three documentation hops", () => {
    const askYourContacts = readDoc("docs/ask-your-contacts.md");
    const boundariesAndTrust = readDoc("docs/boundaries-and-trust.md");
    const buildYourCircle = readDoc("docs/build-your-circle.md");

    expect(askYourContacts).toContain("networked OpenClaw power user");
    expect(askYourContacts).toContain(`mahilo_network`);
    expect(askYourContacts).toContain('"I don\'t know"');

    expect(boundariesAndTrust).toContain("boundary-conscious participant");
    expect(boundariesAndTrust).toContain("mahilo_boundaries");
    expect(boundariesAndTrust).toContain("mahilo review");

    expect(buildYourCircle).toContain("community seed user");
    expect(buildYourCircle).toContain("Mahilo server is the source of truth");
    expect(buildYourCircle).toContain("action=send_request");
  });

  it("keeps listing copy aligned with package and manifest descriptions", async () => {
    const listingCopy = readDoc("docs/listing-copy.md");
    const packageJson = (await Bun.file(join(process.cwd(), "package.json")).json()) as {
      description?: unknown;
      keywords?: unknown;
    };
    const manifest = (await Bun.file(join(process.cwd(), "openclaw.plugin.json")).json()) as {
      description?: unknown;
    };

    expect(listingCopy).toContain(
      "Ask your contacts from OpenClaw and get attributed answers with boundaries built in."
    );
    expect(listingCopy).toContain("Ask Your Contacts: Get trustworthy answers");
    expect(listingCopy).toContain("Boundaries and Trust: Keep your agent helpful");
    expect(listingCopy).toContain("Build Your Circle: Make a small trusted network useful");

    expect(packageJson.description).toBe(
      "Ask your contacts from OpenClaw and get attributed answers with boundaries built in."
    );
    expect(manifest.description).toBe(
      "Ask your contacts from OpenClaw and get attributed answers with boundaries built in."
    );
    expect(packageJson.keywords).toEqual([
      "mahilo",
      "openclaw",
      "plugin",
      "ask-around",
      "trust-network",
      "boundaries"
    ]);
  });
});
