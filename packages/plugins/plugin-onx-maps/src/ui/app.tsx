import { useCallback, useMemo, useRef, useState } from "react";
import {
  ErrorBoundary,
  Spinner,
  useHostContext,
  usePluginAction,
  usePluginData,
  usePluginToast,
  type PluginDetailTabProps,
  type PluginPageProps,
  type PluginSettingsPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";

import {
  ACTION_KEYS,
  DATA_KEYS,
  DEFAULT_CONFIG,
  ONX_MAX_IMPORT_BYTES,
  PAGE_ROUTE,
} from "../constants.js";
import { metersToFeet, metersToMiles, squareMetersToAcres } from "../geo.js";
import type { ImportRecord, MarkupKind, SourceFormat, StoredMarkup } from "../model.js";
import { MARKUP_KINDS } from "../model.js";
import { KIND_COLORS, MarkupMap } from "./map.js";

// ---------------------------------------------------------------------------
// Bridge payload shapes
// ---------------------------------------------------------------------------

interface OverviewPayload {
  markupCount: number;
  importCount: number;
  byKind: Record<string, number>;
  lastImportedAt: string | null;
  folders: Array<{ folderPath: string | null; markupCount: number }>;
  config: {
    basemapTileUrl: string;
    basemapAttribution: string;
    elevationGainThresholdMeters: number;
  };
}

interface MarkupsPayload {
  markups: StoredMarkup[];
  count: number;
}

interface ImportsPayload {
  imports: ImportRecord[];
}

interface IssueLinksPayload {
  links: Array<{
    id: string;
    markupId: string;
    note: string | null;
    linkedAt: string;
    markup: StoredMarkup;
  }>;
}

interface ImportSummary {
  filename: string;
  format: SourceFormat;
  markupCount: number;
  insertedCount: number;
  duplicateCount: number;
  warnings: string[];
  alreadyImported: boolean;
}

interface ExportPayload {
  filename: string;
  content: string;
  markupCount: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<MarkupKind, string> = {
  waypoint: "Waypoint",
  track: "Track",
  route: "Route",
  line: "Line",
  area: "Area",
};

function formatDistance(meters: number | null): string | null {
  if (meters === null) return null;
  const miles = metersToMiles(meters);
  return miles < 0.1 ? `${Math.round(metersToFeet(meters))} ft` : `${miles.toFixed(2)} mi`;
}

function formatArea(squareMeters: number | null): string | null {
  if (squareMeters === null) return null;
  return `${squareMetersToAcres(squareMeters).toFixed(squareMetersToAcres(squareMeters) < 10 ? 2 : 1)} acres`;
}

function formatCoords(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function KindDot({ kind }: { kind: MarkupKind }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: KIND_COLORS[kind] }}
    />
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-border px-4 py-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

/**
 * Reads a GPX/KML file as text and hands it to the worker.
 *
 * The size check mirrors onX's own 4 MB import ceiling so an oversized file
 * fails here with a clear message instead of after a pointless upload.
 */
function useFileImport(companyId: string | null, onDone: () => void) {
  const importFile = usePluginAction(ACTION_KEYS.import);
  const toast = usePluginToast();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (file: File) => {
      if (!companyId) return;
      if (file.size > ONX_MAX_IMPORT_BYTES) {
        toast({
          title: "File too large",
          body: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. onX caps exports at 4 MB.`,
          tone: "error",
        });
        return;
      }

      setBusy(true);
      try {
        const content = await file.text();
        const summary = (await importFile({
          companyId,
          filename: file.name,
          content,
        })) as ImportSummary;

        if (summary.alreadyImported) {
          toast({ title: "Already imported", body: summary.warnings[0], tone: "info" });
        } else {
          const skipped =
            summary.duplicateCount > 0 ? `, ${summary.duplicateCount} already present` : "";
          toast({
            title: `Imported ${summary.insertedCount} markup(s)`,
            body: `${file.name}: ${summary.markupCount} found${skipped}.${
              summary.warnings.length > 0 ? ` ${summary.warnings.length} warning(s).` : ""
            }`,
            tone: summary.warnings.length > 0 ? "warn" : "success",
          });
        }
        onDone();
      } catch (error) {
        toast({ title: "Import failed", body: errorMessage(error), tone: "error" });
      } finally {
        setBusy(false);
      }
    },
    [companyId, importFile, onDone, toast],
  );

  return { run, busy };
}

/** Turn an export payload into a browser download. */
function downloadExport(payload: ExportPayload): void {
  const blob = new Blob([payload.content], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = payload.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function OnxMapsPage({ context }: PluginPageProps) {
  return (
    <ErrorBoundary>
      <OnxMapsPageInner companyId={context.companyId} />
    </ErrorBoundary>
  );
}

function OnxMapsPageInner({ companyId }: { companyId: string | null }) {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<MarkupKind | "">("");
  const [folderPath, setFolderPath] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showImports, setShowImports] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toast = usePluginToast();

  const overview = usePluginData<OverviewPayload>(DATA_KEYS.overview, { companyId });
  const markupsQuery = usePluginData<MarkupsPayload>(DATA_KEYS.markups, {
    companyId,
    search: search.trim() || undefined,
    kind: kind || undefined,
    folderPath: folderPath || undefined,
  });

  const refreshAll = useCallback(() => {
    overview.refresh();
    markupsQuery.refresh();
  }, [overview, markupsQuery]);

  const { run: runImport, busy: importing } = useFileImport(companyId, refreshAll);
  const runExport = usePluginAction(ACTION_KEYS.exportMarkups);

  const markups = markupsQuery.data?.markups ?? [];
  const selected = useMemo(
    () => markups.find((markup) => markup.id === selectedId) ?? null,
    [markups, selectedId],
  );

  const handleExport = useCallback(
    async (format: SourceFormat) => {
      if (!companyId) return;
      try {
        const payload = (await runExport({
          companyId,
          format,
          kind: kind || undefined,
          folderPath: folderPath || undefined,
          search: search.trim() || undefined,
        })) as ExportPayload;
        downloadExport(payload);
        toast({
          title: `Exported ${payload.markupCount} markup(s)`,
          body:
            payload.warnings.length > 0
              ? payload.warnings.join(" ")
              : `${payload.filename} is ready to import into the onX Web Map.`,
          tone: payload.warnings.length > 0 ? "warn" : "success",
        });
      } catch (error) {
        toast({ title: "Export failed", body: errorMessage(error), tone: "error" });
      }
    },
    [companyId, runExport, kind, folderPath, search, toast],
  );

  if (!companyId) {
    return (
      <div className="p-6">
        <EmptyState
          title="Select a company"
          body="onX markups are company-scoped. Choose a company to see its imported markups."
        />
      </div>
    );
  }

  const config = overview.data?.config;
  const folders = overview.data?.folders ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">onX Maps</h1>
          <p className="text-xs text-muted-foreground">
            {overview.loading
              ? "Loading…"
              : `${overview.data?.markupCount ?? 0} markup(s) from ${overview.data?.importCount ?? 0} import(s)` +
                (overview.data?.lastImportedAt
                  ? ` · last import ${formatTimestamp(overview.data.lastImportedAt)}`
                  : "")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".gpx,.kml,application/gpx+xml,application/vnd.google-earth.kml+xml"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void runImport(file);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={importing}
            onClick={() => fileInputRef.current?.click()}
            className="rounded-md border border-border bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {importing ? "Importing…" : "Import GPX/KML"}
          </button>
          <button
            type="button"
            onClick={() => void handleExport("gpx")}
            disabled={markups.length === 0}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            Export GPX
          </button>
          <button
            type="button"
            onClick={() => void handleExport("kml")}
            disabled={markups.length === 0}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            Export KML
          </button>
          <button
            type="button"
            onClick={() => setShowImports((value) => !value)}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
          >
            {showImports ? "Hide imports" : "Imports"}
          </button>
        </div>
      </header>

      {markupsQuery.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {markupsQuery.error.message}
        </div>
      )}

      {showImports && <ImportsPanel companyId={companyId} onChanged={refreshAll} />}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search name, description, folder…"
          className="min-w-[200px] flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground"
        />
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as MarkupKind | "")}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
        >
          <option value="">All types</option>
          {MARKUP_KINDS.map((value) => (
            <option key={value} value={value}>
              {KIND_LABELS[value]}
            </option>
          ))}
        </select>
        <select
          value={folderPath}
          onChange={(event) => setFolderPath(event.target.value)}
          className="max-w-[240px] rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
        >
          <option value="">All folders</option>
          {folders
            .filter((folder) => folder.folderPath !== null)
            .map((folder) => (
              <option key={folder.folderPath} value={folder.folderPath!}>
                {folder.folderPath} ({folder.markupCount})
              </option>
            ))}
        </select>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[320px_1fr]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border">
          <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            {markupsQuery.loading ? "Loading…" : `${markups.length} shown`}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {markupsQuery.loading && markups.length === 0 ? (
              <div className="flex justify-center p-6">
                <Spinner />
              </div>
            ) : markups.length === 0 ? (
              <div className="p-3">
                <EmptyState
                  title="No markups"
                  body={
                    (overview.data?.markupCount ?? 0) === 0
                      ? "Export Markups from the onX Web Map as GPX or KML, then import the file here."
                      : "No markups match the current filters."
                  }
                />
              </div>
            ) : (
              <ul>
                {markups.map((markup) => (
                  <li key={markup.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(markup.id)}
                      className={`flex w-full flex-col gap-0.5 border-b border-border px-3 py-2 text-left transition-colors hover:bg-accent/50 ${
                        markup.id === selectedId ? "bg-accent" : ""
                      }`}
                    >
                      <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                        <KindDot kind={markup.kind} />
                        <span className="truncate">{markup.name ?? "(unnamed)"}</span>
                      </span>
                      <span className="truncate pl-[18px] text-[11px] text-muted-foreground">
                        {[
                          KIND_LABELS[markup.kind],
                          markup.folderPath,
                          formatDistance(markup.stats.distanceMeters),
                          formatArea(markup.stats.areaSquareMeters),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-3">
          <div className="min-h-[280px] flex-1">
            <MarkupMap
              markups={markups}
              selectedId={selectedId}
              onSelect={setSelectedId}
              tileUrl={config?.basemapTileUrl ?? DEFAULT_CONFIG.basemapTileUrl}
              attribution={config?.basemapAttribution ?? DEFAULT_CONFIG.basemapAttribution}
              emptyLabel="Import an onX GPX or KML export to see markups here"
            />
          </div>
          {selected && <MarkupDetail markup={selected} onClose={() => setSelectedId(null)} />}
        </div>
      </div>
    </div>
  );
}

function MarkupDetail({ markup, onClose }: { markup: StoredMarkup; onClose: () => void }) {
  const rows: Array<[string, string | null]> = [
    ["Type", KIND_LABELS[markup.kind]],
    ["Folder", markup.folderPath],
    ["Coordinates", formatCoords(markup.lat, markup.lon)],
    ["Distance", formatDistance(markup.stats.distanceMeters)],
    ["Area", formatArea(markup.stats.areaSquareMeters)],
    [
      "Elevation gain",
      markup.stats.elevationGainMeters === null
        ? null
        : `${Math.round(metersToFeet(markup.stats.elevationGainMeters))} ft`,
    ],
    [
      "Elevation",
      markup.elevationMeters === null ? null : `${Math.round(metersToFeet(markup.elevationMeters))} ft`,
    ],
    ["Points", String(markup.stats.pointCount)],
    ["onX symbol", markup.symbol],
    ["Recorded", markup.sourceTime ? formatTimestamp(markup.sourceTime) : null],
  ];

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <KindDot kind={markup.kind} />
          {markup.name ?? "(unnamed)"}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="rounded px-1.5 text-xs text-muted-foreground hover:bg-accent"
        >
          ✕
        </button>
      </div>

      {markup.description && (
        <p className="mt-1.5 whitespace-pre-wrap text-xs text-muted-foreground">
          {markup.description}
        </p>
      )}

      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        {rows
          .filter((row): row is [string, string] => row[1] !== null)
          .map(([label, value]) => (
            <div key={label}>
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
              <dd className="font-mono text-xs text-foreground">{value}</dd>
            </div>
          ))}
      </dl>

      <p className="mt-2 font-mono text-[10px] text-muted-foreground">{markup.id}</p>
    </div>
  );
}

function ImportsPanel({ companyId, onChanged }: { companyId: string; onChanged: () => void }) {
  const imports = usePluginData<ImportsPayload>(DATA_KEYS.imports, { companyId });
  const deleteImport = usePluginAction(ACTION_KEYS.deleteImport);
  const toast = usePluginToast();

  const remove = async (record: ImportRecord) => {
    try {
      await deleteImport({ companyId, importId: record.id });
      toast({ title: `Deleted ${record.filename}`, tone: "success" });
      imports.refresh();
      onChanged();
    } catch (error) {
      toast({ title: "Delete failed", body: errorMessage(error), tone: "error" });
    }
  };

  const records = imports.data?.imports ?? [];

  return (
    <div className="rounded-md border border-border">
      <div className="border-b border-border px-3 py-2 text-xs font-medium text-foreground">
        Imports
      </div>
      {imports.loading ? (
        <div className="flex justify-center p-4">
          <Spinner />
        </div>
      ) : records.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">Nothing imported yet.</p>
      ) : (
        <ul className="max-h-56 overflow-y-auto">
          {records.map((record) => (
            <li
              key={record.id}
              className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="truncate text-xs text-foreground">{record.filename}</p>
                <p className="text-[11px] text-muted-foreground">
                  {record.format.toUpperCase()} · {record.insertedCount} added ·{" "}
                  {record.duplicateCount} duplicate ·{" "}
                  {record.warningCount > 0 ? `${record.warningCount} warning(s) · ` : ""}
                  {formatTimestamp(record.importedAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void remove(record)}
                className="shrink-0 rounded border border-border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        Deleting an import removes the markups it added. Markups that also arrived in another
        import stay, because they are stored once per company.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issue detail tab
// ---------------------------------------------------------------------------

export function OnxMapsIssueTab({ context }: PluginDetailTabProps) {
  return (
    <ErrorBoundary>
      <IssueTabInner companyId={context.companyId} issueId={context.entityId} />
    </ErrorBoundary>
  );
}

function IssueTabInner({ companyId, issueId }: { companyId: string | null; issueId: string }) {
  const [search, setSearch] = useState("");
  const [picking, setPicking] = useState(false);
  const toast = usePluginToast();

  const links = usePluginData<IssueLinksPayload>("issue-links", { companyId, issueId });
  const candidates = usePluginData<MarkupsPayload>(DATA_KEYS.markups, {
    companyId,
    search: search.trim() || undefined,
    limit: 50,
  });
  const link = usePluginAction("link-markup");
  const unlink = usePluginAction("unlink-markup");

  if (!companyId) {
    return <p className="p-3 text-xs text-muted-foreground">No active company.</p>;
  }

  const attach = async (markupId: string) => {
    try {
      await link({ companyId, issueId, markupId });
      links.refresh();
      setPicking(false);
      setSearch("");
    } catch (error) {
      toast({ title: "Could not attach markup", body: errorMessage(error), tone: "error" });
    }
  };

  const detach = async (markupId: string) => {
    try {
      await unlink({ companyId, issueId, markupId });
      links.refresh();
    } catch (error) {
      toast({ title: "Could not remove markup", body: errorMessage(error), tone: "error" });
    }
  };

  const attached = links.data?.links ?? [];
  const attachedIds = new Set(attached.map((entry) => entry.markupId));

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">onX Markups</h3>
        <button
          type="button"
          onClick={() => setPicking((value) => !value)}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent"
        >
          {picking ? "Cancel" : "Attach markup"}
        </button>
      </div>

      {picking && (
        <div className="rounded-md border border-border p-2">
          <input
            type="search"
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search your imported onX markups…"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground"
          />
          <ul className="mt-2 max-h-56 overflow-y-auto">
            {(candidates.data?.markups ?? [])
              .filter((markup) => !attachedIds.has(markup.id))
              .map((markup) => (
                <li key={markup.id}>
                  <button
                    type="button"
                    onClick={() => void attach(markup.id)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent"
                  >
                    <KindDot kind={markup.kind} />
                    <span className="truncate">{markup.name ?? "(unnamed)"}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                      {KIND_LABELS[markup.kind]}
                    </span>
                  </button>
                </li>
              ))}
            {!candidates.loading && (candidates.data?.markups ?? []).length === 0 && (
              <li className="px-2 py-2 text-xs text-muted-foreground">
                Nothing matched. Import an onX export first.
              </li>
            )}
          </ul>
        </div>
      )}

      {links.loading && attached.length === 0 ? (
        <div className="flex justify-center p-4">
          <Spinner />
        </div>
      ) : attached.length === 0 ? (
        <EmptyState
          title="No markups attached"
          body="Attach a waypoint, track, or area shape so whoever picks up this issue knows exactly where it is."
        />
      ) : (
        <>
          <div className="h-56">
            <MarkupMap
              markups={attached.map((entry) => entry.markup)}
              selectedId={null}
              onSelect={() => undefined}
              tileUrl={DEFAULT_CONFIG.basemapTileUrl}
              attribution={DEFAULT_CONFIG.basemapAttribution}
            />
          </div>
          <ul className="flex flex-col gap-1">
            {attached.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-xs text-foreground">
                    <KindDot kind={entry.markup.kind} />
                    {entry.markup.name ?? "(unnamed)"}
                  </p>
                  <p className="pl-[18px] font-mono text-[11px] text-muted-foreground">
                    {formatCoords(entry.markup.lat, entry.markup.lon)}
                    {entry.markup.stats.distanceMeters !== null
                      ? ` · ${formatDistance(entry.markup.stats.distanceMeters)}`
                      : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void detach(entry.markupId)}
                  className="shrink-0 rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar + settings
// ---------------------------------------------------------------------------

export function OnxMapsSidebarLink({ context }: PluginSidebarProps) {
  const host = useHostContext();
  const prefix = context.companyPrefix ?? host.companyPrefix;
  const href = prefix ? `/${prefix}/plugins/${PAGE_ROUTE}` : `/plugins/${PAGE_ROUTE}`;

  return (
    <a
      href={href}
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
    >
      <span aria-hidden="true" className="shrink-0">
        🗺️
      </span>
      <span className="flex-1 truncate">onX Maps</span>
    </a>
  );
}

export function OnxMapsSettingsPage(_props: PluginSettingsPageProps) {
  return (
    <div className="flex flex-col gap-3 p-4 text-sm text-foreground">
      <h1 className="text-base font-semibold">onX Maps</h1>

      <section className="flex flex-col gap-1.5">
        <h2 className="text-sm font-medium">How data gets in</h2>
        <p className="text-xs text-muted-foreground">
          onX does not publish an API, so there is nothing to connect an account to. The supported
          path is the one onX documents: export Markups from the onX Web Map as GPX or KML, then
          import that file on the onX Maps page. onX caps an export at 4 MB and 3000 markups, and
          this plugin enforces the same limits in both directions.
        </p>
      </section>

      <section className="flex flex-col gap-1.5">
        <h2 className="text-sm font-medium">Format choice</h2>
        <p className="text-xs text-muted-foreground">
          Export tracks as GPX and lines or area shapes as KML. Going the other way is lossy —
          onX converts a track to a line when it reads KML, and a line or shape to a track when it
          reads GPX. The exporter warns before you download a file that will be converted.
        </p>
      </section>

      <section className="flex flex-col gap-1.5">
        <h2 className="text-sm font-medium">Basemap</h2>
        <p className="text-xs text-muted-foreground">
          onX&apos;s basemap and its landowner and public-land layers are licensed for use inside
          onX&apos;s own apps and cannot be re-served here. The map draws your markups over
          whichever XYZ raster tile provider is configured in this plugin&apos;s instance settings
          (OpenStreetMap by default). Clear the tile URL to draw markups with no basemap at all.
        </p>
      </section>
    </div>
  );
}
