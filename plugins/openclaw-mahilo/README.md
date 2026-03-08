# OpenClaw Mahilo Plugin

This directory is the dedicated home for the Mahilo OpenClaw plugin package.

Canonical path:

- `plugins/openclaw-mahilo/`

Scope:

- Plugin-specific code, config, tests, and packaging files only.
- No Mahilo server implementation code.

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

## Plugin Config Boundary

`openclaw.plugin.json` intentionally keeps plugin config minimal and plugin-local:

- `baseUrl`: Mahilo server base URL
- `apiKey`: Mahilo API key (sensitive)
- `callbackUrl` or `callbackPath`: optional callback registration override
- `cacheTtlSeconds`: local cache tuning only
- `reviewMode`: local UX behavior for `ask` outcomes only

Server truth is not configurable in plugin config. Identity ownership, policy decisions, selector normalization, and callback secret lifecycle remain server-owned.
