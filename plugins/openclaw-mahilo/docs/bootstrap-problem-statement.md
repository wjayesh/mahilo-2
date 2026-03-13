# Mahilo OpenClaw Bootstrap Problem Statement

This document is a handoff brief for another model or engineer. It captures the current bootstrap problem as observed in real OpenClaw runs and in the current repo state. It intentionally does not recommend a fix.

## Scope

This document covers the first-run bootstrap path for `plugins/openclaw-mahilo` when an OpenClaw runtime does not already have a Mahilo API key.

It does not cover:

- Mahilo trust policies after bootstrap
- ask-around behavior after a successful connection
- inbound routing bugs unrelated to first-run bootstrap

## Operator Constraints

The following constraints came directly from operator feedback during live OpenClaw runs:

- Agents using the plugin should be treated as if they do not have access to the Mahilo repo, local source tree, or local docs.
- End users will typically only have the installed plugin surface, not this repo checkout.
- The agent should not be told to run `/mahilo setup`.
- Registration should not be framed as a Mahilo tool flow.
- The agent can make raw HTTP requests during bootstrap.
- The first-run path must be understandable from the plugin/runtime surface alone, without source-diving.

## Current Implementation Surface

- The plugin exposes four public tools to the agent: `send_message`, `manage_network`, `ask_network`, and `set_boundaries`.
- The wrapper also still registers a `mahilo setup` command path.
- The wrapper injects bootstrap guidance into prompt context and passes a bootstrap error string into the public tool surface.
- The runtime uses a local credential store so later tool calls can recover the issued Mahilo API key and sender callback details.

Relevant repo locations:

- Prompt/tool bootstrap guidance: `plugins/openclaw-mahilo/src/openclaw-plugin-wrapper.ts`
- Legacy bootstrap prompt text: `plugins/openclaw-mahilo/src/openclaw-plugin.ts`
- Runtime credential store: `plugins/openclaw-mahilo/src/runtime-bootstrap.ts`
- Command registration for `mahilo setup`: `plugins/openclaw-mahilo/src/openclaw-plugin-wrapper.ts`
- Human-facing docs that still center `mahilo setup`: `plugins/openclaw-mahilo/README.md` and `plugins/openclaw-mahilo/docs/guided-first-run.md`

## Current Runtime Store Shape

The plugin persists runtime credentials in a JSON file with this structure:

```json
{
  "version": 1,
  "servers": {
    "https://mahilo.example": {
      "apiKey": "mhl_...",
      "username": "your_handle",
      "callbackConnectionId": "<connection_id>",
      "callbackSecret": "<callback_secret>",
      "callbackUrl": "https://your-openclaw.example/mahilo/incoming",
      "updatedAt": "2026-03-13T00:00:00.000Z"
    }
  }
}
```

This shape is defined by the `MahiloRuntimeBootstrapFile` and `MahiloRuntimeBootstrapStore` code in `plugins/openclaw-mahilo/src/runtime-bootstrap.ts`.

Important behavior of the current parser:

- If the file is missing, the runtime treats bootstrap state as absent.
- If the JSON is malformed, the runtime also treats bootstrap state as absent.
- If the top-level shape is wrong, the runtime also treats bootstrap state as absent.
- If individual server entries are malformed, those entries are silently dropped.

In all of those cases, the caller sees the same practical outcome: Mahilo still appears unbootstrapped.

## Current Repo Messaging Is Split

The repo currently contains two different bootstrap stories:

- The wrapper prompt/tool guidance tells the agent not to ask the human to run `/mahilo setup`, and instead tells it to use raw HTTP plus local runtime persistence.
- The published README and `guided-first-run.md` still describe `mahilo setup` as the recommended bootstrap path.
- The wrapper still registers `mahilo setup` as a command.

That means the repo currently contains both a command-centric setup story and a raw-HTTP-plus-runtime-store story at the same time.

Evidence:

- `plugins/openclaw-mahilo/README.md:26`
- `plugins/openclaw-mahilo/README.md:76`
- `plugins/openclaw-mahilo/README.md:102`
- `plugins/openclaw-mahilo/docs/guided-first-run.md:20`
- `plugins/openclaw-mahilo/src/openclaw-plugin-wrapper.ts:317`
- `plugins/openclaw-mahilo/src/openclaw-plugin-wrapper.ts:465`

## What The Current Wrapper Tells The Agent

The current wrapper guidance says, in substance:

- do not ask the human to run `/mahilo setup`
- assume there is no Mahilo repo checkout available
- create the identity with `POST /api/v1/auth/register`
- attach the default sender with `POST /api/v1/agents`
- save `apiKey`, `username`, `callbackConnectionId`, `callbackSecret`, and `callbackUrl` in the runtime bootstrap store
- retry immediately without restarting OpenClaw

Important detail:

- The prompt-context guidance includes the exact `curl` calls and an example server entry.
- The shorter tool error string does not include the full JSON envelope for the runtime store.
- The shorter tool error string also abbreviates the sender registration step to "attach the default OpenClaw sender with POST /api/v1/agents using callback_url ..." rather than exposing the full request payload.

This difference matters because an agent may be working primarily from the tool failure text instead of the longer prompt-context block.

Evidence:

- Prompt guidance with full `curl` examples: `plugins/openclaw-mahilo/src/openclaw-plugin-wrapper.ts:465`
- Shorter tool error string: `plugins/openclaw-mahilo/src/openclaw-plugin-wrapper.ts:480`

## Actual OpenClaw Run Feedback: Earlier Review

Feedback captured from an earlier real OpenClaw run:

1. The agent had no clear entry point for the invite token and had to read plugin source and multiple docs to infer that `mhinv_...` belonged in `POST /api/v1/auth/register`.
2. The plugin exposed a setup flow in concept, but the tool surface only exposed `manage_network`, `send_message`, `ask_network`, and `set_boundaries`. There was no `mahilo_setup` tool available to the agent in the model-facing tool list.
3. The docs were scattered across `README.md`, `guided-first-run.md`, the plugin design material, and setup/UX notes.
4. After manual registration, the flow felt like an API-key chicken-and-egg problem because the agent had to persist credentials outside the obvious tool path.
5. The conclusion from that run was that, without source access, the agent would have been stuck.

Additional statement from that run:

- There was nothing in the prompt or exposed tool descriptions that explained what an `mhinv_...` token was, what request to make, or how to move from invite token to API key to working setup.

## Actual OpenClaw Run Feedback: Latest Review

Feedback captured from the later live run after the raw-HTTP guidance was added:

1. The bootstrap error message pointed at `/tmp/mahilo-openclaw-sandbox.YCv2yL/mahilo-runtime.json` but did not explain the exact file shape. Multiple incorrect JSON shapes were attempted before the working shape was discovered from plugin code.
2. The registration API required trial and error. The initial register call failed without a username, and the `/agents` call still required fields such as `framework`, `label`, and related payload details that were not obvious from the shorter bootstrap error.
3. The phrase "save ... under server http://127.0.0.1:18080" was interpreted as ambiguous. It did not make the top-level `version` and `servers` envelope obvious.
4. There was no useful feedback loop distinguishing "file missing" from "file found but malformed" or "server entry shape invalid".
5. The operator conclusion from that run was that the flow only succeeded because the plugin source on disk was readable. An agent without filesystem access to the plugin code would likely have looped.

Additional statement from that run:

- The flow felt like a five-minute source-diving exercise instead of a short, self-contained bootstrap sequence.

## Reproduced Technical Facts Behind That Feedback

The feedback above matches the current implementation:

- The runtime store shape is real and required. It is not visible in the shorter tool error string.
- The parser falls back to `null` for missing or malformed state instead of surfacing a format-specific validation error.
- The wrapper still registers `mahilo setup`, while repo docs still present it as the main first-run path.
- The current prompt/tool guidance tells the agent not to inspect the repo, but the first-run operator experience can still depend on details that are only obvious from source or docs.

Evidence:

- Runtime store schema and parser behavior: `plugins/openclaw-mahilo/src/runtime-bootstrap.ts:32`, `plugins/openclaw-mahilo/src/runtime-bootstrap.ts:73`, `plugins/openclaw-mahilo/src/runtime-bootstrap.ts:110`
- Tool registration and command registration: `plugins/openclaw-mahilo/src/openclaw-plugin-wrapper.ts:283`, `plugins/openclaw-mahilo/src/openclaw-plugin-wrapper.ts:317`
- Command schema for `mahilo setup`: `plugins/openclaw-mahilo/src/openclaw-plugin-wrapper.ts:532`
- README command-centric first-run text: `plugins/openclaw-mahilo/README.md:26`, `plugins/openclaw-mahilo/README.md:76`, `plugins/openclaw-mahilo/README.md:102`
- Guided first run still starts with `/mahilo setup`: `plugins/openclaw-mahilo/docs/guided-first-run.md:20`

## Live Sandbox Observation

In the isolated local sandbox, a clean `manage_network` call on an unbootstrapped runtime currently returns a structured "Mahilo is not bootstrapped" message that includes:

- `POST /api/v1/auth/register`
- `POST /api/v1/agents`
- the callback URL
- the exact runtime store file path
- instructions not to ask the human to run `/mahilo setup`
- instructions to assume there is no Mahilo repo checkout

However, the later operator feedback above remains valid because the actual bootstrap still depended on details that were not fully spelled out in the shorter public failure path.

## Summary Of The Problem

The current first-run bootstrap experience is not yet self-contained from the plugin surface alone.

Observed problem characteristics:

- The repo presents mixed bootstrap models at the same time.
- The agent-visible failure path still leaves critical persistence details implicit.
- Runtime state parse failures collapse into the same "not bootstrapped" outcome.
- Real OpenClaw runs still felt dependent on source access despite explicit instructions telling the agent not to rely on source access.

This document stops at the problem statement and the observed evidence.
