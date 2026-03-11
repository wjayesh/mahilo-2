# Ask Your Contacts

For the networked OpenClaw power user who wants trustworthy answers from people they already know.

Mahilo makes "ask around" a normal OpenClaw behavior. You ask once, Mahilo fans the question out across the right contacts, replies come back into the same thread with attribution, and anything that needs review stays in the review loop instead of being sent silently.

## What To Expect

- The answer comes from real people in your Mahilo network, not anonymous web content.
- Replies keep person-level attribution and a running summary in the same OpenClaw thread.
- If someone does not have grounded info, the plugin shows a clear "I don't know" instead of inventing an opinion.

## Fast Path

1. Follow the install and config steps in [README](../README.md#minimal-working-openclaw-config). Mahilo defaults to `https://mahilo.io`, and the plugin auto-detects callback routing from OpenClaw when it can.
2. Run `mahilo setup`. If this runtime is new, include a username once so Mahilo can bootstrap the identity and store the issued key locally.
3. Run `mahilo status`.
4. Ask OpenClaw to check with your Mahilo contacts, or use `ask_network` with `action=ask_around`.

## Next

- Need to understand what your agent will share first? Read [Boundaries and Trust](./boundaries-and-trust.md).
- Need to add or approve more people before you ask around? Read [Build Your Circle](./build-your-circle.md).
