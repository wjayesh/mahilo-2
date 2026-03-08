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

Legacy path policy:

- Do not implement active feature work in `myclawd/extensions/mahilo/`.
- Treat `myclawd/extensions/mahilo/` as migration reference-only.
- If a temporary legacy backport is unavoidable, author the fix in `plugins/openclaw-mahilo/` first, then backport explicitly.

## Plugin Config Boundary

`openclaw.plugin.json` intentionally keeps plugin config minimal and plugin-local:

- `baseUrl`: Mahilo server base URL
- `apiKey`: Mahilo API key (sensitive)
- `callbackUrl` or `callbackPath`: optional callback registration override
- `cacheTtlSeconds`: local cache tuning only
- `reviewMode`: local UX behavior for `ask` outcomes only

Server truth is not configurable in plugin config. Identity ownership, policy decisions, selector normalization, and callback secret lifecycle remain server-owned.
