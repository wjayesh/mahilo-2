# Mahilo Dashboard Frontend Activation PRD

> **Project**: Mahilo Dashboard (`mahilo-2`)
> **Status**: Planning
> **Last Updated**: 2026-03-14
> **Primary Goal**: Turn the hidden legacy dashboard in `public/` into an active, product-aligned Mahilo frontend that matches the current network, boundaries, review, and ask-around model.

---

## Why This Exists

The current dashboard was added before the March 2026 server and plugin product work settled.

Since then, Mahilo has gained:

- canonical boundary/policy semantics
- review-required and approval-pending states
- blocked-event and promotion-suggestion surfaces
- richer friendship data, roles, and interaction counts
- a stronger "ask around" product story centered on network readiness

The current dashboard still reflects an older registry UI:

- broken assumptions about API response shapes
- a raw "Policies" screen instead of a product-ready Boundaries surface
- no clear connection space for a friend's active agent connections
- delivery logs exist, but they are too generic to cover review, blocked, and ask-around auditing well
- demo-only or placeholder actions in active UI paths

This PRD turns that audit into orchestrator-ready frontend work.

---

## Confirmed Frontend Gaps

- dashboard loaders do not match current API shapes consistently
- friends/network UI does not surface roles, interaction counts, or active connection readiness
- direct-message paths are half-removed and still linked from active controls
- current user search and some group/agent actions are still placeholder/demo behavior
- policies UI does not represent lifecycle, provenance, overrides, or role-scoped boundaries well
- activity does not expose reviews, blocked events, or ask-around outcomes
- landing page does not safely surface the dashboard after login

---

## Product Goals

1. The dashboard boots cleanly against the current backend contracts.
2. The network surface shows accepted/pending relationships, roles, interaction history, and connection readiness.
3. Boundaries become the primary user-facing privacy/control surface.
4. Delivery Logs and overview make review, blocked, and ask-around states legible.
5. Overview answers "am I ready to ask around?" at a glance.
6. Once the dashboard is credible, the landing page can safely surface it.

## Non-Goals

- replacing OpenClaw as Mahilo's primary product surface
- building an analytics suite
- migrating the dashboard to a new frontend framework
- widening server/plugin contracts unless a task explicitly identifies a blocking frontend gap

## Frontend Guardrails

- Keep the dashboard static and served from `public/` unless a task explicitly requires a different structure.
- Prefer direct username entry over a new global user-search API; do not block activation on search/discovery work.
- Use **Boundaries** in default user-facing copy; keep **Policies** for advanced/debug-only surfaces.
- Treat `/api/v1/plugin/reviews`, `/api/v1/plugin/events/blocked`, and `/api/v1/plugin/suggestions/promotions` as first-class product inputs.
- Keep Developer available as an advanced surface for API keys, diagnostics, and testing, but do not let it crowd out the primary product path.

---

## Status Legend

| Status | Meaning |
|--------|---------|
| `pending` | Not started |
| `in-progress` | Currently being worked on |
| `blocked` | Waiting on something |
| `review` | Ready for review |
| `done` | Completed |

---

## Phase 0: Stabilize the Existing Dashboard Runtime

### 0.1 Dashboard Data Adapter and Boot Fixes
- **ID**: `DASH-001`
- **Status**: `done`
- **Priority**: `P0`
- **Depends on**: none
- **Description**:
  - Add a normalization layer in `public/app.js` (or extracted helpers) so the dashboard state matches current API shapes for agents, friends, groups, messages, policies, reviews, and blocked events.
  - Repair current boot/runtime issues, including the friends response shape, message loader assumptions, and missing renderer/path mismatches that keep the dashboard from behaving like a real product surface.
- **Acceptance Criteria**:
  - [ ] Dashboard can load after auth without frontend runtime exceptions against the current backend
  - [ ] Friend data is normalized from `{ friends: [...] }` into a consistent UI model keyed by `friendship_id`
  - [ ] Message, group, and policy data use explicit normalized UI models instead of ad hoc field access
  - [ ] All current top-level loaders complete successfully with the existing server routes
- **Notes**:
  - Keep this task frontend-only unless a truly blocking contract gap is discovered.
  - 2026-03-14T12:36:18.232Z: DASH-001 completed via orchestrator integration.

### 0.2 Remove or Replace Dead-End Dashboard Actions
- **ID**: `DASH-002`
- **Status**: `done`
- **Priority**: `P0`
- **Depends on**: `DASH-001`
- **Description**:
  - Remove demo-only or broken active-dashboard paths and replace them with real flows or safe temporary gating.
  - This includes fake user search behavior, links to missing messaging views, placeholder group actions, and advanced agent controls that do not have working product backing.
- **Acceptance Criteria**:
  - [ ] No active CTA opens a missing view or triggers placeholder "would go here" behavior
  - [ ] The current "find users" flow is replaced with a real add-by-username path or clearly removed from the active product path
  - [ ] Old direct-message navigation no longer routes users into missing chat surfaces
  - [ ] The stale browser self-register path is removed or gated off from the normal dashboard journey
  - [ ] Incomplete advanced controls are either moved into Developer with clear labeling or hidden from the primary user journey

---

- **Notes**:
  - 2026-03-14T12:57:57.540Z: DASH-002 completed via orchestrator integration.
## Phase 1: Reframe the Dashboard Around the Current Product

### 1.1 Product-Aligned Navigation and View Model
- **ID**: `DASH-010`
- **Status**: `done`
- **Priority**: `P0`
- **Depends on**: `DASH-002`
- **Description**:
  - Rework the dashboard information architecture so it reflects the current Mahilo model: Overview, Network, Sender Connections, Groups, Boundaries, Delivery Logs, Developer, and Settings.
  - Reframe legacy labels where needed so the navigation communicates the real product shape without removing useful audit or advanced tooling surfaces.
- **Acceptance Criteria**:
  - [ ] Sidebar and page titles use current product language
  - [ ] "Policies" is reframed as "Boundaries" in the primary product path
  - [ ] "Delivery Logs" remains available as an audit-oriented surface enriched with review, blocked, and ask-around visibility
  - [ ] Developer remains available as an advanced configuration/tools area, including API-key and diagnostics flows, without dominating the primary navigation

- **Notes**:
  - 2026-03-14T13:08:02.460Z: DASH-010 completed via orchestrator integration.
### 1.2 Overview Becomes a Readiness Dashboard
- **ID**: `DASH-011`
- **Status**: `pending`
- **Priority**: `P1`
- **Depends on**: `DASH-021`, `DASH-030`, `DASH-041`, `DASH-051`, `DASH-052`
- **Description**:
  - Replace generic welcome stats with signals that answer whether the user can productively use Mahilo right now.
  - Overview should summarize network readiness, sender readiness, pending requests, review queue, blocked events, and recent ask-around activity.
- **Acceptance Criteria**:
  - [ ] Overview highlights accepted contacts, contacts with active agent connections, and pending incoming/outgoing requests
  - [ ] Overview includes current sender-connection readiness and any obvious next-step blocker
  - [ ] Review-required and blocked counts are visible from the overview
  - [ ] Recent ask-around or delivery activity is shown in a lightweight summary

---

## Phase 2: Network and Connection Space

### 2.1 Network List Built from Real Friendship Data
- **ID**: `DASH-020`
- **Status**: `done`
- **Priority**: `P0`
- **Depends on**: `DASH-010`
- **Description**:
  - Rebuild the current Friends page as the Mahilo network list using the real friendship model from the backend.
  - Surface accepted/pending/blocked state, request direction, roles, interaction count, and relationship age instead of a thin legacy friend list.
- **Acceptance Criteria**:
  - [ ] Network filters accurately represent accepted, pending incoming/outgoing, and blocked relationships
  - [ ] Relationship actions use the real `friendship_id`
  - [ ] Roles and interaction counts are visible in the list or its summary row
  - [ ] Empty states guide the user toward building a useful circle instead of generic messaging copy

- **Notes**:
  - 2026-03-14T13:20:41.961Z: DASH-020 completed via orchestrator integration.
### 2.2 Contact Detail and Connection Space
- **ID**: `DASH-021`
- **Status**: `done`
- **Priority**: `P0`
- **Depends on**: `DASH-020`
- **Description**:
  - Add a per-contact detail panel or modal that acts as the contact's "connection space".
  - Use `/api/v1/contacts/:username/connections` to show whether that person has active Mahilo connections, which frameworks/labels are live, and whether they are ready for ask-around participation.
- **Acceptance Criteria**:
  - [ ] Selecting a contact reveals active connection info from the current contacts API
  - [ ] Contacts with no active agent connections are clearly marked as not ready for ask-around
  - [ ] The connection space surfaces framework, label, capabilities, and status for each active connection
  - [ ] The user can tell from the UI whether a contact is ready for direct send or ask-around participation

- **Notes**:
  - 2026-03-14T13:31:32.678Z: DASH-021 completed via orchestrator integration.
### 2.3 Relationship Actions and Role Management
- **ID**: `DASH-022`
- **Status**: `done`
- **Priority**: `P0`
- **Depends on**: `DASH-020`
- **Description**:
  - Implement add-by-username, accept/reject/block/unfriend, and role add/remove flows backed by the current `/friends` and `/roles` surfaces.
  - Keep this flow usable without inventing a new global search endpoint.
- **Acceptance Criteria**:
  - [ ] Send/accept/reject/block/unfriend all use the current endpoints and real friendship IDs
  - [ ] Available roles are loaded from `/api/v1/roles`
  - [ ] A contact's current roles are visible and editable from the dashboard
  - [ ] The UI does not depend on a global search API to make relationship management usable

- **Notes**:
  - 2026-03-14T13:41:07.787Z: DASH-022 completed via orchestrator integration.
### 2.4 Group Detail, Members, and Readiness
- **ID**: `DASH-023`
- **Status**: `done`
- **Priority**: `P1`
- **Depends on**: `DASH-021`, `DASH-022`
- **Description**:
  - Upgrade Groups from static cards to working group management.
  - Show members, invite status, membership role/status, and whether the group is actually useful for targeted ask-around or boundaries work.
- **Acceptance Criteria**:
  - [ ] Group detail uses `/api/v1/groups/:id` and `/api/v1/groups/:id/members`
  - [ ] Invited vs active members are visible
  - [ ] Group invite and leave flows use real endpoints
  - [ ] Groups no longer rely on placeholder join behavior

---

- **Notes**:
  - 2026-03-14T14:44:21.610Z: DASH-023 completed via orchestrator integration.
## Phase 3: Sender Connections

### 3.1 Sender Connections Workspace
- **ID**: `DASH-030`
- **Status**: `done`
- **Priority**: `P1`
- **Depends on**: `DASH-010`
- **Description**:
  - Reframe My Agents as the sender-connections workspace.
  - Show routing priority, last seen, derived connection mode, callback health, default-sender heuristic, and current status so the UI reflects how Mahilo actually routes on the server side.
- **Acceptance Criteria**:
  - [ ] Each connection shows routing priority, last-seen, framework, label, and active/inactive status
  - [ ] Webhook vs polling mode is visible from frontend state
  - [ ] The dashboard indicates which active connection is the current default-sender candidate under existing backend rules
  - [ ] Ping/health check remains available and meaningful

- **Notes**:
  - 2026-03-14T15:22:13.823Z: DASH-030 completed via orchestrator integration.
### 3.2 Agent Add/Edit UX Aligned to the Current API
- **ID**: `DASH-031`
- **Status**: `done`
- **Priority**: `P1`
- **Depends on**: `DASH-030`
- **Description**:
  - Align the add/edit connection flow to the current agent contract, including webhook vs polling registration, advanced fields, and the removal of unsupported controls.
  - Keep the flow clean for normal users while preserving the advanced fields Mahilo still needs.
- **Acceptance Criteria**:
  - [ ] Registering a webhook connection works from the dashboard
  - [ ] Registering a polling connection works from the dashboard
  - [ ] Unsupported rotate-secret behavior is removed or replaced with a real supported action
  - [ ] Save/update states clearly reflect whether the connection was created or updated

- **Notes**:
  - 2026-03-14T15:32:55.709Z: DASH-031 completed via orchestrator integration.
### 3.3 Developer Console and API-Key Utilities
- **ID**: `DASH-032`
- **Status**: `done`
- **Priority**: `P1`
- **Depends on**: `DASH-010`, `DASH-031`
- **Description**:
  - Keep Developer as a real advanced surface for setup and debugging instead of treating it as disposable demo UI.
  - Preserve useful API-key, test-message, and diagnostics flows while removing or clearly isolating unsupported controls.
- **Acceptance Criteria**:
  - [ ] Developer exposes the current API key and related copy/regenerate flows that still exist on the backend
  - [ ] Test-message and connection diagnostics remain available behind a clearly advanced/developer framing
  - [ ] Unsupported or misleading developer controls are removed or clearly marked as unavailable
  - [ ] Developer can be reached intentionally from the dashboard without competing with primary user tasks

---

- **Notes**:
  - 2026-03-14T15:46:50.802Z: DASH-032 completed via orchestrator integration.
## Phase 4: Boundaries as the Primary Control Surface

### 4.1 Boundary Taxonomy and Canonical Policy Mapping
- **ID**: `DASH-040`
- **Status**: `done`
- **Priority**: `P0`
- **Depends on**: `DASH-010`
- **Description**:
  - Define a frontend boundary taxonomy that maps canonical policy records into user-facing categories, audiences, and effects.
  - At minimum cover recommendations/opinions, availability, location, health, financial, contact details, and generic messages.
- **Acceptance Criteria**:
  - [ ] There is a deterministic mapper from canonical policy records to user-facing boundary categories
  - [ ] `allow`, `ask`, and `deny` effects are surfaced directly in the UI model
  - [ ] Global, user, role, and group scopes are represented in user-facing language
  - [ ] Unmatched/custom selector combinations fall back to an explicit advanced path instead of disappearing

- **Notes**:
  - 2026-03-14T13:52:49.983Z: DASH-040 completed via orchestrator integration.
### 4.2 Boundaries Overview and Browsing Experience
- **ID**: `DASH-041`
- **Status**: `done`
- **Priority**: `P0`
- **Depends on**: `DASH-040`
- **Description**:
  - Replace the old Policies view with a Boundaries view that groups rules by category and audience, shows current effect and source, and makes the current privacy posture legible without JSON.
- **Acceptance Criteria**:
  - [ ] Users can browse boundaries by category and audience without reading raw policy content
  - [ ] Each boundary row or card shows effect, audience, source, and whether it is currently active
  - [ ] Default user-facing copy says "Boundaries" rather than "Policies"
  - [ ] Global/user/role/group filters remain available in a user-friendly form

- **Notes**:
  - 2026-03-14T14:05:34.540Z: DASH-041 completed via orchestrator integration.
### 4.3 Common Boundary Create/Edit Flows
- **ID**: `DASH-042`
- **Status**: `done`
- **Priority**: `P0`
- **Depends on**: `DASH-022`, `DASH-023`, `DASH-041`
- **Description**:
  - Implement create/edit flows for the common cases the product actually wants to expose.
  - Let users set boundaries by audience and category without raw JSON editing.
- **Acceptance Criteria**:
  - [ ] Users can create and edit common boundaries for global, contact, role, and group scopes
  - [ ] Common flows cover recommendations/opinions, availability, location, health/financial/contact-sensitive categories, and generic messaging
  - [ ] UI writes the canonical policy fields needed by the current backend contract
  - [ ] Raw JSON is not required for common boundary changes

- **Notes**:
  - 2026-03-14T14:58:36.583Z: DASH-042 completed via orchestrator integration.
### 4.4 Temporary Overrides, Lifecycle, and Provenance
- **ID**: `DASH-043`
- **Status**: `done`
- **Priority**: `P0`
- **Depends on**: `DASH-042`
- **Description**:
  - Surface the richer modern policy model: one-time approvals, expiring rules, effective windows, sources, derived-from-message links, and policy provenance/audit.
- **Acceptance Criteria**:
  - [ ] One-time and expiring overrides are visible in the Boundaries UX
  - [ ] Remaining uses, effective-from, and expires-at are displayed when present
  - [ ] Boundary/source provenance is visible, including user-created vs learned vs override states
  - [ ] A user can drill into provenance or audit for a specific boundary without leaving the dashboard

- **Notes**:
  - 2026-03-14T15:09:19.094Z: DASH-043 completed via orchestrator integration.
### 4.5 Advanced Canonical Policy Inspector
- **ID**: `DASH-044`
- **Status**: `done`
- **Priority**: `P1`
- **Depends on**: `DASH-041`
- **Description**:
  - Keep an advanced view for power users and debugging that exposes canonical policy details, selectors, evaluator, priority, and raw policy content without making that the default experience.
- **Acceptance Criteria**:
  - [ ] Advanced inspector lists canonical selector fields, evaluator, priority, and raw content
  - [ ] Unmatched/custom policies are still inspectable
  - [ ] The primary Boundaries surface remains uncluttered by advanced fields

- **Notes**:
  - 2026-03-14T15:50:43.731Z: DASH-044 completed via orchestrator integration.
### 4.6 Promotion Suggestions from Repeated Overrides
- **ID**: `DASH-045`
- **Status**: `pending`
- **Priority**: `P2`
- **Depends on**: `DASH-043`
- **Description**:
  - Surface `/api/v1/plugin/suggestions/promotions` as boundary-learning suggestions so repeated temporary decisions can be promoted into persistent boundaries.
- **Acceptance Criteria**:
  - [ ] Repeated-override suggestions are visible in the dashboard
  - [ ] Each suggestion links to a prefilled boundary create/edit flow or equivalent next action
  - [ ] Suggestions are clearly separated from already-enforced boundaries

---

## Phase 5: Delivery Logs, Reviews, and Ask-Around Signals

### 5.1 Delivery-Log and Activity Data Layer
- **ID**: `DASH-050`
- **Status**: `done`
- **Priority**: `P0`
- **Depends on**: `DASH-010`
- **Description**:
  - Create a unified audit model that normalizes message history, review queue, and blocked-event data into the delivery-log surface with consistent filters and correlations.
- **Acceptance Criteria**:
  - [ ] The audit model ingests `/api/v1/messages`, `/api/v1/plugin/reviews`, and `/api/v1/plugin/events/blocked`
  - [ ] Outbound/inbound, review, blocked, and delivered states can be filtered consistently
  - [ ] Delivery-log normalization preserves selectors, reason codes, correlation IDs, and timestamps

- **Notes**:
  - 2026-03-14T14:19:26.256Z: DASH-050 completed via orchestrator integration.
### 5.2 Review Queue and Blocked-Event UI Inside Delivery Logs
- **ID**: `DASH-051`
- **Status**: `done`
- **Priority**: `P0`
- **Depends on**: `DASH-050`
- **Description**:
  - Build the visible operational surface the current product docs promise.
  - Users should be able to inspect review-required and blocked items with enough context to understand what happened, while keeping Delivery Logs useful for transport auditing.
- **Acceptance Criteria**:
  - [ ] Review queue UI shows `review_required` and `approval_pending` states
  - [ ] Blocked-event UI shows reason code, summary, selectors, and audit excerpts
  - [ ] Delivery Logs surfaces sender/recipient context without exposing more raw internals than needed
  - [ ] Review and blocked states are visible from Delivery Logs and compact overview cues

- **Notes**:
  - 2026-03-14T14:29:06.592Z: DASH-051 completed via orchestrator integration.
### 5.3 Ask-Around and Delivery Timeline Signals
- **ID**: `DASH-052`
- **Status**: `pending`
- **Priority**: `P1`
- **Depends on**: `DASH-021`, `DASH-050`
- **Description**:
  - Make the web dashboard reflect the current Mahilo wedge, not just transport history.
  - Surface recent asks, attributed replies, waiting states, and explicit "no grounded answer" outcomes inside the delivery-log timeline and overview.
- **Acceptance Criteria**:
  - [ ] Delivery Logs and overview surfaces can distinguish recent ask-around style activity from generic sends
  - [ ] Explicit no-grounded-answer or no-reply states are visible instead of reading like silent failure
  - [ ] Recent activity makes it clear which contacts or groups were ready vs not ready when an ask went out
  - [ ] Correlation and reply context are visible enough to understand a multi-contact ask-around outcome

---

## Phase 6: Browser Access and Agent-Approved Sign-In

### 6.1 Invite-Only Browser Access Cleanup
- **ID**: `DASH-070`
- **Status**: `pending`
- **Priority**: `P1`
- **Depends on**: `DASH-002`
- **Description**:
  - Remove the stale self-serve browser registration path from the dashboard and landing-page auth journey.
  - Reframe browser access as invite-backed onboarding through the agent, with `Sign in with your agent` as the primary path and manual API-key entry as an advanced fallback.
- **Acceptance Criteria**:
  - [ ] No primary browser auth flow calls `/auth/register` directly
  - [ ] Landing/dashboard auth copy explains that account creation happens through an invited Mahilo agent, not self-serve browser registration
  - [ ] The browser auth surface distinguishes primary agent-approved sign-in from advanced API-key fallback
  - [ ] Stale register forms, modals, or CTA paths are removed from the normal user journey

### 6.2 Agent-Approved Browser Login Contract
- **ID**: `DASH-071`
- **Status**: `pending`
- **Priority**: `P1`
- **Depends on**: `DASH-070`
- **Description**:
  - Add a minimal browser-login contract that lets a browser start a short-lived login attempt and lets an already configured Mahilo agent approve it using existing authenticated Mahilo identity.
  - The browser should redeem an approved attempt into a real server session instead of storing a long-lived API key in local storage.
- **Acceptance Criteria**:
  - [ ] Browser can start a login attempt by username and receive an `attempt_id`, short approval code, and `expires_at`
  - [ ] An authenticated agent/plugin can approve a pending attempt for the correct Mahilo user
  - [ ] Browser can poll or subscribe to status and redeem an approved attempt exactly once
  - [ ] Redeem sets a production-safe browser session cookie (`HttpOnly`, `Secure`, `SameSite`) and replayed or expired attempts fail cleanly

### 6.3 Sign In With Agent UX
- **ID**: `DASH-072`
- **Status**: `pending`
- **Priority**: `P1`
- **Depends on**: `DASH-071`
- **Description**:
  - Build the landing/dashboard sign-in experience around the agent-approval flow.
  - The user should enter a username, see a short approval code plus instructions, and watch the browser move through pending, approved, expired, or denied states without ambiguity.
- **Acceptance Criteria**:
  - [ ] User can start browser sign-in by entering a Mahilo username
  - [ ] UI shows the approval code, expiry, and clear instructions to ask the configured agent to approve the login
  - [ ] Pending, approved, expired, denied, and retry states are legible without manual page refreshes
  - [ ] If no agent is configured or approval times out, the UI offers useful fallback guidance instead of a dead end

### 6.4 Session-Backed Dashboard Bootstrap and Logout
- **ID**: `DASH-073`
- **Status**: `pending`
- **Priority**: `P1`
- **Depends on**: `DASH-071`, `DASH-072`
- **Description**:
  - Make server-issued browser sessions the default way the dashboard boots after sign-in.
  - The browser should use cookie-backed auth for `/auth/me` and logout, while manual API-key login stays available only as an advanced fallback path.
- **Acceptance Criteria**:
  - [ ] Dashboard boot prefers a server session over a stored API key
  - [ ] An approved browser login survives refresh via cookie-backed `/auth/me`
  - [ ] Logout clears the server session and returns the UI to a clean signed-out state
  - [ ] Manual API-key login remains available only as an explicitly advanced path

### 6.5 Login Security, Rate Limits, and Diagnostics
- **ID**: `DASH-074`
- **Status**: `pending`
- **Priority**: `P2`
- **Depends on**: `DASH-071`, `DASH-073`
- **Description**:
  - Harden the browser login flow so it is safe to expose from the landing page.
  - Cover replay protection, expiry behavior, rate limits, and enough diagnostics that operators can understand why a login attempt failed.
- **Acceptance Criteria**:
  - [ ] Start, approve, redeem, and logout flows enforce explicit expiry and single-use semantics
  - [ ] Approval and redeem paths are rate-limited and return explicit failure states the UI can represent
  - [ ] Recent login-attempt diagnostics are visible from Developer or otherwise inspectable without digging through raw database state
  - [ ] Automated coverage or documented smoke steps exist for success, expiry, and denied/replayed login attempts

---

## Phase 7: Finish Activation

### 7.1 Copy, Empty States, and Responsive Polish
- **ID**: `DASH-060`
- **Status**: `pending`
- **Priority**: `P2`
- **Depends on**: `DASH-011`, `DASH-023`, `DASH-031`, `DASH-043`, `DASH-051`
- **Description**:
  - Do the final product polish pass once core surfaces work.
  - Align copy with the current Mahilo story and make the dashboard feel intentional on desktop and mobile.
- **Acceptance Criteria**:
  - [ ] Empty states use current product language: build your circle, sender connections, ask around, boundaries, review required
  - [ ] No primary page still reads like a demo or internal tool
  - [ ] Dashboard remains usable on both desktop and mobile widths
  - [ ] Visual hierarchy clearly emphasizes boundaries, network readiness, and review activity

### 7.2 Frontend Smoke Coverage and Regression Harness
- **ID**: `DASH-061`
- **Status**: `pending`
- **Priority**: `P1`
- **Depends on**: `DASH-043`, `DASH-051`
- **Description**:
  - Add lightweight automated coverage for the frontend logic that is easiest to regress: data normalization, boundary mapping, activity grouping, and auth/dashboard gating.
- **Acceptance Criteria**:
  - [ ] Normalization helpers have Vitest coverage
  - [ ] Boundary-mapping helpers have coverage for common and unmatched canonical policies
  - [ ] Activity grouping/review queue helpers have coverage for review, blocked, and delivered states
  - [ ] A documented smoke path exists for landing -> sign-in -> dashboard core views

### 7.3 Surface Dashboard Entry from the Landing Page
- **ID**: `DASH-090`
- **Status**: `pending`
- **Priority**: `P2`
- **Depends on**: `DASH-060`, `DASH-061`, `DASH-073`, `DASH-074`
- **Description**:
  - Once the dashboard and browser access path are product-ready, add the landing-page/dashboard activation hook so signed-in or invited users can actually reach it.
- **Acceptance Criteria**:
  - [ ] Landing page includes a dashboard entry point that matches current auth state
  - [ ] Signed-in users can reach the dashboard without manual local-storage hacks or URL spelunking
  - [ ] Signed-out invited users can start the primary sign-in flow from the landing page without seeing obsolete registration UI
  - [ ] The activation path does not regress the public landing or waitlist experience

---

## Recommended Execution Order

1. `DASH-001` -> `DASH-002` -> `DASH-010`
2. `DASH-020` -> `DASH-021` -> `DASH-022` -> `DASH-023`
3. `DASH-030` -> `DASH-031` -> `DASH-032`
4. `DASH-040` -> `DASH-041` -> `DASH-042` -> `DASH-043`
5. `DASH-050` -> `DASH-051` -> `DASH-052`
6. `DASH-011` -> `DASH-044` -> `DASH-045`
7. `DASH-070` -> `DASH-071` -> `DASH-072` -> `DASH-073` -> `DASH-074`
8. `DASH-060` -> `DASH-061` -> `DASH-090`

## Workflow Continuation

- This PRD should be included in the server workflow task sources so the orchestrator can pick it up directly.
- Treat this PRD as the active frontend/dashboard task source once the existing server PRD remains fully done.
- If a task uncovers a truly blocking contract gap, record the narrowest necessary backend follow-up instead of widening the frontend task silently.

## Scope Guardrails

- Do not migrate the dashboard to React, Vite, or another framework as part of this PRD.
- Do not block activation on global user discovery/search; exact-username invite flow is sufficient for this phase.
- Keep the plugin/server contract fixed unless a task explicitly identifies a frontend-blocking omission.
- Keep Developer tooling available as an advanced surface for API keys and diagnostics without letting it crowd out primary product workflows.
- Do not introduce password-based or generic email auth as part of this PRD; browser access should stay invite-backed with agent approval or advanced API-key fallback.

## Definition of Done

This PRD is complete when:

- the dashboard boots cleanly against current backend contracts
- network surfaces show relationship state, roles, interaction counts, and active connection readiness
- Boundaries are the primary control surface and represent lifecycle/provenance well
- Activity surfaces review-required, blocked, and ask-around outcomes clearly
- no dead-end core actions remain in the primary product path
- browser access is invite-only and supports session-backed sign-in with agent approval plus advanced API-key fallback
- overview makes Mahilo readiness legible at a glance
- the landing page can safely surface the dashboard
