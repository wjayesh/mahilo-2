import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

function readDoc(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("documentation surface", () => {
  it("ships one canonical guided first-run path with measurable success criteria", () => {
    const guidedFirstRun = readDoc("docs/guided-first-run.md");

    expect(guidedFirstRun).toContain("single recommended quickstart path");
    expect(guidedFirstRun).toContain("Five-Minute");
    expect(guidedFirstRun).toContain("mahilo setup");
    expect(guidedFirstRun).toContain("mahilo status");
    expect(guidedFirstRun).toContain("mahilo network");
    expect(guidedFirstRun).toContain('"action": "send_request"');
    expect(guidedFirstRun).toContain("Build your circle");
    expect(guidedFirstRun).toContain("first working reply");
    expect(guidedFirstRun).toContain("ask_network");
    expect(guidedFirstRun).toContain("Mahilo ask-around update");
    expect(guidedFirstRun).toContain("send_message");
    expect(guidedFirstRun).toContain("set_boundaries");
    expect(guidedFirstRun).toContain("callbackUrl");
    expect(guidedFirstRun).toContain("\"username\": \"your_handle\"");
    expect(guidedFirstRun).toContain("Success Scorecard");
  });

  it("ships persona docs for the first three documentation hops", () => {
    const askYourContacts = readDoc("docs/ask-your-contacts.md");
    const boundariesAndTrust = readDoc("docs/boundaries-and-trust.md");
    const buildYourCircle = readDoc("docs/build-your-circle.md");

    expect(askYourContacts).toContain("networked OpenClaw power user");
    expect(askYourContacts).toContain(`ask_network`);
    expect(askYourContacts).toContain('"I don\'t know"');

    expect(boundariesAndTrust).toContain("boundary-conscious participant");
    expect(boundariesAndTrust).toContain("set_boundaries");
    expect(boundariesAndTrust).toContain("mahilo review");

    expect(buildYourCircle).toContain("community seed user");
    expect(buildYourCircle).toContain("Mahilo server is the source of truth");
    expect(buildYourCircle).toContain("action=send_request");
  });

  it("ships a runnable demo story pack for the launch narratives", () => {
    const demoStoryPack = readDoc("docs/demo-story-pack.md");

    expect(demoStoryPack).toContain("bun run demo:stories");
    expect(demoStoryPack).toContain("guided-first-run");
    expect(demoStoryPack).toContain("build-your-circle checkpoint");
    expect(demoStoryPack).toContain("restaurant-question");
    expect(demoStoryPack).toContain("weekend-plan-coordination");
    expect(demoStoryPack).toContain("boundaries-story");
    expect(demoStoryPack).toContain("real plugin registration path");
    expect(demoStoryPack).toContain("Operator Walkthroughs");
    expect(demoStoryPack).toContain("If someone stays silent, nothing is stuck.");
  });

  it("ships first-launch collateral with comparison framing and a feedback loop", () => {
    const launchCollateral = readDoc("docs/launch-collateral.md");

    expect(launchCollateral).toContain("first publish/announce cycle");
    expect(launchCollateral).toContain("trust network for AI agents");
    expect(launchCollateral).toContain("Do not lead with plugin migration");
    expect(launchCollateral).toContain("Screenshot 1: guided first run");
    expect(launchCollateral).toContain("guided-first-run");
    expect(launchCollateral).toContain("restaurant-question");
    expect(launchCollateral).toContain("boundaries-story");
    expect(launchCollateral).toContain("public AI noise");
    expect(launchCollateral).toContain("Early-Adopter Feedback Loop");
    expect(launchCollateral).toContain("Did they reach the first working reply?");
    expect(launchCollateral).toContain("3 of 5 people restate");
  });

  it("ships an operator-facing proof doc for governance, observability, and rollout confidence", () => {
    const operatorProof = readDoc("docs/trust-and-operations-proof.md");

    expect(operatorProof).toContain("skeptical operator or team lead");
    expect(operatorProof).toContain("Governance And Observability Proof Points");
    expect(operatorProof).toContain("mahilo status");
    expect(operatorProof).toContain("mahilo network");
    expect(operatorProof).toContain("mahilo review");
    expect(operatorProof).toContain("guided-first-run");
    expect(operatorProof).toContain("weekend-plan-coordination");
    expect(operatorProof).toContain("reported no grounded answer");
    expect(operatorProof).toContain("Team Adoption Concerns");
    expect(operatorProof).toContain("node scripts/release-gate.mjs");
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
