# Dashboard Frontend Smoke Path

This is the lightweight regression path for the dashboard frontend activation work.

## Automated Regression

Run the Vitest coverage harness for `public/app.js`:

```bash
bun run test:dashboard:regression
```

The harness covers:

- normalization helpers for current dashboard collection models
- boundary mapping for common canonical policies and unmatched advanced fallbacks
- review queue and activity grouping for delivered, review, and blocked states
- landing/auth/dashboard gating for the agent-backed browser sign-in flow

## Manual Smoke Path

Use this when validating the product shell end to end in a browser.

Prerequisites:

- the Mahilo server is running locally
- you have an invite-backed Mahilo account
- the account has a configured agent that can approve browser sign-in

Steps:

1. Open the landing page at `/`.
2. Confirm the primary auth section says `Sign in with your agent` and that manual API-key entry is framed as an advanced fallback, not a registration path.
3. Enter a valid Mahilo username and start browser sign-in.
4. Confirm the page shows a short approval code, an expiry label, and pending instructions without a page refresh.
5. Approve the code from the configured agent, then continue in the browser and confirm the landing page is replaced by the dashboard shell.
6. Check **Overview** and confirm readiness cards, recent activity, and review/blocked audit cues render without console errors.
7. Check **Network** and confirm accepted, pending, and blocked relationship states load from real friendship data.
8. Check **Boundaries** and confirm common categories render with audience/effect labels while unmatched selectors fall back to `Advanced/custom boundary`.
9. Check **Delivery Logs** and confirm delivered, review-required or approval-pending, and blocked items render with consistent filters and audit detail.
10. Check **Developer** and confirm **Recent sign-in attempts** shows the latest browser code plus the current outcome or last failure reason without inspecting raw tables.
11. Log out and confirm the UI returns to the signed-out landing state.

If agent-backed sign-in is unavailable for the environment, use the advanced API-key fallback only to verify that an existing invite-backed account can still boot the dashboard shell.
