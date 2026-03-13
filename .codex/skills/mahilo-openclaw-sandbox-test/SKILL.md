---
name: mahilo-openclaw-sandbox-test
description: Use this when testing the Mahilo OpenClaw plugin against a fresh isolated local OpenClaw instance without disturbing an existing install, including plugin load checks, sandbox config, runtime bootstrap seeding, live tool checks, and known live webhook routing blockers.
---

# Mahilo OpenClaw Sandbox Test

Use this for isolated local testing of `plugins/openclaw-mahilo/`.

## Use this skill when

- the user wants to test Mahilo in a fresh OpenClaw instance
- the user does not want their existing OpenClaw install touched
- you need to confirm plugin load, tools, or live Mahilo server integration
- you need to reproduce the current live inbound webhook/session-routing issue

## Workflow

1. Read `plugins/openclaw-mahilo/docs/openclaw-sandbox-live-test.md`.
2. Default to a fresh temp sandbox under `/tmp/mahilo-openclaw-sandbox.*`.
3. For unpublished repo changes, load the plugin from `plugins.load.paths` pointing at this repo's `plugins/openclaw-mahilo`.
4. Keep the user's existing `OPENCLAW_HOME` and config untouched by always setting:
   - `OPENCLAW_HOME`
   - `OPENCLAW_CONFIG_PATH`
   - `MAHILO_OPENCLAW_RUNTIME_STATE_PATH`
5. Build the plugin before testing.
6. Start three isolated processes:
   - Mahilo server on `18080`
   - OpenClaw gateway on `19123`
   - dummy receiver on `19124`
7. Verify the plugin loads with:
   - `openclaw plugins list --json`
   - webhook `HEAD /mahilo/incoming`
8. Test two phases separately:
   - **first-use auth behavior** with no bootstrap state
   - **seeded runtime behavior** with sandbox users, connections, friendship, and runtime bootstrap state
9. For live model-path verification, use `/v1/chat/completions` with `x-openclaw-session-key`, not only `/tools/invoke`.
10. If live inbound replies still log `No session context for inbound message`, treat that as the current known blocker and report it explicitly.

## Important notes

- Direct `/tools/invoke` is good for plugin load and tool behavior checks, but it is not enough to prove real same-thread inbound routing.
- The current first-use flow still depends on bootstrap state or `mahilo setup`; without it, the plugin returns Mahilo auth errors instead of a polished in-product onboarding flow.
- The current live blocker is documented in `plugins/openclaw-mahilo/docs/openclaw-sandbox-live-test.md`.

## Output

Report:

- sandbox root used
- whether plugin load succeeded
- whether `manage_network`, `send_message`, and `set_boundaries` succeeded
- whether a real model turn called `ask_network`
- whether live inbound reply routing back to the same OpenClaw session succeeded or hit the known blocker
