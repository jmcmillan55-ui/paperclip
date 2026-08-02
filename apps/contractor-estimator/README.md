# Contractor Estimator

A self-contained estimating and quoting tool for contractors. Runs on a phone, tablet, or PC,
prices work off your own equipment and labor costs, applies your margins, and prints a
client-ready quote.

It is a **single HTML file with no dependencies, no build step, and no server**. Open
`index.html` in any modern browser — including straight off a USB stick, an email attachment,
or a local folder. It keeps working with no signal.

Built for site work, excavation, land clearing, forestry, landscaping, and the trades that
price jobs the same way: machine hours plus crew hours plus materials plus getting there.

## Getting to your first quote

1. **Setup** — company name, address, phone, license, optional logo. This becomes the quote
   letterhead.
2. **Rates** — what each machine and each crew class costs *you* per hour, and your default
   margin per category. Costs ship at `$0` and the app keeps warning you until you change
   them, because a `$0` cost prices at `$0` and quietly gives the job away.
3. **Build** — add equipment, labor, materials, mobilization, and lodging lines. Cost, profit,
   margin, and quote total update live in the bar pinned to the bottom.
4. **Quote** — a client-facing document. Print it, or save it as a PDF from the browser's
   print dialog.

### The starter catalog is a placeholder

The app ships with 30 generic machine classes (`EQ-01`–`EQ-30`) and 6 generic crew classes.
They are a starting point, not a recommendation — **replace them with your actual fleet**.
Everything is editable on the Rates screen: rename, recode, recategorize, delete, or clear the
list out entirely and enter your own.

Most outfits already have a sheet with their equipment on it. Use the same names and the same
item codes here, so the estimator and whatever your crews already fill out refer to a machine
the same way.

## Dirt & rock takeoff

The **Takeoff** screen turns dimensions into tons. Enter length × width × depth (or area ×
depth), pick a material, and it gives you four numbers that are not interchangeable:

| Number | What it is | When you use it |
| --- | --- | --- |
| **Tons** | bank volume × density ÷ 2000 | ordering and paying for material |
| **Bank yd³** | what it measures in the ground | the hole you are digging |
| **Loose yd³** | bank + swell | what actually rides in the truck |
| **Compacted yd³** | bank − shrink | what you end up with after rolling it |

Getting these confused is the classic way to lose money on dirt. Haul off the bank number and
you are short on trucks — blasted rock swells better than 50%. Order the bank number for fill
and you come up short on the pad once it compacts.

Loads are computed from tons ÷ truck capacity and rounded up, since half a trip does not exist.

Material presets carry a typical density, swell, and shrink for topsoil, sand, gravel, #57,
crusher run, clay, common fill, shale, broken and solid rock, millings, and broken concrete.
**They are starting points.** Real figures move with moisture, gradation, and which pit it came
from — every field is editable, and one phone call to your supplier is worth more than any
table.

`Add as a material line` drops the tonnage straight onto the estimate at the right unit;
`Add as mobilization` adds the trips. Either way the takeoff is saved on the estimate, so
months later you can still show how you arrived at the number.

## How the margin math works

Prices use **gross margin**, not markup:

```
price = cost / (1 - margin/100)
```

A 30% margin on $1,000 of cost bills $1,428.57, and 30% of that invoice is profit. (Markup
would bill $1,300 — a real margin of only 23%.) This is the single most common way a quote
loses money on paper that looked fine.

Margin resolves in three tiers, most specific first: **per line → per estimate → category
default** from the Rates screen. So you can set a house margin once and still override a
single line on a job that needs it.

Contingency is a percentage of total **cost**, priced with its own margin (default 0%, so it
passes straight through). Sales tax applies only to material lines flagged taxable and shows
as its own line. Overtime hours bill at the class rate times the overtime multiplier.

The quote document shows **sell prices only** — your cost and your margin never render on it.

## Showing it to someone

Open the file with `#demo` on the end of the URL — `index.html#demo` — and it loads a worked
example: a fictional company, real-looking rates, and a finished $39K site-work quote. Useful
when you want someone to *see* the thing working in three seconds instead of imagining it from
an empty screen.

Demo data only seeds on a device with nothing saved yet. If there is any real data in the
browser, `#demo` does nothing at all — it will not overwrite your work.

## Data and backups

Everything is stored in the browser's `localStorage`, on that device only. There is no
account, no server, and no sync — nothing you type leaves the machine.

That cuts both ways: **clearing site data wipes it**. `Export backup` writes a JSON file with
your rates, settings, and every estimate; `Import backup` restores it. That file is how you
move to a new phone, and it is the only backup that exists. Export after any session where you
changed rates.

## Publishing a hosted build

`index.html` is the source of truth. The artifact build strips the
`<!doctype>`/`<html>`/`<head>`/`<body>` wrapper for hosts that supply their own skeleton:

```sh
node apps/contractor-estimator/build-artifact.mjs            # -> dist-artifact.html
node apps/contractor-estimator/build-artifact.mjs /tmp/x.html
```

The script fails if it finds any external reference (script `src`, stylesheet `link`,
`@import`, or absolute URL), because a hosted page may run under a strict CSP that blocks
every external host — and because the offline guarantee is the whole point. The generated
output is not committed.

## Where this sits

A standalone tool, deliberately outside the pnpm workspace. No `package.json`, imports nothing
from `packages/`, not wired into the control plane, and not scanned by the workspace
typecheck, token gates, or Vitest suites.
