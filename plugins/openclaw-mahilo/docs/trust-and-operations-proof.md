# Trust and Operations Proof

For the skeptical operator or team lead who wants adoption evidence before turning Mahilo on for a real team.

Mahilo's user story is easy to like; this page covers the operational proof behind it. The goal is to answer the questions that usually block adoption: who has final control, what can be observed from inside OpenClaw, how failure states behave, and how to pilot the plugin without a big-bang rollout.

## Operator Proof At A Glance

- Mahilo server remains policy truth. The plugin can preview and explain decisions, but final `allow` / `ask` / `deny` still come from Mahilo at send time.
- Sensitive shares stop in an explicit review path. `mahilo review`, ask-mode decisions, and `mahilo_boundaries` exceptions keep approvals visible instead of burying them in prompts.
- Operators get first-party diagnostics inside OpenClaw. `mahilo status` shows connectivity probes, redacted config, callback path, reconnect history, and local runtime counters.
- Network readiness is inspectable before rollout. `mahilo network` shows sender connections, contacts, pending requests, recent review/blocked activity, and lightweight seven-day product signals.
- Inbound replies are authenticated and retry-safe. Callback signatures are verified, stale or invalid callbacks are rejected, and duplicate deliveries are deduplicated by message id.
- Demo and release proof stay tied to shipped artifacts. The story pack runs through the real plugin registration/tool/webhook paths, and the release gate plus tarball smoke test verify what will actually be packaged.

## Governance And Observability Proof Points

| Concern | Proof point | How to inspect it |
| --- | --- | --- |
| Final authority | Mahilo is policy truth and final send-time enforcement. Plugin preflight is UX guidance, not a bypass. | Use the guided first run approval sequence and watch `mahilo_message` return `review_required` before any sensitive send. |
| Approval surface | Review states stay visible as product states instead of disappearing into transport errors. | Run `mahilo review`, or trigger the `mahilo_boundaries` exception flow from the guided first run. |
| Actor identity | Default sender resolution comes from Mahilo server state and stays deterministic. Explicit overrides remain available only for advanced routing. | Run `mahilo setup`, then `mahilo status` or `mahilo network` to inspect sender connections before the first ask. |
| Connectivity and health | `mahilo status` probes the review queue and blocked-event surfaces, returns redacted config, callback path, reconnect history, and runtime counters. | Run `mahilo status` after setup and after any incident. |
| Recent operational activity | Reviews and blocked events are surfaced alongside contacts and pending requests. | Run `mahilo network` or `mahilo_network` with `action=list`. |
| Delivery accountability | Send, outcome, and override flows support idempotency so retries do not create ambiguous double actions. | Reuse the same idempotency key when repeating a send/preview/override during testing. |
| Inbound callback safety | Signed webhook validation rejects spoofed or stale callbacks, and duplicate retries are acknowledged without replaying delivery. | Use the demo pack or webhook tests when changing callback plumbing. |
| Packaged evidence | Demo and publish checks are verified from the plugin package itself, not from private notes. | Run `bun run demo:stories`, `bun test tests/tarball-smoke.test.ts`, and `node scripts/release-gate.mjs`. |

## Demo Plan For Skeptical Review

Use this sequence when the audience cares more about rollout risk than feature sparkle.

### Approval Path

1. Run `bun run demo:stories --story guided-first-run`.
2. Stop on `Message requires review before delivery.`
3. Show the scoped exception: `Boundary exception saved: allow sharing location with alice for 1 hour.`
4. End on `Mahilo preview: allow.`

What this proves: sensitive data does not go out silently, the operator can see the review stop clearly, and the retry succeeds only because the approval changed policy intentionally.

### Failure And Degraded-Path Walkthroughs

1. Run `bun run demo:stories --story weekend-plan-coordination`.
2. Call out `If someone stays silent, nothing is stuck.`
3. Optional second proof: run `bun run demo:stories --story restaurant-question` and show `reported no grounded answer`.

What this proves: non-responses do not stall the thread, and Mahilo prefers explicit uncertainty over fabricated opinions.

## Team Adoption Concerns

- "We do not want a big-bang rollout."
  Start with one operator-configured OpenClaw runtime, one accepted contact, and the guided first run. Mahilo proves value with the one-contact loop before asking a larger team to onboard.
- "We need to know who is making the decision."
  Mahilo makes the final `allow` / `ask` / `deny` decision on the server, while the plugin exposes the result through preview, review, blocked-event, and boundary surfaces.
- "We need something the on-call or operator can inspect quickly."
  `mahilo status` is the fast health snapshot. `mahilo network` is the fast readiness and recent-activity snapshot. `mahilo review` is the fast approval-queue snapshot.
- "We need safe failure behavior, not dead ends."
  Empty networks turn into invite/setup next actions, silent contacts degrade gracefully, and sensitive sends stop on review or blocked states with explicit follow-up guidance.
- "We need confidence that docs and demos reflect real behavior."
  The story pack drives the real plugin registration, tool execution, and webhook formatting path, and the tarball smoke test ensures those docs ship in the packaged artifact.
- "We need a publish or rollout gate."
  Use the release gate before a pilot or release. It checks manifest drift, build/test success, and packed-artifact contents.

## Small-Team Rollout Checklist

1. Save `baseUrl` and the public `callbackUrl` once.
2. Run `mahilo setup`, `mahilo status`, and `mahilo network`.
3. Invite one trusted partner and wait for one live Mahilo agent connection.
4. Replay the approval path and at least one degraded-path walkthrough.
5. Pilot ask-around with a small circle before expanding.
6. Run `node scripts/release-gate.mjs` before publish or wider rollout.

## Next

- Need the canonical user journey first? Read [Guided First Run](./guided-first-run.md).
- Need the runnable replay scripts? Read [Demo Story Pack](./demo-story-pack.md).
- Need the publish-surface gate? Read [Release Gates](./release-gates.md).
