/**
 * A minimal slippy map, built from raster XYZ tiles and an SVG overlay.
 *
 * There is no map library here on purpose: pulling in MapLibre or Leaflet
 * would add a new third-party dependency (and ~800 KB) to render what amounts
 * to a tile grid plus some polylines. Web Mercator tile math is ~30 lines and
 * lives in `../geo.js`, shared with the server-side code and unit tested.
 *
 * onX's own basemap tiles are licensed for use inside onX's apps and are not
 * available to third parties, so the basemap is whatever XYZ provider the
 * operator configures — OpenStreetMap by default.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  clampLatitude,
  fitZoom,
  latToTileY,
  lonToTileX,
  tileXToLon,
  tileYToLat,
} from "../geo.js";
import type { Bounds, Geometry, MarkupKind, Position } from "../model.js";

const TILE_SIZE = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 18;

/**
 * Feature colours are data encodings, not UI chrome: a waypoint must read as
 * the same colour in light and dark, and against arbitrary basemap imagery.
 * They are therefore fixed literals with a white halo rather than theme tokens.
 */
const KIND_COLORS: Record<MarkupKind, string> = {
  waypoint: "#e8590c",
  track: "#1971c2",
  route: "#6741d9",
  line: "#0c8599",
  area: "#2f9e44",
};

export interface MapMarkup {
  id: string;
  kind: MarkupKind;
  name: string | null;
  geometry: Geometry;
  lat: number;
  lon: number;
  bounds: Bounds;
}

export interface MarkupMapProps {
  markups: MapMarkup[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  tileUrl: string;
  attribution: string;
  /** Rendered when there is nothing to show. */
  emptyLabel?: string;
}

interface View {
  lon: number;
  lat: number;
  zoom: number;
}

function boundsOfAll(markups: MapMarkup[]): Bounds | null {
  if (markups.length === 0) return null;
  return markups.reduce<Bounds>(
    (acc, markup) => ({
      minLon: Math.min(acc.minLon, markup.bounds.minLon),
      minLat: Math.min(acc.minLat, markup.bounds.minLat),
      maxLon: Math.max(acc.maxLon, markup.bounds.maxLon),
      maxLat: Math.max(acc.maxLat, markup.bounds.maxLat),
    }),
    { ...markups[0]!.bounds },
  );
}

function viewForBounds(bounds: Bounds, width: number, height: number): View {
  // Inset the viewport so fitted features never touch the frame edge.
  const zoom = fitZoom(bounds, Math.max(64, width - 64), Math.max(64, height - 64), TILE_SIZE, MIN_ZOOM, MAX_ZOOM);
  return {
    lon: (bounds.minLon + bounds.maxLon) / 2,
    lat: (bounds.minLat + bounds.maxLat) / 2,
    zoom,
  };
}

export function MarkupMap({
  markups,
  selectedId,
  onSelect,
  tileUrl,
  attribution,
  emptyLabel = "No markups to show",
}: MarkupMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View | null>(null);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  // Track the container size so tile coverage and fitting react to layout.
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const allBounds = useMemo(() => boundsOfAll(markups), [markups]);

  // Signature of the current extent — refit only when the data actually moves,
  // not on every re-render or selection change.
  const boundsKey = allBounds
    ? `${allBounds.minLon},${allBounds.minLat},${allBounds.maxLon},${allBounds.maxLat}`
    : "";

  useEffect(() => {
    if (!allBounds || size.width === 0 || size.height === 0) return;
    setView(viewForBounds(allBounds, size.width, size.height));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey, size.width, size.height]);

  const fitAll = useCallback(() => {
    if (!allBounds || size.width === 0) return;
    setView(viewForBounds(allBounds, size.width, size.height));
  }, [allBounds, size.width, size.height]);

  // World-pixel offset of the viewport's top-left corner.
  const origin = useMemo(() => {
    if (!view || size.width === 0) return null;
    return {
      x: lonToTileX(view.lon, view.zoom) * TILE_SIZE - size.width / 2,
      y: latToTileY(view.lat, view.zoom) * TILE_SIZE - size.height / 2,
      zoom: view.zoom,
    };
  }, [view, size.width, size.height]);

  const project = useCallback(
    (position: Position): [number, number] => {
      if (!origin) return [0, 0];
      return [
        lonToTileX(position[0], origin.zoom) * TILE_SIZE - origin.x,
        latToTileY(position[1], origin.zoom) * TILE_SIZE - origin.y,
      ];
    },
    [origin],
  );

  const unproject = useCallback(
    (x: number, y: number): [number, number] => {
      if (!origin) return [0, 0];
      return [
        tileXToLon((origin.x + x) / TILE_SIZE, origin.zoom),
        tileYToLat((origin.y + y) / TILE_SIZE, origin.zoom),
      ];
    },
    [origin],
  );

  // --- interaction ---------------------------------------------------------

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !view) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    dragRef.current = { x: event.clientX, y: event.clientY, moved: drag.moved };

    const centerX = lonToTileX(view.lon, view.zoom) * TILE_SIZE - dx;
    const centerY = latToTileY(view.lat, view.zoom) * TILE_SIZE - dy;
    setView({
      lon: tileXToLon(centerX / TILE_SIZE, view.zoom),
      lat: clampLatitude(tileYToLat(centerY / TILE_SIZE, view.zoom)),
      zoom: view.zoom,
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  /** Zoom about a viewport point, keeping the ground position under it fixed. */
  const zoomAt = useCallback(
    (delta: number, pointX: number, pointY: number) => {
      if (!view || !origin) return;
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom + delta));
      if (nextZoom === view.zoom) return;

      const [anchorLon, anchorLat] = unproject(pointX, pointY);
      const anchorTileX = lonToTileX(anchorLon, nextZoom);
      const anchorTileY = latToTileY(anchorLat, nextZoom);
      const centerTileX = anchorTileX + (size.width / 2 - pointX) / TILE_SIZE;
      const centerTileY = anchorTileY + (size.height / 2 - pointY) / TILE_SIZE;

      setView({
        lon: tileXToLon(centerTileX, nextZoom),
        lat: clampLatitude(tileYToLat(centerTileY, nextZoom)),
        zoom: nextZoom,
      });
    },
    [view, origin, unproject, size.width, size.height],
  );

  // Registered natively (not via onWheel) so preventDefault is honoured —
  // React attaches wheel listeners as passive.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      zoomAt(event.deltaY < 0 ? 1 : -1, event.clientX - rect.left, event.clientY - rect.top);
    };
    node.addEventListener("wheel", handler, { passive: false });
    return () => node.removeEventListener("wheel", handler);
  }, [zoomAt]);

  // --- tiles ---------------------------------------------------------------

  const tiles = useMemo(() => {
    if (!origin || !tileUrl || size.width === 0) return [];
    const scale = 2 ** origin.zoom;
    const firstX = Math.floor(origin.x / TILE_SIZE);
    const lastX = Math.floor((origin.x + size.width) / TILE_SIZE);
    const firstY = Math.floor(origin.y / TILE_SIZE);
    const lastY = Math.floor((origin.y + size.height) / TILE_SIZE);

    const result: Array<{ key: string; url: string; left: number; top: number }> = [];
    for (let x = firstX; x <= lastX; x += 1) {
      for (let y = firstY; y <= lastY; y += 1) {
        // Y is clamped (no vertical wrap), X wraps around the antimeridian.
        if (y < 0 || y >= scale) continue;
        const wrappedX = ((x % scale) + scale) % scale;
        result.push({
          key: `${origin.zoom}/${x}/${y}`,
          url: tileUrl
            .replace("{z}", String(origin.zoom))
            .replace("{x}", String(wrappedX))
            .replace("{y}", String(y)),
          left: x * TILE_SIZE - origin.x,
          top: y * TILE_SIZE - origin.y,
        });
      }
    }
    return result;
  }, [origin, tileUrl, size.width, size.height]);

  // --- overlay -------------------------------------------------------------

  /** Drop vertices that project to within ~2px of the previous kept one. */
  const decimate = useCallback(
    (positions: Position[]): Array<[number, number]> => {
      const points: Array<[number, number]> = [];
      let last: [number, number] | null = null;
      for (const position of positions) {
        const point = project(position);
        if (!last || Math.abs(point[0] - last[0]) + Math.abs(point[1] - last[1]) > 2) {
          points.push(point);
          last = point;
        }
      }
      // Always keep the final vertex so lines and rings close where they should.
      if (positions.length > 1) {
        const end = project(positions[positions.length - 1]!);
        const tail = points[points.length - 1];
        if (!tail || tail[0] !== end[0] || tail[1] !== end[1]) points.push(end);
      }
      return points;
    },
    [project],
  );

  const visible = useMemo(() => {
    if (!origin) return [];
    // Cull anything whose extent is off-screen before building any geometry.
    const pad = 128;
    return markups.filter((markup) => {
      const [x1, y1] = project([markup.bounds.minLon, markup.bounds.maxLat]);
      const [x2, y2] = project([markup.bounds.maxLon, markup.bounds.minLat]);
      return (
        x2 >= -pad && x1 <= size.width + pad && y2 >= -pad && y1 <= size.height + pad
      );
    });
  }, [markups, origin, project, size.width, size.height]);

  const hasBasemap = tileUrl.trim().length > 0;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden rounded-md border border-border bg-muted select-none"
      style={{ touchAction: "none", cursor: dragRef.current ? "grabbing" : "grab" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {tiles.map((tile) => (
        <img
          key={tile.key}
          src={tile.url}
          alt=""
          aria-hidden="true"
          draggable={false}
          loading="lazy"
          className="pointer-events-none absolute"
          style={{ left: tile.left, top: tile.top, width: TILE_SIZE, height: TILE_SIZE }}
        />
      ))}

      {origin && (
        <svg
          className="absolute inset-0 h-full w-full"
          width={size.width}
          height={size.height}
          role="presentation"
        >
          {visible.map((markup) => {
            const color = KIND_COLORS[markup.kind];
            const isSelected = markup.id === selectedId;
            const strokeWidth = isSelected ? 5 : 3;

            if (markup.geometry.type === "Point") {
              const [x, y] = project(markup.geometry.coordinates);
              return (
                <g
                  key={markup.id}
                  className="cursor-pointer"
                  onClick={() => onSelect(markup.id)}
                  role="button"
                  aria-label={markup.name ?? "onX waypoint"}
                >
                  <circle cx={x} cy={y} r={isSelected ? 9 : 6} fill={color} stroke="#fff" strokeWidth={2} />
                  {isSelected && (
                    <circle cx={x} cy={y} r={14} fill="none" stroke={color} strokeWidth={2} opacity={0.6} />
                  )}
                </g>
              );
            }

            if (markup.geometry.type === "LineString") {
              const points = decimate(markup.geometry.coordinates);
              if (points.length < 2) return null;
              const d = points.map((point, index) => `${index === 0 ? "M" : "L"}${point[0]},${point[1]}`).join(" ");
              return (
                <g key={markup.id} className="cursor-pointer" onClick={() => onSelect(markup.id)}>
                  {/* Wide transparent stroke widens the click target. */}
                  <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
                  <path d={d} fill="none" stroke="#fff" strokeWidth={strokeWidth + 2} strokeLinejoin="round" strokeLinecap="round" opacity={0.7} />
                  <path d={d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
                </g>
              );
            }

            const ring = decimate(markup.geometry.coordinates[0] ?? []);
            if (ring.length < 3) return null;
            const d = `${ring.map((point, index) => `${index === 0 ? "M" : "L"}${point[0]},${point[1]}`).join(" ")} Z`;
            return (
              <g key={markup.id} className="cursor-pointer" onClick={() => onSelect(markup.id)}>
                <path d={d} fill={color} fillOpacity={isSelected ? 0.35 : 0.18} stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
              </g>
            );
          })}
        </svg>
      )}

      {markups.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {emptyLabel}
        </div>
      )}

      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <MapButton label="Zoom in" onClick={() => zoomAt(1, size.width / 2, size.height / 2)}>
          +
        </MapButton>
        <MapButton label="Zoom out" onClick={() => zoomAt(-1, size.width / 2, size.height / 2)}>
          −
        </MapButton>
        <MapButton label="Fit all markups" onClick={fitAll}>
          ⤢
        </MapButton>
      </div>

      <div className="pointer-events-none absolute bottom-0 right-0 bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {hasBasemap ? attribution : "No basemap configured"}
        {view ? ` · z${view.zoom}` : ""}
      </div>
    </div>
  );
}

function MapButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onPointerDown={(event) => event.stopPropagation()}
      className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background/90 text-sm text-foreground transition-colors hover:bg-accent"
    >
      {children}
    </button>
  );
}

export { KIND_COLORS };
