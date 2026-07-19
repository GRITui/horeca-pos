---
name: workflow-dispatch
description: Tiered multi-model orchestration for clearing a batch of well-scoped backlog items — architect verifies + writes precise task specs, Haiku workers run full engineering loops, a Sonnet QC squad verifies with fix authority, one Opus adversarial reviewer gates the diff, the main loop does final approval + ship. Use when the user asks to orchestrate/clear a backlog with multiple models or tiers; NOT for single features (use a normal build loop) or for M/L-sized items (give those a dedicated pass).
---

# workflow-dispatch — tiered model orchestration

The pattern proven in this repo on 2026-07-16 (8 agents, zero Opus findings,
full battery green on first final-approval run). Roles, cheapest-capable-model
per tier:

| Tier | Model | Role |
|---|---|---|
| Architect | main loop (top model) | verify items against live code, size + group, write specs, final approve + ship |
| L1 workers | `haiku` | full engineering loop per task: implement → syntax check → report |
| L2 QC squad | `sonnet` | verify every L1 claim against real files, **fix authority**, run targeted suites |
| L3 review | `opus` | one adversarial pass over the combined diff, JSON findings only |

## Phase 0 — Architect (do this in the main loop, before any agent)

1. **Verify every backlog item against the live code first.** Grep the
   anchors; drop items that turn out to be already done (this pass found 2 of
   8 were). Never dispatch a task you haven't anchor-checked.
2. **Size-gate.** L1 gets only S-sized, mechanical, precisely-anchorable
   tasks. M/L items (rewrites, new subsystems, localization passes) get their
   own dedicated pass with a stronger model — dispatching them to Haiku
   produces confident wrong code.
3. **Group by file collision.** Tasks touching disjoint files → parallel
   chains. Tasks sharing a file (this repo: almost everything touches
   `app/app.js`) → ONE sequential chain, later workers told "a previous
   worker just edited this file — re-read regions before editing."
4. **Skip what's blocked on the user** (dashboard/console/env steps). List it
   back to them instead.

## Task-spec template (every L1 prompt)

```
Worker task in repo <ABS_PATH>. Files you may touch: <EXPLICIT LIST> ONLY.
TASK: <one paragraph: the WHY (what breaks today), then the exact change>
<anchors: function names, line refs, or a grep command that enumerates the
 sites — never make the worker discover scope>
<edge cases spelled out; what NOT to do (e.g. "AI drafting was dropped by
 user decision and must NOT be reintroduced")>
CONVENTIONS: vanilla JS, no libs; every user-facing string via t() with keys
in BOTH en:/th: dicts (natural Thai); rationale comments in the codebase's
voice; node --check every edited .js file; do NOT commit/push/version-bump;
do NOT touch files outside your list. Final message = terse report: files
touched, what you did, check results, anything unfinished and why.
```

## Workflow script shape

One `Workflow` call encodes the whole machine. Skeleton:

```js
phase('L1 Haiku build')
const [apiChain, appChain] = await parallel([
  async () => {                       // disjoint-file chain — can parallelize internally if safe
    const a1 = await agent(SPEC_1, { model: 'haiku', phase: 'L1 Haiku build' })
    const a2 = await agent(SPEC_2, { model: 'haiku', phase: 'L1 Haiku build' })
    return [a1, a2].join('\n---\n')
  },
  async () => {                       // shared-file chain — STRICTLY sequential
    const b1 = await agent(SPEC_3, { model: 'haiku', phase: 'L1 Haiku build' })
    const b2 = await agent(SPEC_4, { model: 'haiku', phase: 'L1 Haiku build' })
    return [b1, b2].join('\n---\n')
  },
])
phase('L2 Sonnet QC')                 // one QC per chain, gets the L1 reports verbatim
const [qcA, qcB] = await parallel([
  () => agent(`Verify against the REAL files, fix defects directly (full
    authority), run <targeted suites>. L1 reports:\n${apiChain}`,
    { model: 'sonnet', effort: 'medium', phase: 'L2 Sonnet QC' }),
  () => agent(`...${appChain}`, { model: 'sonnet', effort: 'medium', phase: 'L2 Sonnet QC' }),
])
phase('L3 Opus review')               // findings-only, schema-forced
const opus = await agent(`Hunt ONLY real twice-missed defects in git diff;
  verify every candidate against the file before reporting. QC reports:
  ${qcA}\n${qcB}`, { model: 'opus', effort: 'high', schema: FINDINGS_SCHEMA })
return { apiChain, appChain, qcA, qcB, findings: opus.findings }
```

Key rules baked into the prompts:
- **L2 gets L1's reports verbatim** and is told to distrust them — "verify
  every claim against the real files." L2 fixes in place and re-runs the
  named targeted suites (not the full battery — that's the architect's job).
- **L3 is findings-only** (schema-forced JSON), pointed at `git diff`, told
  the classes of twice-missable bugs to hunt (stale-variable mirrors,
  secure-context clipboard throws, i18n keys missing from one dict,
  escaping violations). An empty findings array is a real, good outcome.
- Model overrides go per-`agent()` call; also mirror them in `meta.phases`
  for the progress display.

## Final approval (main loop, after the workflow returns)

1. Read the QC verdicts + Opus findings (the notification truncates — read
   the output file). Apply surviving findings yourself.
2. Run the FULL battery: `bash tests/run-all.sh` (or per-suite, see
   tests/README.md). All green or fix before shipping.
3. Version bump in lockstep (app.js/sw.js/index.html/login.html/book.html),
   changelog entry in project-changelog-handshake-gym.md (include the
   orchestration shape + agent/token counts + what was deferred), commit,
   push, PR.

## Failure handling (both failure modes have happened; both are recoverable)

- **Session-limit deaths mid-fleet**: agents die with partial work on disk.
  `git status` + `node --check` everything touched, read what survived, and
  the architect completes the remainder INLINE from the Phase-0 anchors/maps
  — never re-dispatch into the same limit. (Limits reset on a clock; the
  notification names the time.)
- **Empty/truncated results**: read the workflow's journal.jsonl (path in
  the launch output) before assuming an agent returned nothing.
- **A worker left a file mid-rewrite**: its last message usually says so;
  syntax-check is the tripwire.

## When NOT to use this

- One feature, however large → normal build loop (design → implement →
  verify), no tiering overhead.
- Anything M/L-sized → dedicated pass; L1 tiering is for BATCHES of small,
  independent, mechanically-specifiable items.
- Research/assessment → use a parallel-lens assess workflow instead (no
  file edits, no tiers needed beyond effort levels).
