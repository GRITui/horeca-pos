# Excel Group & Analyze

A self-contained, browser-based spreadsheet analysis tool. Upload an Excel/CSV file, configure grouping, calculations, and filters, and download the result as a formatted `.xlsx` — no server, no install, and your data never leaves the browser.

## Features

- **Upload any `.xlsx` / `.xls` / `.csv`** with a sheet picker (auto-selects a sheet named `Export` when present)
- **Lookup join** — enrich rows from a second file by a shared key before grouping (left join, with match-rate reporting and duplicate-key warnings)
- **Group rows by** any columns, with **date bucketing** (day / ISO week / month) for date columns
- **Per-column aggregation** — sum, count, count distinct, average, min, max
- **Calculated columns** — Excel-style formulas over the aggregated data, e.g. `([Qty Ordered] - [Qty Shipped]) / [Qty Ordered] * 100`, with drag-and-drop column chips and safe evaluation (no `eval`)
- **Category columns** — when/then labeling rules, first match wins
- **Filters & sorting** — `>= > = != < <= contains is blank is not blank` conditions (ANDed), sort control, keep-top-N
- **Total / Average summary rows** — ratio columns are recomputed from the summed inputs (true weighted figures, not averaged percentages)
- **Cross-tab (pivot)** — spread one value column across another column's distinct values
- **Charts** — bar (top N), pie, line via bundled Chart.js, with optional exclusion of blank and total/summary rows, and PNG download
- **Display formats** — per-column number / percent / text with decimals; exported as real Excel number formats
- **KPI tiles**, color-scale conditional formatting in the preview
- **Presets** — save complete setups in the browser, update in place, and export/import as a file to share across computers
- **Self-documenting exports** — every downloaded workbook includes a `Config` sheet with the settings snapshot
- Built-in Help panel

## Quick start

No build step. Either:

- open `index.html` directly in a browser, or
- host the folder on any static host:
  - **GitHub Pages**: repo Settings → Pages → deploy from branch → root
  - **Vercel / Netlify**: import the repo, framework "Other", no build command, output directory = repo root

## Privacy

All parsing and computation happen client-side (SheetJS + Chart.js are bundled locally — no CDN calls). Uploaded files are never sent anywhere.

## Files

| File | Purpose |
|---|---|
| `index.html` | UI layout, styles, help content |
| `app.js` | All application logic |
| `xlsx.full.min.js` | Bundled SheetJS (Apache-2.0) |
| `chart.umd.js` | Bundled Chart.js v4 (MIT) |
