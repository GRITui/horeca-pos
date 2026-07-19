# @grit/shared-ui

GRITui — the shared React component library for the Grit BizSuite apps
(grit-pos, grit-inventory admin surfaces, and any future Next.js app in the
suite). Styled exclusively with Tailwind CSS v4 utility classes (zinc palette,
`dark:` variants) — no CSS files, no runtime dependencies. React 19 is a peer
dependency.

The package ships TypeScript source directly (`main`/`exports` point at
`src/*.ts(x)`, no build step), like every package in this monorepo.

## Consuming from a Next.js app

1. Add the workspace dependency and transpile the source:

   ```js
   // next.config.ts
   const nextConfig = {
     transpilePackages: ["@grit/shared-ui"],
   };
   ```

2. Tailwind v4 must see this package's source so its utility classes are
   generated. Next's Tailwind integration scans imported source in most
   setups; if classes are missing, add an explicit source to your globals.css:

   ```css
   @import "tailwindcss";
   @source "../../../packages/shared-ui/src";
   ```

No environment variables are read by this package.

## Components

All components accept a `className` passthrough. `Button` and `Input` are
`"use client"` components (interactive elements); `Table`, `Panel`, `Badge`,
`EmptyState`, and `AppSwitcher` are server-component safe.

### Button

```tsx
import { Button } from "@grit/shared-ui";

<Button onClick={save}>Save</Button>
<Button variant="secondary" size="sm">Cancel</Button>
<Button variant="danger" loading={deleting}>Delete</Button>
```

Variants: `primary` (default) | `secondary` | `ghost` | `danger`.
Sizes: `sm` | `md` (default) | `lg`. Defaults to `type="button"`; pass
`type="submit"` for form submits. All native `<button>` props pass through.

### Input

```tsx
import { Input } from "@grit/shared-ui";

<Input
  label="SKU"
  hint="Unique per location"
  error={errors.sku}
  value={sku}
  onChange={(e) => setSku(e.target.value)}
/>
```

Renders label, field, and hint/error text with the ARIA wiring
(`htmlFor`, `aria-invalid`, `aria-describedby`) handled for you. All native
`<input>` props pass through; `className` lands on the `<input>` itself.

### Table

Typed generic column definitions: a column either names a property of the row
(`key: keyof T`, stringified automatically) or must provide a `render`
function — the compiler enforces one or the other.

```tsx
import { Table, Badge, type TableColumn } from "@grit/shared-ui";

type OrderRow = { id: string; customer: string; total: string; status: string };

const columns: TableColumn<OrderRow>[] = [
  { key: "customer", header: "Customer" },
  { key: "total", header: "Total", align: "right", className: "font-mono" },
  { key: "status", header: "Status", render: (row) => <Badge status={row.status} /> },
];

<Table
  columns={columns}
  rows={orders}
  rowKey={(row) => row.id}
  empty="No orders yet."
/>;
```

The table sits in an `overflow-x-auto` wrapper (`className` applies there).
Nullish cell values render as an em dash.

### Panel

Bordered surface card with an optional header. Use `padded={false}` for flush
content such as a `<Table>`.

```tsx
import { Panel, Table, Button } from "@grit/shared-ui";

<Panel
  title="Recent orders"
  description="Last 30 days"
  action={<Button size="sm" variant="secondary">Export</Button>}
  padded={false}
>
  <Table columns={columns} rows={orders} rowKey={(r) => r.id} />
</Panel>;
```

### Badge

Status pill. Either pick a variant explicitly or pass a raw lifecycle status
string — common suite statuses (`pending`, `paid`, `fulfilled`, `delivered`,
`failed`, `cancelled`, …) map to variants automatically, unknown statuses fall
back to `neutral`, and underscores become spaces.

```tsx
import { Badge, statusVariant } from "@grit/shared-ui";

<Badge status="out_for_delivery" />          // info pill, "out for delivery"
<Badge variant="warning">3 low stock</Badge> // explicit variant + custom text
```

Variants: `neutral` | `info` | `success` | `warning` | `danger`. The
`statusVariant(status)` helper is exported for styling beyond badges.

### EmptyState

```tsx
import { EmptyState, Button } from "@grit/shared-ui";

<EmptyState
  title="No products yet"
  message="Create your first product to get started."
  action={<Button>New product</Button>}
/>;
```

### AppSwitcher

Presentational cross-app nav strip. Feed it the output of `buildAppNav` from
`@grit/passport` — the item shape (`{ key, label, href, enabled }`) is
mirrored here as `AppSwitcherItem` so this package stays dependency-free.
Disabled (not-in-plan) apps render visibly locked with a padlock icon and a
"Not included in your plan" tooltip rather than being hidden. Links are plain
`<a>` tags because each app is a separate deployment.

```tsx
import { AppSwitcher } from "@grit/shared-ui";
import { buildAppNav } from "@grit/passport";

<AppSwitcher items={buildAppNav(session)} currentApp="pos" />;
```

`currentApp` (an item `key`) highlights the active app and sets
`aria-current="page"`.

## Subpath imports

Every component is also importable directly, e.g.
`import { Button } from "@grit/shared-ui/Button"`.
