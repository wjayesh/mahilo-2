# Guided First Run

This is the single recommended quickstart path for Mahilo inside OpenClaw.

Use it when you want to prove the product in one OpenClaw session instead of stitching together setup, network, trust, and review docs by hand. The path is designed to show server connection, one meaningful orchestration event, a live handoff back into the same thread, and explicit human approval before a sensitive share goes out.

Until the empty-network and setup-friction work lands, treat this as a seeded two-seat run:

- one operator-owned step has already happened outside OpenClaw: `plugins.entries.mahilo.config.baseUrl` and `apiKey` are set
- at least one accepted Mahilo contact already has an active agent connection
- a second accepted contact is helpful, but not required

## What This Proves

- OpenClaw can attach to Mahilo and resolve the default sender from inside the product.
- One ask-around request can fan out across the Mahilo network from inside OpenClaw.
- Replies can land back in the same OpenClaw thread as attributed Mahilo updates.
- Sensitive outbound sharing stops on review first and only proceeds after a narrow human approval.

## Recommended Five-Minute Path

1. Run `mahilo setup`.
   Success looks like `attached @<username>` plus `selected sender <connection_id>`.
2. Run `mahilo status`.
   Success looks like `Mahilo status: connected; diagnostics snapshot available.`
3. Start one meaningful orchestration event with `mahilo_network`.
   Ask OpenClaw to check with your Mahilo contacts, or call:

   ```json
   {
     "action": "ask_around",
     "question": "Who knows a good ramen spot near the Mission for tonight?",
     "senderConnectionId": "<selected_sender_from_step_1>"
   }
   ```

   Today, the raw `mahilo_network` ask-around call should reuse the sender chosen by `mahilo setup`. That keeps the remaining routing friction explicit until the setup-friction task lands.
4. Wait for the live handoff in the same thread.
   Success looks like a `Mahilo ask-around update` with attributed text from at least one contact.
5. Show the human-review gate before a sensitive share goes out.
   Preview a precise follow-up with `mahilo_message`:

   ```json
   {
     "action": "preview",
     "recipient": "alice",
     "message": "I'm at 18th and Valencia right now; meet me here at 7."
   }
   ```

   Success looks like `review_required` or `Message requires review before delivery.` No sensitive message should be sent yet.
6. Approve narrowly with `mahilo_boundaries`.
   Create a one-hour exception for that one recipient:

   ```json
   {
     "action": "exception",
     "category": "location",
     "recipient": "alice",
     "durationMinutes": 60,
     "sourceResolutionId": "<resolution_id_from_step_5>"
   }
   ```

7. Retry the same `mahilo_message` preview.
   Success looks like `allow`, which proves the human approval changed the outcome intentionally instead of bypassing Mahilo.

## Success Scorecard

| Check | Pass condition |
| --- | --- |
| Setup proof | `mahilo setup` reports an attached identity and selected sender |
| Connectivity proof | `mahilo status` reports `connected` |
| Orchestration proof | `mahilo_network` fans the question out across Mahilo contacts and returns waiting-for-reply state |
| Live handoff proof | At least one attributed `Mahilo ask-around update` lands in the same thread |
| Oversight proof | The first sensitive preview returns review-required instead of sending |
| Approval proof | One explicit `mahilo_boundaries` exception changes the retry from review-required to allow |
| Time-to-value proof | The full path completes in 5 minutes or less after config is already in place |

## Measurable Targets

- Sender ids looked up outside OpenClaw during the guided run: `0`
- Raw sender ids copied during the run: `<= 1`, only for the `mahilo_network` ask-around step today
- Context switches outside OpenClaw after config is saved: `0`
- Attributed live replies observed: `>= 1`
- Review gates observed before sensitive send: `1`
- Approval actions required to finish the run: `1`, scoped to one recipient and one time window

## Fixture-Backed Replay

If you want to rehearse the same flow without a live Mahilo server, run:

```bash
bun run demo:stories --story guided-first-run
```

That replay uses the shipped plugin registration path, tool execution path, status/setup commands, and inbound webhook formatting path.
