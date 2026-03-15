# OpenClaw Sandbox Live Test

Use this when testing `plugins/openclaw-mahilo/` against a fresh local OpenClaw instance without touching an existing OpenClaw install.

For the reproducible dual-sandbox harness, the default provisioning path is now invite-backed API provisioning via `dual-sandbox-bootstrap.ts`, `dual-sandbox-provision.ts`, `dual-sandbox-connections.ts`, and `dual-sandbox-relationships.ts`. Keep `seed-local-policy-sandbox.ts` as a fallback-only escape hatch, not the baseline path.

## What this proves

- the local plugin loads in a clean OpenClaw sandbox
- the public tools are registered
- startup auto-registration works when `apiKey` is configured
- server-backed Mahilo network and send flows work
- inbound webhook fallback reaches `main` when no exact session route exists
- boundary writes work

## What this does not touch

- your existing `OPENCLAW_HOME`
- your existing OpenClaw config
- your existing live OpenClaw server

Everything here uses a temp sandbox plus explicit `OPENCLAW_HOME`, `OPENCLAW_CONFIG_PATH`, and `MAHILO_OPENCLAW_RUNTIME_STATE_PATH`.

For the dual-sandbox harness, prefer the generated bootstrap/provisioning scripts instead of the manual curl steps in this doc:

- `plugins/openclaw-mahilo/scripts/dual-sandbox-bootstrap.ts`
- `plugins/openclaw-mahilo/scripts/dual-sandbox-provision.ts`
- `plugins/openclaw-mahilo/scripts/dual-sandbox-connections.ts`
- `plugins/openclaw-mahilo/scripts/dual-sandbox-relationships.ts`

After `dual-sandbox-provision.ts` runs, the harness keeps the secret-bearing user credentials in `runtime/sandbox-a/auth.json` and `runtime/sandbox-b/auth.json`, with redacted mirrors under `artifacts/sandboxes/`.

After `dual-sandbox-connections.ts` runs, the harness also writes the plugin-ready runtime-state files in `runtime/sandbox-a/runtime-state.json` and `runtime/sandbox-b/runtime-state.json`, plus redacted runtime-state and agent-registration evidence under `artifacts/sandboxes/`.

After `dual-sandbox-relationships.ts` runs, the harness writes `artifacts/provisioning/friendship-summary.json` with the accepted friendship, any optional friendship roles, and the shared group setup that later `ask_network` or group-fanout scenarios can reuse.

The manual steps below are still useful for debugging, but the default harness path should stay invite-backed and API-driven.

## Prerequisites

- local OpenClaw checkout at `../myclawd`
- `bun`, `pnpm`, `curl`, `sqlite3`
- provider auth already present in `/Users/wjayesh/.openclaw/agents/main/agent/auth-profiles.json` if you want to run a real model turn

## 1. Build the local plugin

```bash
cd /Users/wjayesh/apps/mahilo-2/plugins/openclaw-mahilo
bun run build
```

## 2. Create a fresh sandbox

```bash
SANDBOX_ROOT="$(mktemp -d /tmp/mahilo-openclaw-sandbox.XXXXXX)"
OPENCLAW_HOME="$SANDBOX_ROOT/openclaw-home"
OPENCLAW_CONFIG="$SANDBOX_ROOT/openclaw.config.json"
RUNTIME_STATE="$SANDBOX_ROOT/mahilo-runtime.json"
MAHILO_DB="$SANDBOX_ROOT/mahilo.db"

mkdir -p "$OPENCLAW_HOME/.openclaw/agents/main/agent"
cp /Users/wjayesh/.openclaw/agents/main/agent/auth-profiles.json \
  "$OPENCLAW_HOME/.openclaw/agents/main/agent/auth-profiles.json"
```

Write the config:

```bash
cat > "$OPENCLAW_CONFIG" <<'JSON'
{
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "port": 19123,
    "auth": { "mode": "none" },
    "http": { "endpoints": { "chatCompletions": { "enabled": true } } }
  },
  "plugins": {
    "enabled": true,
    "allow": ["mahilo"],
    "load": {
      "paths": ["/Users/wjayesh/apps/mahilo-2/plugins/openclaw-mahilo"]
    },
    "entries": {
      "mahilo": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:18080",
          "apiKey": "<SANDBOXOC_API_KEY>"
        }
      }
    }
  }
}
JSON
```

## 3. Start the isolated services

Run these in separate terminals.

Mahilo server:

```bash
cd /Users/wjayesh/apps/mahilo-2
ADMIN_API_KEY="${ADMIN_API_KEY:-sandbox-admin-key}" \
PORT=18080 DATABASE_URL="$MAHILO_DB" bun run src/index.ts
```

OpenClaw gateway:

```bash
OPENCLAW_HOME="$OPENCLAW_HOME" \
OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG" \
MAHILO_OPENCLAW_RUNTIME_STATE_PATH="$RUNTIME_STATE" \
pnpm --dir /Users/wjayesh/apps/myclawd openclaw gateway run --port 19123 --auth none --bind loopback --verbose
```

Verify:

```bash
curl http://127.0.0.1:18080/health
curl -I http://127.0.0.1:19123/mahilo/incoming
OPENCLAW_HOME="$OPENCLAW_HOME" OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG" \
  pnpm --dir /Users/wjayesh/apps/myclawd openclaw plugins list --json
```

Expected Mahilo tool names:

- `send_message`
- `manage_network`
- `ask_network`
- `set_boundaries`

## 4. First-use auth check

Without bootstrap state or `apiKey`, the plugin should return raw-HTTP bootstrap guidance for the current runtime.

```bash
curl -sS http://127.0.0.1:19123/tools/invoke \
  -H 'Content-Type: application/json' \
  -d '{"tool":"manage_network","args":{"action":"list"},"sessionKey":"main"}'
```

Current expected result:

- Mahilo returns a structured bootstrap message for the current runtime
- the message tells the agent not to ask the human to run `/mahilo setup`
- the message tells the agent to assume it does not have access to any Mahilo repo checkout or docs
- the message includes exact `POST /api/v1/auth/register` and `POST /api/v1/agents` calls plus the exact runtime bootstrap store path

## 5. Auto-register from a configured apiKey

If `apiKey` is present in plugin config, the plugin now auto-registers the default sender on startup. When `callbackUrl` is omitted, the plugin first tries stored callback state, OpenClaw gateway remote config, and Tailscale exposure before falling back to `http://localhost:<gateway-port>/mahilo/incoming` for local-only testing.

This is a reference/debugging path, not the default dual-sandbox provisioning flow. The baseline harness should provision users first through invite tokens and explicit API calls.

Expected gateway log line:

- `Startup bootstrap attached @sandboxoc and sender ...`

Verify from Mahilo:

```bash
curl -sS http://127.0.0.1:18080/api/v1/agents \
  -H 'Authorization: Bearer <SANDBOXOC_API_KEY>'
```

Expected:

- one OpenClaw connection with label `default`
- callback URL pointing at `http://127.0.0.1:19123/mahilo/incoming` when running locally

## 6. Provision a fully working sandbox identity on the invite-backed path

Create one invite token per user:

```bash
curl -sS -X POST http://127.0.0.1:18080/api/v1/admin/invite-tokens \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"max_uses":1,"note":"sandboxoc live test"}'

curl -sS -X POST http://127.0.0.1:18080/api/v1/admin/invite-tokens \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"max_uses":1,"note":"alice live test"}'
```

Register the two users with those invite tokens:

```bash
curl -sS -X POST http://127.0.0.1:18080/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"sandboxoc","display_name":"Sandbox OpenClaw","invite_token":"<SANDBOXOC_INVITE_TOKEN>"}'

curl -sS -X POST http://127.0.0.1:18080/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","display_name":"Alice","invite_token":"<ALICE_INVITE_TOKEN>"}'
```

Expected:

- both responses return `201`
- both users come back with `status=active`
- `GET /api/v1/auth/me` reports `registration_source=invite`
- `GET /api/v1/plugin/reviews` returns `200` for each issued API key

If the admin/invite surface regresses and you only need deterministic local-policy fixtures, use `plugins/openclaw-mahilo/scripts/seed-local-policy-sandbox.ts` as a fallback-only escape hatch. Do not silently replace the invite-backed path with direct DB seeding.

Start a dummy receiver for `alice`:

```bash
cat > "$SANDBOX_ROOT/receiver.mjs" <<'EOF'
import http from 'node:http';
import fs from 'node:fs';
const logPath = process.env.RECEIVER_LOG_PATH;
const server = http.createServer((req, res) => {
  if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    fs.appendFileSync(logPath, JSON.stringify({
      ts: new Date().toISOString(),
      method: req.method,
      url: req.url,
      headers: req.headers,
      body
    }) + '\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});
server.listen(19124, '127.0.0.1');
EOF

RECEIVER_LOG_PATH="$SANDBOX_ROOT/receiver-posts.jsonl" node "$SANDBOX_ROOT/receiver.mjs"
```

Register agent connections:

```bash
curl -sS -X POST http://127.0.0.1:18080/api/v1/agents \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <SANDBOXOC_API_KEY>' \
  -d '{"framework":"openclaw","label":"primary","description":"Sandbox OpenClaw","mode":"webhook","callback_url":"http://127.0.0.1:19123/mahilo/incoming"}'

curl -sS -X POST http://127.0.0.1:18080/api/v1/agents \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <ALICE_API_KEY>' \
  -d '{"framework":"openclaw","label":"alice-primary","description":"Alice receiver","mode":"webhook","callback_url":"http://127.0.0.1:19124/incoming"}'
```

Friend them:

```bash
curl -sS -X POST http://127.0.0.1:18080/api/v1/friends/request \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <SANDBOXOC_API_KEY>' \
  -d '{"username":"alice"}'

curl -sS -X POST http://127.0.0.1:18080/api/v1/friends/<FRIENDSHIP_ID>/accept \
  -H 'Authorization: Bearer <ALICE_API_KEY>'
```

Write runtime bootstrap state for the plugin:

```bash
cat > "$RUNTIME_STATE" <<'JSON'
{
  "version": 1,
  "servers": {
    "http://127.0.0.1:18080": {
      "apiKey": "<SANDBOXOC_API_KEY>",
      "username": "sandboxoc",
      "callbackConnectionId": "<PRIMARY_CONNECTION_ID>",
      "callbackSecret": "<PRIMARY_CALLBACK_SECRET>",
      "callbackUrl": "http://127.0.0.1:19123/mahilo/incoming"
    }
  }
}
JSON
```

Restart the OpenClaw gateway after writing `"$RUNTIME_STATE"` if you are testing the no-`apiKey` bootstrap path.

## 7. Working tool checks

Network:

```bash
curl -sS http://127.0.0.1:19123/tools/invoke \
  -H 'Content-Type: application/json' \
  -d '{"tool":"manage_network","args":{"action":"list"},"sessionKey":"main"}'
```

Expected:

- `1 sender connection`
- `1 contact`

## 8. Inbound fallback check

Send a message to the OpenClaw user without first creating any exact thread route:

```bash
curl -sS -X POST http://127.0.0.1:18080/api/v1/messages/send \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <ALICE_API_KEY>' \
  -d '{
    "recipient": "sandboxoc",
    "recipient_type": "user",
    "recipient_connection_id": "<SANDBOX_CONNECTION_ID>",
    "sender_connection_id": "<ALICE_CONNECTION_ID>",
    "message": "inbound to main fallback"
  }'
```

Expected gateway log lines:

- `No exact route for inbound message ...; falling back to configured inbound session main.`
- the inbound system event lands in `main`

Send:

```bash
curl -sS http://127.0.0.1:19123/tools/invoke \
  -H 'Content-Type: application/json' \
  -d '{"tool":"send_message","args":{"target":"alice","message":"Hello from sandbox plugin test."},"sessionKey":"main"}'
```

Expected:

- `Message sent through Mahilo.`
- a webhook POST recorded in `"$SANDBOX_ROOT/receiver-posts.jsonl"`

Boundary write:

```bash
curl -sS http://127.0.0.1:19123/tools/invoke \
  -H 'Content-Type: application/json' \
  -d '{"tool":"set_boundaries","args":{"mode":"set","topic":"location","policy":"ask","applies_to":"everyone","duration":"temporary","hours":1,"reason":"Sandbox review test"},"sessionKey":"main"}'
```

Expected:

- `Boundary updated: ask before sharing location ...`

## 7. Real model turn using the plugin

Create a real OpenClaw session and let the model call `ask_network`:

```bash
curl -sS http://127.0.0.1:19123/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-session-key: session_mahilo_live_3' \
  -d '{
    "model":"anthropic/claude-opus-4-6",
    "messages":[
      {
        "role":"user",
        "content":"Use the ask_network tool to ask my contacts who has been to Gokarna recently. Then tell me you asked them."
      }
    ],
    "stream":false
  }'
```

Expected:

- the model calls `ask_network`
- the transcript file under `"$OPENCLAW_HOME/.openclaw/agents/main/sessions/"` contains the `toolCall` and `toolResult`

## 8. Historical live blocker and regression target

The sandbox originally exposed a live-only routing gap that the unit tests were not modeling closely enough.

Observed blocker before the fix:

- after a real model turn that successfully calls `ask_network`, the live OpenClaw runtime logged:

```text
[Mahilo] rememberInboundRoute: no sessionKey in context, skipping route storage
[Mahilo] No exact route for inbound message <id> (correlation=<corr>, in_response_to=none, routeCount=0); falling back to configured inbound session main.
```

- root cause: in the embedded OpenClaw runtime, `before_tool_call` includes `{ toolName, agentId, sessionKey }`, but live `after_tool_call` omits `sessionKey`, `toolCallId`, and `runId`
- that means correlated reply routing cannot rely on the live `after_tool_call` ctx alone, and ambient fallbacks like “last active session” are vulnerable when another session becomes active first
- the plugin fix is to stamp a reserved `__mahiloRouteContext` payload into Mahilo tool params during `before_tool_call`, then recover the original session from those params during the live `after_tool_call` route-write path
- the final live-runtime root cause was one layer deeper: OpenClaw can load Mahilo into one plugin registry for tool/hooks execution and a different registry for HTTP webhook handling, so the route write and the inbound lookup can land on different `InMemoryPluginState` instances unless Mahilo shares state across plugin instances in the same process
- the final plugin fix is to use a shared process-local Mahilo plugin state keyed to the active runtime/bootstrap configuration, so the `after_tool_call` route write and `/mahilo/incoming` lookup see the same route cache
- regression coverage now needs to prove the live contract shape:
  - `before_tool_call` has the session
  - `after_tool_call` has only the tool name
  - the webhook can be handled by a different live plugin instance than the tool/hook path
  - another session can become active before the inbound reply arrives
  - the correlated reply still lands in the originating session, while genuinely uncorrelated messages still fall back to `main`

The focused regression tests for that contract live in `tests/openclaw-plugin.test.ts` under:

- `routes ask_network replies using before_tool_call route metadata when live after_tool_call lacks ids`
- `shares ask_network routing across hook and webhook plugin instances while keeping main fallback for unrelated replies`

## 9. Cleanup

Stop the three processes you started:

- Mahilo server
- OpenClaw gateway
- dummy receiver

Then remove the temp sandbox:

```bash
rm -rf "$SANDBOX_ROOT"
```
