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
- Plugin-local `build` and `test` scripts.
- HTTP-only client for Mahilo contract endpoints under `src/`.
- No imports from repo-internal server source paths.

## Local Commands

Run from `plugins/openclaw-mahilo/`:

- `bun run build`
- `bun run test`
