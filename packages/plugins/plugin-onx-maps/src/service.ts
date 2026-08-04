/**
 * Import, query, and export operations shared by the agent tools, the UI
 * bridge handlers, and the scoped API routes.
 *
 * Every entry point takes an explicit `companyId` that the host has already
 * authorized — nothing here derives a company from caller-supplied data.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";

import { DEFAULT_CONFIG, ONX_MAX_IMPORT_BYTES, ONX_MAX_MARKUPS_PER_FILE } from "./constants.js";
import { exportMarkups, type ExportResult } from "./export.js";
import { metersToFeet, metersToMiles, squareMetersToAcres } from "./geo.js";
import type { MarkupKind, SourceFormat, StoredMarkup } from "./model.js";
import { MARKUP_KINDS } from "./model.js";
import { OnxParseError, parseOnxExport } from "./parse.js";
import * as store from "./store.js";

export class OnxServiceError extends Error {}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OnxConfig {
  basemapTileUrl: string;
  basemapAttribution: string;
  elevationGainThresholdMeters: number;
}

export async function readConfig(ctx: PluginContext, companyId: string): Promise<OnxConfig> {
  let raw: Record<string, unknown> = {};
  try {
    raw = (await ctx.config.get(companyId)) ?? {};
  } catch {
    // A plugin with no saved config yet is normal, not an error.
    raw = {};
  }

  const threshold = Number(raw.elevationGainThresholdMeters);
  return {
    basemapTileUrl:
      typeof raw.basemapTileUrl === "string" ? raw.basemapTileUrl : DEFAULT_CONFIG.basemapTileUrl,
    basemapAttribution:
      typeof raw.basemapAttribution === "string"
        ? raw.basemapAttribution
        : DEFAULT_CONFIG.basemapAttribution,
    elevationGainThresholdMeters:
      Number.isFinite(threshold) && threshold >= 0
        ? threshold
        : DEFAULT_CONFIG.elevationGainThresholdMeters,
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportInput {
  companyId: string;
  filename: string;
  /** Raw file text. GPX and KML are both XML, so no base64 hop is needed. */
  content: string;
  importedBy: string | null;
}

export interface ImportSummary {
  importId: string;
  filename: string;
  format: SourceFormat;
  markupCount: number;
  insertedCount: number;
  duplicateCount: number;
  warnings: string[];
  alreadyImported: boolean;
}

export async function importExport(
  ctx: PluginContext,
  input: ImportInput,
): Promise<ImportSummary> {
  const byteSize = Buffer.byteLength(input.content, "utf8");
  if (byteSize === 0) {
    throw new OnxServiceError("The uploaded file is empty.");
  }
  if (byteSize > ONX_MAX_IMPORT_BYTES) {
    throw new OnxServiceError(
      `File is ${(byteSize / 1024 / 1024).toFixed(1)} MB. onX exports are capped at 4 MB; export a smaller selection from the onX Web Map.`,
    );
  }

  const hash = store.contentHash(input.content);
  const existing = await store.findImportByHash(ctx.db, input.companyId, hash);
  if (existing) {
    return {
      importId: existing.id,
      filename: existing.filename,
      format: existing.format,
      markupCount: existing.markupCount,
      insertedCount: 0,
      duplicateCount: existing.markupCount,
      warnings: [
        `This exact file was already imported on ${existing.importedAt}. Nothing was changed.`,
      ],
      alreadyImported: true,
    };
  }

  const config = await readConfig(ctx, input.companyId);

  let parsed;
  try {
    parsed = parseOnxExport(input.content, {
      elevationGainThresholdMeters: config.elevationGainThresholdMeters,
    });
  } catch (error) {
    if (error instanceof OnxParseError) throw new OnxServiceError(error.message);
    throw error;
  }

  if (parsed.markups.length === 0) {
    throw new OnxServiceError(
      "No markups found in this file. Check that you exported Waypoints, Tracks, Lines, or Shapes from the onX Web Map.",
    );
  }
  if (parsed.markups.length > ONX_MAX_MARKUPS_PER_FILE) {
    throw new OnxServiceError(
      `File contains ${parsed.markups.length} markups; onX itself caps an export at ${ONX_MAX_MARKUPS_PER_FILE}. This file did not come from onX unmodified.`,
    );
  }

  const warnings = parsed.warnings.map((warning) => `#${warning.index}: ${warning.reason}`);
  const importId = await store.createImport(ctx.db, {
    companyId: input.companyId,
    filename: input.filename,
    format: parsed.format,
    contentHash: hash,
    byteSize,
    warnings,
    importedBy: input.importedBy,
  });

  const { insertedCount, duplicateCount } = await store.insertMarkups(
    ctx.db,
    input.companyId,
    importId,
    parsed.markups,
  );
  await store.finalizeImport(ctx.db, importId, {
    markupCount: parsed.markups.length,
    insertedCount,
    duplicateCount,
  });

  await ctx.activity.log({
    companyId: input.companyId,
    message: `Imported ${insertedCount} onX markup(s) from ${input.filename}`,
    entityType: "onx_import",
    entityId: importId,
    metadata: {
      format: parsed.format,
      markupCount: parsed.markups.length,
      insertedCount,
      duplicateCount,
      warningCount: warnings.length,
    },
  });

  return {
    importId,
    filename: input.filename,
    format: parsed.format,
    markupCount: parsed.markups.length,
    insertedCount,
    duplicateCount,
    warnings,
    alreadyImported: false,
  };
}

export async function deleteImport(
  ctx: PluginContext,
  companyId: string,
  importId: string,
): Promise<{ deleted: boolean }> {
  const deleted = await store.deleteImport(ctx.db, companyId, importId);
  if (deleted > 0) {
    await ctx.activity.log({
      companyId,
      message: "Deleted an onX import and its markups",
      entityType: "onx_import",
      entityId: importId,
    });
  }
  return { deleted: deleted > 0 };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export function parseKind(value: unknown): MarkupKind | undefined {
  return typeof value === "string" && (MARKUP_KINDS as readonly string[]).includes(value)
    ? (value as MarkupKind)
    : undefined;
}

export interface SearchInput {
  companyId: string;
  query?: string | null;
  kind?: MarkupKind;
  folderPath?: string | null;
  limit?: number;
}

export async function searchMarkups(
  ctx: PluginContext,
  input: SearchInput,
): Promise<StoredMarkup[]> {
  return store.listMarkups(ctx.db, input.companyId, {
    search: input.query ?? null,
    kinds: input.kind ? [input.kind] : undefined,
    folderPath: input.folderPath ?? undefined,
    limit: store.clampLimit(input.limit, 25, 200),
  });
}

const METERS_PER_MILE = 1609.344;

export async function markupsNear(
  ctx: PluginContext,
  input: {
    companyId: string;
    lat: number;
    lon: number;
    radiusMiles?: number;
    kind?: MarkupKind;
    limit?: number;
  },
): Promise<store.NearbyMarkup[]> {
  if (!Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90) {
    throw new OnxServiceError("lat must be a number between -90 and 90.");
  }
  if (!Number.isFinite(input.lon) || input.lon < -180 || input.lon > 180) {
    throw new OnxServiceError("lon must be a number between -180 and 180.");
  }

  const radiusMiles =
    typeof input.radiusMiles === "number" && Number.isFinite(input.radiusMiles)
      ? Math.min(500, Math.max(0.01, input.radiusMiles))
      : 5;

  const results = await store.markupsNear(
    ctx.db,
    input.companyId,
    input.lat,
    input.lon,
    radiusMiles * METERS_PER_MILE,
    store.clampLimit(input.limit, 25, 200),
  );

  return input.kind ? results.filter((entry) => entry.markup.kind === input.kind) : results;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportInput {
  companyId: string;
  format: SourceFormat;
  markupIds?: string[];
  kind?: MarkupKind;
  folderPath?: string | null;
  search?: string | null;
}

export async function buildExport(
  ctx: PluginContext,
  input: ExportInput,
): Promise<ExportResult> {
  if (input.format !== "gpx" && input.format !== "kml") {
    throw new OnxServiceError('format must be "gpx" or "kml".');
  }

  let markups: StoredMarkup[];
  if (input.markupIds && input.markupIds.length > 0) {
    const resolved = await Promise.all(
      input.markupIds.map((id) => store.getMarkupById(ctx.db, input.companyId, id)),
    );
    markups = resolved.filter((markup): markup is StoredMarkup => markup !== null);
    if (markups.length === 0) {
      throw new OnxServiceError("None of the requested markup ids exist in this company.");
    }
  } else {
    markups = await store.listMarkups(ctx.db, input.companyId, {
      kinds: input.kind ? [input.kind] : undefined,
      folderPath: input.folderPath ?? undefined,
      search: input.search ?? null,
      limit: ONX_MAX_MARKUPS_PER_FILE,
    });
    if (markups.length === 0) {
      throw new OnxServiceError("No markups match those filters.");
    }
  }

  const stem = `paperclip-onx-${new Date().toISOString().slice(0, 10)}`;
  return exportMarkups(markups, input.format, stem);
}

// ---------------------------------------------------------------------------
// Agent-facing formatting
// ---------------------------------------------------------------------------

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Compact per-markup shape returned to agents.
 *
 * Geometry is omitted by default: a scouting track can carry thousands of
 * points, and dumping them into an agent's context buys nothing that the
 * summary measurements do not already say.
 */
export function toAgentSummary(
  markup: StoredMarkup,
  options: { includeGeometry?: boolean } = {},
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    markupId: markup.id,
    kind: markup.kind,
    name: markup.name,
    description: markup.description,
    folderPath: markup.folderPath,
    symbol: markup.symbol,
    lat: round(markup.lat, 6),
    lon: round(markup.lon, 6),
    pointCount: markup.stats.pointCount,
  };

  if (markup.elevationMeters !== null) {
    summary.elevationFeet = round(metersToFeet(markup.elevationMeters), 0);
  }
  if (markup.stats.distanceMeters !== null) {
    summary.distanceMiles = round(metersToMiles(markup.stats.distanceMeters), 2);
  }
  if (markup.stats.elevationGainMeters !== null) {
    summary.elevationGainFeet = round(metersToFeet(markup.stats.elevationGainMeters), 0);
  }
  if (markup.stats.elevationLossMeters !== null) {
    summary.elevationLossFeet = round(metersToFeet(markup.stats.elevationLossMeters), 0);
  }
  if (markup.stats.areaSquareMeters !== null) {
    summary.areaAcres = round(squareMetersToAcres(markup.stats.areaSquareMeters), 2);
  }
  if (markup.sourceTime) {
    summary.recordedAt = markup.sourceTime;
  }
  if (options.includeGeometry) {
    summary.geometry = markup.geometry;
  }

  return summary;
}

/** One-line human-readable rendering used in tool text output. */
export function describeMarkup(markup: StoredMarkup): string {
  const parts = [`${markup.kind}: ${markup.name ?? "(unnamed)"}`];
  if (markup.folderPath) parts.push(`folder "${markup.folderPath}"`);
  parts.push(`${round(markup.lat, 5)}, ${round(markup.lon, 5)}`);
  if (markup.stats.distanceMeters !== null) {
    parts.push(`${round(metersToMiles(markup.stats.distanceMeters), 2)} mi`);
  }
  if (markup.stats.areaSquareMeters !== null) {
    parts.push(`${round(squareMetersToAcres(markup.stats.areaSquareMeters), 1)} acres`);
  }
  if (markup.stats.elevationGainMeters !== null && markup.stats.elevationGainMeters > 0) {
    parts.push(`+${round(metersToFeet(markup.stats.elevationGainMeters), 0)} ft`);
  }
  return parts.join(" · ");
}
