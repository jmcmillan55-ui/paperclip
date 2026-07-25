# Project Estimator

A self-contained estimating and quoting tool for field/land-clearing work. Runs on a phone,
tablet, or PC, prices work off your own equipment and labor costs, applies your margins, and
prints a client-ready quote.

It is a **single HTML file with no dependencies, no build step, and no server**. Open
`index.html` in any modern browser — including straight off a USB stick or a local folder.

## Why it lives here

This is a standalone tool, deliberately kept outside the pnpm workspace. It has no
`package.json`, imports nothing from `packages/`, and is not wired into the Paperclip control
plane. Nothing here is scanned by the workspace typecheck, token gates, or Vitest suites.

## Using it

1. **Setup** — company name, address, phone, license, and an optional logo. This becomes the
   quote letterhead.
2. **Rates** — enter what each machine and each labor class *costs you* per hour, plus your
   default margin per category. Rates ship at `$0`; the app flags anything still unset,
   because a `$0` cost prices at `$0` and silently undercuts the job.
3. **Build** — add equipment, labor, materials, mobilization, and lodging lines. Cost, profit,
   margin, and quote total update live in the bar pinned to the bottom of the screen.
4. **Quote** — a client-facing document. Print it or save it as a PDF from the browser's print
   dialog.

### Equipment catalog

The 39 machines (`B1`–`B39`) are transcribed from the company's weekly field labor & equipment
sheet, keeping the same item codes so the estimator and the field sheet refer to machines the
same way. Labor classes `CL` / `CM` / `GM` / `TR` come from the same sheet; the expanded names
are a best guess at the abbreviations and are editable on the Rates screen.

Equipment and labor lists are fully editable — add, rename, recategorize, or delete.

## How the margin math works

Prices use **gross margin**, not markup:

```
price = cost / (1 - margin/100)
```

A 30% margin on $1,000 of cost bills $1,428.57, and 30% of that invoice is profit. (Markup
would bill $1,300 — a real margin of only 23%.) Margin resolves in three tiers, most specific
first: per line → per estimate → category default from the Rates screen.

Contingency is a percentage of total **cost**, priced with its own margin (default 0%, so it
passes straight through). Sales tax applies only to material lines flagged taxable, and is
shown as a separate line on the quote. Overtime hours bill at the class rate times the
overtime multiplier.

The quote document shows **sell prices only** — cost and margin never appear on it.

## Data and backups

Everything is stored in the browser's `localStorage`, on that device only. There is no account
and no sync. **Export backup** writes a JSON file containing rates, settings, and every
estimate; **Import backup** restores it. That file is how you move data to another device, and
the only protection against clearing site data.

## Publishing the hosted build

`index.html` is the source of truth. The hosted artifact build strips the
`<!doctype>`/`<html>`/`<head>`/`<body>` wrapper, since the host supplies its own skeleton:

```sh
node apps/estimator/build-artifact.mjs            # -> apps/estimator/dist-artifact.html
node apps/estimator/build-artifact.mjs /tmp/x.html
```

The script fails if it finds any external reference (script `src`, stylesheet `link`,
`@import`, or absolute URL) — the hosted page runs under a strict CSP that blocks every
external host, so the file has to stay fully self-contained. The generated output is not
committed.
