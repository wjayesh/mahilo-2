# OpenClaw Sandbox Live Test

Use this when testing `plugins/openclaw-mahilo/` against a fresh local OpenClaw instance without touching an existing OpenClaw install.

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

Without bootstrap state or `apiKey`, the current plugin does **not** self-bootstrap yet.

```bash
curl -sS http://127.0.0.1:19123/tools/invoke \
  -H 'Content-Type: application/json' \
  -d '{"tool":"manage_network","args":{"action":"list"},"sessionKey":"main"}'
```

Current expected result:

- Mahilo returns an auth-shaped error like `Missing Authorization header`
- this is a known UX gap

## 5. Auto-register from a configured apiKey

If `apiKey` is present in plugin config, the plugin now auto-registers the default sender on startup. When `callbackUrl` is omitted, it falls back to `http://localhost:<gateway-port>/mahilo/incoming` for local-only testing.

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

## 6. Seed a fully working sandbox identity

Register two Mahilo users:

```bash
curl -sS -X POST http://127.0.0.1:18080/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"sandboxoc","display_name":"Sandbox OpenClaw"}'

curl -sS -X POST http://127.0.0.1:18080/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","display_name":"Alice"}'
```

For the sandbox only, mark both verified:

```bash
sqlite3 "$MAHILO_DB" "update users set twitter_verified=1;"
```

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

## 8. Current live blocker

The current repo passes plugin load, direct tool invocation, send, network, and boundary checks in the sandbox.

The current repo does **not** yet prove live same-thread inbound routing end to end.

Observed blocker:

- after a real model turn that successfully calls `ask_network`, a real inbound Mahilo reply still logs:

```text
[Mahilo] No session context for inbound message <id>; delivering to active session.
```

- this means the correlation/session route used for ask-around replies is not resolving in the live OpenClaw runtime
- likely cause: live route state is not persisting across the tool-call path and the webhook-delivery path the way the in-memory test harness expects

Until that is fixed, treat inbound same-thread routing as a known regression in live OpenClaw sandbox testing.

## 9. Cleanup

Stop the three processes you started:

- Mahilo server
- OpenClaw gateway
- dummy receiver

Then remove the temp sandbox:

```bash
rm -rf "$SANDBOX_ROOT"
```
