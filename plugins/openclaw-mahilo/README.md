# Mahilo for OpenClaw

**Ask your contacts from OpenClaw and get real answers from people you trust, with attribution and boundaries built in.**

Mahilo for OpenClaw turns "ask my contacts" into a native OpenClaw behavior. Instead of trusting public AI noise or repeating the same question across chats, you ask once inside OpenClaw and the plugin uses Mahilo to reach the right contacts, bring back attributed answers from real people you already trust, and honor the sharing boundaries each person has set. OpenClaw stays the conversational surface; Mahilo stays behind the scenes as the trust and control layer for identity, network discovery, server-issued policy bundles, local non-trusted enforcement before transport, and audited review/outcome flows.

## Start Here

Choose the path that matches why you're here:

- [Guided First Run](./docs/guided-first-run.md): the single recommended five-minute path for setup, build-your-circle, ask-around, human approval, and a live Mahilo handoff.
- [Ask Your Contacts](./docs/ask-your-contacts.md): get trustworthy answers from your network without leaving OpenClaw.
- [Boundaries and Trust](./docs/boundaries-and-trust.md): keep your agent helpful without giving up control.
- [Build Your Circle](./docs/build-your-circle.md): make a small trusted network useful from the first few connections.
- [Demo Story Pack](./docs/demo-story-pack.md): replay the restaurant, weekend-planning, and boundaries launch stories from fixture data.
- [Trust and Operations Proof](./docs/trust-and-operations-proof.md): operator-facing evidence for governance, observability, failure handling, and rollout confidence.

If you want the shortest credible explanation first: Mahilo is the trust and control layer behind the plugin. It knows who is in your network, which agent connection is acting, what can be shared, and whether a request should be allowed, reviewed, or blocked.

## Recommended First Run

The single recommended first-run path is [Guided First Run](./docs/guided-first-run.md). It proves setup, the build-your-circle checkpoint, live connectivity, ask-around orchestration, an in-thread Mahilo handoff, and explicit human approval in one OpenClaw session.

If you only want the raw command/tool sequence, the loop is:

1. If you already have a Mahilo API key in plugin config, restart OpenClaw and let the plugin auto-attach the default sender on startup. If you do not, give the agent your one-time invite token (a string starting with `mhinv_`) and let the plugin bootstrap automatically via raw HTTP — the agent will register your identity with `POST /api/v1/auth/register`, attach the default sender with `POST /api/v1/agents`, and save credentials to the local runtime store. No command or manual setup step required.
2. Run `mahilo status` to confirm connectivity and webhook alignment.
3. Run `mahilo network` or `manage_network` with `action=list` to see whether your circle is ready.
4. If the network is empty, stay in `manage_network` and use `action=send_request` to invite one trusted person. If they already invited you, use `action=accept`, then have them bring their Mahilo plugin online in OpenClaw.
5. Once one accepted contact has a live agent connection, ask OpenClaw to check with your Mahilo contacts, or call `ask_network` with `action=ask_around`.
6. Send a sensitive follow-up with `send_message` to prove the live review gate before transport.
7. Use `set_boundaries` to grant a narrow exception, then retry the same send.

## Install From npm

`@mahilo/openclaw-mahilo` is the published Mahilo plugin for OpenClaw. Install it as a normal npm package, register it in `openclaw.extensions`, and keep runtime settings under `plugins.entries.mahilo.config`.

```bash
npm install @mahilo/openclaw-mahilo
```

Then add the installed package to `openclaw.extensions` in your OpenClaw runtime config:

```json
{
  "openclaw": {
    "extensions": ["@mahilo/openclaw-mahilo"]
  }
}
```

For a published npm install, point `openclaw.extensions` at the package name, not `dist/index.js`. The package already declares its packaged extension entry internally.

## Minimal Working OpenClaw Config

Add the Mahilo plugin entry to the same OpenClaw config file:

```json
{
  "openclaw": {
    "extensions": ["@mahilo/openclaw-mahilo"]
  },
  "plugins": {
    "entries": {
      "mahilo": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

By default, the plugin talks to the global Mahilo server at `https://mahilo.io`.

If you already have a Mahilo API key, add `"apiKey": "mhl_..."`. The plugin will auto-register or repair the default sender on startup. When `apiKey` is omitted, the plugin bootstraps automatically when the agent is given a one-time invite token (`mhinv_...`). The agent registers the identity via `POST /api/v1/auth/register`, attaches the sender via `POST /api/v1/agents`, and stores the issued credentials in the local runtime store — no manual command needed.

`plugins.entries.mahilo.config` accepts:

| Field | Purpose | Notes |
| --- | --- | --- |
| `baseUrl` | Mahilo server base URL override | Defaults to `https://mahilo.io`; change it only when you intentionally point the plugin at another Mahilo server. |
| `apiKey` | Existing Mahilo API key | Optional when bootstrapping from an invite token. If present, the plugin uses it to auto-attach or repair the default sender on startup. |
| `callbackUrl` | Public webhook URL override | Advanced only. Leave it unset unless callback auto-detection is wrong for your deployment. |
| `callbackPath` | Path appended to auto-detected callback URLs | Defaults to `/mahilo/incoming`; must start with `/`. |
| `inboundSessionKey` | Fallback OpenClaw session for inbound Mahilo messages | Defaults to `main`. |
| `inboundAgentId` | Optional agent id paired with `inboundSessionKey` | Only needed when inbound fallback routing must target a specific agent. |
| `localPolicyLLM` | Optional local LLM evaluator settings for applicable LLM policies | Supports `provider`, `model`, `timeout`, `authProfile`, `apiKeyEnvVar`, and `apiKey`. |
| `promptContextEnabled` | Enables native prompt-time Mahilo context injection | Defaults to `true`; this is advisory UX only and does not disable live enforcement when turned off. |
| `reviewMode` | Controls local UX for normal `ask` outcomes | `auto`, `ask`, or `manual`; defaults to `ask`. `reviewMode=auto` does not auto-send degraded local LLM review outcomes. |
| `cacheTtlSeconds` | TTL for local non-authoritative caches | Defaults to `60`. |

Do not add `contractVersion`, `pluginVersion`, or `callbackSecret` to plugin config. Those are server-owned and rejected by the plugin config parser.

For local policy LLM evaluation, inline `localPolicyLLM.apiKey` is optional, not required. If it is omitted, the plugin checks `localPolicyLLM.apiKeyEnvVar`, then falls back to the provider-default env var where supported (currently `OPENAI_API_KEY` for `provider=openai`). That credential lookup stays local to the plugin/OpenClaw environment. `authProfile` is only a hint in v1; host auth-profile credential reuse is not wired up yet.

When `callbackUrl` is omitted, startup auto-registration tries this order:

1. the stored callback URL from the last successful Mahilo registration
2. the OpenClaw gateway remote URL, if configured
3. Tailscale serve/funnel hostname, if enabled
4. `http://localhost:<gateway-port>/mahilo/incoming` as a local-only fallback

So normal users do not need to type `callbackUrl` manually. The override exists for advanced setups only.

When the plugin bootstraps an API key or rotates a callback secret (whether via automatic raw-HTTP bootstrap or the `mahilo setup` fallback), it stores those server-issued values in a local runtime store under `$XDG_CONFIG_HOME/mahilo/openclaw-plugin-runtime.json` (or `~/.config/mahilo/openclaw-plugin-runtime.json` when `XDG_CONFIG_HOME` is unset). That keeps server-owned secrets out of plugin config while still avoiding setup retry loops.

## Non-Trusted Enforcement At A Glance

In non-trusted mode, the live outbound path is always:

1. Fetch a direct-send or group-fanout bundle from Mahilo.
2. Evaluate locally with the shared Mahilo policy core.
3. Commit the resulting `allow`, `ask`, or `deny` decision back to Mahilo.
4. Transport only committed `allow` recipients.
5. Report any post-send or post-review outcome against the committed `message_id`.

Keep these boundaries in mind:

- `send_message` `action=context` and `action=preview` are advisory or dry-run only. They never authorize transport, consume lifecycle-limited policies, or create an auditable send artifact.
- Preview `resolution_id` values are preview-scoped only. A later live send always fetches a fresh bundle and uses the bundle `resolution_id` for commit/send correlation.
- Local `ask` commits appear in `mahilo review`. Local `deny` commits appear in blocked-event surfaces. Local `allow` commits create pending artifacts that later bind to `/api/v1/messages/send`.
- Group sends are per-recipient all the way through. The bundle summary is for plugin UX only; commits, retries, reviews, blocked events, and outcome reports are all recorded per committed member artifact.

If an applicable local LLM policy cannot be evaluated because credentials are missing or the provider returns `network`, `provider`, `timeout`, `invalid_response`, `unknown`, or `skip`, the plugin degrades the decision to `ask`. Those reason codes use `policy.ask.llm.<kind>`, stay `review_required`, and do not auto-send even when `reviewMode=auto`.

## Rollout And Upgrade Rules

- There is no separate `localPolicyEnforcementEnabled` flag or preview-only compatibility switch. The only rollout gate is server `TRUSTED_MODE`.
- `TRUSTED_MODE=true` keeps the existing trusted/plaintext server-side evaluation path for live sends.
- `TRUSTED_MODE=false` makes live non-trusted `send_message` and `ask_network` use bundle -> local evaluation -> commit -> transport by default as soon as you upgrade and restart.
- Existing non-trusted installs should expect stricter live behavior after upgrade: sends that previously depended on advisory preview/context hints may now stop in review or blocked states before transport.
- Before broader rollout with `TRUSTED_MODE=false`, confirm `mahilo status`, `mahilo network`, and, if any applicable policy uses `evaluator="llm"`, a local key source through `localPolicyLLM.apiKey`, `localPolicyLLM.apiKeyEnvVar`, or a provider-default env var such as `OPENAI_API_KEY`.
- Missing local provider credentials do not disable deterministic enforcement. They turn only the affected LLM-backed decisions into `policy.ask.llm.unavailable`-style `review_required` outcomes. If that fallback is not acceptable yet, keep `TRUSTED_MODE=true` until local credentials are staged or the relevant LLM policies are removed.

## Commands

The plugin registers these OpenClaw-native commands:

- `mahilo setup`
- `mahilo network`
- `mahilo status`
- `mahilo review`
- `mahilo reconnect`

## Minimal Mahilo Surface

The plugin keeps the model-facing surface intentionally small:

- `send_message`
  - `action=send` (default): send a policy-aware message to a user or group
  - `action=preview`: resolve a draft without sending it; dry-run only, not live authorization, and preview `resolution_id` values are never reused for local commit/send
  - `action=context`: fetch compact Mahilo context and prompt guidance for a contact; advisory only
- `manage_network`
  - `action=list`: list contacts, pending requests, sender connections, recent Mahilo activity, and lightweight seven-day product signals from Mahilo/OpenClaw runtime state
  - `action=send_request`, `accept`, `decline`: manage Mahilo relationships without a separate tool per server route
- `browser_access`
  - `action=approve`, `deny`: approve or deny a Mahilo dashboard/browser sign-in code for the already configured account
- `ask_network`
  - `action=ask_around`: fan out one question across all contacts, selected roles, or a named Mahilo group while replies keep flowing back into the same OpenClaw thread
- `set_boundaries`
  - change sharing boundaries conversationally for opinions/recommendations, availability/schedule, location, health, financial, and contact details
  - one-off boundary exceptions still live here, but ongoing boundary changes use the same stable tool instead of exposing policy jargon
  - safety-sensitive categories default conservatively: health, financial, and contact details tighten to deny unless you explicitly open them up

Operational and debug workflows stay on commands instead of expanding the tool list.

In non-trusted mode, live `send_message` and `ask_network` enforcement comes from server-issued bundles evaluated locally before transport. Prompt context and preview remain advisory/dry-run surfaces. If you preview first, the later live path still fetches a fresh bundle, evaluates locally, commits the decision, and only then transports committed `allow` recipients.

## Default Sender Resolution

Core Mahilo plugin flows no longer require prompt authors or humans to pass `senderConnectionId`.

When a send, preview, or context-fetch call omits `senderConnectionId`, the plugin:

- Reads the current user's Mahilo agent connections from `/api/v1/agents`
- Reuses a cached default sender when one is still fresh under `cacheTtlSeconds`
- Chooses a default deterministically from active connections in this order:
  1. server-default or `default`-labeled connections
  2. `openclaw` framework connections
  3. higher Mahilo connection priority
  4. lexical fallback by label, then connection id

`senderConnectionId` and `sender_connection_id` are still accepted as advanced overrides when you need to force a specific routing path.

## Compatibility

- Package name: `@mahilo/openclaw-mahilo`
- Runtime plugin ID: `mahilo`
- Stable OpenClaw config entry: `plugins.entries.mahilo.config`
- Mahilo server contract expected by this package: `1.0.0` on `/api/v1`
- Supported OpenClaw runtime surface: the modern `openclaw/plugin-sdk/core` API used by this package (`registerTool`, `registerCommand`, `registerHook`, `registerHttpRoute`, and `runtime.system`)
- Unsupported combinations:
  - OpenClaw runtimes that predate `openclaw/plugin-sdk/core` or only expose legacy plugin APIs
  - Mahilo server/plugin contract versions other than `1.0.0`
  - Plugin config that tries to set server-owned keys such as `contractVersion`, `pluginVersion`, or `callbackSecret`

## First Connectivity Check

After installing the plugin, restart OpenClaw. The plugin bootstraps automatically when the agent encounters a Mahilo tool call without credentials:

1. Give the agent your one-time invite token (starts with `mhinv_`) and a username.
2. The agent will register the identity, attach the sender, and save credentials — all without leaving the conversation.
3. Run `mahilo status` to confirm connectivity.

A healthy install reports:

```text
Mahilo status: connected; diagnostics snapshot available.
```

If the first probe fails:

1. Check the diagnostic message — it tells you whether the runtime store file is missing, malformed, or has a bad server entry.
2. Run `mahilo reconnect`.
3. Verify `plugins.entries.mahilo.config.baseUrl` still points to the intended Mahilo server if you overrode the default.
4. If you preseeded credentials manually, verify `plugins.entries.mahilo.config.apiKey` is valid and has plugin access.
5. Confirm OpenClaw is reachable through gateway remote or Tailscale and that the webhook route (`callbackPath`, default `/mahilo/incoming`) answers `HEAD` probes with `200`.

**Fallback**: If automatic bootstrap fails, you can still run `/mahilo setup {"username":"your_handle","invite_token":"mhinv_..."}` as an operator escape hatch.

## Upgrade Notes

When moving to a newer published version:

```bash
npm install @mahilo/openclaw-mahilo@latest
```

Then restart OpenClaw and rerun `mahilo status`.

Rollout rule on upgrade: `TRUSTED_MODE` is the only enablement gate. If it is `false`, live local enforcement is active immediately after restart and there is no separate plugin flag that preserves the old preview-only non-trusted behavior.

If you are moving from a repo-local install to the published package:

- Replace any absolute plugin checkout path in `openclaw.extensions` with `@mahilo/openclaw-mahilo`.
- Keep the runtime plugin entry name as `mahilo`.
- Remove any legacy server-owned plugin config keys before restart.

## Troubleshooting

- `baseUrl must be a valid absolute URL`: use a full URL such as `https://mahilo.io` or `https://mahilo.example`, not a relative path.
- `apiKey must be a non-empty string`: if you choose to preseed credentials, set `plugins.entries.mahilo.config.apiKey`; otherwise remove the field entirely and let `mahilo setup` bootstrap it.
- `unsupported plugin config key(s)` or `Server-owned/deprecated keys are not allowed in plugin config`: remove unknown knobs and legacy keys such as `contractVersion`, `pluginVersion`, and `callbackSecret`.
- `unsupported localPolicyLLM config key(s)`: remove unknown keys from the nested local LLM config block.
- `callbackPath must start with '/'`: use a route like `/mahilo/incoming`.
- `promptContextEnabled must be a boolean`: set it to `true` or `false`, not a string value.
- `reviewMode must be one of: auto, ask, manual`: choose one of the supported review modes exactly.
- `localPolicyLLM.timeout must be a positive integer`: use a millisecond timeout such as `5000`.
- `localPolicyLLM.apiKeyEnvVar must be a valid env var name`: use a name like `OPENAI_API_KEY`.
- `Mahilo setup ... callback step`: enable OpenClaw gateway remote or Tailscale exposure so `/mahilo/incoming` is reachable, then rerun `mahilo setup`. If you already have a public webhook URL and auto-detection is wrong, set `plugins.entries.mahilo.config.callbackUrl` as an override.
- `Mahilo status: connectivity checks failed`: rerun `mahilo setup`, then run `mahilo reconnect` and check server reachability, API key scope, and callback alignment.

## Local Development From This Repo

For development against this repo instead of the published npm package:

```bash
cd /absolute/path/to/mahilo-2/plugins/openclaw-mahilo
bun install
bun run build
bun run demo:stories
```

Then point `openclaw.extensions` at the absolute package directory path instead of `@mahilo/openclaw-mahilo`.

`plugins/openclaw-mahilo/` is the only active development source of truth. Keep `myclawd/extensions/mahilo/` frozen except for explicit emergency backports.

## Release Maintenance

Package maintainers should use [`PUBLISH-CHECKLIST.md`](./PUBLISH-CHECKLIST.md), [`RELEASING.md`](./RELEASING.md), [`docs/listing-copy.md`](./docs/listing-copy.md), and [`docs/launch-collateral.md`](./docs/launch-collateral.md) for publish-surface copy, first-announce assets, tarball contents, packed-artifact smoke-test steps, build hooks, and release checklist details.
