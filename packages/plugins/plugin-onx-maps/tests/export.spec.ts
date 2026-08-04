import { describe, expect, it } from "vitest";

import { ONX_MAX_MARKUPS_PER_FILE } from "../src/constants.js";
import { OnxExportError, exportMarkups, exportWarnings, toGpx, toKml } from "../src/export.js";
import type { ParsedMarkup } from "../src/model.js";
import { parseGpx, parseKml, parseOnxExport } from "../src/parse.js";
import { GPX_EXPORT, KML_EXPORT } from "./fixtures.js";

const gpxMarkups = parseOnxExport(GPX_EXPORT).markups;
const kmlMarkups = parseOnxExport(KML_EXPORT).markups;

describe("toGpx", () => {
  it("produces a parseable GPX document", () => {
    const result = toGpx(gpxMarkups);
    expect(result.format).toBe("gpx");
    expect(result.filename).toBe("paperclip-onx.gpx");
    expect(() => parseGpx(result.content)).not.toThrow();
  });

  it("round-trips waypoint identity, position and symbol", () => {
    const reparsed = parseGpx(toGpx(gpxMarkups).content).markups;
    const original = gpxMarkups.find((markup) => markup.name === "North Treestand")!;
    const copy = reparsed.find((markup) => markup.name === "North Treestand")!;

    expect(copy.kind).toBe("waypoint");
    expect(copy.lat).toBeCloseTo(original.lat, 7);
    expect(copy.lon).toBeCloseTo(original.lon, 7);
    expect(copy.symbol).toBe(original.symbol);
    expect(copy.description).toBe(original.description);
    // Identity survives the round trip, so re-importing dedupes.
    expect(copy.externalKey).toBe(original.externalKey);
  });

  it("preserves track geometry and distance", () => {
    const original = gpxMarkups.find((markup) => markup.kind === "track")!;
    const copy = parseGpx(toGpx([original]).content).markups[0]!;
    expect(copy.stats.pointCount).toBe(original.stats.pointCount);
    expect(copy.stats.distanceMeters!).toBeCloseTo(original.stats.distanceMeters!, 3);
    expect(copy.externalKey).toBe(original.externalKey);
  });

  it("closes a polygon when flattening it to a GPX track", () => {
    const area = kmlMarkups.find((markup) => markup.kind === "area")!;
    const copy = parseGpx(toGpx([area]).content).markups[0]!;
    expect(copy.kind).toBe("track");
    const coordinates = copy.geometry.type === "LineString" ? copy.geometry.coordinates : [];
    expect(coordinates[0]).toEqual(coordinates[coordinates.length - 1]);
  });

  it("escapes XML metacharacters in names and descriptions", () => {
    const hostile: ParsedMarkup = {
      ...gpxMarkups[0]!,
      name: `Stand <script>alert("x")</script> & 'more'`,
      description: "a < b > c & d",
    };
    const content = toGpx([hostile]).content;
    expect(content).not.toContain("<script>");
    expect(content).toContain("&lt;script&gt;");
    const copy = parseGpx(content).markups[0]!;
    expect(copy.name).toBe(hostile.name);
    expect(copy.description).toBe(hostile.description);
  });

  it("strips control characters XML cannot represent", () => {
    const control = String.fromCharCode(7);
    const markup: ParsedMarkup = { ...gpxMarkups[0]!, name: `Bell${control}Name` };
    const content = toGpx([markup]).content;
    expect(content).not.toContain(control);
    expect(parseGpx(content).markups[0]!.name).toBe("BellName");
  });
});

describe("toKml", () => {
  it("produces a parseable KML document", () => {
    const result = toKml(kmlMarkups);
    expect(result.format).toBe("kml");
    expect(() => parseKml(result.content)).not.toThrow();
  });

  it("round-trips a polygon as an area with a stable key", () => {
    const original = kmlMarkups.find((markup) => markup.kind === "area")!;
    const copy = parseKml(toKml([original]).content).markups[0]!;
    expect(copy.kind).toBe("area");
    expect(copy.stats.areaSquareMeters!).toBeCloseTo(original.stats.areaSquareMeters!, 0);
    expect(copy.externalKey).toBe(original.externalKey);
  });

  it("keeps folder grouping", () => {
    const copy = parseKml(toKml(kmlMarkups).content).markups;
    const wallow = copy.find((markup) => markup.name === "Wallow")!;
    expect(wallow.folderPath).toBe("Elk 2025 / North Ridge");
  });

  it("preserves elevation in coordinates", () => {
    const line = kmlMarkups.find((markup) => markup.kind === "line")!;
    const copy = parseKml(toKml([line]).content).markups[0]!;
    const coordinates = copy.geometry.type === "LineString" ? copy.geometry.coordinates : [];
    expect(coordinates[0]!.length).toBe(3);
    expect(coordinates[0]![2]).toBeCloseTo(1015, 3);
  });
});

describe("exportWarnings", () => {
  it("flags the conversions onX will apply on GPX import", () => {
    const warnings = exportWarnings(kmlMarkups, "gpx");
    expect(warnings.join(" ")).toMatch(/area shape\(s\) will import into onX as Tracks/);
    expect(warnings.join(" ")).toMatch(/line\(s\) will import into onX as Tracks/);
  });

  it("flags tracks becoming lines on KML import", () => {
    const warnings = exportWarnings(gpxMarkups, "kml");
    expect(warnings.join(" ")).toMatch(/track\(s\) will import into onX as Lines/);
  });

  it("says nothing when the format is lossless for the selection", () => {
    const waypointsOnly = gpxMarkups.filter((markup) => markup.kind === "waypoint");
    expect(exportWarnings(waypointsOnly, "gpx")).toEqual([]);
  });

  it("warns that nested KML folders get flattened", () => {
    expect(toKml(kmlMarkups).warnings.join(" ")).toMatch(/flattened/);
  });
});

describe("onX import ceilings", () => {
  it("refuses to emit more markups than onX will accept", () => {
    const many: ParsedMarkup[] = Array.from(
      { length: ONX_MAX_MARKUPS_PER_FILE + 1 },
      (_, index) => ({ ...gpxMarkups[0]!, name: `Waypoint ${index}` }),
    );
    expect(() => toGpx(many)).toThrow(OnxExportError);
    expect(() => toGpx(many)).toThrow(/3000 markups/);
  });

  it("reports the byte size of an accepted export", () => {
    const result = toGpx(gpxMarkups);
    expect(result.byteSize).toBe(Buffer.byteLength(result.content, "utf8"));
    expect(result.markupCount).toBe(gpxMarkups.length);
  });
});

describe("exportMarkups", () => {
  it("dispatches on the requested format and honours the filename stem", () => {
    expect(exportMarkups(gpxMarkups, "gpx", "scouting").filename).toBe("scouting.gpx");
    expect(exportMarkups(gpxMarkups, "kml", "scouting").filename).toBe("scouting.kml");
  });

  it("handles an empty selection without producing invalid XML", () => {
    expect(() => parseGpx(exportMarkups([], "gpx").content)).not.toThrow();
    expect(() => parseKml(exportMarkups([], "kml").content)).not.toThrow();
  });
});
