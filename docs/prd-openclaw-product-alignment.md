# Mahilo OpenClaw Product Alignment PRD

> **Goal**: Close the gap between the current plugin/server implementation and the Mahilo product positioning: "a trust network for AI agents" that lives inside OpenClaw and makes "ask my contacts" feel native, trustworthy, and easy to adopt.
>
> **Source positioning doc**: `/Users/wjayesh/apps/mahilo-2-product-positioning.md`
>
> **When this PRD starts**: After `PLG2-080` completes.

---

## Why This PRD Exists

The current work is strong on infrastructure:

- canonical policy/boundary enforcement
- authenticated identity and plugin/server contracts
- plugin-native hooks, routes, diagnostics, and publish-readiness work

That is necessary, but it is not yet the full product story from the positioning document.

The biggest remaining product gaps are:

1. **The first-time experience is still too technical.**
   - The positioning doc says setup should happen inside OpenClaw.
   - Today, the plugin is still oriented around low-level tools and config surfaces.

2. **The wedge use case is not productized yet.**
   - The story is "ask my contacts" / "ask around", not just `talk_to_agent`.
   - We still need a high-level fan-out experience with synthesis and attribution.

3. **The trust contract needs explicit product behavior.**
   - The positioning doc requires real provenance, clear attribution, and "I don't know" instead of fabricated opinions.
   - The infrastructure supports this direction, but the product experience and tests are not complete yet.

4. **Relationship flows are not yet native enough.**
   - Friend request / accept, boundaries, and connection visibility should be normal OpenClaw actions, not implicit server capabilities.

5. **The plugin still exposes too much connection plumbing.**
   - Normal OpenClaw use should not require a human or prompt author to manually supply `senderConnectionId`.
   - The plugin should discover or remember the default sender connection and use Mahilo server as the source of truth for contacts and friendships.

6. **The positioning doc promises an ongoing loop.**
   - The last task in this PRD should reassess the shipped product against positioning and create the next task list if more work remains.

---

## Alignment Notes

### Already Aligned

- The plugin is the long-term product surface, not the legacy `myclawd` copy.
- Mahilo server is the source of truth for policy/boundary decisions.
- The system has a real trust model: authenticated identity, conservative defaults, explicit boundaries, and auditability.
- Publish-readiness work is already tracked before this PRD starts.

### Gaps To Close

- Setup still needs to feel conversational and native in OpenClaw.
- Friend network flows need direct OpenClaw commands/tools.
- Contact discovery should come from Mahilo server, not host-injected contact lists.
- Normal plugin use should not require manual sender connection IDs.
- The OpenClaw tool surface must stay compact; avoid a tool explosion and prefer a few high-signal actions.
- "Ask around" needs to be first-class.
- Response attribution and "I don't know" behavior need explicit implementation and tests.
- Non-user nudges and connection visibility need product polish.

### Deliberate Non-Goals For This PRD

- federation
- end-to-end encryption rollout
- analytics dashboards
- plugin marketplace work
- mobile app work
- enterprise/governance packaging

Those are intentionally excluded because the positioning doc explicitly says to skip them for now.

---

## Phase 1: First-Time Experience Inside OpenClaw

### 1.1 Conversational Setup Flow
- **ID**: `PLG3-001`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-080
- **Description**:
  - Add a first-run setup path that lives inside OpenClaw.
  - The user should be able to set up Mahilo conversationally or through a single clear command.
  - The flow should:
    - create or attach the Mahilo identity
    - confirm the username/agent connection
    - discover or select the default sender connection for the plugin
    - run a connectivity check
    - apply conservative default boundaries
- **Acceptance Criteria**:
  - [ ] A user can complete Mahilo setup inside OpenClaw without repo archaeology
  - [ ] The flow confirms username + connectivity at the end
  - [ ] Normal plugin flows no longer require a human to pass `senderConnectionId` manually
  - [ ] Default boundaries remain conservative
  - [ ] The setup flow reduces visible YAML/config burden for normal use

- **Notes**:
  - 2026-03-09T22:09:45.889Z: PLG3-001 completed via orchestrator integration.
### 1.2 Default Sender Connection Resolution
- **ID**: `PLG3-004`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-080
- **Description**:
  - Stop treating `senderConnectionId` as normal user/model input.
  - The plugin should discover the user's active Mahilo agent connections from Mahilo server, choose a default deterministically, cache it appropriately, and inject it when low-level routes still require it.
  - Explicit sender-connection selection should remain available only for advanced routing cases.
- **Acceptance Criteria**:
  - [ ] Core Mahilo plugin flows work without a human or prompt author passing `senderConnectionId`
  - [ ] The plugin can discover the user's own Mahilo agent connections from server state
  - [ ] Default sender resolution is deterministic and documented
  - [ ] Advanced/explicit sender-connection override remains possible when needed

- **Notes**:
  - 2026-03-09T22:33:11.406Z: PLG3-004 completed via orchestrator integration.
### 1.3 Mahilo Social Client Expansion
- **ID**: `PLG3-005`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-080
- **Description**:
  - Expand the plugin client beyond policy/send primitives so it can represent the full Mahilo social product.
  - Add typed client support for:
    - list own agent connections
    - list friends / friendships
    - send friend request
    - accept / reject friend request
    - list a friend's active agent connections
  - Remove `contactsProvider` from the primary product path.
- **Acceptance Criteria**:
  - [ ] Plugin client exposes typed methods for Mahilo friendship/contact/connection flows
  - [ ] `list_mahilo_contacts` no longer depends on host-injected contacts as the normal path
  - [ ] Client errors map cleanly to product-level states such as not found, already connected, and no active connections

- **Notes**:
  - 2026-03-09T22:43:57.338Z: PLG3-005 completed via orchestrator integration.
### 1.4 Friend Request and Accept Flows
- **ID**: `PLG3-002`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG3-001, PLG3-004, PLG3-005
- **Description**:
  - Expose relationship management natively in OpenClaw.
  - Support:
    - send friend request by username
    - list current contacts/friendships from Mahilo server
    - review pending incoming/outgoing requests
    - accept or decline inside OpenClaw
- **Acceptance Criteria**:
  - [ ] "Add @alice on Mahilo" style flows work inside OpenClaw
  - [ ] Contact/friend listings come from Mahilo server as the source of truth
  - [ ] Pending requests can be reviewed and acted on in OpenClaw
  - [ ] Errors are human-friendly and distinguish "not found", "already connected", and transport failures

- **Notes**:
  - 2026-03-09T22:55:24.396Z: PLG3-002 completed via orchestrator integration.
### 1.5 Minimal Tool Surface and Routing
- **ID**: `PLG3-006`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG3-002, PLG3-004, PLG3-005
- **Description**:
  - Keep the OpenClaw integration compact.
  - Prefer a small number of high-signal tools/commands over a tool per Mahilo API route.
  - Relationship flows, ask-around, boundaries, and diagnostics should be grouped into a stable surface that OpenClaw can use reliably without polluting tool context.
- **Acceptance Criteria**:
  - [ ] The plugin exposes a deliberately small, documented Mahilo tool set
  - [ ] Relationship management and ask-around do not require a separate tool for every server endpoint
  - [ ] Operational/debug flows prefer commands when that reduces tool-surface noise
  - [ ] Tool naming and responsibilities are stable and non-overlapping

- **Notes**:
  - 2026-03-09T23:08:36.797Z: PLG3-006 completed via orchestrator integration.
### 1.6 Boundary Management by Conversation
- **ID**: `PLG3-003`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-033, PLG3-001, PLG3-002, PLG3-006
- **Description**:
  - Turn the policy engine into user-facing "boundaries" management.
  - Focus on common categories first:
    - opinions/recommendations
    - availability/schedule
    - location
    - health/financial/contact details
  - The plugin should present these as conversational boundary changes, not policy jargon.
- **Acceptance Criteria**:
  - [ ] Users can change common sharing boundaries conversationally
  - [ ] Plugin writes canonical Mahilo policies/overrides under the hood
  - [ ] User-facing copy says "boundaries", not "guardrails"
  - [ ] Safety-sensitive categories default to conservative behavior

---

- **Notes**:
  - 2026-03-09T23:21:09.173Z: PLG3-003 completed via orchestrator integration.
## Phase 2: The Ask-Around Wedge

### 2.1 Ask My Contacts / Ask Around
- **ID**: `PLG3-010`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-041, PLG2-042, PLG3-002, PLG3-005, PLG3-006
- **Description**:
  - Add a high-level ask-around action for the core Mahilo wedge:
    - "ask my contacts"
    - "ask my friends"
    - optional filters by role or group
  - The plugin should fan out to relevant contacts from Mahilo server rather than forcing the user into one-recipient sends or relying on injected host contact providers.
  - This should be implemented as one compact user-facing capability, not a proliferation of low-level tools.
- **Acceptance Criteria**:
  - [ ] A single OpenClaw action can fan out a question across contacts
  - [ ] Recipient discovery uses Mahilo server friendship/contact data as the source of truth
  - [ ] The caller can target all contacts, selected roles, or a specific group
  - [ ] The flow handles timeouts/non-responses without feeling broken

- **Notes**:
  - 2026-03-09T23:33:44.114Z: PLG3-010 completed via orchestrator integration.
### 2.2 Trustworthy Response Synthesis and Attribution
- **ID**: `PLG3-011`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG2-052, PLG3-010
- **Description**:
  - Summarize multiple replies without losing the provenance that makes Mahilo valuable.
  - The synthesis should preserve:
    - who responded
    - what was actually said
    - when or from what experience context the answer came, when known
- **Acceptance Criteria**:
  - [ ] Synthesized replies preserve person-level attribution
  - [ ] The final answer clearly distinguishes direct replies from synthesized summary text
  - [ ] The result reads well in OpenClaw chat without hiding provenance

- **Notes**:
  - 2026-03-09T23:42:49.813Z: PLG3-011 completed via orchestrator integration.
### 2.3 Trust Contract: "I Don't Know" Over Fabrication
- **ID**: `PLG3-012`
- **Status**: `done`
- **Priority**: P0
- **Depends on**: PLG3-010, PLG3-011
- **Description**:
  - Enforce the product trust contract explicitly in plugin behavior and tests.
  - If a friend's agent lacks grounded data, the plugin should return a clear "I don't know" / "no grounded answer" outcome rather than attributing an inferred opinion.
- **Acceptance Criteria**:
  - [ ] Plugin does not attribute inferred opinions to real contacts
  - [ ] "No grounded answer" outcomes are explicit and user-friendly
  - [ ] Plugin/tool result types include a first-class no-grounded-answer / I-don't-know outcome
  - [ ] Tests cover attribution failures, unknown responses, and provenance formatting

- **Notes**:
  - 2026-03-09T23:52:44.500Z: PLG3-012 completed via orchestrator integration.
### 2.4 Missing-Contact and Not-On-Mahilo Nudges
- **ID**: `PLG3-013`
- **Status**: `done`
- **Priority**: P1
- **Depends on**: PLG3-010
- **Description**:
  - Turn network gaps into clear, useful product feedback.
  - Examples:
    - the requested contact is not on Mahilo
    - the contact has not connected an agent
    - the contact is not yet in your Mahilo network
- **Acceptance Criteria**:
  - [ ] The user can tell the difference between "no answer" and "not on Mahilo"
  - [ ] The product suggests the next useful action when a contact is missing
  - [ ] The copy supports the viral loop without sounding spammy

---

- **Notes**:
  - 2026-03-10T00:11:49.109Z: PLG3-013 completed via orchestrator integration.
## Phase 3: Social Utility Beyond Direct Messages

### 3.1 Group Ask-Around
- **ID**: `PLG3-020`
- **Status**: `done`
- **Priority**: P1
- **Depends on**: PLG2-052, PLG3-010, PLG3-011
- **Description**:
  - Promote group usage from a low-level transport capability into a user-facing flow.
  - Support prompts like:
    - "ask the hiking group"
    - "ask the foodie group"
- **Acceptance Criteria**:
  - [ ] Group ask-around works inside OpenClaw
  - [ ] Replies preserve per-person attribution
  - [ ] Request/reply continuity is preserved for group threads

- **Notes**:
  - 2026-03-10T00:20:13.805Z: PLG3-020 completed via orchestrator integration.
### 3.2 Connection and Activity View
- **ID**: `PLG3-021`
- **Status**: `done`
- **Priority**: P1
- **Depends on**: PLG2-044, PLG3-002
- **Description**:
  - Add a simple in-plugin view of:
    - friends/contacts
    - pending requests
    - recent Mahilo activity
  - This should stay inside OpenClaw for the MVP.
- **Acceptance Criteria**:
  - [ ] Users can inspect their Mahilo network inside OpenClaw
  - [ ] Pending requests and recent activity are visible
  - [ ] Common debugging steps do not require reading server tables directly

- **Notes**:
  - 2026-03-10T00:32:09.153Z: PLG3-021 completed via orchestrator integration.
### 3.3 Lightweight Product Signals
- **ID**: `PLG3-022`
- **Status**: `done`
- **Priority**: P1
- **Depends on**: PLG3-010, PLG3-021
- **Description**:
  - Capture the minimum signals needed to judge whether the product is alive:
    - queries sent
    - replies received
    - connected contacts
  - Keep this lightweight and operational; do not build an analytics dashboard.
- **Acceptance Criteria**:
  - [ ] Queries per user/week can be derived from the system
  - [ ] Response-rate signals exist
  - [ ] The implementation stays lightweight and does not drift into dashboard work

---

- **Notes**:
  - 2026-03-10T00:40:58.025Z: PLG3-022 completed via orchestrator integration.
## Phase 4: Demo and Launch Readiness

### 4.1 Demo Fixture and Story Pack
- **ID**: `PLG3-030`
- **Status**: `done`
- **Priority**: P1
- **Depends on**: PLG3-003, PLG3-010, PLG3-011, PLG3-012
- **Description**:
  - Prepare reproducible demo flows for the launch stories in the positioning doc:
    - restaurant question
    - weekend plan / coordination
    - boundaries story
  - This can be fixtures, scripts, seed data, or reproducible test/demo docs.
- **Acceptance Criteria**:
  - [ ] At least three repeatable demo flows exist
  - [ ] The demos show provenance, trust, and boundaries clearly
  - [ ] Running the demos does not require tribal knowledge

---

- **Notes**:
  - 2026-03-10T00:53:52.933Z: PLG3-030 completed via orchestrator integration.
## Phase 5: Keep The Loop Open-Ended

### 5.1 Positioning Reassessment and Next-Cycle Task Generation
- **ID**: `PLG3-099`
- **Status**: `done`
- **Priority**: P1
- **Depends on**: PLG3-003, PLG3-012, PLG3-013, PLG3-020, PLG3-021, PLG3-022, PLG3-030
- **Description**:
  - Re-read the positioning document and compare it to the actual shipped state.
  - Decide whether Mahilo now matches the intended first-use experience and trust story.
  - If more work remains, create or refresh the next task list and wire it into the plugin workflow.
- **Acceptance Criteria**:
  - [ ] The shipped state has been re-reviewed against positioning
  - [ ] Remaining gaps are converted into a follow-on task list if needed
  - [ ] Workflow continuation is documented so the loop does not dead-end silently

---

- **Notes**:
  - 2026-03-10T00:59:39.061Z: PLG3-099 completed via orchestrator integration.
## Recommended Build Order

1. PLG3-001 → PLG3-006
2. PLG3-010 → PLG3-013
3. PLG3-020 → PLG3-022
4. PLG3-030
5. PLG3-099

---

## 2026-03-10 Positioning Re-review

Primary references for this refresh:

- `/Users/wjayesh/apps/mahilo-2-product-positioning.md`
- `docs/prd-openclaw-plugin-migration.md`

This re-review uses the shipped plugin surface in `plugins/openclaw-mahilo/`, not just the earlier task plan, and reframes the next stage around Mahilo's product-positioning pillars: framework-agnostic agent integration, human-in-the-loop operations, and real-time multi-agent communication surfaced through OpenClaw.

### Shipped-State Evidence Used For This Re-review

- `plugins/openclaw-mahilo/README.md`: published install/config flow, compact tool surface, and the first actions currently presented to a new OpenClaw user.
- `plugins/openclaw-mahilo/src/openclaw-plugin-wrapper.ts`: native `mahilo setup` command, identity bootstrap fallback, and default-sender setup behavior.
- `plugins/openclaw-mahilo/src/network.ts` plus `plugins/openclaw-mahilo/tests/openclaw-plugin.test.ts`: ask-around fan-out, network-gap nudges, in-thread reply routing, attribution, and explicit no-grounded-answer handling.
- `plugins/openclaw-mahilo/docs/demo-story-pack.md`: repeatable restaurant, weekend-planning, and boundaries launch stories run through the shipped plugin code path.

### What The Shipped Plugin Already Proves

- Mahilo has a publishable OpenClaw surface: packed-artifact install, stable manifest/package identity, and a compact native surface (`mahilo_message`, `mahilo_network`, `mahilo_boundaries` plus setup/status/review commands).
- The core first-use mechanics now live inside OpenClaw: `mahilo setup` exists, default sender connection resolution no longer depends on humans passing `senderConnectionId`, and relationship management stays inside `mahilo network`.
- The wedge is real: ask-around can fan out across contacts, roles, and groups; replies route back into the originating OpenClaw thread; and lightweight product signals are visible in-plugin.
- The trust story is materially implemented: attributed replies stay separate from synthesized summary text, "I don't know" remains explicit, and review/boundary flows keep sensitive sharing conservative by default.
- Launch proof is repeatable: the demo story pack exercises restaurant question, weekend coordination, and boundaries flows through the shipped plugin code path.

### Reassessment Verdict

- Mahilo now matches the intended trust story and the core "ask my contacts" wedge.
- Mahilo does not yet fully match the intended first-use experience from the positioning document.
- The next cycle should focus on making the first successful run feel inevitable and self-explanatory, not on more migration cleanup.

### Remaining Positioning Gaps

- The current install path still starts with `npm install` plus manual `baseUrl` / `apiKey` config before a user can run `mahilo setup`, which falls short of the positioning goal that setup should feel fully native inside OpenClaw.
- When `mahilo setup` has to bootstrap identity, the user is still told to save the issued API key in plugin config and rerun the command; callback reachability is also still described as operator-facing plumbing rather than a guided product step.
- The plugin has the ingredients for the launch story, but not one canonical quickstart that proves setup, friend addition, ask-around, review/approval, and live reply handoff in a single measured flow.
- Zero-network / no-active-agent states are diagnosed well, but the product still needs an explicit invite/onboarding loop that turns those states into the next useful action.
- Trust proof exists across `mahilo review`, `mahilo network`, and the demo pack, but it is not yet packaged into one operator-facing adoption walkthrough that answers "why should I trust this in production?"

## Current Priorities

The task ordering below supersedes any older sequencing in this document when there is a conflict.

### 1.1 Narrative and ICP Refresh
- **ID**: `PAL-001`
- **Status**: `done`
- **Priority**: `P0`
- **Depends on**: none
- **Description**:
  - Translate `/Users/wjayesh/apps/mahilo-2-product-positioning.md` into an OpenClaw-specific message architecture for the shipped plugin.
  - Define the primary OpenClaw user/persona targets, the before/after value proposition, and the shortest credible explanation of Mahilo as the control plane behind the plugin.
- **Acceptance Criteria**:
  - [ ] The plugin has a crisp one-paragraph positioning statement aligned to the product-positioning doc
  - [ ] Target personas and top jobs-to-be-done are explicit
  - [ ] The product promise is framed in outcomes, not migration mechanics

#### PAL-001 Working Output

**One-line promise**

Ask your contacts from OpenClaw and get real answers from people you trust, with attribution and boundaries built in.

**Positioning statement**

Mahilo for OpenClaw turns "ask my contacts" into a native OpenClaw behavior. Instead of trusting public AI noise or manually repeating the same question across chats, a user asks once inside OpenClaw and the plugin uses Mahilo to reach the right contacts, bring back attributed answers from real people they already trust, and honor the sharing boundaries each person has set. OpenClaw stays the familiar conversational surface; Mahilo stays behind the scenes as the control plane for identity, network discovery, policy decisions, review paths, and final send-time enforcement.

**Shortest credible explanation of Mahilo**

Mahilo is the trust and control layer behind the plugin: it knows who is in your network, which agent connection is acting, what can be shared, and whether a request should be allowed, reviewed, or blocked.

**Message architecture**

- Lead with the outcome: trustworthy answers from your own network inside OpenClaw.
- Reinforce with the experience: ask once, fan out across contacts, and get attributed replies back in the same OpenClaw flow.
- Reinforce with the trust contract: answers trace back to real people and respect user-set boundaries by default.
- Explain Mahilo only after the value is clear: it is the control plane that handles identity, routing, policy, and review behind the plugin.
- Do not lead with migration mechanics, repo moves, contract versions, `senderConnectionId`, callback plumbing, or other implementation details.

**Primary personas and top jobs-to-be-done**

1. **Networked OpenClaw power user**
   - Profile: already uses OpenClaw regularly, has a small but real circle of friends or collaborators with AI agents, and is frustrated by generic web answers or scattered group-chat outreach.
   - Top jobs:
     - When I need a recommendation or reality check, ask my contacts from OpenClaw and get grounded replies I can trust.
     - When I would otherwise message several people manually, ask once and let the system gather answers for me.
   - Message to emphasize: "Real answers from real people you already trust."

2. **Boundary-conscious participant**
   - Profile: likes the idea of agent-to-agent help, but only if it is obvious what their agent can share and what stays private.
   - Top jobs:
     - Let my agent help friends without exposing sensitive details by default.
     - Adjust sharing boundaries conversationally when I want to open up or tighten access.
   - Message to emphasize: "Your agent helps on your terms, with conservative defaults."

3. **Community seed user**
   - Profile: early adopter who wants to bring a few friends or collaborators onto Mahilo and needs the product to feel useful with a small trusted network.
   - Top jobs:
     - Add contacts, review requests, and make the network useful from the first few connections.
     - Demo a tangible "ask around" moment that makes other OpenClaw users want in.
   - Message to emphasize: "A small trusted circle is enough to unlock value quickly."

**Before / after value proposition**

- Before: you rely on SEO spam, generic AI answers, or repeated manual outreach across chats when you want a real opinion.
- Before: even if your friends use AI agents, their knowledge is trapped in separate assistants and you do the coordination work yourself.
- Before: sharing feels risky because it is not obvious what an agent will reveal or when human review applies.
- After: you ask once inside OpenClaw and Mahilo helps your agent reach the right people, collect responses, and return an attributed summary in the same conversation.
- After: the useful information comes from people you actually know, not anonymous internet content.
- After: boundaries and review stay intact because Mahilo remains the policy and enforcement control plane behind the plugin.

**Outcome framing to reuse in docs and launch copy**

- Primary promise: "Get trustworthy answers from your network without leaving OpenClaw."
- Supporting promise: "Ask around, see who said what, and keep boundaries intact."
- Proof statement: "Mahilo makes the trust model operational by handling identity, network state, policy decisions, and final enforcement behind the plugin."

- **Notes**:
  - 2026-03-09T23:55:28.610Z: PAL-001 completed via orchestrator integration.
### 1.2 Documentation Surface Refresh
- **ID**: `PAL-002`
- **Status**: `done`
- **Priority**: `P0`
- **Depends on**: `PAL-001`
- **Description**:
  - Rework the README, marketplace/listing copy inputs, and primary documentation entry points so the first screens a user sees reflect the refreshed narrative.
  - Make OpenClaw-specific user journeys and calls-to-action obvious without requiring prior Mahilo context.
- **Acceptance Criteria**:
  - [ ] The primary plugin docs open with the new positioning
  - [ ] Listing/packaging copy inputs are ready for publish surfaces
  - [ ] The first three documentation hops match the intended persona flow

- **Notes**:
  - 2026-03-10T00:01:45.701Z: PAL-002 completed via orchestrator integration.
### 1.3 Guided First-Run Story
- **ID**: `PAL-010`
- **Status**: `done`
- **Priority**: `P1`
- **Depends on**: `PAL-001`
- **Description**:
  - Design the canonical first-run workflow that proves Mahilo's value inside OpenClaw within minutes.
  - The flow should demonstrate connection to the Mahilo server, a meaningful agent event, human review/approval, and at least one multi-agent or real-time handoff.
- **Acceptance Criteria**:
  - [ ] A single recommended demo/quickstart path exists
  - [ ] The path highlights human oversight and orchestration, not just connectivity
  - [ ] Success criteria for the first-run experience are measurable

- **Notes**:
  - 2026-03-10T01:07:08.055Z: PAL-010 completed via orchestrator integration.
### 1.4 Native Setup Friction Reduction
- **ID**: `PAL-012`
- **Status**: `done`
- **Priority**: `P1`
- **Depends on**: `PAL-010`
- **Description**:
  - Collapse the current install/config/setup friction into the smallest credible operator path.
  - Reduce the number of manual steps needed before a new OpenClaw user can complete Mahilo setup, and make any remaining operator-owned step explicit inside the product.
  - Focus on the concrete shipped-flow gaps: credential bootstrap, default sender attachment, and callback readiness.
- **Acceptance Criteria**:
  - [ ] The first-run path identifies at most one explicit manual/operator step before Mahilo is ready, or fully handles that step inside OpenClaw
  - [ ] `mahilo setup` reports the exact remaining blocker and next action when identity, sender attachment, or callback readiness cannot complete
  - [ ] First-run docs and demo paths no longer bounce the user between README/config snippets and setup retry loops

- **Notes**:
  - 2026-03-10T01:29:14.749Z: PAL-012 completed via orchestrator integration.
### 1.5 Empty-Network Invite Loop
- **ID**: `PAL-013`
- **Status**: `done`
- **Priority**: `P1`
- **Depends on**: `PAL-010`, `PAL-012`
- **Description**:
  - Turn the existing network-gap states into a productized invite/onboarding loop.
  - A user who has zero contacts, a contact who is not on Mahilo, or a contact who has not finished setup should always get one crisp next action that keeps the first-run flow moving.
- **Acceptance Criteria**:
  - [ ] Zero-contact and no-active-agent states are framed as invite/onboarding steps, not dead-end errors
  - [ ] The recommended first-run path includes a concrete "build your circle" step that gets at least one other user to a working reply state
  - [ ] The docs/demo path shows how Mahilo becomes useful with the first few accepted connections

- **Notes**:
  - 2026-03-10T01:45:02.561Z: PAL-013 completed via orchestrator integration.
### 1.6 Trust and Operations Proof
- **ID**: `PAL-011`
- **Status**: `pending`
- **Priority**: `P1`
- **Depends on**: `PAL-010`, `PAL-012`, `PAL-013`
- **Description**:
  - Package the operational proof needed for the positioning story: observability, approvals/policy surfaces, failure handling, and rollout confidence.
  - Focus on the evidence a skeptical operator or team lead would need before adopting the plugin.
- **Acceptance Criteria**:
  - [ ] Governance and observability proof points are enumerated
  - [ ] The docs/demo plan includes at least one failure-path or approval-path walkthrough
  - [ ] Team-adoption concerns are addressed explicitly

### 1.7 Launch Collateral and Validation Loop
- **ID**: `PAL-020`
- **Status**: `pending`
- **Priority**: `P2`
- **Depends on**: `PAL-002`, `PAL-011`
- **Description**:
  - Prepare the publish-adjacent collateral that validates the new positioning in the market: screenshots, short-form walkthrough assets, comparison framing, and a feedback loop for first adopters.
  - Keep this scoped to the minimum artifact set required to learn whether the positioning lands.
- **Acceptance Criteria**:
  - [ ] The first publish/announce asset checklist exists
  - [ ] Early-adopter feedback capture is planned
  - [ ] The collateral reinforces the refreshed positioning without reopening migration work

## Recommended Execution Order

1. `PAL-001` -> `PAL-002`
2. `PAL-010` -> `PAL-012` -> `PAL-013`
3. `PAL-011`
4. `PAL-020`

## Workflow Continuation

- `WORKFLOW.plugin.md` already lists `docs/prd-openclaw-product-alignment.md` as a task source, so after `PLG3-099` the plugin loop should continue in this same PRD.
- The next pending task order is: `PAL-010`, `PAL-012`, `PAL-013`, `PAL-011`, `PAL-020`.
- After `PAL-020`, rerun another positioning reassessment in this PRD instead of silently returning to migration work.

## Scope Guardrails

- Do not reopen migration-parity work unless a concrete product-alignment task exposes a blocking regression in the shipped plugin.
- Prefer proof-of-value work over additional infrastructure cleanup.
- Treat the Mahilo server and shared contract as fixed inputs unless a future task explicitly routes a dependency back to the server workflow.
- If native-setup cleanup requires new OpenClaw credential persistence or new server bootstrap support, record that dependency explicitly instead of hiding the gap in documentation work.

## Definition of Done

This PRD is complete when:

- Mahilo setup feels native inside OpenClaw
- normal plugin use does not require manual sender connection IDs
- contacts/friendships come from Mahilo server, not host-injected providers
- relationship management happens inside OpenClaw
- the Mahilo tool surface stays intentionally compact
- "ask around" is a first-class user action
- replies preserve attribution and honor the trust contract
- missing-contact states support the viral loop cleanly
- basic product signals are visible without building a dashboard
- the final task has either confirmed alignment or created the next task list
- the loop has an explicit follow-on reassessment path instead of ending silently after one launch cycle
