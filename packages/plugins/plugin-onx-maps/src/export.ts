/**
 * GPX and KML writers.
 *
 * Output is aimed squarely at being re-importable by the onX Web Map, so the
 * onX ceilings (4 MB, 3000 markups) are enforced here rather than left for
 * onX to reject after the fact. Format choice is lossy in a documented way —
 * `exportWarnings()` reports what a given format will flatten so the caller
 * can surface it before the user uploads the file to onX.
 */

import { ONX_MAX_IMPORT_BYTES, ONX_MAX_MARKUPS_PER_FILE } from "./constants.js";
import type { ParsedMarkup, Position, SourceFormat } from "./model.js";

export class OnxExportError extends Error {}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Drop control characters XML 1.0 cannot represent at all, even escaped.
 * Tab, LF, and CR are the only characters below U+0020 that are legal.
 */
function sanitize(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function tag(name: string, value: string | null): string {
  if (value === null) return "";
  const clean = sanitize(value).trim();
  if (clean.length === 0) return "";
  return `<${name}>${escapeXml(clean)}</${name}>`;
}

function coord(value: number): string {
  return value.toFixed(7).replace(/\.?0+$/, "");
}

function positionsOfMarkup(markup: ParsedMarkup): Position[] {
  if (markup.geometry.type === "Point") return [markup.geometry.coordinates];
  if (markup.geometry.type === "LineString") return markup.geometry.coordinates;
  return markup.geometry.coordinates[0] ?? [];
}

/**
 * Describe what the chosen format will change about these markups, following
 * onX's own conversion rules.
 */
export function exportWarnings(markups: ParsedMarkup[], format: SourceFormat): string[] {
  const warnings: string[] = [];
  const count = (predicate: (markup: ParsedMarkup) => boolean): number =>
    markups.filter(predicate).length;

  if (format === "gpx") {
    const areas = count((markup) => markup.kind === "area");
    const lines = count((markup) => markup.kind === "line");
    if (areas > 0) {
      warnings.push(
        `${areas} area shape(s) will import into onX as Tracks. Export as KML to keep them as shapes.`,
      );
    }
    if (lines > 0) {
      warnings.push(
        `${lines} line(s) will import into onX as Tracks. Export as KML to keep them as lines.`,
      );
    }
  } else {
    const tracks = count((markup) => markup.kind === "track");
    if (tracks > 0) {
      warnings.push(
        `${tracks} track(s) will import into onX as Lines. Export as GPX to keep them as tracks.`,
      );
    }
  }

  return warnings;
}

export interface ExportResult {
  filename: string;
  format: SourceFormat;
  content: string;
  byteSize: number;
  markupCount: number;
  warnings: string[];
}

function assertWithinOnxLimits(markups: ParsedMarkup[], content: string): number {
  if (markups.length > ONX_MAX_MARKUPS_PER_FILE) {
    throw new OnxExportError(
      `onX rejects imports over ${ONX_MAX_MARKUPS_PER_FILE} markups; this export has ${markups.length}. Filter by folder or type and export again.`,
    );
  }
  const byteSize = Buffer.byteLength(content, "utf8");
  if (byteSize > ONX_MAX_IMPORT_BYTES) {
    throw new OnxExportError(
      `onX rejects imports over 4 MB; this export is ${(byteSize / 1024 / 1024).toFixed(1)} MB. Export a smaller selection.`,
    );
  }
  return byteSize;
}

export function toGpx(markups: ParsedMarkup[], filenameStem = "paperclip-onx"): ExportResult {
  const waypoints = markups.filter((markup) => markup.kind === "waypoint");
  // GPX has a native <rte>, so routes round-trip losslessly and must not be
  // flattened into <trk> — doing so changes their kind on re-import, which
  // changes their dedupe key and produces a duplicate of the same markup.
  const routes = markups.filter((markup) => markup.kind === "route");
  const paths = markups.filter(
    (markup) => markup.kind !== "waypoint" && markup.kind !== "route",
  );

  const body: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Paperclip onX Maps plugin" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata>${tag("name", filenameStem)}<time>${new Date().toISOString()}</time></metadata>`,
  ];

  for (const markup of waypoints) {
    const [lon, lat, ele] = markup.geometry.type === "Point"
      ? markup.geometry.coordinates
      : [markup.lon, markup.lat, undefined];
    body.push(
      `  <wpt lat="${coord(lat)}" lon="${coord(lon)}">` +
        (typeof ele === "number" ? tag("ele", String(ele)) : "") +
        tag("time", markup.sourceTime) +
        tag("name", markup.name) +
        tag("desc", markup.description) +
        tag("sym", markup.symbol) +
        `</wpt>`,
    );
  }

  for (const markup of routes) {
    const positions = positionsOfMarkup(markup);
    if (positions.length < 2) continue;
    const points = positions
      .map((position) => {
        const ele = position.length > 2 ? tag("ele", String(position[2])) : "";
        return `    <rtept lat="${coord(position[1])}" lon="${coord(position[0])}">${ele}</rtept>`;
      })
      .join("\n");
    body.push(
      `  <rte>${tag("name", markup.name)}${tag("desc", markup.description)}\n${points}\n  </rte>`,
    );
  }

  for (const markup of paths) {
    const positions = positionsOfMarkup(markup);
    if (positions.length < 2) continue;
    // A polygon has to be closed explicitly; GPX has no area primitive.
    const ring =
      markup.geometry.type === "Polygon" &&
      (positions[0]![0] !== positions[positions.length - 1]![0] ||
        positions[0]![1] !== positions[positions.length - 1]![1])
        ? [...positions, positions[0]!]
        : positions;

    const points = ring
      .map((position) => {
        const ele = position.length > 2 ? tag("ele", String(position[2])) : "";
        return `      <trkpt lat="${coord(position[1])}" lon="${coord(position[0])}">${ele}</trkpt>`;
      })
      .join("\n");

    body.push(
      `  <trk>${tag("name", markup.name)}${tag("desc", markup.description)}\n    <trkseg>\n${points}\n    </trkseg>\n  </trk>`,
    );
  }

  body.push("</gpx>", "");
  const content = body.join("\n");

  return {
    filename: `${filenameStem}.gpx`,
    format: "gpx",
    content,
    byteSize: assertWithinOnxLimits(markups, content),
    markupCount: markups.length,
    warnings: exportWarnings(markups, "gpx"),
  };
}

export function toKml(markups: ParsedMarkup[], filenameStem = "paperclip-onx"): ExportResult {
  const grouped = new Map<string, ParsedMarkup[]>();
  for (const markup of markups) {
    const key = markup.folderPath ?? "";
    const bucket = grouped.get(key);
    if (bucket) bucket.push(markup);
    else grouped.set(key, [markup]);
  }

  const renderPlacemark = (markup: ParsedMarkup): string => {
    const positions = positionsOfMarkup(markup);
    if (positions.length === 0) return "";
    const asCoordinates = (list: Position[]): string =>
      list
        .map((position) =>
          `${coord(position[0])},${coord(position[1])},${position.length > 2 ? position[2] : 0}`,
        )
        .join(" ");

    let geometry: string;
    if (markup.geometry.type === "Point") {
      geometry = `<Point><coordinates>${asCoordinates(positions)}</coordinates></Point>`;
    } else if (markup.geometry.type === "LineString") {
      geometry = `<LineString><tessellate>1</tessellate><coordinates>${asCoordinates(positions)}</coordinates></LineString>`;
    } else {
      const ring =
        positions[0]![0] !== positions[positions.length - 1]![0] ||
        positions[0]![1] !== positions[positions.length - 1]![1]
          ? [...positions, positions[0]!]
          : positions;
      geometry =
        `<Polygon><outerBoundaryIs><LinearRing><coordinates>${asCoordinates(ring)}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
    }

    const timestamp = markup.sourceTime
      ? `<TimeStamp>${tag("when", markup.sourceTime)}</TimeStamp>`
      : "";

    return `      <Placemark>${tag("name", markup.name)}${tag("description", markup.description)}${timestamp}${geometry}</Placemark>`;
  };

  const sections: string[] = [];
  for (const [folder, items] of grouped) {
    const placemarks = items.map(renderPlacemark).filter((entry) => entry.length > 0);
    if (placemarks.length === 0) continue;
    if (folder.length === 0) {
      sections.push(placemarks.join("\n"));
    } else {
      // Nested onX folders are flattened to one level; KML has no way to
      // express the original path other than as a name.
      sections.push(
        `    <Folder>${tag("name", folder)}\n${placemarks.join("\n")}\n    </Folder>`,
      );
    }
  }

  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    "  <Document>",
    `    ${tag("name", filenameStem)}`,
    ...sections,
    "  </Document>",
    "</kml>",
    "",
  ].join("\n");

  const warnings = exportWarnings(markups, "kml");
  if ([...grouped.keys()].some((key) => key.includes(" / "))) {
    warnings.push("Nested folders are flattened to a single level of KML folders.");
  }

  return {
    filename: `${filenameStem}.kml`,
    format: "kml",
    content,
    byteSize: assertWithinOnxLimits(markups, content),
    markupCount: markups.length,
    warnings,
  };
}

export function exportMarkups(
  markups: ParsedMarkup[],
  format: SourceFormat,
  filenameStem?: string,
): ExportResult {
  return format === "gpx" ? toGpx(markups, filenameStem) : toKml(markups, filenameStem);
}
