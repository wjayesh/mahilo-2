# Launch Collateral

Use this for the first publish/announce cycle for `@mahilo/openclaw-mahilo`.

The goal is to validate the refreshed story with a small set of OpenClaw power users, not to build a full launch campaign or reopen migration work.

## Positioning Guardrails

- Lead with the user outcome: ask your contacts from OpenClaw and get real answers from people you trust.
- Keep the category line visible: Mahilo is a trust network for AI agents.
- Show the wedge before the platform: ask-around, attributed replies, explicit "I don't know", and boundary review.
- Be honest about the current first-run shape: Mahilo defaults to `https://mahilo.io`, and inbound callback routing is auto-detected when OpenClaw is already exposed through gateway remote or Tailscale.
- Do not lead with plugin migration, SDK modernization, contract versioning, or server internals.
- Reuse shipped docs, fixture-backed demos, and listing copy instead of inventing a parallel launch narrative.

## First Publish/Announce Asset Checklist

- [ ] Screenshot 1: guided first run
- [ ] Screenshot 2: ask-around proof
- [ ] Screenshot 3: boundary review proof
- [ ] Short-form walkthrough clip
- [ ] Comparison frame card
- [ ] Launch blurb / post draft

| Asset | Source of truth | What it must show |
| --- | --- | --- |
| Screenshot 1: guided first run | `bun run demo:stories --story guided-first-run` plus `docs/guided-first-run.md` | attached identity, selected sender, and `Mahilo status: connected; diagnostics snapshot available.` |
| Screenshot 2: ask-around proof | `bun run demo:stories --story restaurant-question` plus `docs/ask-your-contacts.md` | attributed replies plus one explicit `reported no grounded answer` outcome |
| Screenshot 3: boundary review proof | `bun run demo:stories --story boundaries-story` plus `docs/boundaries-and-trust.md` | `Mahilo needs review before sending this person message.` followed by the scoped approval path |
| Short-form walkthrough clip | `guided-first-run` plus `restaurant-question` stories | one ask-around question, at least one attributed reply, and one trust signal without leaving OpenClaw |
| Comparison frame card | approved copy in this doc plus `docs/listing-copy.md` | public AI noise versus real answers from people you trust |
| Launch blurb / post draft | `docs/listing-copy.md` | the one-line promise and short package description unchanged across npm, GitHub, and announcement surfaces |

If an asset cannot be produced from the shipped docs or fixture-backed stories, cut it instead of staging new product behavior for launch.

## Approved Comparison Frame

Use this structure for the first announcement, one-pager, or live demo intro:

- Before: public AI noise gives generic, anonymous, hard-to-trust answers.
- With Mahilo: ask once inside OpenClaw, fan out across your trusted network, and get attributed replies back in the same thread.
- Trust proof: every answer traces back to a person, explicit uncertainty stays visible, and sensitive sharing stops for review first.
- Punchline: real answers from real people you trust.

Avoid these frames:

- Mahilo as a protocol, registry, or developer platform first
- model-performance or benchmark comparisons
- migration parity, plugin packaging internals, or server contract talk
- claims that setup is fully zero-config today

## Early-Adopter Feedback Loop

Target the first 5 to 8 OpenClaw power users across three roles:

| Role | Why they matter | Minimum target |
| --- | --- | --- |
| Installer | Tests whether the positioning survives first contact with setup | 3 |
| Invited contact | Tests whether the social loop and trust framing feel worth joining | 2 |
| Demo-only observer | Tests whether the story is legible before they install | 1 |

Capture feedback immediately after the demo, install attempt, or first real ask-around. Use one running note, issue, or shared doc so the evidence does not stay buried in DMs.

### Feedback Note Template

- Participant:
- Role: installer, invited contact, or observer
- Entry point: demo, install, invite, or ask-around
- First sentence they used to describe Mahilo:
- Did they reach the first working reply? yes or no
- What felt trustworthy: attribution, boundaries, "I don't know", or none
- Where did they stall:
- Exact phrase worth reusing:
- Next action:

## Review Cadence And Decision Signals

- Review the first 3 notes one by one, then switch to a weekly rollup.
- The positioning lands if at least 3 of 5 people restate some version of "ask my contacts" or "real answers from people I trust" without prompting.
- The trust story lands if attribution or boundaries comes up unprompted in at least half of the notes.
- First-run friction still dominates if more than half of the notes stall before the first working reply or focus on setup/config details instead of the ask-around outcome.
- Feed any persistent gaps into the next positioning reassessment. Do not reopen migration-parity work from this loop unless a shipped plugin regression is exposed.
