# Demo Story Pack

Run the canonical guided first run plus the launch stories from the positioning doc without a live Mahilo server or a real OpenClaw runtime.

The story pack replays fixture data through the real plugin registration path, tool execution path, and inbound webhook formatting path. That means the output comes from the same provenance, trust, and boundary code the plugin already ships, not from hand-written screenshots.

## Run It

From [`plugins/openclaw-mahilo/`](../README.md#local-development-from-this-repo):

```bash
bun run demo:stories
```

Useful variants:

- `bun run demo:stories --list`
- `bun run demo:stories --story guided-first-run`
- `bun run demo:stories --story restaurant-question`
- `bun run demo:stories --json`

## What The Pack Covers

| Story ID | Launch story | What it proves |
| --- | --- | --- |
| `guided-first-run` | Guided first run | The single recommended first run after the build-your-circle checkpoint: setup, connected status, circle-ready check, ask-around, live reply handoff, review-required preview, and one explicit approval in one path. |
| `restaurant-question` | Restaurant question | Ask once, get attributed answers back in-thread, and keep `"I don't know"` explicit instead of fabricating advice. |
| `weekend-plan-coordination` | Weekend plan / coordination | Fan out one coordination question to a role-filtered circle and keep partial progress useful even when someone stays silent. |
| `boundaries-story` | Boundaries story | Start from conservative defaults, stop on review for a sensitive share, then apply a conversational temporary exception and retry cleanly. |

## Fixture Layout

The fixture source of truth lives in:

- [`docs/demo-fixtures/guided-first-run.json`](./demo-fixtures/guided-first-run.json)
- [`docs/demo-fixtures/restaurant-question.json`](./demo-fixtures/restaurant-question.json)
- [`docs/demo-fixtures/weekend-plan-coordination.json`](./demo-fixtures/weekend-plan-coordination.json)
- [`docs/demo-fixtures/boundaries-story.json`](./demo-fixtures/boundaries-story.json)

Each fixture is intentionally small:

- mock Mahilo identity / network state
- ordered demo steps
- trust signals the story is supposed to make obvious

## Why This Is Repeatable

- The runner uses a mocked Mahilo contract client, so no server seed data is required.
- The runner drives the actual plugin tools and webhook route, so provenance and boundary wording stay aligned with shipped behavior.
- The guided first-run replay starts right after the first accepted contacts are live, so you can rehearse the working-reply loop quickly after practicing the invite step from [Build Your Circle](./build-your-circle.md).
- Each story is self-describing and can be replayed individually by story id.

## Fast Validation

If you only want the automated check, run:

```bash
bun test tests/demo-story-pack.test.ts
```
