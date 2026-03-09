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

5. **The positioning doc promises an ongoing loop.**
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
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: PLG2-080
- **Description**:
  - Add a first-run setup path that lives inside OpenClaw.
  - The user should be able to set up Mahilo conversationally or through a single clear command.
  - The flow should:
    - create or attach the Mahilo identity
    - confirm the username/agent connection
    - run a connectivity check
    - apply conservative default boundaries
- **Acceptance Criteria**:
  - [ ] A user can complete Mahilo setup inside OpenClaw without repo archaeology
  - [ ] The flow confirms username + connectivity at the end
  - [ ] Default boundaries remain conservative
  - [ ] The setup flow reduces visible YAML/config burden for normal use

### 1.2 Friend Request and Accept Flows
- **ID**: `PLG3-002`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: PLG3-001
- **Description**:
  - Expose relationship management natively in OpenClaw.
  - Support:
    - send friend request by username
    - review pending incoming/outgoing requests
    - accept or decline inside OpenClaw
- **Acceptance Criteria**:
  - [ ] "Add @alice on Mahilo" style flows work inside OpenClaw
  - [ ] Pending requests can be reviewed and acted on in OpenClaw
  - [ ] Errors are human-friendly and distinguish "not found", "already connected", and transport failures

### 1.3 Boundary Management by Conversation
- **ID**: `PLG3-003`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: PLG2-033, PLG3-001, PLG3-002
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

## Phase 2: The Ask-Around Wedge

### 2.1 Ask My Contacts / Ask Around
- **ID**: `PLG3-010`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: PLG2-041, PLG2-042, PLG3-002
- **Description**:
  - Add a high-level ask-around tool/command for the core Mahilo wedge:
    - "ask my contacts"
    - "ask my friends"
    - optional filters by role or group
  - The plugin should fan out to relevant contacts rather than forcing the user into one-recipient sends.
- **Acceptance Criteria**:
  - [ ] A single OpenClaw action can fan out a question across contacts
  - [ ] The caller can target all contacts, selected roles, or a specific group
  - [ ] The flow handles timeouts/non-responses without feeling broken

### 2.2 Trustworthy Response Synthesis and Attribution
- **ID**: `PLG3-011`
- **Status**: `pending`
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

### 2.3 Trust Contract: "I Don't Know" Over Fabrication
- **ID**: `PLG3-012`
- **Status**: `pending`
- **Priority**: P0
- **Depends on**: PLG3-010, PLG3-011
- **Description**:
  - Enforce the product trust contract explicitly in plugin behavior and tests.
  - If a friend's agent lacks grounded data, the plugin should return a clear "I don't know" / "no grounded answer" outcome rather than attributing an inferred opinion.
- **Acceptance Criteria**:
  - [ ] Plugin does not attribute inferred opinions to real contacts
  - [ ] "No grounded answer" outcomes are explicit and user-friendly
  - [ ] Tests cover attribution failures, unknown responses, and provenance formatting

### 2.4 Missing-Contact and Not-On-Mahilo Nudges
- **ID**: `PLG3-013`
- **Status**: `pending`
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

## Phase 3: Social Utility Beyond Direct Messages

### 3.1 Group Ask-Around
- **ID**: `PLG3-020`
- **Status**: `pending`
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

### 3.2 Connection and Activity View
- **ID**: `PLG3-021`
- **Status**: `pending`
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

### 3.3 Lightweight Product Signals
- **ID**: `PLG3-022`
- **Status**: `pending`
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

## Phase 4: Demo and Launch Readiness

### 4.1 Demo Fixture and Story Pack
- **ID**: `PLG3-030`
- **Status**: `pending`
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

## Phase 5: Keep The Loop Open-Ended

### 5.1 Positioning Reassessment and Next-Cycle Task Generation
- **ID**: `PLG3-099`
- **Status**: `pending`
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

## Recommended Build Order

1. PLG3-001 → PLG3-003
2. PLG3-010 → PLG3-013
3. PLG3-020 → PLG3-022
4. PLG3-030
5. PLG3-099

---

## Definition of Done

This PRD is complete when:

- Mahilo setup feels native inside OpenClaw
- relationship management happens inside OpenClaw
- "ask around" is a first-class user action
- replies preserve attribution and honor the trust contract
- missing-contact states support the viral loop cleanly
- basic product signals are visible without building a dashboard
- the final task has either confirmed alignment or created the next task list
