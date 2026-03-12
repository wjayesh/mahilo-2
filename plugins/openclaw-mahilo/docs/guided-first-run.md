# Guided First Run

This is the single recommended quickstart path for Mahilo inside OpenClaw.

Use it when you want to prove the product in one OpenClaw session instead of stitching together setup, network, trust, and review docs by hand. The path is designed to show server connection, one meaningful orchestration event, a live handoff back into the same thread, and explicit human approval before a sensitive share goes out.

The only operator-owned step that still happens outside OpenClaw is installing the plugin and, if you already have one, optionally saving a Mahilo API key once. Mahilo defaults to `https://mahilo.io`, and callback routing is auto-detected from OpenClaw before falling back to localhost for local-only testing.

## What This Proves

- OpenClaw can attach to Mahilo and resolve the default sender from inside the product.
- An empty Mahilo circle turns into one concrete invite/setup loop instead of a dead end.
- One accepted contact with a live agent connection is enough to reach the first working reply state.
- One ask-around request can fan out across the Mahilo network from inside OpenClaw.
- Replies can land back in the same OpenClaw thread as attributed Mahilo updates.
- Sensitive outbound sharing stops on review first and only proceeds after a narrow human approval.

## Recommended Five-Minute Path

1. Give the agent your username and one-time invite token (a string starting with `mhinv_`). The plugin will bootstrap automatically when the agent tries any Mahilo tool — it registers the identity via `POST /api/v1/auth/register`, attaches the default sender via `POST /api/v1/agents`, and saves credentials to the runtime store. No command needed.

   If you prefer to bootstrap manually, you can still run `/mahilo setup {"username":"your_handle","invite_token":"mhinv_..."}` as a fallback.

   Success looks like `attached @<username>` plus `selected sender <connection_id>` and callback readiness passing in the same run.
2. Run `mahilo status`.
   Success looks like `Mahilo status: connected; diagnostics snapshot available.`
3. Check whether your circle is ready with `mahilo network` or `manage_network` using `action=list`.
   If it reports `0 contacts`, stay in the same OpenClaw session for the next step instead of stopping.
4. Build your circle with one concrete invite.
   Send one request from `manage_network`:

   ```json
   {
     "action": "send_request",
     "username": "your_first_contact"
   }
   ```

   If they already invited you, use `action=accept` instead. Ask them to give their agent an invite token in OpenClaw so their agent connection goes live.
   Success looks like `mahilo network` showing at least `1 contact`, and ask-around no longer returning a `needs_agent_connection` state for that person.
5. Start one meaningful orchestration event with `ask_network`.
   Ask OpenClaw to check with your Mahilo contacts, or call:

   ```json
   {
     "action": "ask_around",
     "question": "Who knows a good ramen spot near the Mission for tonight?"
   }
   ```
6. Wait for the live handoff in the same thread.
   Success looks like a `Mahilo ask-around update` with attributed text from at least one contact.
7. Show the human-review gate before a sensitive share goes out.
   Send a precise follow-up with `send_message`:

   ```json
   {
     "recipient": "alice",
     "message": "I'm at 18th and Valencia right now; meet me here at 7."
   }
   ```

   Success looks like `Mahilo needs review before sending this person message.` No sensitive message should be sent yet.
8. Approve narrowly with `set_boundaries`.
   Create a one-hour exception for that one recipient:

   ```json
   {
     "action": "exception",
     "category": "location",
     "recipient": "alice",
     "durationMinutes": 60,
     "sourceResolutionId": "<resolution_id_from_step_7>"
   }
   ```

9. Retry the same `send_message`.
   Success looks like `Message sent through Mahilo.`, which proves the human approval changed the outcome intentionally instead of bypassing Mahilo.

## Success Scorecard

| Check | Pass condition |
| --- | --- |
| Setup proof | Bootstrap completes with an attached identity, selected sender, and no remaining setup blocker |
| Connectivity proof | `mahilo status` reports `connected` |
| Build-your-circle proof | `mahilo network` reports at least `1 contact`, and that contact has finished Mahilo setup before the first ask |
| Orchestration proof | `ask_network` fans the question out across Mahilo contacts and returns waiting-for-reply state |
| Live handoff proof | At least one attributed `Mahilo ask-around update` lands in the same thread |
| Oversight proof | The first sensitive send returns review-required instead of delivering |
| Approval proof | One explicit `set_boundaries` exception changes the retry from review-required to sent |
| Time-to-value proof | The full path completes in 5 minutes or less once OpenClaw is running and one invitee is available to accept/setup in parallel |

## Measurable Targets

- Sender ids looked up outside OpenClaw during the guided run: `0`
- Raw sender ids copied during the run: `0`
- Context switches outside OpenClaw after config is saved: `0`
- Accepted contacts before the first ask-around: `>= 1`
- Contacts with active agent connections before the first ask-around: `>= 1`
- Attributed live replies observed: `>= 1`
- Review gates observed before sensitive send: `1`
- Approval actions required to finish the run: `1`, scoped to one recipient and one time window

## Fixture-Backed Replay

If you want to rehearse the same flow without a live Mahilo server, run:

```bash
bun run demo:stories --story guided-first-run
```

That replay uses the shipped plugin registration path, tool execution path, status/setup commands, and inbound webhook formatting path.

The replay starts immediately after the build-your-circle checkpoint, with the first accepted contacts already live, so you can rehearse the working-reply path without waiting on a second seat. Use the invite step above when your real network is still empty.
