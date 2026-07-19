# Sidekick test battery

Standalone scripts, no framework — matching the app's own no-build-step
philosophy. Two kinds:

- **`test-*.mjs`** — Node harnesses for pure server-side logic
  (`lib/entitlements.js`, `lib/teams.js`, `lib/lineLogin.js` tokens, Stripe
  webhook signatures, LINE multi-tenant routing). No browser, no network —
  fake `sql` functions and hand-signed tokens.
- **`check-*.js`** — Playwright suites driving the real app served
  statically from `app/`, with `window.SidekickBackend` stubbed in-page
  where a suite needs backend state (see `check-team.js` for the stub
  pattern). Each registers a fresh account per run; IndexedDB state is
  namespaced per browser profile so runs are independent.

Run everything: `bash tests/run-all.sh` (starts static servers on ports
8923/8933 if not already running; exits non-zero on any failure or any
captured console/page error).

Requirements: Node 22+, Playwright + Chromium reachable (the scripts pass an
explicit `executablePath` — edit it if your Chromium lives elsewhere),
`python3` for the static server.

These suites were born as scratchpad verification during feature
development (every entry in `project-changelog-handshake-gym.md` cites its
pass counts) and are committed here per the recorded backlog item "commit a
real regression suite to the repo." Keep them green: every feature PR since
subscription Phase 0 has re-run the full battery before shipping.
