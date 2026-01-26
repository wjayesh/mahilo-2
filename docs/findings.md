# Mahilo 2.0 Design Review Findings

## Findings
### Critical
- [CRIT-1] The privacy/trust claim that Mahilo "only routes" conflicts with registry-side content inspection and message persistence, so the registry is implicitly a trusted data processor; decide whether to make that explicit or move toward end-to-end encryption plus local policy evaluation. `clawdbot/docs/mahilo/registry-design.md:13` `clawdbot/docs/mahilo/registry-design.md:262` `clawdbot/docs/mahilo/registry-design.md:597`

### High
- [HIGH-1] Webhook signature verification uses `JSON.stringify(body)` rather than the raw request body, which will break HMAC validation when JSON ordering/whitespace changes or middleware mutates the payload. `clawdbot/docs/mahilo/plugin-design.md:635`
- [HIGH-2] Retry plus immediate ack lacks idempotency/deduping, so retries can trigger duplicate agent runs and repeated side effects; a queue or message_id de-dupe is required before ack. `clawdbot/docs/mahilo/registry-design.md:276` `clawdbot/docs/mahilo/registry-design.md:775` `clawdbot/docs/mahilo/plugin-design.md:657` `clawdbot/docs/mahilo/tasks-registry.md:337`
- [HIGH-3] Callback URL validation only checks HTTPS and localhost, leaving SSRF and internal network abuse unaddressed for hosted registry deployments. `clawdbot/docs/mahilo/tasks-registry.md:198`
- [HIGH-4] Message authenticity is only registry-to-plugin (callback HMAC); there is no sender-to-recipient signing or attestation, so recipients cannot verify that a message was authored by the claimed sender if the registry is compromised. `clawdbot/docs/mahilo/registry-design.md:189` `clawdbot/docs/mahilo/registry-design.md:752`

### Medium
- [MED-1] API base paths are inconsistent (`/v1` vs `/api/v1` and base URLs include `/v1`), which will cause client/server mismatches and double-prefix bugs. `clawdbot/docs/mahilo/registry-design.md:625` `clawdbot/docs/mahilo/plugin-design.md:120` `clawdbot/docs/mahilo/tasks-registry.md:165`
- [MED-2] Agent connections are described as multiple per user, but the schema enforces a unique `(user_id, framework)` constraint, blocking multiple instances per framework and HA. `clawdbot/docs/mahilo/registry-design.md:116` `clawdbot/docs/mahilo/registry-design.md:544` `clawdbot/docs/mahilo/tasks-registry.md:89`
- [MED-3] Recipient routing is underspecified when a user has multiple connections ("preference order or all"), which can result in duplicate or wrong-agent deliveries; sender-side selection or capability-based routing is missing. `clawdbot/docs/mahilo/registry-design.md:265`
- [MED-4] Group addressing uses group names in the send API, but groups are modeled by id; names are not guaranteed unique or stable. `clawdbot/docs/mahilo/registry-design.md:557` `clawdbot/docs/mahilo/registry-design.md:733`
- [MED-5] Inbound policy filtering is mentioned in the webhook flow but there is no task coverage or configuration for inbound policies, leaving prompt-injection defenses and receiver-side filtering undefined. `clawdbot/docs/mahilo/plugin-design.md:646` `clawdbot/docs/mahilo/tasks-plugin.md:369`
- [MED-6] API key hashing is specified without a lookup strategy; hashing-only storage implies full-table scans on auth unless a key id prefix or indexed hash is added. `clawdbot/docs/mahilo/registry-design.md:170` `clawdbot/docs/mahilo/tasks-registry.md:133`
- [MED-7] Acknowledgement semantics are inconsistent: the flow shows `{ status: "processing", ack: true }` while the callback spec expects `{ acknowledged: true }`, which affects delivery status expectations. `clawdbot/docs/mahilo/registry-design.md:324` `clawdbot/docs/mahilo/registry-design.md:775`
- [MED-8] LLM policy evaluation implies external model access to message content but there is no data handling, retention, or model isolation guidance (self-hosted vs vendor), which is material for privacy/compliance. `clawdbot/docs/mahilo/registry-design.md:430` `clawdbot/docs/mahilo/registry-design.md:833`

### Low
- [LOW-1] `talk_to_agent` defines a structured output type but the example implementation returns plain strings, which may confuse SDK expectations or downstream tooling. `clawdbot/docs/mahilo/plugin-design.md:321` `clawdbot/docs/mahilo/plugin-design.md:376`
- [LOW-2] Message payloads are treated as plain text without explicit size limits or content type, which limits future extensibility (attachments, structured payloads) and increases DoS risk. `clawdbot/docs/mahilo/registry-design.md:597` `clawdbot/docs/mahilo/tasks-registry.md:302`
- [LOW-3] Security best practices call for audit logging and minimal retention, but the Phase 1 task plan does not include concrete work items for retention policies or audit logs. `clawdbot/docs/mahilo/registry-design.md:833` `clawdbot/docs/mahilo/tasks-registry.md:424`
- [LOW-4] There is no documented callback secret rotation or recovery path if the plugin loses the secret, and no rotate endpoint is described. `clawdbot/docs/mahilo/registry-design.md:651` `clawdbot/docs/mahilo/tasks-registry.md:190`

## Open Questions
- Do you want Mahilo to be a fully trusted data processor, or do you want end-to-end confidentiality where the registry cannot read message content?
- Should a user be allowed multiple active connections per framework (multiple devices or HA), and if so how should routing priority be chosen?
- Should senders be able to target a specific framework or agent connection, or do you want registry-side capability discovery before delivery?
- Will LLM policy evaluation run on a self-hosted model, a vendor API, or be optional by deployment tier?
- What is the desired semantics for "delivered" vs "processed" vs "responded," and do you need a message status update endpoint?
- Do you want to support structured payloads (JSON, attachments) in Phase 1, or strictly text-only?

## Assumptions
- Phase 1 prioritizes centralized routing and operational simplicity over end-to-end privacy.
- Group support is not required for Phase 1, so group policies and membership are deferred.
- The plugin is allowed to trigger agent runs asynchronously without guaranteed processing completion.

## Summary
- The vision is coherent (trusted routing plus policy enforcement), but the trust boundary and privacy guarantees need explicit decisions.
- Several integration and security details are currently underspecified (signature verification, idempotency, SSRF protection).
- The task lists cover most MVP work, but a few essential gaps should be added before implementation.
