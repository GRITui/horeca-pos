# Grit BizSuite monorepo

npm-workspaces + turbo monorepo. Four apps under `apps/`, shared packages under
`packages/`. Each app must keep running standalone (its own deploy, its own
`package.json`); cross-app integration happens ONLY through the event contracts
in `packages/shared-events` (HMAC-signed internal webhooks + Postgres outbox) —
never through direct cross-app database queries.

## Apps

- `apps/grit-pos` — Next.js 16 + Prisma 7 + Neon. Front-of-house checkout (staff
  register, QR dine-in, pickup links). Hospitality features are optional plugin
  traits; core is channel-agnostic checkout.
- `apps/grit-inventory` — Next.js 16 + Prisma 7 + Neon. Multi-location stock,
  transfer orders, FIFO costing.
- `apps/grit-taskboard` — no-build plain-JS PWA + Vercel serverless `api/`
  (Neon HTTP driver). Do not introduce a build step or npm dependencies to the
  PWA. Ops kanban with event-driven card automation.
- `apps/grit-reports` — static vanilla-JS report constructor (bundled SheetJS +
  Chart.js). Cross-app aggregation endpoints live behind feature flags.

## The Next.js you know is wrong

The Next.js in this repo (16.x) has breaking changes vs. your training data —
middleware is `proxy.ts`, etc. Read the relevant guide in
`apps/grit-pos/node_modules/next/dist/docs/` before writing Next.js code.
Heed deprecation notices.

## Shared packages

- `@grit/database` — canonical relational schema (SQL migrations + Prisma
  schema) and the event outbox store.
- `@grit/shared-events` — event envelopes, webhook signing/verification, bus.
- `@grit/passport` — SSO session contract, RBAC, `hasFeatureAccess` tier gates
  (LITE / GROWTH / SCALE + addons).
- `@grit/shared-ui` — GRITui React components (Tailwind v4). Next apps must
  list consumed packages in `transpilePackages`.

Packages ship TypeScript source (no build step). The taskboard app mirrors the
webhook verification in plain JS (`apps/grit-taskboard/lib/gritEvents.js`) —
wire-format changes must be made in both places.

## AI orchestration convention (project owner preference)

Substantive AI work on this repo runs as 3-layer multi-model orchestration:

1. **Architect/Gate (top-tier model, main loop)** — decomposition, task specs,
   integration decisions, adversarial final review, commits/pushes.
2. **Builders/QC (mid-tier, e.g. Sonnet)** — scoped implementation and
   verification tasks, each confined to a disjoint directory slice, each
   self-verifying (tsc / build / tests) before returning.
3. **Mechanical sweeps (small-tier, e.g. Haiku)** — lint/typecheck fix loops,
   doc syncs, repetitive per-file transforms.

Agents must own disjoint paths (no two agents write the same directory), and
cross-cutting files (root configs, shared packages) belong to the architect
layer only.
