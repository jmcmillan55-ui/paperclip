/**
 * Spherical geometry helpers.
 *
 * Everything here uses a sphere of radius `EARTH_RADIUS_METERS` rather than a
 * true ellipsoid. For markup-scale features (a treestand, a property line, a
 * day hike) the error is well under a metre, and staying dependency-free is
 * worth more here than WGS84-exact geodesics.
 */

import type { Bounds, Geometry, MarkupStats, Position } from "./model.js";

export const EARTH_RADIUS_METERS = 6_371_008.8;

const DEG_TO_RAD = Math.PI / 180;

export function toRadians(degrees: number): number {
  return degrees * DEG_TO_RAD;
}

export function isFiniteCoordinate(lon: number, lat: number): boolean {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= -180 &&
    lon <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

/** Great-circle distance between two `[lon, lat]` positions, in metres. */
export function haversineMeters(a: Position, b: Position): number {
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const dLat = lat2 - lat1;
  const dLon = toRadians(b[0] - a[0]);

  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total length along an ordered path, in metres. */
export function pathLengthMeters(positions: Position[]): number {
  let total = 0;
  for (let i = 1; i < positions.length; i += 1) {
    total += haversineMeters(positions[i - 1]!, positions[i]!);
  }
  return total;
}

/**
 * Signed spherical area of a closed ring, in square metres.
 *
 * Uses the standard spherical-excess line integral. The caller gets the
 * absolute value; winding order is not meaningful for onX area shapes.
 */
export function ringAreaSquareMeters(ring: Position[]): number {
  if (ring.length < 3) return 0;

  // Treat the ring as closed whether or not the source repeated the first vertex.
  const closed =
    ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1]
      ? ring
      : [...ring, ring[0]!];

  let total = 0;
  for (let i = 1; i < closed.length; i += 1) {
    const [lon1, lat1] = closed[i - 1]!;
    const [lon2, lat2] = closed[i]!;
    // Normalize the longitude delta so rings crossing the antimeridian do not
    // pick up a spurious ~360° sweep.
    let dLon = toRadians(lon2 - lon1);
    if (dLon > Math.PI) dLon -= 2 * Math.PI;
    if (dLon < -Math.PI) dLon += 2 * Math.PI;
    total += dLon * (2 + Math.sin(toRadians(lat1)) + Math.sin(toRadians(lat2)));
  }

  return Math.abs((total * EARTH_RADIUS_METERS * EARTH_RADIUS_METERS) / 2);
}

export function boundsOf(positions: Position[]): Bounds {
  if (positions.length === 0) {
    throw new Error("boundsOf requires at least one position");
  }
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of positions) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

export function mergeBounds(all: Bounds[]): Bounds | null {
  if (all.length === 0) return null;
  return all.reduce((acc, next) => ({
    minLon: Math.min(acc.minLon, next.minLon),
    minLat: Math.min(acc.minLat, next.minLat),
    maxLon: Math.max(acc.maxLon, next.maxLon),
    maxLat: Math.max(acc.maxLat, next.maxLat),
  }));
}

/** Flatten any geometry to the flat list of positions it is built from. */
export function positionsOf(geometry: Geometry): Position[] {
  if (geometry.type === "Point") return [geometry.coordinates];
  if (geometry.type === "LineString") return geometry.coordinates;
  return geometry.coordinates.flat();
}

/**
 * Point at 50% of the path length, interpolated between the two bracketing
 * vertices. Unlike a bounding-box centre this is guaranteed to sit *on* the
 * line, which is what makes proximity search over tracks behave sensibly.
 */
export function midpointAlongPath(positions: Position[]): Position {
  if (positions.length === 0) throw new Error("midpointAlongPath requires positions");
  if (positions.length === 1) return positions[0]!;

  const half = pathLengthMeters(positions) / 2;
  if (half === 0) return positions[0]!;

  let travelled = 0;
  for (let i = 1; i < positions.length; i += 1) {
    const from = positions[i - 1]!;
    const to = positions[i]!;
    const segment = haversineMeters(from, to);
    if (travelled + segment >= half) {
      const ratio = segment === 0 ? 0 : (half - travelled) / segment;
      return [
        from[0] + (to[0] - from[0]) * ratio,
        from[1] + (to[1] - from[1]) * ratio,
      ];
    }
    travelled += segment;
  }
  return positions[positions.length - 1]!;
}

/** Mean of a ring's distinct vertices. */
export function vertexCentroid(positions: Position[]): Position {
  if (positions.length === 0) throw new Error("vertexCentroid requires positions");

  const distinct =
    positions.length > 1 &&
    positions[0]![0] === positions[positions.length - 1]![0] &&
    positions[0]![1] === positions[positions.length - 1]![1]
      ? positions.slice(0, -1)
      : positions;

  const source = distinct.length > 0 ? distinct : positions;
  let lon = 0;
  let lat = 0;
  for (const position of source) {
    lon += position[0];
    lat += position[1];
  }
  return [lon / source.length, lat / source.length];
}

/** The point used to represent a whole markup in lists and proximity search. */
export function representativePoint(geometry: Geometry): Position {
  if (geometry.type === "Point") return geometry.coordinates;
  if (geometry.type === "LineString") return midpointAlongPath(geometry.coordinates);
  return vertexCentroid(geometry.coordinates[0] ?? []);
}

export interface ElevationProfile {
  gainMeters: number;
  lossMeters: number;
  minMeters: number | null;
  maxMeters: number | null;
}

/**
 * Accumulate elevation change, ignoring wobble below `thresholdMeters`.
 *
 * Consumer GPS elevation is noisy by several metres; summing every raw delta
 * turns a flat walk into hundreds of metres of "climb". Deltas are therefore
 * measured against the last *committed* elevation rather than the previous
 * sample, so sustained climbs accumulate fully while jitter never does.
 */
export function elevationProfile(
  elevations: Array<number | null | undefined>,
  thresholdMeters = 3,
): ElevationProfile {
  const values = elevations.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (values.length === 0) {
    return { gainMeters: 0, lossMeters: 0, minMeters: null, maxMeters: null };
  }

  let gain = 0;
  let loss = 0;
  let anchor = values[0]!;
  let min = values[0]!;
  let max = values[0]!;

  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;

    const delta = value - anchor;
    if (delta >= thresholdMeters) {
      gain += delta;
      anchor = value;
    } else if (delta <= -thresholdMeters) {
      loss += -delta;
      anchor = value;
    }
  }

  return { gainMeters: gain, lossMeters: loss, minMeters: min, maxMeters: max };
}

export function statsFor(geometry: Geometry, elevationThresholdMeters = 3): MarkupStats {
  const positions = positionsOf(geometry);
  const profile = elevationProfile(
    positions.map((position) => (position.length > 2 ? position[2] : null)),
    elevationThresholdMeters,
  );
  const hasElevation = profile.minMeters !== null;

  return {
    pointCount: positions.length,
    distanceMeters:
      geometry.type === "LineString" ? pathLengthMeters(geometry.coordinates) : null,
    elevationGainMeters: hasElevation && geometry.type !== "Point" ? profile.gainMeters : null,
    elevationLossMeters: hasElevation && geometry.type !== "Point" ? profile.lossMeters : null,
    minElevationMeters: profile.minMeters,
    maxElevationMeters: profile.maxMeters,
    areaSquareMeters:
      geometry.type === "Polygon"
        ? ringAreaSquareMeters(geometry.coordinates[0] ?? [])
        : null,
  };
}

// ---------------------------------------------------------------------------
// Web Mercator tile math (shared by the map UI)
// ---------------------------------------------------------------------------

/** Maximum latitude representable in Web Mercator. */
export const MERCATOR_MAX_LATITUDE = 85.05112878;

export function clampLatitude(lat: number): number {
  return Math.max(-MERCATOR_MAX_LATITUDE, Math.min(MERCATOR_MAX_LATITUDE, lat));
}

/** Fractional tile X for a longitude at zoom `z`. */
export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

/** Fractional tile Y for a latitude at zoom `z`. */
export function latToTileY(lat: number, z: number): number {
  const rad = toRadians(clampLatitude(lat));
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - 2 * Math.PI * (y / 2 ** z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Highest integer zoom at which `bounds` still fits inside a viewport of
 * `widthPx` × `heightPx`, clamped to `[minZoom, maxZoom]`.
 */
export function fitZoom(
  bounds: Bounds,
  widthPx: number,
  heightPx: number,
  tileSize = 256,
  minZoom = 0,
  maxZoom = 18,
): number {
  for (let z = maxZoom; z >= minZoom; z -= 1) {
    const spanX = Math.abs(lonToTileX(bounds.maxLon, z) - lonToTileX(bounds.minLon, z)) * tileSize;
    const spanY = Math.abs(latToTileY(bounds.minLat, z) - latToTileY(bounds.maxLat, z)) * tileSize;
    if (spanX <= widthPx && spanY <= heightPx) return z;
  }
  return minZoom;
}

// ---------------------------------------------------------------------------
// Formatting helpers shared by tools and UI
// ---------------------------------------------------------------------------

const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;
const SQUARE_METERS_PER_ACRE = 4046.8564224;

export function metersToMiles(meters: number): number {
  return meters / METERS_PER_MILE;
}

export function metersToFeet(meters: number): number {
  return meters / METERS_PER_FOOT;
}

export function squareMetersToAcres(squareMeters: number): number {
  return squareMeters / SQUARE_METERS_PER_ACRE;
}
