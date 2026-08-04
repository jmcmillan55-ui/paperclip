/**
 * Database access for imported onX markups.
 *
 * `ctx.db` is deliberately restrictive: `query()` accepts a single SELECT (and
 * may not contain the words insert/update/delete/create/…), `execute()` accepts
 * a single INSERT/UPDATE/DELETE targeting this plugin's namespace. Every table
 * reference is therefore schema-qualified, and proximity ranking is done in
 * JavaScript over a bounding-box prefilter rather than in SQL.
 */

import { createHash, randomUUID } from "node:crypto";

import { DB_NAMESPACE } from "./constants.js";
import { haversineMeters } from "./geo.js";
import type {
  Geometry,
  ImportRecord,
  MarkupKind,
  ParsedMarkup,
  SourceFormat,
  StoredMarkup,
} from "./model.js";

/** The slice of `PluginContext` this module needs. */
export interface StoreDb {
  namespace: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

const IMPORTS = `${DB_NAMESPACE}.onx_imports`;
const MARKUPS = `${DB_NAMESPACE}.onx_markups`;
const LINKS = `${DB_NAMESPACE}.onx_issue_links`;

/**
 * Postgres caps a statement at 65535 bind parameters. At 24 columns per row a
 * 3000-markup file would blow past that in one statement, so inserts are
 * chunked well under the limit.
 */
const INSERT_CHUNK_ROWS = 200;

const MARKUP_COLUMNS = `
  id, company_id, import_id, external_key, kind, name, description, folder_path, symbol,
  lat, lon, elevation_meters, source_time, geometry,
  min_lon, min_lat, max_lon, max_lat,
  point_count, distance_meters, elevation_gain_meters, elevation_loss_meters,
  min_elevation_meters, max_elevation_meters, area_square_meters,
  created_at, updated_at
`;

export function contentHash(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

interface MarkupRow {
  id: string;
  company_id: string;
  import_id: string;
  external_key: string;
  kind: string;
  name: string | null;
  description: string | null;
  folder_path: string | null;
  symbol: string | null;
  lat: number;
  lon: number;
  elevation_meters: number | null;
  source_time: string | null;
  geometry: Geometry | string;
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
  point_count: number;
  distance_meters: number | null;
  elevation_gain_meters: number | null;
  elevation_loss_meters: number | null;
  min_elevation_meters: number | null;
  max_elevation_meters: number | null;
  area_square_meters: number | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function asIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoredMarkup(row: MarkupRow): StoredMarkup {
  // node-postgres decodes jsonb for us, but a driver that hands back text
  // should not turn into a silent `[object Object]` downstream.
  const geometry: Geometry =
    typeof row.geometry === "string" ? (JSON.parse(row.geometry) as Geometry) : row.geometry;

  return {
    id: row.id,
    companyId: row.company_id,
    importId: row.import_id,
    externalKey: row.external_key,
    kind: row.kind as MarkupKind,
    name: row.name,
    description: row.description,
    folderPath: row.folder_path,
    symbol: row.symbol,
    lat: Number(row.lat),
    lon: Number(row.lon),
    elevationMeters: row.elevation_meters === null ? null : Number(row.elevation_meters),
    sourceTime: row.source_time,
    geometry,
    bounds: {
      minLon: Number(row.min_lon),
      minLat: Number(row.min_lat),
      maxLon: Number(row.max_lon),
      maxLat: Number(row.max_lat),
    },
    stats: {
      pointCount: Number(row.point_count),
      distanceMeters: row.distance_meters === null ? null : Number(row.distance_meters),
      elevationGainMeters:
        row.elevation_gain_meters === null ? null : Number(row.elevation_gain_meters),
      elevationLossMeters:
        row.elevation_loss_meters === null ? null : Number(row.elevation_loss_meters),
      minElevationMeters:
        row.min_elevation_meters === null ? null : Number(row.min_elevation_meters),
      maxElevationMeters:
        row.max_elevation_meters === null ? null : Number(row.max_elevation_meters),
      areaSquareMeters: row.area_square_meters === null ? null : Number(row.area_square_meters),
    },
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export interface RecordImportInput {
  companyId: string;
  filename: string;
  format: SourceFormat;
  contentHash: string;
  byteSize: number;
  warnings: string[];
  importedBy: string | null;
}

/** Returns the existing import when this exact file was already uploaded. */
export async function findImportByHash(
  db: StoreDb,
  companyId: string,
  hash: string,
): Promise<ImportRecord | null> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, company_id, filename, format, content_hash, byte_size, markup_count,
            inserted_count, duplicate_count, warnings, imported_by, imported_at
       FROM ${IMPORTS}
      WHERE company_id = $1 AND content_hash = $2
      LIMIT 1`,
    [companyId, hash],
  );
  const row = rows[0];
  return row ? toImportRecord(row) : null;
}

function toImportRecord(row: Record<string, unknown>): ImportRecord {
  const warnings = row.warnings;
  const parsed = typeof warnings === "string" ? JSON.parse(warnings) : warnings;
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    filename: String(row.filename),
    format: String(row.format) as SourceFormat,
    contentHash: String(row.content_hash),
    byteSize: Number(row.byte_size),
    markupCount: Number(row.markup_count),
    insertedCount: Number(row.inserted_count),
    duplicateCount: Number(row.duplicate_count),
    warningCount: Array.isArray(parsed) ? parsed.length : 0,
    importedAt: asIso(row.imported_at as string | Date),
    importedBy: row.imported_by === null ? null : String(row.imported_by),
  };
}

export async function createImport(db: StoreDb, input: RecordImportInput): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO ${IMPORTS}
       (id, company_id, filename, format, content_hash, byte_size, warnings, imported_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      id,
      input.companyId,
      input.filename,
      input.format,
      input.contentHash,
      input.byteSize,
      JSON.stringify(input.warnings),
      input.importedBy,
    ],
  );
  return id;
}

export async function finalizeImport(
  db: StoreDb,
  importId: string,
  counts: { markupCount: number; insertedCount: number; duplicateCount: number },
): Promise<void> {
  await db.execute(
    `UPDATE ${IMPORTS}
        SET markup_count = $2, inserted_count = $3, duplicate_count = $4
      WHERE id = $1`,
    [importId, counts.markupCount, counts.insertedCount, counts.duplicateCount],
  );
}

export async function listImports(db: StoreDb, companyId: string): Promise<ImportRecord[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, company_id, filename, format, content_hash, byte_size, markup_count,
            inserted_count, duplicate_count, warnings, imported_by, imported_at
       FROM ${IMPORTS}
      WHERE company_id = $1
      ORDER BY imported_at DESC
      LIMIT 200`,
    [companyId],
  );
  return rows.map(toImportRecord);
}

export async function deleteImport(
  db: StoreDb,
  companyId: string,
  importId: string,
): Promise<number> {
  // Markups cascade via the import_id foreign key.
  const result = await db.execute(
    `DELETE FROM ${IMPORTS} WHERE company_id = $1 AND id = $2`,
    [companyId, importId],
  );
  return result.rowCount;
}

// ---------------------------------------------------------------------------
// Markups
// ---------------------------------------------------------------------------

export interface InsertMarkupsResult {
  insertedCount: number;
  duplicateCount: number;
}

export async function insertMarkups(
  db: StoreDb,
  companyId: string,
  importId: string,
  markups: ParsedMarkup[],
): Promise<InsertMarkupsResult> {
  if (markups.length === 0) return { insertedCount: 0, duplicateCount: 0 };

  // Collapse duplicates inside the file itself first — a single INSERT cannot
  // apply ON CONFLICT twice to the same key within one statement.
  const unique = new Map<string, ParsedMarkup>();
  for (const markup of markups) {
    if (!unique.has(markup.externalKey)) unique.set(markup.externalKey, markup);
  }
  const rows = [...unique.values()];

  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_ROWS) {
    const chunk = rows.slice(offset, offset + INSERT_CHUNK_ROWS);
    const params: unknown[] = [];
    const valueGroups = chunk.map((markup) => {
      const base = params.length;
      params.push(
        randomUUID(),
        companyId,
        importId,
        markup.externalKey,
        markup.kind,
        markup.name,
        markup.description,
        markup.folderPath,
        markup.symbol,
        markup.lat,
        markup.lon,
        markup.elevationMeters,
        markup.sourceTime,
        JSON.stringify(markup.geometry),
        markup.bounds.minLon,
        markup.bounds.minLat,
        markup.bounds.maxLon,
        markup.bounds.maxLat,
        markup.stats.pointCount,
        markup.stats.distanceMeters,
        markup.stats.elevationGainMeters,
        markup.stats.elevationLossMeters,
        markup.stats.minElevationMeters,
        markup.stats.maxElevationMeters,
        markup.stats.areaSquareMeters,
      );
      const placeholders = Array.from({ length: 25 }, (_, index) => {
        const position = base + index + 1;
        // geometry is the 14th value and needs an explicit jsonb cast.
        return index === 13 ? `$${position}::jsonb` : `$${position}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    const result = await db.execute(
      `INSERT INTO ${MARKUPS}
         (id, company_id, import_id, external_key, kind, name, description, folder_path, symbol,
          lat, lon, elevation_meters, source_time, geometry,
          min_lon, min_lat, max_lon, max_lat,
          point_count, distance_meters, elevation_gain_meters, elevation_loss_meters,
          min_elevation_meters, max_elevation_meters, area_square_meters)
       VALUES ${valueGroups.join(", ")}
       ON CONFLICT (company_id, external_key) DO NOTHING`,
      params,
    );
    inserted += result.rowCount;
  }

  // Everything the file described but that did not become a new row: repeats
  // within the file plus markups already imported from an earlier export.
  return { insertedCount: inserted, duplicateCount: markups.length - inserted };
}

export interface MarkupFilters {
  kinds?: MarkupKind[];
  folderPath?: string | null;
  search?: string | null;
  importId?: string | null;
  limit?: number;
  offset?: number;
}

export async function listMarkups(
  db: StoreDb,
  companyId: string,
  filters: MarkupFilters = {},
): Promise<StoredMarkup[]> {
  const params: unknown[] = [companyId];
  const clauses = ["company_id = $1"];

  if (filters.kinds && filters.kinds.length > 0) {
    params.push(filters.kinds);
    clauses.push(`kind = ANY($${params.length}::text[])`);
  }
  if (filters.folderPath !== undefined && filters.folderPath !== null) {
    params.push(filters.folderPath);
    clauses.push(`folder_path = $${params.length}`);
  }
  if (filters.importId) {
    params.push(filters.importId);
    clauses.push(`import_id = $${params.length}`);
  }
  if (filters.search && filters.search.trim().length > 0) {
    params.push(`%${escapeLike(filters.search.trim())}%`);
    const index = params.length;
    clauses.push(
      `(name ILIKE $${index} ESCAPE '\\' OR description ILIKE $${index} ESCAPE '\\' OR folder_path ILIKE $${index} ESCAPE '\\')`,
    );
  }

  params.push(clampLimit(filters.limit, 500, 2000));
  const limitIndex = params.length;
  params.push(Math.max(0, Math.trunc(filters.offset ?? 0)));
  const offsetIndex = params.length;

  const rows = await db.query<MarkupRow>(
    `SELECT ${MARKUP_COLUMNS}
       FROM ${MARKUPS}
      WHERE ${clauses.join(" AND ")}
      ORDER BY kind, name NULLS LAST, id
      LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    params,
  );
  return rows.map(toStoredMarkup);
}

export async function getMarkupById(
  db: StoreDb,
  companyId: string,
  id: string,
): Promise<StoredMarkup | null> {
  const rows = await db.query<MarkupRow>(
    `SELECT ${MARKUP_COLUMNS} FROM ${MARKUPS} WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, id],
  );
  return rows[0] ? toStoredMarkup(rows[0]) : null;
}

export async function getMarkupByExternalKey(
  db: StoreDb,
  companyId: string,
  externalKey: string,
): Promise<StoredMarkup | null> {
  const rows = await db.query<MarkupRow>(
    `SELECT ${MARKUP_COLUMNS} FROM ${MARKUPS} WHERE company_id = $1 AND external_key = $2 LIMIT 1`,
    [companyId, externalKey],
  );
  return rows[0] ? toStoredMarkup(rows[0]) : null;
}

export interface NearbyMarkup {
  markup: StoredMarkup;
  distanceMeters: number;
}

/**
 * Markups whose representative point falls within `radiusMeters`.
 *
 * A latitude/longitude window narrows the scan in SQL, then true great-circle
 * distance decides membership and ordering — the window is a superset of the
 * circle, never a subset, so nothing inside the radius is missed.
 */
export async function markupsNear(
  db: StoreDb,
  companyId: string,
  lat: number,
  lon: number,
  radiusMeters: number,
  limit = 25,
): Promise<NearbyMarkup[]> {
  const latDelta = radiusMeters / 111_320;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // Near the poles the longitude window degenerates; fall back to the full
  // range rather than dividing by ~0.
  const lonDelta = Math.abs(cosLat) < 1e-6 ? 180 : Math.min(180, radiusMeters / (111_320 * cosLat));

  const rows = await db.query<MarkupRow>(
    `SELECT ${MARKUP_COLUMNS}
       FROM ${MARKUPS}
      WHERE company_id = $1
        AND lat BETWEEN $2 AND $3
        AND lon BETWEEN $4 AND $5
      LIMIT 5000`,
    [companyId, lat - latDelta, lat + latDelta, lon - lonDelta, lon + lonDelta],
  );

  return rows
    .map((row) => {
      const markup = toStoredMarkup(row);
      return {
        markup,
        distanceMeters: haversineMeters([lon, lat], [markup.lon, markup.lat]),
      };
    })
    .filter((entry) => entry.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, clampLimit(limit, 25, 500));
}

export interface FolderSummary {
  folderPath: string | null;
  markupCount: number;
}

export async function listFolders(db: StoreDb, companyId: string): Promise<FolderSummary[]> {
  const rows = await db.query<{ folder_path: string | null; markup_count: string | number }>(
    `SELECT folder_path, COUNT(*) AS markup_count
       FROM ${MARKUPS}
      WHERE company_id = $1
      GROUP BY folder_path
      ORDER BY folder_path NULLS FIRST`,
    [companyId],
  );
  return rows.map((row) => ({
    folderPath: row.folder_path,
    markupCount: Number(row.markup_count),
  }));
}

export interface CompanyOverview {
  markupCount: number;
  importCount: number;
  byKind: Record<string, number>;
  bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number } | null;
  lastImportedAt: string | null;
}

export async function getOverview(db: StoreDb, companyId: string): Promise<CompanyOverview> {
  const [kindRows, boundsRows, importRows] = await Promise.all([
    db.query<{ kind: string; markup_count: string | number }>(
      `SELECT kind, COUNT(*) AS markup_count
         FROM ${MARKUPS}
        WHERE company_id = $1
        GROUP BY kind`,
      [companyId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT MIN(min_lon) AS min_lon, MIN(min_lat) AS min_lat,
              MAX(max_lon) AS max_lon, MAX(max_lat) AS max_lat
         FROM ${MARKUPS}
        WHERE company_id = $1`,
      [companyId],
    ),
    db.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS import_count, MAX(imported_at) AS last_imported_at
         FROM ${IMPORTS}
        WHERE company_id = $1`,
      [companyId],
    ),
  ]);

  const byKind: Record<string, number> = {};
  let markupCount = 0;
  for (const row of kindRows) {
    const count = Number(row.markup_count);
    byKind[row.kind] = count;
    markupCount += count;
  }

  const boundsRow = boundsRows[0];
  const minLon = boundsRow?.min_lon;
  const bounds =
    minLon === null || minLon === undefined
      ? null
      : {
          minLon: Number(boundsRow!.min_lon),
          minLat: Number(boundsRow!.min_lat),
          maxLon: Number(boundsRow!.max_lon),
          maxLat: Number(boundsRow!.max_lat),
        };

  const importRow = importRows[0];
  const lastImportedAt = importRow?.last_imported_at;

  return {
    markupCount,
    importCount: Number(importRow?.import_count ?? 0),
    byKind,
    bounds,
    lastImportedAt: lastImportedAt ? asIso(lastImportedAt as string | Date) : null,
  };
}

// ---------------------------------------------------------------------------
// Issue links
// ---------------------------------------------------------------------------

export interface IssueLink {
  id: string;
  issueId: string;
  markupId: string;
  note: string | null;
  linkedBy: string | null;
  linkedAt: string;
  markup: StoredMarkup;
}

export async function linkMarkupToIssue(
  db: StoreDb,
  companyId: string,
  issueId: string,
  markupId: string,
  note: string | null,
  linkedBy: string | null,
): Promise<{ linked: boolean }> {
  // Confirms the markup belongs to this company before creating the link, so
  // a caller cannot attach another company's markup by guessing an id.
  const markup = await getMarkupById(db, companyId, markupId);
  if (!markup) {
    throw new Error(`No onX markup ${markupId} in this company`);
  }

  const result = await db.execute(
    `INSERT INTO ${LINKS} (id, company_id, issue_id, markup_id, note, linked_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (issue_id, markup_id) DO NOTHING`,
    [randomUUID(), companyId, issueId, markupId, note, linkedBy],
  );
  return { linked: result.rowCount > 0 };
}

export async function unlinkMarkupFromIssue(
  db: StoreDb,
  companyId: string,
  issueId: string,
  markupId: string,
): Promise<{ unlinked: boolean }> {
  const result = await db.execute(
    `DELETE FROM ${LINKS} WHERE company_id = $1 AND issue_id = $2 AND markup_id = $3`,
    [companyId, issueId, markupId],
  );
  return { unlinked: result.rowCount > 0 };
}

export async function listIssueLinks(
  db: StoreDb,
  companyId: string,
  issueId: string,
): Promise<IssueLink[]> {
  const rows = await db.query<MarkupRow & Record<string, unknown>>(
    `SELECT link.id AS link_id, link.issue_id, link.markup_id, link.note,
            link.linked_by, link.linked_at,
            ${MARKUP_COLUMNS.trim()
              .split(/,\s*/)
              .map((column) => `markup.${column}`)
              .join(", ")}
       FROM ${LINKS} AS link
       JOIN ${MARKUPS} AS markup ON markup.id = link.markup_id
      WHERE link.company_id = $1 AND link.issue_id = $2
      ORDER BY link.linked_at DESC`,
    [companyId, issueId],
  );

  return rows.map((row) => ({
    id: String(row.link_id),
    issueId: String(row.issue_id),
    markupId: String(row.markup_id),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    linkedBy: row.linked_by === null || row.linked_by === undefined ? null : String(row.linked_by),
    linkedAt: asIso(row.linked_at as string | Date),
    markup: toStoredMarkup(row),
  }));
}

/** Issues a markup is attached to, for the markup detail panel. */
export async function listMarkupIssueIds(
  db: StoreDb,
  companyId: string,
  markupId: string,
): Promise<string[]> {
  const rows = await db.query<{ issue_id: string }>(
    `SELECT issue_id FROM ${LINKS} WHERE company_id = $1 AND markup_id = $2`,
    [companyId, markupId],
  );
  return rows.map((row) => String(row.issue_id));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape LIKE wildcards so a user searching for `50%` does not match everything. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}
