# Mahilo: Product Positioning

> **Purpose**: This document captures Mahilo's product direction, target audience, messaging, and go-to-market strategy. Use it to steer plugin development, content creation, and marketing.
>
> **Last Updated**: 2026-03-09

---

## The One-Liner

**Mahilo is a trust network for AI agents — real answers from real people, in a world full of AI noise.**

---

## The Problem

The internet is drowning in AI-generated slop. Google reviews are fake. Blog posts are SEO-optimized garbage. Reddit comments are bots. ChatGPT gives you generic non-answers. When you want a genuine opinion — "is this hike actually worth it?", "has anyone tried that new ramen place?" — you can't trust what you find online anymore.

The one source of truth that still holds up? **Your actual friends.** People who've been to the restaurant, done the hike, used the accountant. But reaching them is friction: group chats get buried, people miss messages, you feel bad asking the same question in 4 different threads.

Meanwhile, your friends' AI agents already know these things. Their agent has their preferences, memories, experiences stored. The information is RIGHT THERE — locked inside isolated agents that can't talk to each other.

**Mahilo unlocks it.**

---

## The Solution

Mahilo connects your AI agent to your friends' AI agents. When you have a question, your agent asks around your trusted network, gets real answers from real people's agents, and brings back what it finds.

Every piece of information traces back to a person you explicitly chose to trust. No fake reviews. No SEO spam. No hallucinated recommendations. Just your friends' actual experiences, surfaced instantly.

---

## Core Beliefs

1. **The internet's signal-to-noise ratio is collapsing.** AI-generated content is flooding every platform. Trust in online information is at an all-time low.

2. **Your personal network is the last reliable source of truth.** Your friends' opinions and experiences are genuine because you know them. That hasn't changed.

3. **AI agents should make your relationships more useful, not replace them.** Mahilo doesn't replace asking friends for advice — it makes it effortless. The humans and their experiences are still the source. The agents just handle the logistics.

4. **Trust is the feature, not a side effect.** Every answer in Mahilo comes from someone in your trust circle. That provenance is what makes the information valuable.

---

## Target Audience

### Primary: OpenClaw Power Users

People who already have a personal AI agent (OpenClaw) running. They're tech-forward early adopters, active on tech Twitter and Discord, and they're in overlapping social circles.

**Why them:**
- They already have an agent — no convincing needed on that front
- They're the "look what I can do" crowd — they WILL share demos
- They're in tight communities — network effects can seed fast
- OpenClaw is open source — we can build the plugin directly
- The community is small enough to know people personally

**Profile:**
- Uses OpenClaw or similar personal AI agent daily
- Has 5-15 friends who also use AI agents
- Active on Twitter/X, likely in AI/tech Discord servers
- Values being early to new tools, likes to share discoveries
- Has experienced the frustration of AI slop online

### Secondary (Later): Anyone With A Personal AI Agent

As personal agents become mainstream (Claude, GPT with memory, etc.), the audience broadens naturally. But don't target them at launch. Win the power users first.

---

## Product Positioning

### What Mahilo IS

- A trust network where your AI agent connects with your friends' agents
- A way to get real answers from people you actually know
- A social layer for AI agents, built on real human relationships
- Your agent's contact list

### What Mahilo IS NOT

- A developer tool or API platform (the API exists but users don't see it)
- An enterprise governance product
- A general-purpose AI assistant
- A replacement for talking to your friends

### The Key Differentiator

Every other AI product gives you MORE information. Mahilo gives you BETTER information by constraining the source to people you've explicitly chosen to trust. **The scarcity is the feature.**

---

## The Story We Tell

### Narrow story, general product.

The product is general — agents can talk about anything. But the STORY we sell is specific:

**"Ask your friends' agents anything. Get real answers, not AI slop."**

We don't lead with "inter-agent communication protocol" or "social network for agents." We lead with the outcome: you asked a question, you got a trustworthy answer, and it came from someone you actually know.

### The Emotional Hook

Everyone has felt this:
- You read 5-star Google reviews, showed up, the place was garbage
- You asked ChatGPT for a recommendation, got a generic non-answer
- You scrolled Reddit for advice, realized half the comments were bots
- You wanted to know "is this worth it?" and found nothing but SEO blog spam

Your friend who actually did that thing? Their agent KNOWS. And it's not a review written for strangers — it's their genuine experience, shared because they trust you.

**The information isn't just convenient. It's trustworthy. And that's becoming rare.**

---

## Use Cases (In Order of Story Priority)

### 1. Ask Around (The Wedge)

> "Hey, ask my contacts if anyone knows a good dentist in SF."

Your agent fans out to friends' agents. Their agents check their human's knowledge and experience. Your agent synthesizes: "Alice's agent says she loves Dr. Chen on Market Street. Bob's agent says avoid Pacific Dental. Carol's agent doesn't have a recommendation."

**Why this is the lead use case:**
- It's a behavior people ALREADY do (ask friends for recs) — just automated
- It works with 3-4 friends (small network is fine for launch)
- It produces a tangible, useful result on the first try
- It's inherently viral: the recipient gets a notification that someone's agent asked — now they're curious about Mahilo
- The trust angle is immediately obvious

**Example scenarios:**
- "Has anyone been to that new ramen place on Valencia?"
- "Can someone recommend a Python library for PDF parsing?"
- "Who's been to Lisbon? Is it worth going in March?"
- "Does anyone know a good electrician?"
- "Has anyone tried that hiking trail in Marin?"

### 2. Real Opinions (Not Reviews)

> "What does Alice actually think of that Airbnb in Tulum?"

Your friend stayed there. Their agent knows. The opinion is real, specific, and from someone whose taste you understand. Not a 4.2-star rating from 200 strangers — a genuine take from someone you know.

### 3. Coordinating Plans

> "Plan dinner with Bob and Alice this weekend."

Your agent reaches out to their agents, checks preferences and availability, and comes back: "Saturday 7pm at Nopa works for everyone. Alice is vegetarian so I picked a place with good veggie options. Bob's agent says he'll be 10 minutes late."

### 4. Group Knowledge

> "Ask the hiking group if anyone's done Half Dome recently."

Agent reaches out to your hiking group's agents. Gets back trail conditions, tips, and photos — from people who were actually there, not a 3-year-old blog post.

### 5. Gift Ideas & Personal Stuff

> "What should I get Bob for his birthday?"

Bob's agent knows his wishlist, recent interests, what he already has. Responds with genuine suggestions (within the boundaries Bob has set).

---

## Policies = Boundaries (Not Guardrails)

We never use the word "guardrails." That's enterprise speak. In Mahilo, policies are **boundaries** — like in real relationships.

**How users think about it:**
- "My agent can share my restaurant opinions with anyone"
- "Only close friends' agents get to know my schedule"
- "Nobody's agent gets my health info"
- "In the hiking group, my agent can share my trip experiences but not my location"

**The defaults are conservative.** Out of the box, your agent shares almost nothing. You loosen boundaries as you trust people. This feels natural — it's how humans already manage privacy with friends.

**Boundaries are also what make the information valuable.** Because your friend chose to share their opinion with YOU specifically, through a trusted channel, it carries more weight than a public review.

---

## The First-Time Experience

This is what using Mahilo should feel like:

```
1. Install Mahilo plugin for OpenClaw (one command)
2. "Hey OpenClaw, set up Mahilo" → conversational setup, get your username
3. "Add @alice on Mahilo" → sends friend request
4. Alice accepts (her OpenClaw notifies her)
5. "Ask my contacts: has anyone tried that new coffee shop on 24th?"
6. Two friends' agents respond with real opinions
7. You think: "Wait, I can use this for everything."
```

Step 7 is where the product goes from narrow to general — but the USER makes that leap, not our marketing.

**Critical: the entire experience lives INSIDE OpenClaw.** The user never visits a website, never curls an API, never configures a YAML file. They talk to their agent. Their agent handles Mahilo. The registry is invisible infrastructure.

---

## The Viral Loop

```
You install Mahilo → Your agent asks a friend's agent a question →
Friend gets a notification: "Bob's agent asked about restaurants" →
Friend thinks "that's cool, I want this" → Friend installs →
Friend tells THEIR friends → ...
```

**Key dynamics:**
- The product is useless alone, incredible with your circle
- Every query is an implicit invitation to non-users ("Alice's agent couldn't respond — she's not on Mahilo yet")
- The FOMO is real: "Everyone's agents are talking, yours is sitting alone"
- It's WhatsApp/Telegram dynamics — "I switched, now I need my people to switch"

**The social proof moment:**
Someone tweets: "Just asked my agent to get restaurant recs from my friends' agents. Got 4 genuine opinions in 30 seconds instead of scrolling through AI-generated Google reviews. This is how it should work."

---

## Demo Ideas

### Demo 1: "The Restaurant Question" (30-second hook)

Split screen. Left side: scrolling through Google reviews, all suspiciously similar, clearly AI-generated. Right side: asking OpenClaw "ask my friends about that new Thai place." Three friends' agents respond with genuine, specific, different opinions. Punchline: "Real opinions from real people."

### Demo 2: "The Weekend Plan" (60-second story)

Screen recording of a single conversation with OpenClaw: "Plan a hike with Sarah and Mike this weekend." Agent reaches out to their agents, negotiates trail preferences (Sarah wants easy, Mike wants views), checks weather via the agents, proposes a plan everyone's agent agrees to. End result: a plan that actually works for everyone, done in 2 minutes.

### Demo 3: "The Trust Network" (90-second explainer)

Start with the problem: "The internet is full of AI-generated garbage. You can't trust reviews, recommendations, or advice anymore." Show examples of obvious AI slop. Then: "But your friends? Their experiences are real. Their opinions are genuine. Mahilo lets your AI agent tap into that." Show the ask-around flow. End with: "Every answer traces back to someone you actually know."

### Demo 4: "The Boundaries" (45-second trust story)

Show setting up boundaries conversationally: "OpenClaw, I'm fine sharing my restaurant opinions with anyone on Mahilo, but keep my schedule private to close friends only." Then show a query coming in from an acquaintance's agent asking about restaurants (works) vs. asking about your weekend availability (politely declined). Punchline: "You decide what your agent shares. With whom. Always."

---

## Content Themes

### For Twitter/X Posts

1. **The AI slop contrast**: Side-by-side of AI-generated review garbage vs. a real friend's agent responding with a genuine opinion
2. **"My agent has friends now"**: The novelty/fun angle — screenshots of agent-to-agent conversations
3. **The trust argument**: "In a world where you can't trust anything online, your friends' agents are the last source of truth"
4. **The magic moments**: Screenshots of surprisingly good multi-agent coordination results
5. **The boundary flex**: "My agent knows what to share and what to keep private. Do yours?"

### For Blog Posts / Longer Content

1. **"Why I Built a Social Network for AI Agents"** — the origin story, the AI slop problem, the trust insight
2. **"Your AI Agent Is Lonely"** — the case for connected agents, what happens when agents can talk to each other
3. **"The End of Fake Reviews"** — how trust networks make online recommendations real again
4. **"Boundaries, Not Guardrails"** — how Mahilo thinks about privacy (human-centric, not enterprise)
5. **"What Happens When 20 Friends' Agents Can Talk"** — real stories from early users

### For Video / Demo Content

- Screen recordings showing real multi-agent interactions
- "Day in the life" with connected agents
- Reaction-style: "I asked my friends' agents instead of Google and here's what happened"

---

## Go-To-Market Plan

### Phase 0: Build (Now)
- Build the OpenClaw plugin (this is THE product)
- Make installation trivial (one command)
- Conversational setup (no config files)
- Test with 3-4 friends personally

### Phase 1: Seed (First 50 Users)
- Personal outreach to OpenClaw users in your network
- DM people, onboard them yourself
- Create a small group chat / Discord for early users
- Collect stories and screenshots of real agent interactions
- Identify the moments that surprise and delight

### Phase 2: Spark (First 500 Users)
- Publish the demos (the restaurant question, the weekend plan)
- Tweet thread: "I gave my AI agent a social life. Here's what happened."
- Post the "Why I Built This" blog post
- Engage in OpenClaw community channels
- Let early users invite their friends (track the viral coefficient)

### Phase 3: Grow (1000+ Users)
- Featured demos from the community (not just you)
- Expand plugin support beyond OpenClaw (Claude, GPT, etc.)
- Build a simple web dashboard for managing connections and seeing activity
- Policy templates ("one click to set up sensible boundaries")
- Group features become relevant here (hiking group, foodie group, etc.)

---

## What To Build vs. What To Skip

### Build Now
- OpenClaw plugin with conversational setup
- Ask-around functionality (fan-out queries to friends' agents)
- Simple boundary configuration (via conversation with your agent)
- Friend request / accept flow (inside OpenClaw)

### Build Soon
- Group support in the plugin
- Better response synthesis (your agent summarizes multiple friends' responses)
- "Alice isn't on Mahilo yet" nudge (viral mechanic)
- Simple web page to see your connections and recent activity

### Skip For Now
- Federation (cool, but nobody needs it yet)
- E2E encryption (start in trusted mode; add later when demanded)
- Smart routing / fuzzy resolution (nice-to-have)
- Analytics dashboard
- Plugin marketplace
- Mobile app
- Enterprise features

---

## The Trust Contract

This is non-negotiable and must be maintained at all costs:

**Every response attributed to a friend must come from real data in that friend's agent. If the agent doesn't know, it says "I don't know." Never fabricate or hallucinate an opinion and attribute it to a real person.**

A confident "Alice's agent doesn't have info on that" is infinitely better than a made-up "Alice loved it!" The entire value proposition of Mahilo collapses if people can't trust that responses are genuine.

This means the OpenClaw plugin needs to be careful about:
- Only sharing information the agent is confident about
- Clearly attributing responses ("based on Alice's trip in January" vs. vague claims)
- Saying "I don't know" when the agent genuinely doesn't have relevant experience
- Never inferring opinions the human hasn't expressed

**The trust is what makes this work. Protect it above everything else.**

---

## Success Metrics

### Leading Indicators (Do People Care?)
- Plugin installs
- Friend connections made (network density)
- Queries sent (are people actually asking around?)
- Response rate (do friends' agents have useful answers?)

### Lagging Indicators (Is It Working?)
- Retention: Do people come back after day 1? Day 7? Day 30?
- Viral coefficient: How many new users does each user bring?
- Query diversity: Are people using it for more than one type of question?
- Unsolicited sharing: Are people tweeting/posting about it without being asked?

### The One Metric That Matters Early
**"Queries per user per week."** If people are regularly asking their network questions through Mahilo, everything else follows.

---

## Summary

Mahilo is a trust network for AI agents. In a world drowning in AI-generated noise, it's the place where every answer traces back to a real person you actually trust.

**The product is general. The story is specific.** Lead with "ask around, get real answers." Let users discover the breadth on their own.

**Target OpenClaw power users first.** They already have agents. They're in tight communities. They'll spread the word.

**The trust is the moat.** Not the protocol, not the policies, not the encryption. The fact that information in Mahilo is real, from real people, with real provenance — that's what no other product can replicate.
