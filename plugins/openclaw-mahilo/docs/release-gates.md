# Release Gates

Run the release gate from anywhere in the repo with:

```bash
node plugins/openclaw-mahilo/scripts/release-gate.mjs
```

The command is intended to be the single pre-publish check for the plugin. It fails fast on version drift between `package.json` and `openclaw.plugin.json`, then verifies:

- the manifest is valid JSON with the required release metadata
- the plugin `build` and `test` scripts both pass
- `npm pack --dry-run` includes the manifest plus the expected published files
- publish prerequisites are in place before `npm publish --dry-run`

Keep the `version` field in `openclaw.plugin.json` aligned with `package.json`; the release gate exits before build/test if they differ.

Use it immediately before cutting a release and in CI when publish automation is added later.
