import { describe, expect, it } from "vitest";

import { DB_NAMESPACE, DB_NAMESPACE_SLUG, PLUGIN_ID } from "../src/constants.js";
import { createHash } from "node:crypto";
import {
  OnxParseError,
  computeExternalKey,
  detectFormat,
  parseGpx,
  parseKml,
  parseKmlCoordinates,
  parseOnxExport,
} from "../src/parse.js";
import type { Geometry } from "../src/model.js";
import { decodeXmlText, parseXml, XmlParseError } from "../src/xml.js";
import { GPX_EXPORT, KML_EXPORT, KML_WITH_DOCTYPE } from "./fixtures.js";

describe("database namespace constant", () => {
  it("matches the host's derivation formula", () => {
    // Mirrors derivePluginDatabaseNamespace() in the server. The migration SQL
    // hardcodes this schema name, so a drift here would break installation.
    const hash = createHash("sha256").update(PLUGIN_ID).digest("hex").slice(0, 10);
    expect(DB_NAMESPACE).toBe(`plugin_${DB_NAMESPACE_SLUG}_${hash}`);
    expect(DB_NAMESPACE.length).toBeLessThanOrEqual(63);
  });
});

describe("xml parser", () => {
  it("strips namespace prefixes and lowercases names", () => {
    const root = parseXml(`<kml:kml xmlns:kml="x"><kml:Document Foo="1"/></kml:kml>`);
    expect(root.name).toBe("kml");
    expect(root.children[0]!.name).toBe("document");
    expect(root.children[0]!.attributes.foo).toBe("1");
  });

  it("decodes the five predefined entities and numeric references", () => {
    expect(decodeXmlText("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(
      `a & b <c> "d" 'e'`,
    );
    expect(decodeXmlText("&#65;&#x42;")).toBe("AB");
  });

  it("leaves an undeclared entity verbatim instead of expanding it", () => {
    expect(decodeXmlText("&xxe;")).toBe("&xxe;");
  });

  it("takes CDATA verbatim", () => {
    const root = parseXml(`<a><b><![CDATA[<not> &amp; parsed]]></b></a>`);
    expect(root.children[0]!.text).toBe("<not> &amp; parsed");
  });

  it("skips comments and processing instructions", () => {
    const root = parseXml(`<?xml version="1.0"?><a><!-- note --><b>1</b></a>`);
    expect(root.children).toHaveLength(1);
    expect(root.children[0]!.text).toBe("1");
  });

  it("handles self-closing tags", () => {
    const root = parseXml(`<a><b/><c d="1"/></a>`);
    expect(root.children.map((child) => child.name)).toEqual(["b", "c"]);
    expect(root.children[1]!.attributes.d).toBe("1");
  });

  it("tolerates a UTF-8 BOM", () => {
    expect(parseXml(`﻿<a><b>1</b></a>`).name).toBe("a");
  });

  it("rejects mismatched and unclosed tags", () => {
    expect(() => parseXml(`<a><b></c></a>`)).toThrow(XmlParseError);
    expect(() => parseXml(`<a><b></a>`)).toThrow(XmlParseError);
    expect(() => parseXml(`<a>`)).toThrow(/Unclosed element/);
    expect(() => parseXml(`   `)).toThrow(/no root element/);
  });

  it("does not overflow the stack on deeply nested input", () => {
    const depth = 20_000;
    const deep = "<a>".repeat(depth) + "x" + "</a>".repeat(depth);
    expect(() => parseXml(deep)).not.toThrow();
  });
});

describe("detectFormat", () => {
  it("reads the root element rather than the filename", () => {
    expect(detectFormat(GPX_EXPORT)).toBe("gpx");
    expect(detectFormat(KML_EXPORT)).toBe("kml");
    expect(detectFormat("plain text")).toBeNull();
  });
});

describe("parseGpx", () => {
  const result = parseGpx(GPX_EXPORT);

  it("reads waypoints, a route and a track", () => {
    expect(result.format).toBe("gpx");
    expect(result.markups.map((markup) => markup.kind).sort()).toEqual([
      "route",
      "track",
      "waypoint",
      "waypoint",
    ]);
  });

  it("keeps waypoint fields including the onX symbol", () => {
    const stand = result.markups.find((markup) => markup.name === "North Treestand");
    expect(stand).toBeDefined();
    expect(stand!.kind).toBe("waypoint");
    expect(stand!.lat).toBeCloseTo(46.8721, 6);
    expect(stand!.lon).toBeCloseTo(-114.0198, 6);
    expect(stand!.elevationMeters).toBeCloseTo(1042.3, 3);
    expect(stand!.symbol).toBe("Tree Stand");
    expect(stand!.sourceTime).toBe("2025-09-14T13:05:00Z");
    expect(stand!.description).toContain("thermals & clear");
  });

  it("skips an out-of-range coordinate and records a warning", () => {
    expect(result.markups.some((markup) => markup.name === "Corrupt Waypoint")).toBe(false);
    expect(result.warnings.some((warning) => /lat\/lon/.test(warning.reason))).toBe(true);
  });

  it("computes track distance and elevation gain", () => {
    const track = result.markups.find((markup) => markup.kind === "track")!;
    expect(track.stats.pointCount).toBe(3);
    expect(track.stats.distanceMeters).toBeGreaterThan(200);
    expect(track.stats.elevationGainMeters).toBeCloseTo(41, 0);
    expect(track.stats.areaSquareMeters).toBeNull();
  });

  it("gives a track a representative point on the line", () => {
    const track = result.markups.find((markup) => markup.kind === "track")!;
    expect(track.lon).toBeCloseTo(-114.02, 6);
    expect(track.lat).toBeGreaterThan(46.87);
    expect(track.lat).toBeLessThan(46.872);
  });

  it("rejects a non-GPX root element", () => {
    expect(() => parseGpx("<foo/>")).toThrow(OnxParseError);
  });

  it("warns when a track's segments are joined", () => {
    const multi = parseGpx(`<gpx><trk><name>Split</name>
      <trkseg><trkpt lat="46.0" lon="-114.0"/><trkpt lat="46.001" lon="-114.0"/></trkseg>
      <trkseg><trkpt lat="46.5" lon="-114.0"/><trkpt lat="46.501" lon="-114.0"/></trkseg>
    </trk></gpx>`);
    expect(multi.markups).toHaveLength(1);
    expect(multi.markups[0]!.stats.pointCount).toBe(4);
    expect(multi.warnings.some((warning) => /segments/.test(warning.reason))).toBe(true);
  });
});

describe("parseKmlCoordinates", () => {
  it("reads whitespace-separated lon,lat[,ele] tuples", () => {
    expect(parseKmlCoordinates("-114.0,46.8,100 -114.1,46.9")).toEqual([
      [-114, 46.8, 100],
      [-114.1, 46.9],
    ]);
  });

  it("drops malformed and out-of-range tuples", () => {
    expect(parseKmlCoordinates("bad -114.0,46.8 999,999")).toEqual([[-114, 46.8]]);
  });

  it("survives newline-separated blocks", () => {
    expect(parseKmlCoordinates("\n  -114.0,46.8,0\n  -114.1,46.9,0\n ")).toHaveLength(2);
  });
});

describe("parseKml", () => {
  const result = parseKml(KML_EXPORT);

  it("maps geometry to onX markup kinds", () => {
    expect(result.markups.map((markup) => markup.kind).sort()).toEqual([
      "area",
      "line",
      "waypoint",
    ]);
  });

  it("records the nested folder path", () => {
    const wallow = result.markups.find((markup) => markup.name === "Wallow")!;
    expect(wallow.folderPath).toBe("Elk 2025 / North Ridge");
    expect(wallow.symbol).toBe("#onx-icon-water");
    expect(wallow.sourceTime).toBe("2025-09-12T08:30:00Z");
    // Document is not a folder level, but Folder is.
    const drainage = result.markups.find((markup) => markup.name === "Drainage Line")!;
    expect(drainage.folderPath).toBe("Elk 2025");
  });

  it("keeps CDATA descriptions intact", () => {
    const wallow = result.markups.find((markup) => markup.name === "Wallow")!;
    expect(wallow.description).toBe("Fresh sign <strong>Sept 12</strong>");
  });

  it("computes polygon area", () => {
    const boundary = result.markups.find((markup) => markup.kind === "area")!;
    expect(boundary.stats.areaSquareMeters).toBeGreaterThan(0);
    expect(boundary.stats.distanceMeters).toBeNull();
    expect(boundary.geometry.type).toBe("Polygon");
  });

  it("warns about a placemark with no geometry", () => {
    expect(result.warnings.some((warning) => /no supported geometry/.test(warning.reason))).toBe(
      true,
    );
  });

  it("does not expand external entities declared in a DOCTYPE", () => {
    const parsed = parseKml(KML_WITH_DOCTYPE);
    expect(parsed.markups).toHaveLength(1);
    // The name is the literal entity reference, never file contents.
    expect(parsed.markups[0]!.name).toBe("&xxe;");
  });
});

describe("parseOnxExport", () => {
  it("dispatches on the detected format", () => {
    expect(parseOnxExport(GPX_EXPORT).format).toBe("gpx");
    expect(parseOnxExport(KML_EXPORT).format).toBe("kml");
  });

  it("gives an actionable error for a non-GPX/KML file", () => {
    expect(() => parseOnxExport("id,name\n1,foo")).toThrow(/neither GPX nor KML/);
  });

  it("reports malformed XML rather than throwing a raw parser error", () => {
    expect(() => parseOnxExport("<gpx><wpt></gpx>")).toThrow(/not well-formed XML/);
  });
});

describe("computeExternalKey", () => {
  const geometry: Geometry = { type: "Point", coordinates: [-114.0198, 46.8721] };

  it("is stable across repeated exports of the same markup", () => {
    expect(computeExternalKey("waypoint", "Stand", geometry)).toBe(
      computeExternalKey("waypoint", "Stand", geometry),
    );
  });

  it("ignores name case and surrounding whitespace", () => {
    expect(computeExternalKey("waypoint", "  stand ", geometry)).toBe(
      computeExternalKey("waypoint", "Stand", geometry),
    );
  });

  it("ignores float formatting noise below ~1cm", () => {
    expect(
      computeExternalKey("waypoint", "Stand", {
        type: "Point",
        coordinates: [-114.01980000001, 46.87210000001],
      }),
    ).toBe(computeExternalKey("waypoint", "Stand", geometry));
  });

  it("separates genuinely different markups", () => {
    expect(computeExternalKey("waypoint", "Other", geometry)).not.toBe(
      computeExternalKey("waypoint", "Stand", geometry),
    );
    expect(
      computeExternalKey("waypoint", "Stand", {
        type: "Point",
        coordinates: [-114.03, 46.8721],
      }),
    ).not.toBe(computeExternalKey("waypoint", "Stand", geometry));
    // Same shape, different kind — a GPX track and a KML line of one path.
    expect(
      computeExternalKey("line", "Path", {
        type: "LineString",
        coordinates: [
          [-114, 46],
          [-114, 46.01],
        ],
      }),
    ).not.toBe(
      computeExternalKey("track", "Path", {
        type: "LineString",
        coordinates: [
          [-114, 46],
          [-114, 46.01],
        ],
      }),
    );
  });

  it("re-parsing the same file yields identical keys", () => {
    const first = parseOnxExport(GPX_EXPORT).markups.map((markup) => markup.externalKey);
    const second = parseOnxExport(GPX_EXPORT).markups.map((markup) => markup.externalKey);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });
});
