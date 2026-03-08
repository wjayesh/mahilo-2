# Mahilo Architecture Analysis: Server-Only vs Server+Plugin

## Executive Summary

This document analyzes two deployment architectures for Mahilo:
1. **Server-Only**: Agents interact directly with the registry via HTTP/SKILL.md
2. **Server+Plugin**: Agents use the Mahilo SDK/plugin for richer integration

**Key Insight**: The plugin model provides stronger privacy guarantees and richer features, but creates adoption friction. The server-only model is easier to adopt but centralizes more control (and data visibility) at the server.

---

## Architecture Comparison

### Server-Only Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    AGENT (Any Framework)                    │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                    SKILL.md                           │  │
│  │  - HTTP calls to registry API                         │  │
│  │  - API key management (stored in env)                 │  │
│  │  - Message send/receive instructions                  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP/WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     MAHILO REGISTRY                         │
│                                                             │
│  - Authentication          - Message routing                │
│  - Friendship management   - Policy enforcement (server)    │
│  - Message storage         - Delivery & retries             │
│  - Groups (Phase 2+)       - Notifications                  │
└─────────────────────────────────────────────────────────────┘
```

### Server+Plugin Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    AGENT (Framework X)                      │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  MAHILO PLUGIN/SDK                    │  │
│  │                                                       │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  │  │
│  │  │ Framework   │  │ Local       │  │ E2E          │  │  │
│  │  │ Adapter     │  │ Policies    │  │ Encryption   │  │  │
│  │  └─────────────┘  └─────────────┘  └──────────────┘  │  │
│  │                                                       │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  │  │
│  │  │ Session     │  │ Message     │  │ can_contact  │  │  │
│  │  │ Management  │  │ Storage     │  │ ACLs         │  │  │
│  │  └─────────────┘  └─────────────┘  └──────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP (encrypted payloads)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     MAHILO REGISTRY                         │
│                                                             │
│  - Authentication          - Message routing                │
│  - Friendship management   - Policy storage (optional)      │
│  - Ciphertext routing      - Delivery & retries             │
│  - Groups (Phase 2+)       - Notifications                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Detailed Feature Comparison

| Feature | Server-Only | Server+Plugin | Notes |
|---------|-------------|---------------|-------|
| **Setup Complexity** | Low (copy SKILL.md) | Medium (pip install + config) | Server-only wins on adoption |
| **Framework Lock-in** | None (HTTP only) | Adapters available | Plugin provides deeper integration |
| **Policy Enforcement** | Server-side only | Local + Server | Plugin can block before network |
| **Data Privacy** | Server sees plaintext | E2E encryption possible | Critical for sensitive agents |
| **Latency (policy)** | Network round-trip | Local (instant) | Plugin faster for policy checks |
| **Session Management** | Agent's responsibility | Built-in | Plugin handles state |
| **Message History** | Server-only | Local + Server | Plugin has offline access |
| **Voice Support** | Not available | Built-in | Plugin exclusive feature |
| **Offline Operation** | Not possible | Partial (local queue) | Plugin more resilient |
| **can_contact ACLs** | Not enforced | Enforced locally | Plugin prevents accidental leaks |

---

## Pros and Cons Analysis

### Server-Only Architecture

#### Pros

1. **Zero Installation Barrier**
   - Just add SKILL.md to agent's context
   - Works with ANY agent that can make HTTP calls
   - No dependency management headaches
   - Lower barrier to adoption = faster growth

2. **Simpler Mental Model**
   - One component to understand
   - Standard REST API patterns
   - Easy to debug (just HTTP calls)
   - Works with any language/framework

3. **Centralized Control**
   - All policies evaluated consistently at server
   - Single source of truth for message state
   - Easier to audit and monitor
   - Uniform enforcement across all agents

4. **Maintenance Simplicity**
   - Only one codebase to update
   - No version compatibility issues between plugin/server
   - Faster iteration on features

#### Cons

1. **Privacy Concerns (Critical)**
   - Server sees ALL message content in plaintext
   - Policies evaluated on server = server reads messages
   - Trust model: users must trust the registry operator
   - Problematic for enterprise/sensitive use cases

2. **Performance Penalty**
   - Every policy check requires network round-trip
   - No local caching of policies
   - Higher latency for real-time agent conversations

3. **Reduced Functionality**
   - No E2E encryption (server must read messages)
   - No local message history
   - No voice support
   - No offline capabilities
   - No framework-specific optimizations

4. **Single Point of Failure**
   - If server is down, no communication
   - Network issues = complete outage
   - No graceful degradation

5. **No Local Access Control**
   - can_contact lists can't be enforced locally
   - Agent might accidentally try to contact unauthorized agents
   - Error only surfaces after network call

---

### Server+Plugin Architecture

#### Pros

1. **Privacy-First Design**
   - E2E encryption: server only routes ciphertext
   - Local policy evaluation: sensitive checks happen on-device
   - Users control their data
   - Enterprise-friendly privacy guarantees

2. **Performance**
   - Local policy checks are instant (no network)
   - Local message caching
   - Reduced server load
   - Better for real-time conversations

3. **Richer Features**
   - Voice streaming support
   - Framework-specific adapters (LangGraph, PydanticAI)
   - Session management built-in
   - Local message history and search
   - Offline message queueing

4. **Resilience**
   - Operates partially offline
   - Local state survives server outages
   - Graceful degradation

5. **Fine-Grained Control**
   - can_contact enforced locally
   - Per-agent policy customization
   - Agent decides what leaves the device

#### Cons

1. **Installation Friction**
   - Requires pip install (or npm/cargo for other SDKs)
   - Dependency conflicts possible
   - Different versions across agents can cause issues
   - Harder to onboard new users

2. **Complexity**
   - Two components to understand and debug
   - Distributed state (local + server)
   - More failure modes
   - Harder to reason about message flow

3. **Maintenance Burden**
   - Two codebases to maintain
   - Version compatibility between plugin and server
   - Need SDKs for multiple languages/frameworks
   - Slower feature rollouts (need plugin updates)

4. **Inconsistent Enforcement**
   - Policies are evaluated locally = old plugin = old policies
   - Users can disable/bypass local checks
   - Harder to guarantee uniform behavior

---

## The Vision Question

### What is Mahilo Trying to Be?

Based on the design docs, Mahilo's vision is:

> A **trusted inter-agent communication protocol** that enables AI agents from different users and frameworks to communicate securely.

Key words: **trusted**, **secure**, **different users**.

This implies:
1. Privacy matters (different users = don't trust each other)
2. Security matters (trusted = cryptographic guarantees)
3. Interoperability matters (different frameworks)

### Does Server-Only Preserve the Vision?

| Vision Element | Server-Only | Assessment |
|----------------|-------------|------------|
| **Trusted** | Requires trusting registry operator | Partial - centralizes trust |
| **Secure** | No E2E encryption possible | Weakened - server sees plaintext |
| **Different users** | Works for any user | Preserved |
| **Different frameworks** | HTTP works everywhere | Preserved |

**Verdict**: Server-only trades privacy/security for ease of adoption. This may be acceptable for:
- Early-stage adoption where trust isn't critical
- Intra-organization communication (same trust domain)
- Non-sensitive agent conversations

But problematic for:
- Cross-organization communication
- Agents handling sensitive data
- Enterprise deployments with compliance requirements

---

## Hybrid Approach: Best of Both Worlds?

### Option A: Tiered Architecture

```
TIER 1 (BASIC): Server-Only
- SKILL.md approach
- Server-side policies
- Good for getting started
- No E2E encryption

TIER 2 (ADVANCED): Server+Plugin
- E2E encryption
- Local policies
- Framework adapters
- For power users / enterprise
```

**How it works:**
- Users start with SKILL.md (zero friction)
- When they need privacy/features, they upgrade to plugin
- Server supports both modes seamlessly
- Migration path: start simple, grow as needed

### Option B: Thin Plugin

```
┌─────────────────────────────────────────────────────────────┐
│                    AGENT (Any Framework)                    │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │            MAHILO THIN CLIENT (Optional)              │  │
│  │                                                       │  │
│  │  - E2E encryption only                                │  │
│  │  - Message signing only                               │  │
│  │  - NO framework adapters                              │  │
│  │  - NO session management                              │  │
│  │  - NO local policies                                  │  │
│  └───────────────────────────────────────────────────────┘  │
│                           OR                                │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                    SKILL.md                           │  │
│  │  (Direct HTTP, no encryption)                         │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Rationale:**
- Keep the plugin minimal: just crypto operations
- Everything else (policies, adapters) stays at server or is optional
- Smaller install footprint
- Focused value proposition: "privacy through encryption"

### Option C: Server-Side Everything (SKILL.md Enhanced)

Move plugin features to the server:

1. **Session Management**: Server tracks per-agent sessions
2. **Message History**: Already at server (just expose better APIs)
3. **Policy Caching**: Server sends policies to agent, agent evaluates locally (in SKILL.md instructions)
4. **can_contact**: Server enforces (already does via friendships)

**What you lose:**
- E2E encryption (fundamental limitation)
- Local policy evaluation without sending data to server
- Voice streaming (needs local processing)

**What you keep:**
- Zero installation
- Universal compatibility
- Most functionality

---

## Recommendation

### Short-Term (Adoption Phase)

**Prioritize Server-Only (SKILL.md)**

Rationale:
- Adoption is the #1 priority right now
- Zero-friction onboarding beats features
- Build user base first, add features later
- Most agent use cases don't need E2E encryption yet

Actions:
1. Ensure SKILL.md covers all essential workflows
2. Add server-side session management
3. Add server-side policy enforcement (already planned)
4. Improve polling mode for agents without callbacks
5. Add notification WebSocket support to SKILL.md

### Medium-Term (Scale Phase)

**Add Thin Plugin Option**

When you have:
- Enterprise customers asking for privacy
- Use cases involving sensitive data
- Framework partnerships wanting deeper integration

Actions:
1. Create minimal "Mahilo Crypto" package (encryption + signing only)
2. Keep everything else at server
3. Plugin becomes optional enhancement, not requirement

### Long-Term (Maturity Phase)

**Full Plugin SDK (Optional)**

For power users who want:
- Local policy evaluation
- Framework adapters
- Voice support
- Offline capabilities

Actions:
1. Maintain full SDK for advanced users
2. Keep server-only path as primary
3. Both paths fully supported

---

## Decision Matrix

| Scenario | Recommendation |
|----------|----------------|
| "I just want my agents to talk" | Server-only (SKILL.md) |
| "I need privacy/compliance" | Thin plugin (encryption) |
| "I want the best experience" | Full plugin |
| "I'm building a framework integration" | Full plugin |
| "I want voice support" | Full plugin |

---

## What to Do Next

### Immediate (P0)

1. **Complete server-side policy enforcement**
   - Task: REG-017 to REG-020 in tasks-registry.md
   - This enables policy evaluation without plugin

2. **Enhance SKILL.md**
   - Add polling mode instructions
   - Add WebSocket notification subscription
   - Add better error handling guidance

3. **Add server-side session endpoints** (NEW)
   - POST /api/v1/sessions - create session
   - GET /api/v1/sessions/:id/messages - get session history
   - DELETE /api/v1/sessions/:id - end session

### Short-Term (P1)

4. **Document the SKILL.md-first approach**
   - Update README to emphasize server-only path
   - Create getting-started guide without plugin

5. **Evaluate plugin features for server migration**
   - Which features MUST stay in plugin (E2E encryption)
   - Which CAN move to server (sessions, history)
   - Which SHOULD move to server (for adoption)

### Medium-Term (P2)

6. **Create "Mahilo Crypto" thin package**
   - Just encryption and signing
   - Available but not required
   - Clear upgrade path from server-only

---

## Appendix: Feature Migration Feasibility

| Plugin Feature | Can Move to Server? | How |
|----------------|---------------------|-----|
| E2E Encryption | **No** | Fundamental - must be local |
| Local Policy Eval | **Partial** | Server can send policy rules, but evaluation happens after data is sent |
| Session Management | **Yes** | Server-side sessions with API |
| Message History | **Yes** | Already at server |
| Framework Adapters | **No** | Must be in agent environment |
| Voice Support | **No** | Requires local audio processing |
| can_contact ACLs | **Yes** | Server enforces via friendships |
| Offline Queueing | **No** | Requires local storage |
| Message Signing | **Partial** | Server can sign, but loses E2E auth |

---

## Conclusion

The server-only architecture is the right choice for maximizing adoption in the short term. The key trade-off is privacy (server sees messages) vs. ease of use (no installation).

For Mahilo to achieve its vision of trusted, secure inter-agent communication, the plugin will eventually be necessary for users who need privacy guarantees. But that can be an opt-in upgrade path rather than a requirement.

**Recommended strategy**: Server-only first, thin crypto plugin later, full SDK for power users.
