import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  loadBundledDemoStoryFixtures,
  renderDemoStoryPack,
  runDemoStoryFixturePack,
} from "../scripts/demo-story-pack-lib";

function readDoc(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("demo story pack", () => {
  it("loads the guided first run plus the launch story fixtures from disk", () => {
    const fixtures = loadBundledDemoStoryFixtures();

    expect(fixtures.map((fixture) => fixture.id)).toEqual([
      "guided-first-run",
      "restaurant-question",
      "weekend-plan-coordination",
      "boundaries-story",
    ]);
    expect(fixtures.every((fixture) => fixture.steps.length >= 3)).toBe(true);
    expect(fixtures.every((fixture) => fixture.trustSignals.length >= 3)).toBe(true);
  });

  it("replays all launch stories with provenance, trust, and boundaries signals", async () => {
    const runs = await runDemoStoryFixturePack();
    const rendered = renderDemoStoryPack(runs);

    expect(rendered).toContain("Guided First Run");
    expect(rendered).toContain("Mahilo status: connected; diagnostics snapshot available.");
    expect(rendered).toContain("Check that your first accepted contacts are ready before the first ask");
    expect(rendered).toContain("The real empty-network loop is send_request -> accept -> mahilo setup on the other side.");
    expect(rendered).toContain("Ask the network for one recommendation using the sender selected by setup");
    expect(rendered).toContain("Mahilo ask-around update");
    expect(rendered).toContain("Restaurant Question");
    expect(rendered).toContain("Try Mensho for the broth.");
    expect(rendered).toContain("reported no grounded answer");
    expect(rendered).toContain("What time should we leave for Saturday's Tahoe day trip?");
    expect(rendered).toContain('Asked: Mahilo contacts in roles "weekend_planners".');
    expect(rendered).toContain("If someone stays silent, nothing is stuck.");
    expect(rendered).toContain("Message requires review before delivery.");
    expect(rendered).toContain("Boundary exception saved: allow sharing location with alice for 1 hour.");
    expect(rendered).toContain("Mahilo preview: allow.");
    expect(rendered).toContain("This step intentionally omits senderConnectionId");
  });

  it("documents how to run the demo pack without a live server", () => {
    const demoDoc = readDoc("docs/demo-story-pack.md");

    expect(demoDoc).toContain("bun run demo:stories");
    expect(demoDoc).toContain("guided-first-run");
    expect(demoDoc).toContain("build-your-circle checkpoint");
    expect(demoDoc).toContain("restaurant-question");
    expect(demoDoc).toContain("weekend-plan-coordination");
    expect(demoDoc).toContain("boundaries-story");
    expect(demoDoc).toContain("Operator Walkthroughs");
    expect(demoDoc).toContain("Message requires review before delivery.");
    expect(demoDoc).toContain("If someone stays silent, nothing is stuck.");
    expect(demoDoc).toContain("without a live Mahilo server");
  });
});
