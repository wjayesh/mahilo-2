# Release Artifacts

The published package is expected to ship the runtime and release surface below:

- `dist/` with the bundled runtime entry and generated declaration files
- root `index.d.ts` that references the packaged OpenClaw SDK shim
- `openclaw.plugin.json`
- `README.md`
- `LICENSE`

Build contract:

- `package.json` is the version source of truth for the npm package and plugin manifest.
- `bun run build` syncs the manifest version, rebuilds `dist/`, and regenerates declarations.
- `prepare` rebuilds the package before source installs, `prepack` rebuilds before tarball creation, and `prepublishOnly` runs `bun run check` before publish.

## Tarball Smoke Test

Run the full packed-artifact validation from `plugins/openclaw-mahilo/` with:

```bash
bun run smoke:tarball
```

The smoke harness stages a clean temp copy of the package, runs `npm pack --dry-run --json`, verifies the packaged file list, creates a real tarball with `npm pack --json`, installs that tarball into a scratch OpenClaw-style project, writes a minimal `openclaw.config.json`, resolves the installed package through `openclaw.extensions`, and registers the packed plugin against a mock OpenClaw API.

For a manual reproduction path:

1. Run `npm pack --dry-run --json` and confirm the packed files include `dist/`, `openclaw.plugin.json`, `README.md`, `LICENSE`, and `RELEASING.md` without pulling in `src/`, `tests/`, or other source-only directories.
2. Run `npm pack --json` and keep the resulting `mahilo-openclaw-mahilo-<version>.tgz`.
3. In an empty scratch directory, create a minimal `openclaw.config.json` that sets `openclaw.extensions` to `["@mahilo/openclaw-mahilo"]` and `plugins.entries.mahilo.config` with `baseUrl` and `apiKey`.
4. Install the tarball into that scratch directory with `npm install /absolute/path/to/mahilo-openclaw-mahilo-<version>.tgz`.
5. Load the installed package entry from `package.json` / `openclaw.plugin.json` and confirm the packed artifact still registers the expected tools, hooks, routes, commands, and required config schema keys.
