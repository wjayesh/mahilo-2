# OpenClaw Mahilo Plugin

This directory is the dedicated home for the Mahilo OpenClaw plugin package.

Canonical path:

- `plugins/openclaw-mahilo/`

Scope:

- Plugin-specific code, config, tests, and packaging files only.
- No Mahilo server implementation code.

## Package and Runtime Identity

Long-term identity decision (PLG2-021):

- Package name: `@mahilo/openclaw-mahilo`
- Runtime plugin ID: `mahilo` (stable)
- OpenClaw config entry path: `plugins.entries.mahilo.config`

Expected keys inside `plugins.entries.mahilo.config`:

- `baseUrl` (required)
- `apiKey` (required, sensitive)
- `callbackUrl` (optional)
- `callbackPath` (optional)
- `promptContextEnabled` (optional, default `true`)
- `reviewMode` (optional)
- `cacheTtlSeconds` (optional)

## Extractable Package Boundaries

The package is structured so it can be published or extracted later with minimal changes:

- Standalone `package.json` and `tsconfig.json` inside this directory.
- Standalone `openclaw.plugin.json` with plugin metadata and config schema.
- Standalone `vitest.config.ts` for plugin-local test configuration.
- Plugin-local `build` and `test` scripts.
- HTTP-only client for Mahilo contract endpoints under `src/`.
- No imports from repo-internal server source paths.

## Local Commands

Run from `plugins/openclaw-mahilo/`:

- `bun run build`
- `bun run test`
- `bun run validate:manifest`
- `bun run check`

## Build/Test Story (Publish-Ready)

This package stays `private: true` while migration is in progress, but publish readiness is maintained now:

- Build output is produced at `dist/index.js`.
- `package.json` declares `openclaw.extensions` as `["./dist/index.js"]` so package installs resolve the built plugin entry.
- `bun run check` runs the release-gate flow: build, tests, and manifest/package metadata validation.

## Runtime Diagnostics Commands

The plugin registers OpenClaw-native diagnostics/management commands:

- `mahilo status`: show redacted plugin config, connectivity probe status, and local runtime state counters.
- `mahilo review`: inspect Mahilo review queue items (supports optional `status` and `limit` input).
- `mahilo reconnect`: retry Mahilo connectivity probes with configurable retry attempts and delay.

## Local OpenClaw Development (Repo-First)

Use this package as the only active development target.

1. Build the local plugin package from this repo:

```bash
cd /absolute/path/to/mahilo-2/plugins/openclaw-mahilo
bun install
bun run build
```

2. Point OpenClaw at this local package path by adding it to `openclaw.extensions` in your OpenClaw runtime config:

```json
{
  "openclaw": {
    "extensions": [
      "/absolute/path/to/mahilo-2/plugins/openclaw-mahilo"
    ]
  }
}
```

3. Configure the `mahilo` plugin entry with this package's runtime keys:

```json
{
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

4. Restart OpenClaw and confirm Mahilo tools register from the local package.

## Future Publish Path

When moving from repo-local package to published package, keep this sequence:

1. Run `bun run check` and confirm all plugin-local checks pass.
2. Update package release metadata (`version`, `private`) when publishing is approved.
3. Build before packaging so `openclaw.extensions` points to a present built entry (`./dist/index.js`).
4. Run a dry package inspection (`npm pack --dry-run`) and verify `dist/`, `openclaw.plugin.json`, and `README.md` are included.

Legacy path and deprecation policy (PLG2-062, effective 2026-03-08):

- `plugins/openclaw-mahilo/` is the only active development source of truth.
- Freeze `myclawd/extensions/mahilo/` for normal development (no new feature work, no routine fixes).
- Keep only a minimal legacy stub/README redirect in `myclawd/extensions/mahilo/` that points contributors to this package.
- If an emergency legacy backport is unavoidable, author and validate the fix in `plugins/openclaw-mahilo/` first, then backport explicitly.
- Remove the remaining legacy plugin directory after downstream users are fully cut over to this package path.

## Plugin Config Boundary

`openclaw.plugin.json` intentionally keeps plugin config minimal and plugin-local:

- `baseUrl`: Mahilo server base URL
- `apiKey`: Mahilo API key (sensitive)
- `callbackUrl` or `callbackPath`: optional callback registration override
- `cacheTtlSeconds`: local cache tuning only
- `reviewMode`: local UX behavior for `ask` outcomes only

Server truth is not configurable in plugin config. Identity ownership, policy decisions, selector normalization, and callback secret lifecycle remain server-owned.
