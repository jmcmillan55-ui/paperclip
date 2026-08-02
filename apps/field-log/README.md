# Field Log

A daily field log and custom safety-sheet tool for contractors. Records who was on site, what
ran, what got done, and — the part that pays for itself — every hour lost and who caused it.
Prints a signed daily report and any safety form you build.

It is a **single HTML file with no dependencies, no build step, and no server**. Open
`index.html` in any modern browser. It works with no signal, which matters on a job site.

## Why the delay section is the point

Most daily logs record what happened. The money is in what *didn't*. When a client disputes a
bill six weeks later, or a claim comes down to whether the crew sat waiting on a locate, the
only thing that settles it is a dated record written the day it happened.

So the log asks for the hours lost and **who caused it** — weather, client, utility, inspection,
subcontractor, breakdown, material delivery, or your own crew. It totals them on the day and
prints them on the report above the signature line.

Standby hours on equipment are tracked separately from hours run, for the same reason.

## Using it

1. **Setup** — company name and phone. This becomes the report letterhead.
2. **Roster** — your crew and your machines. One tap each after that, instead of typing names
   into every log.
3. **Day** — open a new day and fill it in as you go. `Add whole roster` puts the whole crew on
   the log at 8 hours each; adjust from there.
4. **Report** — the printable daily record. Print it or save it as a PDF at end of day.

A day covers: job and location, weather and ground conditions with a "weather impacted work"
flag, crew with straight and overtime hours, equipment with hours run and standby, work
performed, quantities placed, materials received with ticket numbers, delays, visitors, the
morning toolbox talk with attendance, and incidents.

## Custom safety sheets

The **Safety** screen holds *forms* (blank templates) and *sheets* (filled, dated, signed).

Two starter forms are included — **Toolbox talk** and **Job hazard analysis** — and both are
fully editable. Build your own by adding sections and items. Four item types:

| Type | Prints as |
| --- | --- |
| Checkbox | `☒` / `☐` with the label |
| Yes / No / N-A | the answer in bold, then the label |
| Short text | label above a single-line answer |
| Paragraph | label above a block of text |

Fill a form and it becomes a sheet stamped with the date, job, and supervisor. `Add whole
roster` puts every crew member on it, and each one prints with their own signature line — which
is what an inspector or an insurer actually asks to see.

## Data and backups

Everything is stored in the browser's `localStorage`, on that device only. No account, no
server, no sync — nothing leaves the machine.

That means **clearing site data wipes it.** `Export backup` writes a JSON file with your
company info, roster, forms, every log, and every signed sheet; `Import backup` restores it.
That file is the only backup that exists, and it is how you move to a new phone. Export weekly.

## Publishing a hosted build

```sh
node apps/field-log/build-artifact.mjs            # -> dist-artifact.html
node apps/field-log/build-artifact.mjs /tmp/x.html
```

The script strips the document wrapper for hosts that supply their own, and fails if it finds
any external reference — the offline guarantee is the whole point. Generated output is not
committed.

## Where this sits

A standalone tool, deliberately outside the pnpm workspace. No `package.json`, imports nothing
from `packages/`, not wired into the control plane, and not scanned by the workspace typecheck,
token gates, or Vitest suites. It shares its visual language with `apps/contractor-estimator`
but is entirely independent of it.
