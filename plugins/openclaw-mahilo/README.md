# OpenClaw Mahilo Plugin

`@mahilo/openclaw-mahilo` is the published Mahilo plugin for OpenClaw. Install it as a normal npm package, register it in `openclaw.extensions`, and keep runtime settings under `plugins.entries.mahilo.config`.

The plugin adds Mahilo-aware tools, diagnostics commands, prompt-time context injection, and inbound webhook handling while keeping Mahilo server as the policy source of truth.

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

## Install From npm

From the OpenClaw runtime or project that loads your extensions:

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
        "config": {
          "baseUrl": "http://localhost:8080",
          "apiKey": "mhl_..."
        }
      }
    }
  }
}
```

`plugins.entries.mahilo.config` accepts:

- Required:
  - `baseUrl`
  - `apiKey`
- Optional:
  - `callbackPath` (defaults to `/mahilo/incoming`)
  - `callbackUrl`
  - `promptContextEnabled` (defaults to `true`)
  - `reviewMode` (`auto`, `ask`, or `manual`; defaults to `ask`)
  - `cacheTtlSeconds` (defaults to `60`)

Do not add `contractVersion`, `pluginVersion`, or `callbackSecret` to plugin config. Those are server-owned and rejected by the plugin config parser.

## First Connectivity Check

After saving the config, restart OpenClaw and run:

```text
mahilo status
```

A healthy install reports:

```text
Mahilo status: connected; diagnostics snapshot available.
```

If the first probe fails:

1. Run `mahilo reconnect`.
2. Verify `plugins.entries.mahilo.config.baseUrl` points to the active Mahilo server.
3. Verify `plugins.entries.mahilo.config.apiKey` is valid and has plugin access.
4. If inbound delivery is part of your setup, confirm Mahilo callbacks target `callbackUrl` or the default `callbackPath` of `/mahilo/incoming`.

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

- `baseUrl must be a valid absolute URL`: use a full URL such as `http://localhost:8080` or `https://mahilo.example`, not a relative path.
- `apiKey must be a non-empty string`: set `plugins.entries.mahilo.config.apiKey`.
- `unsupported plugin config key(s)` or `Server-owned/deprecated keys are not allowed in plugin config`: remove unknown knobs and legacy keys such as `contractVersion`, `pluginVersion`, and `callbackSecret`.
- `callbackPath must start with '/'`: use a route like `/mahilo/incoming`.
- `promptContextEnabled must be a boolean`: set it to `true` or `false`, not a string value.
- `reviewMode must be one of: auto, ask, manual`: choose one of the supported review modes exactly.
- `Mahilo status: connectivity checks failed`: run `mahilo reconnect` and check server reachability, API key scope, and callback alignment.

## Available Diagnostics Commands

The plugin registers these OpenClaw-native commands:

- `mahilo status`
- `mahilo review`
- `mahilo override`
- `mahilo reconnect`

## Local Development From This Repo

For development against this repo instead of the published npm package:

```bash
cd /absolute/path/to/mahilo-2/plugins/openclaw-mahilo
bun install
bun run build
```

Then point `openclaw.extensions` at the absolute package directory path instead of `@mahilo/openclaw-mahilo`.

`plugins/openclaw-mahilo/` is the only active development source of truth. Keep `myclawd/extensions/mahilo/` frozen except for explicit emergency backports.

## Release Maintenance

Package maintainers should use [`RELEASING.md`](./RELEASING.md) for tarball contents, packed-artifact smoke-test steps, build hooks, and publish checklist details.
