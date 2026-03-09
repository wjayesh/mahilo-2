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
