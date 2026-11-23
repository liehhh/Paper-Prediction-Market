"use client";

import { useEffect, useMemo, useRef } from "react";
import type { WorldCountry } from "@league/trading-contract";
import { type Camera, type Viewport, MAX_K, ZOOM_STEP, panBy, zoomAt } from "@/lib/camera";
import { type Placement } from "@/lib/world-layout";

/** Screen pixel size of a label. Constant, so names stay readable at every zoom level. */
const LABEL_PX = 13;
/** A circle smaller than this on screen is too small to hold its name inside. */
const LABEL_INSIDE_MIN_PX = 24;
/** Every country can be tapped with at least this radius on screen, however small its circle is. */
const MIN_HIT_PX = 16;
const DRAG_THRESHOLD_PX = 5;

interface WorldMapProps {
  placements: Placement[];
  countries: ReadonlyMap<string, WorldCountry>;
  camera: Camera | null;
  viewport: Viewport | null;
  minK: number;
  onViewport(viewport: Viewport): void;
  /** Every user gesture (drag, wheel, pinch, keys, buttons) goes through here. */
  onCamera(update: (camera: Camera) => Camera): void;
  onFit(): void;
  onFindMe?: () => void;
  selectedId: string | null;
  myId: string | null;
  onSelect(id: string | null): void;
  failedUrls: ReadonlySet<string>;
  onImageError(url: string): void;
}

/**
 * Draws the world: a pannable, zoomable SVG surface with the countries as circles.
 * It only DRAWS and reports gestures. The camera, the data and the selection live in the parent, so a data refresh
 * re-draws circles but never moves the viewer's camera. It never writes anything anywhere.
 *
 * Each country is drawn once in a local unit-circle space and positioned with a CSS transform
 * (translate + scale(radius)), so changes in size or position animate smoothly with a plain CSS transition, and
 * there is no animation loop while the map is idle.
 */
export function WorldMap(props: WorldMapProps) {
  const { placements, countries, camera, viewport, minK, selectedId, myId, failedUrls, onViewport } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // The gesture handlers read the newest values from here, so they never act on a stale camera.
  const latest = useRef({ minK, onCamera: props.onCamera });
  useEffect(() => {
    latest.current = { minK, onCamera: props.onCamera };
  });

  // ---- viewport size -------------------------------------------------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const report = () => onViewport({ width: el.clientWidth, height: el.clientHeight });
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onViewport]);

  // ---- wheel zoom (needs a non-passive listener to stop the page scrolling) -------------------------------------
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      latest.current.onCamera((c) => zoomAt(c, factor, point, latest.current.minK));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  // ---- drag to pan, pinch to zoom, tap to select ---------------------------------------------------------------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startX: number; startY: number; moved: boolean; targetId: string | null; pinchDistance: number | null } | null>(null);

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    const target = (event.target as Element).closest("[data-country]")?.getAttribute("data-country") ?? null;
    if (pointers.current.size === 1) {
      gesture.current = { startX: point.x, startY: point.y, moved: false, targetId: target, pinchDistance: null };
    } else if (gesture.current) {
      // A second finger: this is a pinch, not a tap.
      gesture.current.moved = true;
      const [a, b] = [...pointers.current.values()];
      gesture.current.pinchDistance = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
    }
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const previous = pointers.current.get(event.pointerId);
    if (!previous || !gesture.current) return;
    const point = local(event);
    pointers.current.set(event.pointerId, point);

    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const before = gesture.current.pinchDistance;
      gesture.current.pinchDistance = distance;
      if (before && before > 0) {
        const factor = distance / before;
        latest.current.onCamera((c) => zoomAt(c, factor, centre, latest.current.minK));
      }
      return;
    }

    const g = gesture.current;
    if (!g.moved && Math.hypot(point.x - g.startX, point.y - g.startY) < DRAG_THRESHOLD_PX) return;
    g.moved = true;
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    latest.current.onCamera((c) => panBy(c, dx, dy));
  }

  function onPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    pointers.current.delete(event.pointerId);
    const g = gesture.current;
    if (pointers.current.size === 0 && g) {
      if (!g.moved) props.onSelect(g.targetId); // a tap: select the country under the finger, or clear
      gesture.current = null;
    } else if (pointers.current.size === 1 && g) {
      g.pinchDistance = null; // one finger left after a pinch: carry on panning, never select
    }
  }

  function onKeyDown(event: React.KeyboardEvent<SVGSVGElement>) {
    const step = 80;
    const centre = { x: (svgRef.current?.clientWidth ?? 0) / 2, y: (svgRef.current?.clientHeight ?? 0) / 2 };
    const move: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const delta = move[event.key];
    if (delta) props.onCamera((c) => panBy(c, delta[0], delta[1]));
    else if (event.key === "+" || event.key === "=") props.onCamera((c) => zoomAt(c, ZOOM_STEP, centre, minK));
    else if (event.key === "-" || event.key === "_") props.onCamera((c) => zoomAt(c, 1 / ZOOM_STEP, centre, minK));
    else if (event.key === "0") props.onFit();
    else return;
    event.preventDefault();
  }

  function zoomButton(factor: number) {
    const centre = { x: (containerRef.current?.clientWidth ?? 0) / 2, y: (containerRef.current?.clientHeight ?? 0) / 2 };
    props.onCamera((c) => zoomAt(c, factor, centre, minK));
  }

  // Big circles first, so small ones are drawn on top and stay discoverable.
  const drawOrder = useMemo(() => [...placements].sort((a, b) => b.r - a.r || a.slot - b.slot), [placements]);
  const k = camera?.k ?? 1;
  const grid = useMemo(() => gridExtent(placements), [placements]);

  return (
    <div ref={containerRef} className="relative h-[58svh] min-h-[340px] max-h-[760px] w-full select-none overflow-hidden rounded-xl bg-[#e9efe9] ring-1 ring-zinc-300 dark:bg-[#0f1a17] dark:ring-zinc-800">
      <svg
        ref={svgRef}
        role="group"
        aria-label="World map. Drag to move, scroll or pinch to zoom. Use the leaderboard to find a country by name."
        tabIndex={0}
        className="h-full w-full cursor-grab touch-none outline-none focus-visible:ring-2 focus-visible:ring-sky-500 active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <defs>
          <clipPath id="world-unit-circle">
            <circle r={1} />
          </clipPath>
        </defs>
        {camera && (
          <g transform={`translate(${camera.tx} ${camera.ty}) scale(${camera.k})`}>
            <Cartography extent={grid} k={k} />
            {drawOrder.map((placement) => {
              const country = countries.get(placement.countryId);
              if (!country) return null;
              return (
                <Country
                  key={placement.countryId}
                  placement={placement}
                  country={country}
                  k={k}
                  isMine={placement.countryId === myId}
                  isSelected={placement.countryId === selectedId}
                  imageFailed={country.avatarUrl !== null && failedUrls.has(country.avatarUrl)}
                  onImageError={props.onImageError}
                />
              );
            })}
          </g>
        )}
      </svg>

      <div className="absolute right-2 top-2 flex flex-col gap-1.5">
        <MapButton label="Zoom in" onClick={() => zoomButton(ZOOM_STEP)} disabled={k >= MAX_K}>
          +
        </MapButton>
        <MapButton label="Zoom out" onClick={() => zoomButton(1 / ZOOM_STEP)} disabled={k <= minK * 1.001}>
          −
        </MapButton>
        <MapButton label="Show the whole world" onClick={props.onFit}>
          ⤢
        </MapButton>
        {props.onFindMe && (
          <MapButton label="Find my country" onClick={props.onFindMe}>
            ◎
          </MapButton>
        )}
      </div>

      {camera && viewport && (
        <p aria-hidden className="pointer-events-none absolute bottom-1.5 left-2 font-mono text-[10px] text-zinc-600/80 dark:text-zinc-400/80">
          x {Math.round((viewport.width / 2 - camera.tx) / camera.k)} · y {Math.round((viewport.height / 2 - camera.ty) / camera.k)} · {camera.k.toFixed(2)}×
        </p>
      )}
    </div>
  );
}

function MapButton({ label, onClick, disabled, children }: { label: string; onClick(): void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      // 44 px: a comfortable touch target. Stop the map treating the press as the start of a drag.
      onPointerDown={(event) => event.stopPropagation()}
      className="flex h-11 w-11 items-center justify-center rounded-lg bg-white/90 text-lg font-semibold text-zinc-800 shadow ring-1 ring-zinc-300 hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-40 dark:bg-zinc-900/90 dark:text-zinc-100 dark:ring-zinc-700"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Background: a subtle coordinate grid and faint contour lines. Decorative only (aria-hidden, no pointer events).
// ---------------------------------------------------------------------------------------------------------------------

function gridExtent(placements: readonly Placement[]): number {
  const far = placements.reduce((max, p) => Math.max(max, Math.hypot(p.x, p.y) + p.r), 400);
  return Math.ceil((far * 3) / 400) * 400;
}

/** Contour rings: fixed wobbly closed curves around the origin, the same for everybody. */
function contourPath(radius: number, seed: number): string {
  const points = 72;
  const coordinates = Array.from({ length: points }, (_, i) => {
    const angle = (i / points) * Math.PI * 2;
    const wobble = 1 + 0.07 * Math.sin(angle * 3 + seed) + 0.04 * Math.sin(angle * 5 + seed * 2.3) + 0.025 * Math.sin(angle * 9 + seed * 0.7);
    return `${(Math.cos(angle) * radius * wobble).toFixed(1)} ${(Math.sin(angle) * radius * wobble).toFixed(1)}`;
  });
  return `M${coordinates.join("L")}Z`;
}

function Cartography({ extent, k }: { extent: number; k: number }) {
  const fine = k >= 0.9;
  const rings = useMemo(() => Array.from({ length: 9 }, (_, i) => ({ r: 420 + i * 520, seed: i * 1.7 + 0.4 })), []);
  return (
    <g aria-hidden pointerEvents="none">
      <defs>
        <pattern id="world-grid-major" width={400} height={400} patternUnits="userSpaceOnUse" x={0} y={0}>
          <path d="M400 0H0V400" fill="none" stroke="currentColor" strokeWidth={1.2 / k} />
        </pattern>
        <pattern id="world-grid-minor" width={80} height={80} patternUnits="userSpaceOnUse" x={0} y={0}>
          <path d="M80 0H0V80" fill="none" stroke="currentColor" strokeWidth={0.8 / k} />
        </pattern>
      </defs>
      <g className="text-emerald-900 dark:text-emerald-200">
        {fine && <rect x={-extent} y={-extent} width={extent * 2} height={extent * 2} fill="url(#world-grid-minor)" opacity={0.08} />}
        <rect x={-extent} y={-extent} width={extent * 2} height={extent * 2} fill="url(#world-grid-major)" opacity={0.16} />
        {rings.map((ring) => (
          <path key={ring.r} d={contourPath(ring.r, ring.seed)} fill="none" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.1} />
        ))}
        {/* The two world axes, a touch stronger than the grid. */}
        <path d={`M${-extent} 0H${extent}M0 ${-extent}V${extent}`} stroke="currentColor" strokeWidth={1.4} vectorEffect="non-scaling-stroke" opacity={0.18} />
      </g>
    </g>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// One country.
// ---------------------------------------------------------------------------------------------------------------------

interface CountryProps {
  placement: Placement;
  country: WorldCountry;
  k: number;
  isMine: boolean;
  isSelected: boolean;
  imageFailed: boolean;
  onImageError(url: string): void;
}

function Country({ placement, country, k, isMine, isSelected, imageFailed, onImageError }: CountryProps) {
  const { r } = placement;
  const rpx = r * k; // radius on screen, in pixels
  const unit = 1 / rpx; // one screen pixel, in the circle's local unit space
  const showImage = country.avatarUrl !== null && !imageFailed;
  const labelInside = rpx >= LABEL_INSIDE_MIN_PX;
  const labelBelow = !labelInside && (isMine || isSelected);
  const label = `${isMine ? "★ " : ""}${fit(country.username, rpx)}${isMine && labelBelow ? " (you)" : ""}`;

  return (
    <g
      data-country={country.countryId}
      // Position and size animate by CSS transition. With reduced motion they simply jump.
      style={{ transform: `translate(${placement.x}px, ${placement.y}px) scale(${r})` }}
      className="transition-transform duration-700 ease-out motion-reduce:transition-none"
    >
      <title>{`${country.username}${isMine ? " (you)" : ""} · rank ${country.rank}`}</title>
      {/* An invisible, generously sized target so even a tiny country can be tapped. */}
      <circle r={Math.max(1, MIN_HIT_PX * unit)} fill="transparent" />
      {/* No picture, or it failed to load: the permanent country colour fills the circle. */}
      <circle r={1} fill={country.color} />
      {showImage && (
        <image
          href={country.avatarUrl!}
          x={-1}
          y={-1}
          width={2}
          height={2}
          preserveAspectRatio="xMidYMid slice" // fills the whole circle, centre-cropped, aspect ratio kept
          clipPath="url(#world-unit-circle)"
          onError={() => onImageError(country.avatarUrl!)}
        />
      )}
      {/* The thin border in the country's own colour, one screen pixel wide at every zoom. */}
      <circle r={1} fill="none" stroke={country.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />

      {isSelected && (
        <>
          <circle r={1.1} fill="none" stroke="#111827" strokeWidth={6} vectorEffect="non-scaling-stroke" opacity={0.55} />
          <circle r={1.1} fill="none" stroke="#ffffff" strokeWidth={3} vectorEffect="non-scaling-stroke" />
        </>
      )}
      {/* Marks the player's own country with a dashed ring and a star: visible without seeing colour. */}
      {isMine && <circle r={1.18} fill="none" stroke="#ffffff" strokeWidth={3} strokeDasharray="7 5" vectorEffect="non-scaling-stroke" style={{ filter: "drop-shadow(0 0 1px rgba(0,0,0,.8))" }} />}

      {(labelInside || labelBelow) && (
        <text
          x={0}
          y={labelInside ? 0 : 1 + unit * (LABEL_PX * 1.1)}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={unit * LABEL_PX}
          fontWeight={600}
          fill="#ffffff"
          stroke="rgba(0,0,0,0.75)"
          strokeWidth={unit * 3.2}
          strokeLinejoin="round"
          style={{ paintOrder: "stroke", pointerEvents: "none" }}
        >
          {label}
        </text>
      )}
    </g>
  );
}

/** Shortens a name so it fits inside a circle of `rpx` pixels. A name that cannot fit at least 4 characters is hidden by the caller's size rule. */
function fit(name: string, rpx: number): string {
  const room = Math.floor((rpx * 2 * 0.88) / (LABEL_PX * 0.6));
  if (room >= name.length) return name;
  return room <= 3 ? name.slice(0, 1) : `${name.slice(0, room - 1)}…`;
}
