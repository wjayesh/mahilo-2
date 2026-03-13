import {
  loadBundledDemoStoryFixtures,
  renderDemoStoryPack,
  runDemoStoryFixture,
  runDemoStoryFixturePack,
} from "./demo-story-pack-lib";

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  bun run demo:stories",
      "  bun run demo:stories --story <story-id>",
      "  bun run demo:stories --json",
      "  bun run demo:stories --list",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixtures = loadBundledDemoStoryFixtures();

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  if (args.includes("--list")) {
    for (const fixture of fixtures) {
      console.log(`${fixture.id}: ${fixture.title}`);
    }
    return;
  }

  const storyIndex = args.indexOf("--story");
  const storyId =
    storyIndex >= 0 && storyIndex + 1 < args.length
      ? args[storyIndex + 1]
      : undefined;

  if (storyIndex >= 0 && !storyId) {
    throw new Error("--story requires a story id.");
  }

  const selectedFixture = storyId
    ? fixtures.find((fixture) => fixture.id === storyId)
    : undefined;
  if (storyId && !selectedFixture) {
    throw new Error(
      `Unknown story ${storyId}. Use --list to see available story ids.`,
    );
  }

  const runs = selectedFixture
    ? [await runDemoStoryFixture(selectedFixture)]
    : await runDemoStoryFixturePack(fixtures);

  if (args.includes("--json")) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }

  console.log(renderDemoStoryPack(runs));
}

await main();
