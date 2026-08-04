/**
 * Canonical markup model.
 *
 * onX exports GPX and KML with overlapping but non-identical vocabularies
 * (a GPX `<trk>` and a KML `<LineString>` can both describe the same drawn
 * line). Everything is normalized to this one shape at parse time so the
 * store, the tools, and the UI never branch on source format.
 *
 * Geometry is GeoJSON-compatible: coordinates are `[lon, lat]` (and an
 * optional third elevation element), longitude first.
 */

export type MarkupKind = "waypoint" | "track" | "route" | "line" | "area";

export const MARKUP_KINDS: readonly MarkupKind[] = [
  "waypoint",
  "track",
  "route",
  "line",
  "area",
] as const;

export type SourceFormat = "gpx" | "kml";

/** `[lon, lat]` or `[lon, lat, eleMeters]`. */
export type Position = [number, number] | [number, number, number];

export type Geometry =
  | { type: "Point"; coordinates: Position }
  | { type: "LineString"; coordinates: Position[] }
  /** Rings; outer ring first. onX area shapes are single-ring in practice. */
  | { type: "Polygon"; coordinates: Position[][] };

export interface Bounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface MarkupStats {
  pointCount: number;
  /** Path length along a line/track/route. Null for points and areas. */
  distanceMeters: number | null;
  /** Sum of positive elevation deltas above the noise threshold. */
  elevationGainMeters: number | null;
  elevationLossMeters: number | null;
  minElevationMeters: number | null;
  maxElevationMeters: number | null;
  /** Enclosed area for polygons. Null otherwise. */
  areaSquareMeters: number | null;
}

export interface ParsedMarkup {
  kind: MarkupKind;
  name: string | null;
  description: string | null;
  /** KML folder path (`"Elk 2025 / North Ridge"`), or null for flat GPX files. */
  folderPath: string | null;
  /** GPX `<sym>` or KML `<styleUrl>` — onX's icon selection, kept verbatim. */
  symbol: string | null;
  /** Representative point: the point itself, or the geometry centroid. */
  lat: number;
  lon: number;
  elevationMeters: number | null;
  /** GPX `<time>` / KML `<TimeStamp>` when present. */
  sourceTime: string | null;
  geometry: Geometry;
  bounds: Bounds;
  stats: MarkupStats;
  /**
   * Stable content-derived identity used for cross-import dedupe.
   *
   * onX GPX/KML exports carry no durable per-markup id, so re-exporting the
   * same waypoint produces a byte-different file with the same real-world
   * object. Hashing kind + name + rounded geometry makes repeat imports
   * converge instead of accumulating duplicates.
   */
  externalKey: string;
}

export interface ParseWarning {
  /** 1-based index of the offending element within its source collection. */
  index: number;
  reason: string;
}

export interface ParseResult {
  format: SourceFormat;
  markups: ParsedMarkup[];
  warnings: ParseWarning[];
}

export interface StoredMarkup extends ParsedMarkup {
  id: string;
  companyId: string;
  importId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImportRecord {
  id: string;
  companyId: string;
  filename: string;
  format: SourceFormat;
  contentHash: string;
  byteSize: number;
  markupCount: number;
  insertedCount: number;
  duplicateCount: number;
  warningCount: number;
  importedAt: string;
  importedBy: string | null;
}
