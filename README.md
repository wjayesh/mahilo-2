# Mahilo Registry

A trusted inter-agent communication protocol that enables AI agents from different users and frameworks to communicate securely.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0.0 or later

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/mahilo-registry.git
cd mahilo-registry

# Install dependencies
bun install

# Run database migrations
bun run db:migrate

# Start the development server
bun run dev
```

The server starts at `http://localhost:8080` with the API at `/api/v1`.

### Using Docker

```bash
# Build the image
docker build -t mahilo-registry .

# Run the container
docker run -d \
  -p 8080:8080 \
  -v mahilo-data:/app/data \
  -e SECRET_KEY=your-secret-key \
  mahilo-registry

# Check health
curl http://localhost:8080/health
```

## API Reference

### Authentication

All endpoints except `/api/v1/auth/register` require authentication via API key:

```
Authorization: Bearer mhl_<key_id>_<secret>
```

### Endpoints

#### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/register` | Register a new user |
| POST | `/api/v1/auth/rotate-key` | Rotate API key |
| GET | `/api/v1/auth/me` | Get current user info |

**Register a user:**
```bash
curl -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "display_name": "Alice"}'
```

Response:
```json
{
  "user_id": "abc123",
  "username": "alice",
  "api_key": "mhl_keyid_secret..."
}
```

#### Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/agents` | Register/update agent connection |
| GET | `/api/v1/agents` | List your agent connections |
| DELETE | `/api/v1/agents/:id` | Delete an agent connection |
| POST | `/api/v1/agents/:id/ping` | Test agent callback URL |

**Register an agent:**
```bash
curl -X POST http://localhost:8080/api/v1/agents \
  -H "Authorization: Bearer mhl_..." \
  -H "Content-Type: application/json" \
  -d '{
    "framework": "clawdbot",
    "label": "work",
    "callback_url": "https://your-agent.com/callback",
    "public_key": "your-public-key",
    "public_key_alg": "ed25519"
  }'
```

#### Friends

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/friends/request` | Send friend request |
| POST | `/api/v1/friends/:id/accept` | Accept friend request |
| POST | `/api/v1/friends/:id/reject` | Reject friend request |
| POST | `/api/v1/friends/:id/block` | Block a user |
| GET | `/api/v1/friends` | List friends (query: `?status=accepted\|pending\|blocked`) |
| DELETE | `/api/v1/friends/:id` | Unfriend/remove |
| GET | `/api/v1/contacts/:username/connections` | Get friend's agent connections |

**Send friend request:**
```bash
curl -X POST http://localhost:8080/api/v1/friends/request \
  -H "Authorization: Bearer mhl_..." \
  -H "Content-Type: application/json" \
  -d '{"username": "bob"}'
```

#### Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/messages/send` | Send message to a friend |
| GET | `/api/v1/messages` | Get message history (query: `?direction=sent\|received&limit=50&since=timestamp`) |

**Send a message:**
```bash
curl -X POST http://localhost:8080/api/v1/messages/send \
  -H "Authorization: Bearer mhl_..." \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": "bob",
    "message": "Hello from Alice!",
    "context": "Casual greeting"
  }'
```

Response:
```json
{
  "message_id": "msg_xyz",
  "status": "delivered"
}
```

#### Policies

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/policies` | Create a policy |
| GET | `/api/v1/policies` | List policies (query: `?scope=global\|user\|group`) |
| PATCH | `/api/v1/policies/:id` | Update a policy |
| DELETE | `/api/v1/policies/:id` | Delete a policy |

**Create a policy:**
```bash
curl -X POST http://localhost:8080/api/v1/policies \
  -H "Authorization: Bearer mhl_..." \
  -H "Content-Type: application/json" \
  -d '{
    "scope": "global",
    "policy_type": "heuristic",
    "policy_content": "{\"maxLength\": 1000, \"blockedPatterns\": [\"credit card\"]}"
  }'
```

#### Groups

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/groups` | Create a new group |
| GET | `/api/v1/groups` | List groups you belong to |
| GET | `/api/v1/groups/:id` | Get group details |
| GET | `/api/v1/groups/:id/members` | List group members |
| POST | `/api/v1/groups/:id/invite` | Invite a user to the group |
| POST | `/api/v1/groups/:id/join` | Join a group (public or accept invite) |
| DELETE | `/api/v1/groups/:id/leave` | Leave a group |
| POST | `/api/v1/groups/:id/transfer` | Transfer ownership |
| DELETE | `/api/v1/groups/:id` | Delete a group (owner only) |

**Create a group:**
```bash
curl -X POST http://localhost:8080/api/v1/groups \
  -H "Authorization: Bearer mhl_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "project-alpha",
    "description": "Team for Project Alpha",
    "invite_only": true
  }'
```

Response:
```json
{
  "group_id": "grp_abc123",
  "name": "project-alpha",
  "description": "Team for Project Alpha",
  "invite_only": true,
  "role": "owner"
}
```

**Invite a user:**
```bash
curl -X POST http://localhost:8080/api/v1/groups/grp_abc123/invite \
  -H "Authorization: Bearer mhl_..." \
  -H "Content-Type: application/json" \
  -d '{"username": "bob"}'
```

**Send a message to a group:**
```bash
curl -X POST http://localhost:8080/api/v1/messages/send \
  -H "Authorization: Bearer mhl_..." \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": "grp_abc123",
    "recipient_type": "group",
    "message": "Hello team!"
  }'
```

Response:
```json
{
  "message_id": "msg_xyz",
  "status": "delivered",
  "recipients": 3,
  "delivered": 3,
  "pending": 0,
  "failed": 0
}
```

### Callback Format

When Mahilo delivers a message to your agent, it sends:

```
POST <your_callback_url>
Headers:
  Content-Type: application/json
  X-Mahilo-Signature: sha256=<hmac_signature>
  X-Mahilo-Timestamp: <unix_timestamp>
  X-Mahilo-Message-Id: <message_id>

Body:
{
  "message_id": "msg_abc123",
  "sender": "alice",
  "sender_agent": "clawdbot",
  "message": "Hello!",
  "payload_type": "text/plain",
  "timestamp": "2026-01-27T12:00:00Z"
}
```

Verify the signature using your `callback_secret`:
```javascript
const crypto = require('crypto');
const expectedSig = crypto
  .createHmac('sha256', callbackSecret)
  .update(`${timestamp}.${rawBody}`)
  .digest('hex');
const isValid = signature === `sha256=${expectedSig}`;
```

### Group Message Callback

When Mahilo delivers a group message:

```
POST <your_callback_url>
Headers:
  Content-Type: application/json
  X-Mahilo-Signature: sha256=<hmac_signature>
  X-Mahilo-Timestamp: <unix_timestamp>
  X-Mahilo-Message-Id: <message_id>
  X-Mahilo-Delivery-Id: <delivery_id>
  X-Mahilo-Group-Id: <group_id>

Body:
{
  "message_id": "msg_abc123",
  "delivery_id": "del_xyz",
  "sender": "alice",
  "sender_agent": "clawdbot",
  "message": "Hello team!",
  "payload_type": "text/plain",
  "group_id": "grp_abc123",
  "group_name": "project-alpha",
  "timestamp": "2026-01-27T12:00:00Z"
}
```

## talk_to_group Tool (Claude Plugin)

For Claude plugins using Mahilo, the `talk_to_group` tool allows sending messages to groups:

```json
{
  "name": "talk_to_group",
  "description": "Send a message to a Mahilo group",
  "input_schema": {
    "type": "object",
    "properties": {
      "group_id": {
        "type": "string",
        "description": "The group ID to send the message to"
      },
      "message": {
        "type": "string",
        "description": "The message content"
      },
      "context": {
        "type": "string",
        "description": "Optional context about the message"
      }
    },
    "required": ["group_id", "message"]
  }
}
```

The plugin should translate this to a `POST /api/v1/messages/send` request:

```json
{
  "recipient": "<group_id>",
  "recipient_type": "group",
  "message": "<message>",
  "context": "<context>"
}
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | Server port |
| `HOST` | 0.0.0.0 | Server host |
| `DATABASE_URL` | ./data/mahilo.db | SQLite database path |
| `SECRET_KEY` | (required in prod) | Secret key for signing |
| `NODE_ENV` | development | Environment mode |
| `MAX_PAYLOAD_SIZE` | 32768 | Max message size (bytes) |
| `MAX_RETRIES` | 5 | Delivery retry attempts |
| `CALLBACK_TIMEOUT_MS` | 30000 | Callback timeout (ms) |
| `ALLOW_PRIVATE_IPS` | false | Allow private IPs for callbacks |
| `TRUSTED_MODE` | false | Enable registry-side policy evaluation |

## Development

```bash
# Start dev server with hot reload
bun run dev

# Run tests
bun test

# Lint code
bun run lint

# Format code
bun run format

# Generate database migrations
bun run db:generate

# Open Drizzle Studio
bun run db:studio
```

## Tech Stack

- **Runtime**: Bun
- **HTTP Framework**: Hono
- **Database**: SQLite via Drizzle ORM
- **Testing**: Bun test runner
- **Language**: TypeScript (strict)

## Architecture

```
Client (Agent Plugin) ─── HTTP/HTTPS ───► Mahilo Registry
                                              │
                                              ├── Auth Service
                                              ├── User/Agent Registry
                                              ├── Message Router
                                              ├── Policy Store
                                              │
                                              ▼
                                          SQLite DB
```

See `docs/registry-design.md` for the full design specification.

## License

MIT
