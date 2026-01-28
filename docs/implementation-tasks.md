# Implementation Tasks

Status: `pending` | `in-progress` | `done`

- [done] Harden callback URL validation (IP literal checks, DNS resolution in production)
- [done] Scope idempotency to sender and add DB uniqueness/indexing
- [done] Add trusted-mode flag for registry policy evaluation
- [done] Normalize/validate agent capabilities to avoid JSON parse failures
- [done] Fix policy list filtering and patch validation edge cases
- [done] Run migrations during dev startup (or make behavior explicit)
- [done] Add `since` filtering to message history
- [done] Implement simple per-user rate limiting in auth middleware
- [done] Move contact lookup to `/contacts/:username/connections`
- [done] Update DB test setup to reflect schema changes
- [done] Replace placeholder integration/E2E tests with real flows
- [done] Update docs for endpoint/path/config changes
