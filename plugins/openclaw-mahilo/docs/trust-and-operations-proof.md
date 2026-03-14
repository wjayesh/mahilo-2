# Trust and Operations Proof

For the skeptical operator or team lead who wants adoption evidence before turning Mahilo on for a real team.

Mahilo's user story is easy to like; this page covers the operational proof behind it. The goal is to answer the questions that usually block adoption: who has final control, what can be observed from inside OpenClaw, how failure states behave, and how to pilot the plugin without a big-bang rollout.

## Operator Proof At A Glance

- Mahilo server remains policy truth and audit authority. In non-trusted mode, the plugin evaluates server-issued bundles locally before transport, then commits the result back to Mahilo.
- Sensitive shares stop in an explicit review path. `mahilo review`, ask-mode decisions, and `set_boundaries` exceptions keep approvals visible instead of burying them in prompts.
- Operators get first-party diagnostics inside OpenClaw. `mahilo status` shows connectivity probes, redacted config, callback path, reconnect history, and local runtime counters.
- Network readiness is inspectable before rollout. `mahilo network` shows sender connections, contacts, pending requests, recent review/blocked activity, and lightweight seven-day product signals.
- Inbound replies are authenticated and retry-safe. Callback signatures are verified, stale or invalid callbacks are rejected, and duplicate deliveries are deduplicated by message id.
- Demo and release proof stay tied to shipped artifacts. The story pack runs through the real plugin registration/tool/webhook paths, and the release gate plus tarball smoke test verify what will actually be packaged.

## Governance And Observability Proof Points

| Concern | Proof point | How to inspect it |
| --- | --- | --- |
| Final authority | Mahilo is policy truth. Non-trusted sends enforce locally from server-issued bundles, and preview/prompt guidance stay advisory. | Use the guided first run approval sequence and watch `send_message` return `review_required` before any sensitive transport. |
| Approval surface | Review states stay visible as product states instead of disappearing into transport errors. | Run `mahilo review`, or trigger the `set_boundaries` exception flow from the guided first run. |
| Actor identity | Default sender resolution comes from Mahilo server state and stays deterministic. Explicit overrides remain available only for advanced routing. | Run `mahilo setup`, then `mahilo status` or `mahilo network` to inspect sender connections before the first ask. |
| Connectivity and health | `mahilo status` probes the review queue and blocked-event surfaces, returns redacted config, callback path, reconnect history, and runtime counters. | Run `mahilo status` after setup and after any incident. |
| Recent operational activity | Reviews and blocked events are surfaced alongside contacts and pending requests. | Run `mahilo network` or `mahilo_network` with `action=list`. |
| Delivery accountability | Send, outcome, and override flows support idempotency so retries do not create ambiguous double actions. | Reuse the same idempotency key when repeating a send/preview/override during testing. |
| Inbound callback safety | Signed webhook validation rejects spoofed or stale callbacks, and duplicate retries are acknowledged without replaying delivery. | Use the demo pack or webhook tests when changing callback plumbing. |
| Packaged evidence | Demo and publish checks are verified from the plugin package itself, not from private notes. | Run `bun run demo:stories`, `bun test tests/tarball-smoke.test.ts`, and `node scripts/release-gate.mjs`. |

## Required Config For Local Enforcement

- `baseUrl`: optional override. Leave it at `https://mahilo.io` unless you intentionally target another Mahilo server.
- `apiKey`: optional when invite-token bootstrap is allowed. Preseed it only when you already have an existing Mahilo key to reuse.
- `callbackPath` / `callbackUrl`: `callbackPath` defaults to `/mahilo/incoming`; set `callbackUrl` only when OpenClaw auto-detection is wrong for your deployment.
- `inboundSessionKey` / `inboundAgentId`: inbound routing fallbacks only. They do not control outbound enforcement.
- `localPolicyLLM`: required only when applicable policies use `evaluator="llm"`. Configure provider/model/timeout plus local credential lookup through `apiKey`, `apiKeyEnvVar`, or the provider-default env var such as `OPENAI_API_KEY`.
- `reviewMode`: keep `ask` or `manual` for conservative rollout. `reviewMode=auto` still does not bypass degraded local LLM reviews.
- `promptContextEnabled`: prompt enrichment only. Turning it off does not disable the live bundle -> local evaluation -> commit path.

## Failure Semantics Operators Should Expect

- Prompt context and preview remain UX-only surfaces. A live non-trusted send still fetches a fresh bundle, evaluates locally, commits the result, and only then transports committed `allow` recipients.
- Missing local LLM credentials or evaluator failures degrade to `policy.ask.llm.<kind>` reason codes such as `policy.ask.llm.unavailable`, `policy.ask.llm.network`, or `policy.ask.llm.timeout`. Those outcomes stay `review_required`; they do not silently auto-send even when `reviewMode=auto`.
- Group sends may legitimately split across `allow`, `ask`, and `deny`. The plugin transports only committed `allow` members and leaves the rest visible in review or blocked surfaces one member at a time.
- Ask-around silence is not treated as a transport failure. The thread keeps moving, and explicit uncertainty is preferable to fabricated output.

## Audit Mapping

- Local `ask` commits become review records and show up in `mahilo review`.
- Local `deny` commits become blocked events and stay visible through recent activity plus blocked-event inspection.
- Local `allow` commits create pending transport artifacts first; later `/api/v1/messages/send` and `/api/v1/plugin/outcomes` calls extend that same audit trail.
- Group fanout audits are per committed member artifact, not per bundle. Mixed results are expected and supportable.

## Demo Plan For Skeptical Review

Use this sequence when the audience cares more about rollout risk than feature sparkle.

### Approval Path

1. Run `bun run demo:stories --story guided-first-run`.
2. Stop on `Mahilo needs review before sending this person message.`
3. Show the scoped exception: `Boundary exception saved: allow sharing location with alice for 1 hour.`
4. End on `Message sent through Mahilo.`

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
  Mahilo owns the canonical policies and audits. In non-trusted mode, the plugin resolves server-issued bundles locally before transport, then commits the result so reviews, overrides, and blocked-event surfaces stay server-visible.
- "We need something the on-call or operator can inspect quickly."
  `mahilo status` is the fast health snapshot. `mahilo network` is the fast readiness and recent-activity snapshot. `mahilo review` is the fast approval-queue snapshot.
- "We need safe failure behavior, not dead ends."
  Empty networks turn into invite/setup next actions, silent contacts degrade gracefully, degraded local LLM evaluation falls back to review instead of fail-open, and sensitive sends stop on review or blocked states with explicit follow-up guidance.
- "We need confidence that docs and demos reflect real behavior."
  The story pack drives the real plugin registration, tool execution, and webhook formatting path, and the tarball smoke test ensures those docs ship in the packaged artifact.
- "We need a publish or rollout gate."
  Use the release gate before a pilot or release. It checks manifest drift, build/test success, and packed-artifact contents.

## Small-Team Rollout Checklist

1. Install the plugin and let it use the default Mahilo server (`https://mahilo.io`) unless you intentionally override it.
2. Run `mahilo setup`, `mahilo status`, and `mahilo network`.
3. If you use LLM policies, configure `localPolicyLLM` and verify the expected key source exists on the OpenClaw host.
4. Invite one trusted partner and wait for one live Mahilo agent connection.
5. Replay the approval path and at least one degraded-path walkthrough.
6. Pilot ask-around with a small circle before expanding.
7. Run `node scripts/release-gate.mjs` before publish or wider rollout.

## Next

- Need the canonical user journey first? Read [Guided First Run](./guided-first-run.md).
- Need the runnable replay scripts? Read [Demo Story Pack](./demo-story-pack.md).
- Need the publish-surface gate? Read [Release Gates](./release-gates.md).
