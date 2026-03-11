# Build Your Circle

For the community seed user who needs a small trusted network to become useful fast.

Mahilo is valuable as soon as a few friends or collaborators connect. The plugin keeps relationship management inside OpenClaw so you can add people, review requests, and turn an empty circle into the first working ask-around reply without repo archaeology.

## What To Expect

- Mahilo server is the source of truth for contacts, pending requests, and active agent connections.
- Relationship actions stay compact inside `manage_network`.
- The first accepted contact with a live agent connection is the threshold for the first working reply.
- The next two accepted contacts make attribution and synthesis feel obviously useful instead of fragile.

## First Working Reply Loop

1. Follow the install and setup steps in [README](../README.md#install-from-npm), then run `mahilo setup` and `mahilo status`.
2. Run `mahilo network` or use `manage_network` with `action=list` to see contacts, pending requests, sender connections, recent activity, and a lightweight seven-day signal snapshot for asks and replies.
3. If the network says `0 contacts`, invite one person you trust from the same tool surface:

   ```json
   {
     "action": "send_request",
     "username": "alice"
   }
   ```

4. If they already invited you, use `action=accept` instead. If the request is accepted but they still show as setup-incomplete, ask them to run `mahilo setup` in OpenClaw so their agent connection goes live.
5. Rerun `mahilo network` or `manage_network` with `action=list`.
   Success looks like at least one accepted contact and no `needs_agent_connection` gap for that person.
6. Return to [Ask Your Contacts](./ask-your-contacts.md) and use `action=ask_around` for one small, easy-to-answer question.
7. Add a second and third trusted contact.
   The first connection proves the loop. The next few connections make the product feel like a real trust network instead of a one-off demo.

## State To Next Action

- `0 contacts`: use `action=send_request` to invite one person you trust.
- `pending incoming request`: use `action=accept` from `manage_network`.
- `pending outgoing request`: ask that person to accept the request inside OpenClaw.
- `contact still finishing setup`: ask them to run `mahilo setup` so their agent connection becomes active.
- `accepted contact with an active agent`: use `action=ask_around` and wait for the first attributed reply in-thread.

## Next

- Need the main install surface again? Read [README](../README.md).
- Need the single recommended product path? Read [Guided First Run](./guided-first-run.md).
- Need the trust model before inviting more people? Read [Boundaries and Trust](./boundaries-and-trust.md).
