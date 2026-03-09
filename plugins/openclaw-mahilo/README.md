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

The package is structured as a standalone OpenClaw package for public npm release now and later extraction with minimal changes:

- Standalone `package.json` and `tsconfig.json` inside this directory.
- Standalone `openclaw.plugin.json` with plugin metadata and config schema.
- Standalone `vitest.config.ts` for plugin-local test configuration.
- Plugin-local `build` and `test` scripts.
- HTTP-only client for Mahilo contract endpoints under `src/`.
- No imports from repo-internal server source paths.

## Local Commands

Run from `plugins/openclaw-mahilo/`:

- `bun run sync:manifest-version`
- `bun run build`
- `bun run test`
- `bun run validate:manifest`
- `bun run check`
- `npm pack --dry-run`

## Build/Test Story (Publish-Ready)

This package is configured for a first public scoped npm release:

- `package.json` is publishable and sets `publishConfig.access` to `public`.
- `package.json` is the canonical release-version source; `bun run sync:manifest-version` keeps `openclaw.plugin.json` aligned with it.
- Build output is produced at `dist/index.js`, with declarations at `dist/index.d.ts`.
- The public type surface is explicit: root `index.d.ts` references the packaged OpenClaw SDK shim and re-exports the generated declarations from `dist/`.
- `prepare` rebuilds runtime artifacts for source installs, `prepack` rebuilds before tarball creation, and `prepublishOnly` gates publish with `bun run check`.
- `package.json` declares `openclaw.extensions` as `["./dist/index.js"]` so package installs resolve the built plugin entry.
- `bun run check` runs the release-gate flow: build, tests, and manifest/package metadata validation.

## Runtime Diagnostics Commands

The plugin registers OpenClaw-native diagnostics/management commands:

- `mahilo status`: show redacted plugin config, connectivity probe status, and local runtime state counters.
- `mahilo review`: inspect Mahilo review queue items (supports optional `status` and `limit` input).
- `mahilo override`: create a one-time or temporary override; defaults to a conservative one-time `allow`, and can resolve user `targetId` from `recipient`.
- `mahilo reconnect`: retry Mahilo connectivity probes with configurable retry attempts and delay.

Temporary override flow notes:

- Use `preview_mahilo_send` first when you want Mahilo’s resolution summary and guidance before creating an override.
- For user-scoped overrides, prefer passing `recipient` and `senderConnectionId`; the plugin will resolve the Mahilo user ID through prompt context when possible.
- For expiring rules, use `durationMinutes`, `durationHours`, `ttlSeconds`, or `expiresAt`.

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

## Public Release Workflow

When preparing or cutting a public npm release, keep this sequence:

1. Run `bun run check` and confirm all plugin-local checks pass.
2. Bump `package.json` version and run `bun run sync:manifest-version` if you did not already build or check as part of the release flow.
3. Run `npm pack --dry-run` to confirm the tarball contents; `prepack` rebuilds `dist/` so the packaged runtime and declarations stay current even from a clean source tree.
4. Publish the scoped package with public access after validating tarball contents and release notes.

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
