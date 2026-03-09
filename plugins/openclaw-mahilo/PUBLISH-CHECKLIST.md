# OpenClaw Mahilo Publish Checklist

Run every command from `plugins/openclaw-mahilo/`.

## 1. Bump and review the version

Choose exactly one:

```bash
npm version patch --no-git-tag-version
npm version minor --no-git-tag-version
npm version major --no-git-tag-version
```

Then rebuild and confirm the manifest stayed in sync with the package version:

```bash
bun run build
node -p "require('./package.json').version"
node -p "require('./openclaw.plugin.json').version"
git diff -- package.json openclaw.plugin.json
```

## 2. Run the release gates

```bash
bun run check
bun run smoke:tarball
npm whoami
```

Do not publish until both Bun commands pass and `npm whoami` shows the expected maintainer account.

## 3. Publish to npm

```bash
npm publish --access public
```

If npm prompts for a one-time password, finish the publish with the account's current OTP.

## 4. Verify the live package

```bash
VERSION="$(npm pkg get version | tr -d '"')"
npm view @mahilo/openclaw-mahilo version
npm view @mahilo/openclaw-mahilo dist-tags --json
TMP_DIR="$(mktemp -d)"
npm init -y --prefix "$TMP_DIR" >/dev/null
npm install --prefix "$TMP_DIR" "@mahilo/openclaw-mahilo@$VERSION"
test -f "$TMP_DIR/node_modules/@mahilo/openclaw-mahilo/dist/index.js"
test -f "$TMP_DIR/node_modules/@mahilo/openclaw-mahilo/openclaw.plugin.json"
```

If you already have an OpenClaw runtime configured for the published package, restart it and rerun `mahilo status` as the final smoke check.

## 5. Tag the repo and write the release notes

```bash
VERSION="$(npm pkg get version | tr -d '"')"
git tag -a "openclaw-mahilo-v$VERSION" -m "OpenClaw Mahilo plugin v$VERSION"
git push origin HEAD "openclaw-mahilo-v$VERSION"
```

Use this GitHub release title:

```text
OpenClaw Mahilo plugin v<VERSION>
```

Use this release note body:

```md
## What changed
- <one line summary>
- <migration or compatibility note, if any>

## Verification
- `bun run check`
- `bun run smoke:tarball`
- `npm install @mahilo/openclaw-mahilo@<VERSION>`

## Compatibility
- OpenClaw runtime: `openclaw/plugin-sdk/core`
- Mahilo plugin/server contract: `1.0.0`
```

If `gh` is installed, create the GitHub release with:

```bash
VERSION="$(npm pkg get version | tr -d '"')"
cat > /tmp/openclaw-mahilo-release-notes.md <<EOF
## What changed
- <one line summary>
- <migration or compatibility note, if any>

## Verification
- \`bun run check\`
- \`bun run smoke:tarball\`
- \`npm install @mahilo/openclaw-mahilo@$VERSION\`

## Compatibility
- OpenClaw runtime: \`openclaw/plugin-sdk/core\`
- Mahilo plugin/server contract: \`1.0.0\`
EOF
gh release create "openclaw-mahilo-v$VERSION" --title "OpenClaw Mahilo plugin v$VERSION" --notes-file /tmp/openclaw-mahilo-release-notes.md
```

## 6. Bad first release: rollback or hotfix

There is no previous `latest` version to point back to on the first public release. Prefer a fast deprecate-plus-patch unless the package must be removed entirely.

If the first release was accidental or severe and still qualifies for npm unpublish:

```bash
npm unpublish @mahilo/openclaw-mahilo@<BAD_VERSION>
```

Use this only when the package must disappear completely. On a first release, unpublishing the only version removes the whole package and npm will not let you reuse the package name for 24 hours.

For an ordinary bad first release, or if npm refuses the unpublish, deprecate the bad version and ship a fix immediately:

```bash
npm deprecate @mahilo/openclaw-mahilo@<BAD_VERSION> "Broken release. Install @mahilo/openclaw-mahilo@<FIXED_VERSION> instead."
npm version patch --no-git-tag-version
bun run check
bun run smoke:tarball
npm publish --access public
```

For a later release where an older good version already exists, move `latest` back with:

```bash
npm dist-tag add @mahilo/openclaw-mahilo@<PREVIOUS_GOOD_VERSION> latest
```
