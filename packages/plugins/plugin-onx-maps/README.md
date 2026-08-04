# onX Maps plugin

Import onX Maps GPX/KML exports as company-scoped markups, browse them on a map,
attach them to issues, query them from agent tools, and export selections back
out for re-import into onX.

Status: **experimental**. It has been built and unit-tested against
onX-shaped GPX and KML, but not yet against a real export from a live onX
account.

---

## Why there is no onX account connection

onX does not publish an API. There is no `api.onxmaps.com`, no developer
portal, no OAuth, and no public SDK — the [onXmaps GitHub
org](https://github.com/onXmaps) contains forks and internal tooling only. onX
sells map *data* (private/public land boundaries, landowner records) as its
product, so there is nothing for a third party to authenticate against.

What onX *does* document is file-based import and export, and that is what this
plugin builds on:

> Export Markups from the onX Web Map as GPX or KML, then import that file.
> — [onX support: Importing and Exporting Markups](https://support.onxmaps.com/hc/en-us/articles/115002196452)

So the flow is: **onX Web Map → export GPX/KML → upload here.** It is manual by
necessity, not by choice. Scraping `webmap.onxmaps.com` with a personal login
was deliberately not implemented: it is behind auth, the endpoints are
undocumented and unstable, and it is against onX's terms.

## What is *not* imported

Only **your own markups** — waypoints, tracks, routes, lines, and area shapes.
onX's basemap and its proprietary layers (landowner names, parcel boundaries,
public-land classification) are not in an export file and are not licensable
for re-serving, so the map here draws your markups over a configurable
third-party basemap (OpenStreetMap by default), not over onX imagery.

---

## Install

The plugin is discovered automatically as a bundled monorepo plugin:

```sh
pnpm --filter @paperclipai/plugin-onx-maps build
pnpm paperclipai plugin install packages/plugins/plugin-onx-maps
```

It is marked experimental in the bundled-plugin list, so it must be installed
deliberately.

## Use

1. In the onX Web Map, select Markups and export them as **GPX** or **KML**.
2. Open **onX Maps** in the Paperclip sidebar and click **Import GPX/KML**.
3. Filter by name, type, or onX folder; click a markup to see its details.
4. On an issue, open the **onX Markups** tab to attach a markup to that issue.

### Which format to export from onX

onX converts between geometry types on the way in and out, so the format
matters:

| Markup | Export from onX as | Because |
|---|---|---|
| Tracks | GPX | exporting as KML converts them to Lines |
| Lines, Area shapes | KML | exporting as GPX converts them to Tracks |
| Waypoints | either | round-trips cleanly |

The same applies to files this plugin generates for you. The exporter reports
exactly which conversions onX will apply before you download.

### Limits

onX caps an import at **4 MB** and **3000 markups**. This plugin enforces the
same ceilings in both directions, so a generated file is always loadable back
into onX.

One host constraint worth knowing: scoped plugin API routes are capped at 1 MB
by Paperclip itself (413 before the worker runs), so
`POST /api/plugins/:id/api/imports` only suits small files. **The UI upload path
handles the full 4 MB range** — it goes through the action bridge, under the
server's 10 MB JSON limit.

### Duplicate handling

onX exports carry no durable per-markup id, so re-exporting the same waypoint
produces a byte-different file describing the same real-world object. Each
markup is therefore keyed by a hash of its kind, name, and geometry rounded to
~1 cm. Re-importing an overlapping export adds only what is genuinely new.
Uploading a byte-identical file is a no-op.

## Agent tools

| Tool | Purpose |
|---|---|
| `onx_search_markups` | Search by name, description, or folder |
| `onx_markups_near` | Markups within a radius of a lat/lon, nearest first |
| `onx_get_markup` | One markup in full, including attached issues |
| `onx_list_folders` | onX folders present, with counts |
| `onx_export_markups` | Build a GPX/KML file from a selection |

Geometry is omitted from tool results unless asked for — a scouting track can
hold thousands of points, and the summary measurements (distance, elevation
gain, acreage, bounds) carry the useful signal.

## Configuration

Instance settings:

- **Basemap tile URL** — XYZ raster template. Defaults to OpenStreetMap. Clear
  it to draw markups with no basemap.
- **Basemap attribution** — shown over the map. Required by most tile
  providers, including OSM.
- **Elevation noise threshold** (default 3 m) — elevation changes below this
  are treated as GPS jitter and excluded from track gain/loss. Without it, a
  flat walk reports hundreds of metres of phantom climb.

If you point the tile URL at a commercial provider, respect that provider's
terms and rate limits; tiles are fetched directly by each viewer's browser.

## Implementation notes

- **No new npm dependencies.** GPX/KML parsing, geodesy, and the slippy map are
  all implemented in this package. A map library would have added ~800 KB and a
  lockfile change for a tile grid plus some polylines.
- **The XML reader cannot expand entities.** `<!DOCTYPE …>` is skipped without
  parsing its internal subset and only the five predefined entities plus
  numeric character references are resolved, so XXE and billion-laughs are
  ruled out by construction rather than by limit-checking. Parsing is iterative,
  so a deeply nested document cannot overflow the stack.
- **Geodesy is spherical, not ellipsoidal.** Sub-metre error at markup scale.
- **Proximity search** prefilters with a lat/lon window in SQL, then ranks by
  true great-circle distance in JS. The window is a superset of the circle, so
  nothing inside the radius is missed.
- **Issue links live in a plugin table**, not `plugin_entities`: `ctx.entities`
  can upsert and list but has no delete, which would make detaching impossible.

## Layout

```
migrations/001_onx_maps.sql   imports, markups, issue links
src/xml.ts                    dependency-free, entity-free XML reader
src/parse.ts                  GPX + KML → canonical markups
src/geo.ts                    haversine, areas, elevation, mercator tiles
src/export.ts                 GPX + KML writers, onX limit enforcement
src/store.ts                  ctx.db access
src/service.ts                import/query/export shared by tools, UI, routes
src/worker.ts                 tools, bridge handlers, scoped API routes
src/ui/map.tsx                slippy map
src/ui/app.tsx                page, issue tab, sidebar, settings
```

## Develop

```sh
pnpm --filter @paperclipai/plugin-onx-maps test
pnpm --filter @paperclipai/plugin-onx-maps typecheck
pnpm --filter @paperclipai/plugin-onx-maps build
```
