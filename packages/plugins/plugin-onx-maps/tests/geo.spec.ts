import { describe, expect, it } from "vitest";

import {
  boundsOf,
  elevationProfile,
  fitZoom,
  haversineMeters,
  latToTileY,
  lonToTileX,
  midpointAlongPath,
  pathLengthMeters,
  representativePoint,
  ringAreaSquareMeters,
  squareMetersToAcres,
  statsFor,
  tileXToLon,
  tileYToLat,
  vertexCentroid,
} from "../src/geo.js";
import type { Position } from "../src/model.js";

describe("haversineMeters", () => {
  it("returns zero for identical points", () => {
    expect(haversineMeters([-114.0, 46.86], [-114.0, 46.86])).toBe(0);
  });

  it("matches a known one-degree-of-latitude distance", () => {
    // One degree of latitude is ~111.19 km on this sphere, everywhere.
    const meters = haversineMeters([-114, 46], [-114, 47]);
    expect(meters).toBeGreaterThan(111_100);
    expect(meters).toBeLessThan(111_300);
  });

  it("shrinks a degree of longitude with latitude", () => {
    const atEquator = haversineMeters([0, 0], [1, 0]);
    const atFortySix = haversineMeters([-114, 46], [-113, 46]);
    expect(atFortySix).toBeLessThan(atEquator);
    // cos(46°) ≈ 0.695
    expect(atFortySix / atEquator).toBeCloseTo(Math.cos((46 * Math.PI) / 180), 3);
  });

  it("is symmetric", () => {
    const a: Position = [-114.1, 46.8];
    const b: Position = [-113.9, 46.9];
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 9);
  });
});

describe("pathLengthMeters", () => {
  it("is zero for a single point", () => {
    expect(pathLengthMeters([[-114, 46]])).toBe(0);
  });

  it("sums segment lengths", () => {
    const positions: Position[] = [
      [-114, 46],
      [-114, 46.5],
      [-114, 47],
    ];
    expect(pathLengthMeters(positions)).toBeCloseTo(haversineMeters([-114, 46], [-114, 47]), 3);
  });
});

describe("ringAreaSquareMeters", () => {
  it("returns zero for degenerate rings", () => {
    expect(ringAreaSquareMeters([])).toBe(0);
    expect(
      ringAreaSquareMeters([
        [-114, 46],
        [-114, 47],
      ]),
    ).toBe(0);
  });

  it("computes a small square to within a fraction of a percent", () => {
    // 0.01° of latitude tall; width chosen so the box is near-square on the ground.
    const lat = 46;
    const dLat = 0.01;
    const dLon = 0.01 / Math.cos((lat * Math.PI) / 180);
    const ring: Position[] = [
      [-114, lat],
      [-114 + dLon, lat],
      [-114 + dLon, lat + dLat],
      [-114, lat + dLat],
      [-114, lat],
    ];

    const height = haversineMeters([-114, lat], [-114, lat + dLat]);
    const width = haversineMeters([-114, lat], [-114 + dLon, lat]);
    const area = ringAreaSquareMeters(ring);

    expect(area).toBeGreaterThan(0);
    expect(Math.abs(area - width * height) / (width * height)).toBeLessThan(0.005);
  });

  it("is winding-order independent", () => {
    const ring: Position[] = [
      [-114, 46],
      [-113.99, 46],
      [-113.99, 46.01],
      [-114, 46.01],
    ];
    expect(ringAreaSquareMeters(ring)).toBeCloseTo(ringAreaSquareMeters([...ring].reverse()), 6);
  });

  it("treats an unclosed ring as closed", () => {
    const open: Position[] = [
      [-114, 46],
      [-113.99, 46],
      [-113.99, 46.01],
      [-114, 46.01],
    ];
    expect(ringAreaSquareMeters(open)).toBeCloseTo(ringAreaSquareMeters([...open, open[0]!]), 6);
  });

  it("converts to a plausible acreage", () => {
    // ~1/8 mile square ≈ 10 acres.
    const lat = 46;
    const dLat = 201 / 111_195;
    const dLon = dLat / Math.cos((lat * Math.PI) / 180);
    const acres = squareMetersToAcres(
      ringAreaSquareMeters([
        [-114, lat],
        [-114 + dLon, lat],
        [-114 + dLon, lat + dLat],
        [-114, lat + dLat],
      ]),
    );
    expect(acres).toBeGreaterThan(9);
    expect(acres).toBeLessThan(11);
  });
});

describe("elevationProfile", () => {
  it("handles an empty or elevation-free series", () => {
    expect(elevationProfile([])).toEqual({
      gainMeters: 0,
      lossMeters: 0,
      minMeters: null,
      maxMeters: null,
    });
    expect(elevationProfile([null, undefined]).minMeters).toBeNull();
  });

  it("ignores jitter below the threshold", () => {
    // Nine samples oscillating by 1m: a naive sum would report 4m of gain.
    const jitter = [100, 101, 100, 101, 100, 101, 100, 101, 100];
    const profile = elevationProfile(jitter, 3);
    expect(profile.gainMeters).toBe(0);
    expect(profile.lossMeters).toBe(0);
    expect(profile.minMeters).toBe(100);
    expect(profile.maxMeters).toBe(101);
  });

  it("accumulates a sustained climb in full", () => {
    const climb = [1000, 1010, 1020, 1030, 1040];
    expect(elevationProfile(climb, 3).gainMeters).toBeCloseTo(40, 6);
    expect(elevationProfile(climb, 3).lossMeters).toBe(0);
  });

  it("tracks gain and loss separately over a there-and-back profile", () => {
    const profile = elevationProfile([1000, 1100, 1000], 3);
    expect(profile.gainMeters).toBeCloseTo(100, 6);
    expect(profile.lossMeters).toBeCloseTo(100, 6);
    expect(profile.minMeters).toBe(1000);
    expect(profile.maxMeters).toBe(1100);
  });

  it("does not lose a slow climb made of sub-threshold steps", () => {
    // 1m steps summing to 20m: measuring against the last committed anchor
    // (not the previous sample) is what keeps this from reporting zero.
    const slow = Array.from({ length: 21 }, (_, index) => 1000 + index);
    expect(elevationProfile(slow, 3).gainMeters).toBeGreaterThan(17);
  });
});

describe("midpointAlongPath", () => {
  it("returns a point on the line, not the bounding-box centre", () => {
    // An L-shaped path: the bbox centre would sit off the line entirely.
    const positions: Position[] = [
      [-114, 46],
      [-114, 46.02],
      [-113.98, 46.02],
    ];
    const midpoint = midpointAlongPath(positions);
    const onVerticalLeg = Math.abs(midpoint[0] - -114) < 1e-9;
    const onHorizontalLeg = Math.abs(midpoint[1] - 46.02) < 1e-9;
    expect(onVerticalLeg || onHorizontalLeg).toBe(true);
  });

  it("splits a straight path evenly", () => {
    const positions: Position[] = [
      [-114, 46],
      [-114, 47],
    ];
    expect(midpointAlongPath(positions)[1]).toBeCloseTo(46.5, 4);
  });

  it("handles a zero-length path", () => {
    expect(
      midpointAlongPath([
        [-114, 46],
        [-114, 46],
      ]),
    ).toEqual([-114, 46]);
  });
});

describe("vertexCentroid", () => {
  it("ignores a repeated closing vertex", () => {
    const ring: Position[] = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ];
    expect(vertexCentroid(ring)).toEqual([1, 1]);
  });
});

describe("representativePoint", () => {
  it("returns the point itself for a Point", () => {
    expect(representativePoint({ type: "Point", coordinates: [-114, 46] })).toEqual([-114, 46]);
  });

  it("returns a centroid for a Polygon", () => {
    const point = representativePoint({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
        ],
      ],
    });
    expect(point).toEqual([1, 1]);
  });
});

describe("boundsOf", () => {
  it("throws on empty input", () => {
    expect(() => boundsOf([])).toThrow(/at least one position/);
  });

  it("covers all positions", () => {
    expect(
      boundsOf([
        [-114, 46],
        [-113, 47],
        [-115, 45],
      ]),
    ).toEqual({ minLon: -115, minLat: 45, maxLon: -113, maxLat: 47 });
  });
});

describe("statsFor", () => {
  it("reports no distance or area for a waypoint", () => {
    const stats = statsFor({ type: "Point", coordinates: [-114, 46, 1200] });
    expect(stats.pointCount).toBe(1);
    expect(stats.distanceMeters).toBeNull();
    expect(stats.areaSquareMeters).toBeNull();
    expect(stats.minElevationMeters).toBe(1200);
    // A single point cannot have climbed anywhere.
    expect(stats.elevationGainMeters).toBeNull();
  });

  it("reports distance and gain for a line", () => {
    const stats = statsFor({
      type: "LineString",
      coordinates: [
        [-114, 46, 1000],
        [-114, 46.01, 1050],
      ],
    });
    expect(stats.pointCount).toBe(2);
    expect(stats.distanceMeters).toBeGreaterThan(1000);
    expect(stats.elevationGainMeters).toBeCloseTo(50, 6);
    expect(stats.areaSquareMeters).toBeNull();
  });

  it("reports area for a polygon", () => {
    const stats = statsFor({
      type: "Polygon",
      coordinates: [
        [
          [-114, 46],
          [-113.99, 46],
          [-113.99, 46.01],
          [-114, 46.01],
        ],
      ],
    });
    expect(stats.areaSquareMeters).toBeGreaterThan(0);
    expect(stats.distanceMeters).toBeNull();
  });
});

describe("web mercator tile math", () => {
  it("places the origin at the top-left of tile 0/0/0", () => {
    expect(lonToTileX(-180, 0)).toBeCloseTo(0, 9);
    expect(latToTileY(85.05112878, 0)).toBeCloseTo(0, 6);
  });

  it("places the null island at the centre of tile 0/0/0", () => {
    expect(lonToTileX(0, 0)).toBeCloseTo(0.5, 9);
    expect(latToTileY(0, 0)).toBeCloseTo(0.5, 9);
  });

  it("round-trips lon/lat through tile coordinates", () => {
    for (const [lon, lat] of [
      [-114.02, 46.87],
      [12.5, -33.9],
      [151.2, -33.87],
    ] as Array<[number, number]>) {
      for (const zoom of [3, 10, 16]) {
        expect(tileXToLon(lonToTileX(lon, zoom), zoom)).toBeCloseTo(lon, 9);
        expect(tileYToLat(latToTileY(lat, zoom), zoom)).toBeCloseTo(lat, 7);
      }
    }
  });

  it("clamps latitudes beyond the mercator limit", () => {
    expect(Number.isFinite(latToTileY(90, 5))).toBe(true);
    expect(Number.isFinite(latToTileY(-90, 5))).toBe(true);
  });

  it("picks a closer zoom for a smaller extent", () => {
    const tight = fitZoom({ minLon: -114.01, minLat: 46.86, maxLon: -114.0, maxLat: 46.87 }, 800, 600);
    const wide = fitZoom({ minLon: -120, minLat: 40, maxLon: -100, maxLat: 50 }, 800, 600);
    expect(tight).toBeGreaterThan(wide);
    expect(wide).toBeGreaterThanOrEqual(0);
    expect(tight).toBeLessThanOrEqual(18);
  });
});
