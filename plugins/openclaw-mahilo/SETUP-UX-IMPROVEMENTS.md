# Mahilo Plugin: Setup UX Improvements

## Problem

When the plugin is installed but not configured (no API key), the agent has no idea what to do. Tools fail silently. The agent has to reverse-engineer the setup flow from docs.

## Recommended Flow (No New Tools)

### The Idea

The plugin already has a `before_prompt_build` hook and a startup lifecycle. Use those two things to make the unconfigured state self-resolving.

### Step-by-Step

**1. Startup: Detect missing API key**

The plugin already knows on startup whether `config.apiKey` is set. If it's missing, set an internal flag: `this.needsSetup = true`.

**2. Prompt injection: Tell the agent what's wrong**

Use the existing `before_prompt_build` hook. When `needsSetup` is true, inject a short context block into the agent's system prompt:

```
[Mahilo] Plugin installed but not configured.
To set up:
1. Ask your human for their Mahilo API key (they can get one at mahilo.io)
2. Once you have it, patch the gateway config:
   gateway config.patch → plugins.entries.mahilo.config.apiKey = "mhl_..."
   This will restart and connect automatically.

If your human wants to register a new account:
   POST https://mahilo.io/api/v1/auth/register
   Body: {"username": "<handle>", "display_name": "<name>"}
   Save the api_key from the response, then patch config as above.
```

That's it. The agent now knows exactly what to do. No new tool, no detective work.

**3. Tool errors: Be explicit**

When any Mahilo tool (`manage_network`, `send_message`, `ask_network`, `set_boundaries`) is called while `needsSetup` is true, return:

```json
{
  "error": "mahilo_not_configured",
  "message": "Mahilo API key not set. Ask your human for their key, or register at mahilo.io/api/v1/auth/register. Then patch gateway config with the key.",
  "setup_hint": "gateway config.patch → plugins.entries.mahilo.config.apiKey"
}
```

Not a silent failure. Not a generic error. A specific, actionable message.

**4. After config patch: Gateway restarts, plugin picks up key**

The agent calls `gateway config.patch` with the API key (this tool already exists). Gateway restarts. Plugin reads the key on startup. `needsSetup` flips to false. Prompt injection disappears. Tools start working.

Zero new tools exposed. Zero manual JSON editing. The agent's existing `gateway` tool handles config changes.

### Why This Works

- **No new tool surface.** The agent already has `gateway config.patch` for config changes. Adding a `mahilo_setup` tool that just wraps "write a config key and restart" is redundant.
- **Prompt injection is the right channel.** The agent reads its system prompt every turn. If the prompt says "Mahilo needs an API key, here's how," the agent knows what to do immediately. No hunting through docs.
- **Self-healing.** Once configured, the prompt injection disappears. The agent never sees it again. No leftover tools to confuse things.
- **Works for any agent framework.** Any agent that reads its prompt context and can call `gateway config.patch` can set this up. No OpenClaw-specific magic.

### What the Agent Experience Looks Like

**Before (current, broken):**
```
Human: "Set up Mahilo"
Agent: calls manage_network → silent failure
Agent: reads README → confused
Agent: digs through old logs → finds API key maybe
Agent: manually edits JSON config file
Agent: restarts gateway
```

**After (with these changes):**
```
Human: "Set up Mahilo"
Agent: (already sees in prompt context: "Mahilo needs API key")
Agent: "I need your Mahilo API key. You can get one at mahilo.io"
Human: "Here it is: mhl_abc..."
Agent: calls gateway config.patch with the key
Agent: gateway restarts, plugin connects
Agent: "Done. Mahilo is live."
```

Three turns. No archaeology.

### Implementation Checklist

- [ ] In plugin startup (`onLoad` or `onActivate`): check for `config.apiKey`, set `this.needsSetup` flag
- [ ] In `before_prompt_build` hook: if `needsSetup`, inject the setup instructions block
- [ ] In each tool handler: if `needsSetup`, return structured error with `setup_hint`
- [ ] Test: install plugin without config → verify prompt injection appears → provide key via config.patch → verify tools work

### Optional: Auto-registration

If you want the plugin to handle registration without the agent using `exec`/`curl`:

Overload `manage_network` with a `setup` action that only works when unconfigured:

```json
{
  "action": "setup",
  "username": "my_agent"
}
```

This calls the register endpoint, stores the key via OpenClaw's config API, and triggers a restart. But honestly, the prompt injection approach above is simpler and doesn't require any tool changes. The agent can always `curl` the register endpoint if needed.

### Edge Case: Key Exists but Invalid

On startup, after reading the key, make a lightweight API call (e.g., `GET /api/v1/friends`) to validate it. If 401, treat it like `needsSetup` but with a different message:

```
[Mahilo] API key is invalid or expired. Ask your human for a new key.
```
