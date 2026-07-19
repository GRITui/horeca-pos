#!/usr/bin/env bash
# Sidekick — full local test battery. No test framework by design (the app has
# no build step); each suite is a standalone script that prints "N passed,
# M failed" and exits non-zero on any failure or console error.
#
# Requirements:
#   - Node 22+ with Playwright installed globally or via NODE_PATH
#     (in Claude Code's remote env: NODE_PATH=/opt/node22/lib/node_modules,
#      Chromium at /opt/pw-browsers/chromium — the check-*.js scripts use
#      an explicit executablePath; adjust CHROMIUM env below elsewhere)
#   - python3 (serves app/ as static files; suites hit fixed localhost ports)
#
# Usage:  bash tests/run-all.sh
set -u
cd "$(dirname "$0")/.."

# Static servers on the fixed ports the suites expect (8923 = most suites,
# 8933 scheduling, 8943 ux-flow, 8953 payments, 8963 invoice-public,
# 8973 catalog, 8983 items; check-shop.js spawns its own on 8993). Reuse
# any that are already running.
for port in 8923 8933 8943 8953 8963 8973 8983; do
  if ! curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/login.html"; then
    nohup python3 -m http.server "$port" --directory app > "/tmp/sidekick-test-$port.log" 2>&1 &
    STARTED="${STARTED:-} $!"
  fi
done
sleep 1.5

fail=0
echo "── Node harnesses (pure logic, no browser) ──"
for f in tests/test-*.mjs; do
  out=$(node "$f" 2>&1 | grep -E "passed, [0-9]+ failed" | tail -1)
  echo "$(basename "$f") → ${out:-CRASH}"
  [[ "$out" == *" 0 failed" ]] || fail=1
done

echo "── Playwright suites (live UI against app/) ──"
for f in tests/check-*.js; do
  out=$(node "$f" 2>&1 | grep -E "passed, [0-9]+ failed" | tail -1)
  echo "$(basename "$f") → ${out:-CRASH}"
  [[ "$out" == *" 0 failed" ]] || fail=1
done

# Only kill servers this run started.
[ -n "${STARTED:-}" ] && kill $STARTED 2>/dev/null
exit $fail
