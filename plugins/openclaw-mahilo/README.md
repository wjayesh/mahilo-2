# Mahilo for OpenClaw

**Ask your contacts from OpenClaw and get real answers from people you trust, with attribution and boundaries built in.**

Mahilo for OpenClaw turns "ask my contacts" into a native OpenClaw behavior. Instead of trusting public AI noise or repeating the same question across chats, you ask once inside OpenClaw and the plugin uses Mahilo to reach the right contacts, bring back attributed answers from real people you already trust, and honor the sharing boundaries each person has set. OpenClaw stays the conversational surface; Mahilo stays behind the scenes as the trust and control layer for identity, network discovery, policy decisions, review paths, and final send-time enforcement.

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

1. If you already have a Mahilo API key in plugin config, restart OpenClaw and let the plugin auto-attach the default sender on startup. If you do not, run `mahilo setup` once to bootstrap identity and sender attachment.
2. Run `mahilo status` to confirm connectivity and webhook alignment.
3. Run `mahilo network` or `manage_network` with `action=list` to see whether your circle is ready.
4. If the network is empty, stay in `manage_network` and use `action=send_request` to invite one trusted person. If they already invited you, use `action=accept`, then have them bring their Mahilo plugin online in OpenClaw.
5. Once one accepted contact has a live agent connection, ask OpenClaw to check with your Mahilo contacts, or call `ask_network` with `action=ask_around`.
6. Preview a sensitive follow-up with `send_message` so Mahilo can stop on review before send.
7. Use `set_boundaries` to grant a narrow exception, then retry the same preview or send.

## Install From npm

`@mahilo/openclaw-mahilo` is the published Mahilo plugin for OpenClaw. Install it as a normal npm package, register it in `openclaw.extensions`, and keep runtime settings under `plugins.entries.mahilo.config`.

```bash
npm install @mahilo/openclaw-mahilo
```

Then add the installed package to `openclaw.extensions` in your OpenClaw runtime config:

```json
{
  "openclaw": {
    "extensions": [
      "@mahilo/openclaw-mahilo"
    ]
  }
}
```

For a published npm install, point `openclaw.extensions` at the package name, not `dist/index.js`. The package already declares its packaged extension entry internally.

## Minimal Working OpenClaw Config

Add the Mahilo plugin entry to the same OpenClaw config file:

```json
{
  "openclaw": {
    "extensions": [
      "@mahilo/openclaw-mahilo"
    ]
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

If you already have a Mahilo API key, add `"apiKey": "mhl_..."`. The plugin will auto-register or repair the default sender on startup. When `apiKey` is omitted, `mahilo setup` can bootstrap the identity and store the issued key locally for the OpenClaw runtime.

`plugins.entries.mahilo.config` accepts:

- Optional:
  - `baseUrl` (defaults to `https://mahilo.io`; only use this as an override)
  - `callbackUrl` (advanced override if you already know the public webhook URL)
  - `inboundSessionKey` (defaults to `main`)
  - `inboundAgentId`
  - `apiKey`
  - `callbackPath` (defaults to `/mahilo/incoming`)
  - `promptContextEnabled` (defaults to `true`)
  - `reviewMode` (`auto`, `ask`, or `manual`; defaults to `ask`)
  - `cacheTtlSeconds` (defaults to `60`)

Do not add `contractVersion`, `pluginVersion`, or `callbackSecret` to plugin config. Those are server-owned and rejected by the plugin config parser.

When `callbackUrl` is omitted, startup auto-registration tries this order:

1. the stored callback URL from the last successful Mahilo registration
2. the OpenClaw gateway remote URL, if configured
3. Tailscale serve/funnel hostname, if enabled
4. `http://localhost:<gateway-port>/mahilo/incoming` as a local-only fallback

So normal users do not need to type `callbackUrl` manually. The override exists for advanced setups only.

When `mahilo setup` bootstraps an API key or rotates a callback secret, the plugin stores those server-issued values in a local runtime store under `$XDG_CONFIG_HOME/mahilo/openclaw-plugin-runtime.json` (or `~/.config/mahilo/openclaw-plugin-runtime.json` when `XDG_CONFIG_HOME` is unset). That keeps server-owned secrets out of plugin config while still avoiding setup retry loops.

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
  - `action=preview`: resolve a draft without sending it
  - `action=context`: fetch compact Mahilo context and prompt guidance for a contact
- `manage_network`
  - `action=list`: list contacts, pending requests, sender connections, recent Mahilo activity, and lightweight seven-day product signals from Mahilo/OpenClaw runtime state
  - `action=send_request`, `accept`, `decline`: manage Mahilo relationships without a separate tool per server route
- `ask_network`
  - `action=ask_around`: fan out one question across all contacts, selected roles, or a named Mahilo group while replies keep flowing back into the same OpenClaw thread
- `set_boundaries`
  - change sharing boundaries conversationally for opinions/recommendations, availability/schedule, location, health, financial, and contact details
  - one-off boundary exceptions still live here, but ongoing boundary changes use the same stable tool instead of exposing policy jargon
  - safety-sensitive categories default conservatively: health, financial, and contact details tighten to deny unless you explicitly open them up

Operational and debug workflows stay on commands instead of expanding the tool list.

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

After installing the plugin, restart OpenClaw and run:

```text
mahilo setup
```

On a fresh runtime, `mahilo setup` can:

- create the Mahilo identity if you provide a username
- store the issued API key locally
- register or repair the default OpenClaw sender connection
- tell you the exact remaining blocker when OpenClaw is still not publicly reachable enough for inbound replies

Then run:

```text
mahilo status
```

A healthy install reports:

```text
Mahilo status: connected; diagnostics snapshot available.
```

If the first probe fails:

1. Rerun `mahilo setup` first and follow the blocker it reports.
2. Run `mahilo reconnect`.
3. Verify `plugins.entries.mahilo.config.baseUrl` still points to the intended Mahilo server if you overrode the default.
4. If you preseeded credentials manually, verify `plugins.entries.mahilo.config.apiKey` is valid and has plugin access.
5. Confirm OpenClaw is reachable through gateway remote or Tailscale and that the webhook route (`callbackPath`, default `/mahilo/incoming`) answers `HEAD` probes with `200`.

## Upgrade Notes

When moving to a newer published version:

```bash
npm install @mahilo/openclaw-mahilo@latest
```

Then restart OpenClaw and rerun `mahilo status`.

If you are moving from a repo-local install to the published package:

- Replace any absolute plugin checkout path in `openclaw.extensions` with `@mahilo/openclaw-mahilo`.
- Keep the runtime plugin entry name as `mahilo`.
- Remove any legacy server-owned plugin config keys before restart.

## Troubleshooting

- `baseUrl must be a valid absolute URL`: use a full URL such as `https://mahilo.io` or `https://mahilo.example`, not a relative path.
- `apiKey must be a non-empty string`: if you choose to preseed credentials, set `plugins.entries.mahilo.config.apiKey`; otherwise remove the field entirely and let `mahilo setup` bootstrap it.
- `unsupported plugin config key(s)` or `Server-owned/deprecated keys are not allowed in plugin config`: remove unknown knobs and legacy keys such as `contractVersion`, `pluginVersion`, and `callbackSecret`.
- `callbackPath must start with '/'`: use a route like `/mahilo/incoming`.
- `promptContextEnabled must be a boolean`: set it to `true` or `false`, not a string value.
- `reviewMode must be one of: auto, ask, manual`: choose one of the supported review modes exactly.
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
