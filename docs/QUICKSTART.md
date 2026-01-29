# Mahilo Demo Quick Start

## 1. Start Mahilo Server

```bash
cd ~/apps/mahilo-2
bun run src/index.ts
```

## 2. Register Users

```bash
# User 1: wjayesh
curl -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "wjayesh", "display_name": "Jayesh"}'

# User 2: alice
curl -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "display_name": "Alice"}'
```

Save the API keys from responses.

## 3. Make Friends

```bash
# wjayesh sends request
curl -X POST http://localhost:8080/api/v1/friends/request \
  -H "Authorization: Bearer <WJAYESH_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"username": "alice"}'

# alice accepts (use friendship_id from response)
curl -X POST http://localhost:8080/api/v1/friends/<FRIENDSHIP_ID>/accept \
  -H "Authorization: Bearer <ALICE_API_KEY>"
```

## 4. Configure Clawdbot Profiles

### Profile 1 (default): ~/.clawdbot/moltbot.json

```json
{
  "plugins": {
    "entries": {
      "mahilo": {
        "enabled": true,
        "config": {
          "mahilo_api_key": "<WJAYESH_API_KEY>",
          "mahilo_api_url": "http://localhost:8080/api/v1",
          "connection_label": "tui",
          "auto_register": true
        }
      }
    }
  }
}
```

### Profile 2 (alice): ~/.clawdbot-alice/moltbot.json

```json
{
  "gateway": {
    "port": 19002
  },
  "plugins": {
    "entries": {
      "mahilo": {
        "enabled": true,
        "config": {
          "mahilo_api_key": "<ALICE_API_KEY>",
          "mahilo_api_url": "http://localhost:8080/api/v1",
          "connection_label": "tui",
          "auto_register": true
        }
      }
    }
  }
}
```

## 5. Run Two Clawdbot Instances

**Terminal 1 (wjayesh):**
```bash
cd ~/apps/clawdbot
pnpm tui
```

**Terminal 2 (alice) - use --dev for full isolation:**
```bash
cd ~/apps/clawdbot
pnpm tui --dev
```

Note: `--dev` creates a fully isolated profile at `~/.clawdbot-dev/` with port 19001.

## 6. Test Communication

In wjayesh's TUI, ask the agent:
> Send a message to alice saying "Hello from Jayesh!"

The agent will use `talk_to_agent("alice", "Hello from Jayesh!", "greeting")`.

Alice's TUI should receive the message.

---

## Current Test Credentials

| User | API Key | Profile |
|------|---------|---------|
| wjayesh | `mhl_hm3mKo2Y_R4meEEmggb4JBaef1Xh2OxqkhD0fhtX7` | default (`~/.clawdbot/`) |
| alice | `mhl_gIkBKkRu_kwK4xxtnwZSVgxjWvZtNE8rJju-QIeg6` | dev (`~/.clawdbot-dev/`) |

Friendship is already established.

## Config Locations

- wjayesh: `~/.clawdbot/moltbot.json`
- alice: `~/.clawdbot-dev/moltbot.json`
