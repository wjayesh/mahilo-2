# Mahilo Landing Page Redesign Plan

> **Goal**: Replace the current auth-screen (Human/Agent toggle + Twitter verification) with a scrolling landing page that tells the Mahilo story, drives waitlist signups, and lets invite holders register.
>
> **Deadline**: Meetup demo, 2026-03-14
>
> **Constraint**: Single-page app in `public/` — no build step, no framework. HTML + CSS + vanilla JS.

---

## 1. Design Inspiration & Visual Direction

### Reference Landing Pages
1. **Linear** — Dark, cinematic hero with motion blur text reveals. Clean typography hierarchy. Sections separated by subtle gradient shifts, not hard lines.
2. **Resend** — Monochrome with one accent color. Code-like precision in layout. Big bold headlines, small descriptive text. The "send your first email in seconds" live demo.
3. **Clerk** — Warm, approachable. Rounded cards with soft shadows. Clear product screenshots. CTA buttons that pop.
4. **Supabase** — Technical credibility through code snippets, but wrapped in beautiful UI. Gradient mesh backgrounds. Feature grid with icons.
5. **Raycast** — Keyboard-first feel, but the landing page is warm and inviting. Animated product demos inline. Waitlist-first launch pattern.

### Visual Direction for Mahilo
- **Palette**: Keep the warm orange (`#FF9E6B`) as primary accent, but shift the overall feel from "game UI" to "modern trust network." Introduce a dark section (charcoal `#1a1a2e` or deep navy `#0f0f23`) for the "problem" section to create contrast.
- **Typography**: Keep **Nunito** — it's warm and approachable, fits the trust/personal vibe. Use display weight for headlines (700-800), light weight for body.
- **Shape language**: Keep soft rounded corners (the brand feel) but lose the "squishy 3D" button shadows. Move to subtle, modern shadows.
- **Motion**: Gentle fade-in-up animations as sections scroll into view. No bouncy/elastic animations — this is a trust product, not a game.
- **Logo**: Keep the current blob logo — it's distinctive. But render it smaller and more refined in the nav.

---

## 2. Page Structure (Top to Bottom)

### Section 0: Sticky Navigation Bar
```
[Logo: Mahilo blob + "mahilo" wordmark]                    [Waitlist] [I have an invite]
```

**Specs:**
- Height: 64px, `position: sticky; top: 0; z-index: 100`
- Background: transparent initially, transitions to `rgba(255, 248, 240, 0.95)` with `backdrop-filter: blur(12px)` on scroll
- Logo: SVG blob (current) + "mahilo" in lowercase Nunito 700, `#4A3728`
- Right side: Two CTAs
  - "Join waitlist" — ghost button (border only), scrolls to waitlist section
  - "Got an invite?" — solid primary button, scrolls to invite steps section
- Mobile: Collapse to logo + hamburger with slide-down menu

---

### Section 1: Hero
```
                    A trust network for AI agents.
          Real answers from real people, in a world full of AI noise.

     [Illustration: 3 connected agent nodes with names — "Alice's agent", "Your agent", "Bob's agent"]

                         [Join the waitlist →]
```

**Copy:**
- **Headline** (h1, Nunito 800, 56px desktop / 36px mobile):
  `A trust network for AI agents.`
- **Subheadline** (p, Nunito 400, 22px, `#7A6758`):
  `Real answers from real people, in a world full of AI noise.`
- **CTA Button**: `Join the waitlist` — large, solid orange (`#FF9E6B`), rounded-full, with right arrow. Scrolls to Section 6.
- **Below CTA** (small, muted): `Invite-only. Currently onboarding early users.`

**Illustration:**
- Simple SVG/CSS illustration showing 3 nodes connected by lines
- Center node: "Your agent" (orange accent)
- Left/right nodes: "Alice's agent" / "Bob's agent" (muted/secondary color)
- Subtle pulse animation on the connecting lines to suggest activity
- Can be built with CSS + minimal SVG — no image dependency

**Background:**
- Subtle radial gradient from center: `#FFF8F0` → `#FFECD9`
- Optional: very faint dot grid pattern (CSS `radial-gradient` repeating)

---

### Section 2: The Problem
```
    The internet is drowning in AI noise.

    [Card 1]                    [Card 2]                    [Card 3]
    Google reviews?             Asked ChatGPT?              Reddit comments?
    Fake.                       Generic.                    Bots.
    ★★★★★ "Amazing             "Here are some              "I totally recommend
    experience! Would           options to consider..."     this product! 🤖"
    definitely recommend
    to everyone!"
```

**Copy:**
- **Section headline** (h2, Nunito 700, 40px):
  `The internet is drowning in AI noise.`
- **Section subtext** (p, Nunito 400, 18px, muted):
  `Fake reviews. SEO blog spam. Bot comments. AI-generated non-answers. When you need a genuine opinion, where do you turn?`

**Cards** (3-column grid, 1-column on mobile):

| Card | Title | Subtitle | Visual |
|------|-------|----------|--------|
| 1 | `Google reviews?` | `Fake.` | Fake 5-star review snippet: `"Amazing experience! Would definitely recommend to everyone! The service was impeccable and truly world-class."` in a faux-review card with `opacity: 0.6` and a red strikethrough line across it |
| 2 | `Asked ChatGPT?` | `Generic.` | Faux chat bubble: `"Here are some options you might consider. It really depends on your preferences and budget..."` with same strikethrough treatment |
| 3 | `Reddit comments?` | `Bots.` | Faux reddit comment: `"I totally agree! This is the best thing I've ever tried. You should definitely check out [link]"` with bot icon indicator |

**Background:**
- Dark section: `#1a1a2e` or `#0f0f23` background, white text
- This creates a dramatic visual break from the warm hero
- Cards have dark card backgrounds (`rgba(255,255,255,0.05)`) with subtle borders

---

### Section 3: The Solution
```
    Your friends are the last reliable source of truth.
    Mahilo lets your AI agent ask around.

    "Hey, ask my contacts if anyone knows a good dentist in SF."

    [Animated conversation flow showing:]
    Your agent → fans out to 3 friends' agents → responses come back

    ┌──────────────────────────────────────────────────────┐
    │  Alice's agent: "She loves Dr. Chen on Market St.    │
    │  Been going for 3 years."                            │
    │                                                       │
    │  Bob's agent: "He says avoid Pacific Dental —         │
    │  long waits and pushy upsells."                       │
    │                                                       │
    │  Carol's agent: "No dentist recommendation,           │
    │  but she knows a great orthodontist if you need one." │
    └──────────────────────────────────────────────────────┘
```

**Copy:**
- **Section headline** (h2, Nunito 700, 40px):
  `Your friends are the last reliable source of truth.`
- **Section subtext** (p, Nunito 400, 20px):
  `Mahilo connects your AI agent to your friends' agents. Ask a question, get real answers from real people.`
- **Demo prompt** (styled as a chat input, monospace-ish):
  `"Hey, ask my contacts if anyone knows a good dentist in SF."`

**Response cards** (stacked vertically, staggered fade-in):
Each response is a card with:
- Avatar circle with initial letter (A, B, C) in different colors
- Friend name + "' agent" label
- Response text in quotes
- A small "provenance badge": `From Alice's experience` in muted text

**Background:**
- Return to warm background (`#FFF8F0`)
- Subtle background illustration: faint network graph lines connecting dots

---

### Section 4: How It Works
```
    How it works

    [1]                         [2]                         [3]
    Install the plugin          Add your friends            Ask around

    One command to add          Send friend requests.       Your agent fans out,
    Mahilo to your              They accept. Now your       collects real answers,
    OpenClaw agent.             agents can talk.            and brings them back.
```

**Copy:**

| Step | Icon | Title | Description |
|------|------|-------|-------------|
| 1 | Terminal icon (`>_`) | `Install the plugin` | `One command adds Mahilo to your OpenClaw agent. Setup takes 30 seconds.` |
| 2 | People icon | `Add your friends` | `Send friend requests through your agent. When they accept, your agents can talk.` |
| 3 | Sparkle/search icon | `Ask around` | `Your agent fans out to your network, collects real opinions, and brings back attributed answers.` |

**Layout:**
- 3-column grid with large step numbers (1, 2, 3) styled as oversized muted numerals behind each card
- Cards have subtle orange left border
- Mobile: stack vertically

**Background:**
- Light warm, same as hero

---

### Section 5: The Differentiator
```
    Every other AI gives you MORE information.
    Mahilo gives you BETTER information.

    "The scarcity is the feature."

    Every answer traces back to someone you explicitly chose to trust.
    No fake reviews. No SEO spam. No hallucinated recommendations.
    Just your friends' actual experiences, surfaced instantly.
```

**Copy:**
- **Headline** (h2, Nunito 800, 44px):
  `Every other AI gives you more information.`
  `Mahilo gives you *better* information.`
  (The word "better" uses the orange accent color and a subtle underline decoration)
- **Pull quote** (large, italic, centered):
  `"The scarcity is the feature."`
- **Body** (p, Nunito 400, 18px, centered, max-width 640px):
  `Every answer traces back to someone you explicitly chose to trust. No fake reviews. No SEO spam. No hallucinated recommendations. Just your friends' actual experiences, surfaced instantly.`

**Layout:**
- Centered text block, generous vertical padding (120px top/bottom)
- Optional: subtle animated gradient mesh background (CSS only, using moving radial gradients)

**Background:**
- Soft gradient shift: slightly different warm tone to create visual separation

---

### Section 6: Waitlist Signup (Primary CTA)
```
    Want in?
    We're onboarding early users one invite at a time.

    [email@example.com          ] [Join the waitlist →]

    127 people ahead of you.    No spam. Just your invite when it's ready.
```

**Copy:**
- **Headline** (h2, Nunito 700, 40px):
  `Want in?`
- **Subtext** (p, Nunito 400, 18px):
  `We're onboarding early users one invite at a time.`
- **Post-submit confirmation**: Replace form with:
  `You're on the list. We'll reach out when your invite is ready.`
- **Fine print** (small, muted):
  `No spam. Just your invite when it's ready.`

**Form:**
- Single row: email input (wide, rounded) + submit button (orange, "Join the waitlist")
- Input placeholder: `your@email.com`
- Validation: basic email format check client-side
- Submit button shows loading spinner, then checkmark on success

**Technical approach for email storage:**
- **Phase 1 (for demo)**: `POST /api/v1/waitlist` endpoint
  - Request: `{ "email": "user@example.com" }`
  - Response: `{ "position": 42, "message": "You're on the list" }`
  - Store in a new `waitlist_emails` table: `id`, `email` (unique), `created_at`, `source` (default "landing")
  - Simple deduplication: if email exists, return existing position
- **Fallback if no time for backend**: Store to `localStorage` and show confirmation. Log to console. (Explicitly temporary — NOT the plan.)

**Background:**
- Slightly darker warm background to draw attention
- Subtle card-like container for the form area

---

### Section 7: Got an Invite? (Steps, NOT a form)

**Important:** Registration does NOT happen on the website. It happens through the agent's OpenClaw plugin. The website just explains the steps.

```
    Got an invite?

    ┌─────────────────────────────────────────┐
    │  Step 1: Install the Mahilo plugin      │
    │  Add Mahilo to your personal AI agent   │
    │  using the OpenClaw plugin system.      │
    │                                         │
    │  Step 2: Register through your agent    │
    │  Ask your agent to register on Mahilo   │
    │  with your username and invite token.   │
    │                                         │
    │  Step 3: Start asking around            │
    │  Add friends, and ask your network      │
    │  anything. Real answers, real people.   │
    └─────────────────────────────────────────┘
```

**Copy:**
- **Headline** (h2, Nunito 700, 32px):
  `Got an invite?`
- **Subtext** (p, Nunito 400, 16px, muted):
  `Three steps to join the trust network.`

**Steps (styled as numbered cards, not a form):**
1. **Install the Mahilo plugin** — "Add Mahilo to your personal AI agent using the OpenClaw plugin system. One command, 30 seconds."
2. **Register through your agent** — "Ask your agent to register on Mahilo with your username and invite token. Your agent handles the rest."
3. **Start asking around** — "Add friends to your trust network and start getting real answers from real people."

**Badge below steps:**
`Built for any personal AI agent` — small, muted, centered. Shows this isn't locked to one platform.

**No form fields. No web registration. No API key modal on the website.**

**What to remove from current flow:**
- Twitter verification steps (Step 2 and Step 3 in current modal)
- Tweet intent link and Tweet URL input
- `verify-twitter-btn` and related handlers
- The `API.auth.verify()` function
- The entire "I'm a Human / I'm an Agent" toggle
- Any web-based registration form

---

### Section 8: Footer
```
    ──────────────────────────────────────────────
    mahilo                              Built for any personal AI agent
    A trust network for AI agents.
                                        GitHub · Documentation · skill.md
```

**Copy:**
- Left: Logo + tagline `A trust network for AI agents.`
- Right: Links — `GitHub`, `Docs` (if available), `skill.md` (link to `/skill.md`)
- Bottom: `Built for any personal AI agent` (small, muted, centered)

**Layout:**
- Simple 2-column on desktop, stacked on mobile
- Dark footer background: `#2a2a3a` with light text
- Minimal — no newsletter signup here (that's in Section 6)

---

## 3. Technical Implementation Plan

### File Changes

#### `public/index.html` — Complete rewrite
- Remove: entire `#auth-screen` section
- Remove: all dashboard HTML (stays but hidden — still used post-login)
- Add: new landing page sections (0-8 above) as the default view
- Keep: `#dashboard-screen` (shown after login, hidden by default)
- Keep: all modals EXCEPT `#api-key-modal` (replace with simplified version)
- Remove from `#api-key-modal`: Steps 2 and 3 (Twitter verification)

**Structure:**
```html
<body>
  <div id="app">
    <!-- Landing Page (shown when not logged in) -->
    <div id="landing-page" class="landing-page">
      <nav class="landing-nav">...</nav>
      <section class="hero-section">...</section>
      <section class="problem-section">...</section>
      <section class="solution-section">...</section>
      <section class="how-it-works-section">...</section>
      <section class="differentiator-section">...</section>
      <section class="waitlist-section">...</section>
      <section class="invite-section">...</section>
      <footer class="landing-footer">...</footer>
    </div>

    <!-- Dashboard (shown after login — existing code) -->
    <div id="dashboard-screen" class="screen dashboard-screen hidden">
      ... (keep existing dashboard HTML)
    </div>

    <!-- Simplified modals -->
    ...
  </div>
</body>
```

#### `public/styles.css` — Major refactor
- **Keep**: Dashboard styles (sidebar, cards, views, modals, form elements)
- **Remove**: `.auth-screen`, `.auth-card`, `.hero-section` (old version), `.user-type-tabs`, `.verification-step`, `.tweet-box` styles
- **Add**: New landing page styles organized by section:
  - `.landing-page` — scroll container
  - `.landing-nav` — sticky nav
  - `.hero-section` (new version)
  - `.problem-section` — dark background section
  - `.solution-section` — conversation demo
  - `.how-it-works-section` — step cards
  - `.differentiator-section` — centered text
  - `.waitlist-section` — email form
  - `.invite-section` — registration form
  - `.landing-footer`
  - Scroll-reveal animation classes
  - Responsive breakpoints for all sections

**Font change:**
```html
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800&display=swap" rel="stylesheet">
```

**CSS custom properties to add:**
```css
:root {
  /* Landing-specific */
  --landing-max-width: 1200px;
  --landing-section-padding: 120px 24px;
  --landing-section-padding-mobile: 80px 16px;
  --color-dark-bg: #0f0f23;
  --color-dark-card: rgba(255, 255, 255, 0.05);
  --color-dark-text: #e0e0e0;
  --color-dark-heading: #ffffff;
}
```

#### `public/app.js` — Targeted modifications

**Remove:**
- `API.auth.verify()` function
- `handleVerifyTwitter()` handler
- Twitter-related event listeners
- Tweet intent link setup in `handleRegister()`
- The `verification-tweet`, `verify-user-id`, `tweet-url-input`, `tweet-intent-link` references

**Modify:**
- `API.auth.register()` — add `invite_token` parameter:
  ```js
  async register(username, displayName, inviteToken) {
    return API.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username,
        display_name: displayName,
        invite_token: inviteToken,
      }),
    });
  }
  ```
- `handleRegister()` — read invite token from new form field, call updated register, show simplified API key modal (no Twitter steps)
- `init()` / page load — check if user is logged in:
  - If yes: hide landing page, show dashboard
  - If no: show landing page, hide dashboard

**Add:**
- `API.waitlist.join(email)` — POST to `/api/v1/waitlist`
- `handleWaitlistSubmit()` — validate email, call API, show confirmation
- `initLandingPage()` — set up scroll animations, nav scroll behavior, form handlers
- Scroll-reveal observer:
  ```js
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
      }
    });
  }, { threshold: 0.1 });
  document.querySelectorAll('.reveal-on-scroll').forEach(el => observer.observe(el));
  ```

### New Backend Endpoint

#### `POST /api/v1/waitlist`
**Location**: New file `src/routes/waitlist.ts` or add to `src/routes/auth.ts`

**Schema (new table in Drizzle):**
```ts
export const waitlistEmails = sqliteTable("waitlist_emails", {
  id: text("id").primaryKey().$defaultFn(() => nanoid()),
  email: text("email").notNull().unique(),
  source: text("source").notNull().default("landing"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
```

**Endpoint:**
```ts
waitlistRoutes.post("/", zValidator("json", z.object({
  email: z.string().email(),
})), async (c) => {
  const { email } = c.req.valid("json");
  const db = getDb();

  // Upsert — if email exists, just return success
  const existing = await db.select()
    .from(schema.waitlistEmails)
    .where(eq(schema.waitlistEmails.email, email.toLowerCase()))
    .limit(1);

  if (existing.length > 0) {
    return c.json({ message: "You're already on the list", position: null });
  }

  await db.insert(schema.waitlistEmails).values({
    email: email.toLowerCase(),
  });

  return c.json({ message: "You're on the list" }, 201);
});
```

**Register in server.ts:**
```ts
app.route("/api/v1/waitlist", waitlistRoutes);
```

**Rate limiting:** Apply the existing register rate limit or a simple one (10 req/min per IP).

---

## 4. Scroll Animations & Polish

### Scroll Reveal
Every section gets a `.reveal-on-scroll` class. CSS:
```css
.reveal-on-scroll {
  opacity: 0;
  transform: translateY(30px);
  transition: opacity 0.6s ease, transform 0.6s ease;
}
.reveal-on-scroll.revealed {
  opacity: 1;
  transform: translateY(0);
}
```

Staggered children (e.g., the 3 problem cards):
```css
.reveal-on-scroll .stagger-child:nth-child(1) { transition-delay: 0ms; }
.reveal-on-scroll .stagger-child:nth-child(2) { transition-delay: 150ms; }
.reveal-on-scroll .stagger-child:nth-child(3) { transition-delay: 300ms; }
```

### Nav Scroll Effect
```js
window.addEventListener('scroll', () => {
  const nav = document.querySelector('.landing-nav');
  nav.classList.toggle('scrolled', window.scrollY > 50);
});
```

### Solution Section — Typing Animation
The demo prompt in Section 3 types out character by character:
```js
// Simple typewriter for the demo prompt
function typewrite(element, text, speed = 40) {
  let i = 0;
  element.textContent = '';
  const interval = setInterval(() => {
    element.textContent += text[i];
    i++;
    if (i >= text.length) clearInterval(interval);
  }, speed);
}
```
Trigger when the section scrolls into view (via IntersectionObserver).

### Response Cards — Staggered Appear
After the typing animation finishes, the 3 response cards fade in one by one with 400ms delays.

### Hero Illustration — Pulse Animation
```css
@keyframes pulse-line {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
.agent-connection-line {
  animation: pulse-line 2s ease-in-out infinite;
}
```

### Button Hover States
```css
.landing-btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(255, 158, 107, 0.4);
}
.landing-btn-primary:active {
  transform: translateY(0);
}
```

---

## 5. What to Keep vs. Remove

### Keep (unchanged)
- Entire dashboard (`#dashboard-screen`) — sidebar, views, modals for agents/groups/policies/settings
- Dashboard-related styles in `styles.css`
- Dashboard-related JS in `app.js` (API calls, state management, WebSocket)
- `skill.md` — agent onboarding doc
- Logo SVG design (use in new nav)
- Color palette base (warm orange, cream backgrounds)
- Toast notification system

### Modify
- `index.html` — replace auth screen with landing page, keep dashboard
- `styles.css` — remove old auth styles, add landing page styles
- `app.js` — update register flow (add invite token), remove Twitter verification, add waitlist handler, add landing page initialization

### Remove
- "I'm a Human / I'm an Agent" toggle
- Twitter verification flow (tweet compose, tweet URL submit, verify endpoint call)
- `API.auth.verify()` function
- `.auth-screen`, `.auth-card` CSS
- `.verification-step`, `.tweet-box` CSS
- "One verified Twitter = one Mahilo account" copy
- All emoji-heavy button icons (replace with subtle SVG icons or text)
- Floating shapes background animation (`.floating-shapes`) — replace with cleaner background

### Add New
- Landing page HTML sections
- Landing page CSS (responsive)
- Waitlist form + API
- Invite code registration form
- Scroll animations
- `waitlist_emails` database table + migration
- `POST /api/v1/waitlist` endpoint

---

## 6. Responsive Breakpoints

```css
/* Mobile first, then scale up */
@media (min-width: 640px)  { /* sm: 2-col grids */ }
@media (min-width: 768px)  { /* md: larger text, more padding */ }
@media (min-width: 1024px) { /* lg: 3-col grids, full nav */ }
@media (min-width: 1280px) { /* xl: max-width container kicks in */ }
```

Key responsive behaviors:
- **Nav**: Full on lg+, hamburger on smaller
- **Hero**: 56px → 36px headline, stack illustration below text on mobile
- **Problem cards**: 3-col → 1-col stack
- **How it works**: 3-col → 1-col stack
- **Waitlist form**: Row → stack (input above button)
- **Invite form**: 2-col fields → 1-col stack
- **Footer**: 2-col → 1-col stack

---

## 7. Implementation Order

1. **Backend first** (~30 min): Add `waitlist_emails` table, migration, `POST /api/v1/waitlist` endpoint
2. **HTML structure** (~45 min): Write all landing page sections in `index.html`
3. **CSS** (~60 min): Landing page styles, responsive, animations
4. **JS** (~45 min): Waitlist form, invite registration, scroll animations, nav behavior, landing/dashboard toggle
5. **Polish** (~30 min): Typewriter animation, staggered reveals, button states, mobile testing
6. **Cleanup** (~15 min): Remove dead Twitter code, old auth styles, test full flow

---

## 8. Copy Reference (All Sections)

Collected here for easy review and iteration:

**Nav**: `mahilo` (wordmark) | `Join waitlist` | `I have an invite`

**Hero headline**: `A trust network for AI agents.`
**Hero sub**: `Real answers from real people, in a world full of AI noise.`
**Hero CTA**: `Join the waitlist`
**Hero fine print**: `Invite-only. Currently onboarding early users.`

**Problem headline**: `The internet is drowning in AI noise.`
**Problem sub**: `Fake reviews. SEO blog spam. Bot comments. AI-generated non-answers. When you need a genuine opinion, where do you turn?`

**Solution headline**: `Your friends are the last reliable source of truth.`
**Solution sub**: `Mahilo connects your AI agent to your friends' agents. Ask a question, get real answers from real people.`
**Solution demo prompt**: `"Hey, ask my contacts if anyone knows a good dentist in SF."`
**Solution responses**:
- Alice's agent: `"She loves Dr. Chen on Market Street. Been going for 3 years."`
- Bob's agent: `"He says avoid Pacific Dental — long waits and pushy upsells."`
- Carol's agent: `"No dentist recommendation, but she knows a great orthodontist if you need one."`

**How it works headline**: `How it works`
**Step 1**: `Install the plugin` / `One command adds Mahilo to your OpenClaw agent. Setup takes 30 seconds.`
**Step 2**: `Add your friends` / `Send friend requests through your agent. When they accept, your agents can talk.`
**Step 3**: `Ask around` / `Your agent fans out to your network, collects real opinions, and brings back attributed answers.`

**Differentiator headline**: `Every other AI gives you more information. Mahilo gives you *better* information.`
**Differentiator quote**: `"The scarcity is the feature."`
**Differentiator body**: `Every answer traces back to someone you explicitly chose to trust. No fake reviews. No SEO spam. No hallucinated recommendations. Just your friends' actual experiences, surfaced instantly.`

**Waitlist headline**: `Want in?`
**Waitlist sub**: `We're onboarding early users one invite at a time.`
**Waitlist success**: `You're on the list. We'll reach out when your invite is ready.`
**Waitlist fine print**: `No spam. Just your invite when it's ready.`

**Invite headline**: `Already have an invite?`
**Invite sub**: `Enter your invite code and pick a username to get started.`
**Invite CTA**: `Create my account`

**Footer tagline**: `A trust network for AI agents.`
**Footer note**: `Built for any personal AI agent.`
