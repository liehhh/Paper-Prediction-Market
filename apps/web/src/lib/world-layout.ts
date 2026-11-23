/**
 * Where every country sits on the World, in WORLD coordinates. Pan, zoom and screen size belong to the viewer
 * (see camera.ts) and never appear here, so two people looking at the same snapshot get exactly the same picture.
 *
 * ANCHOR  Each country has a permanent anchor derived from its permanent `slot` alone: a sunflower (Vogel) spiral,
 *         slot n at distance SPACING * sqrt(n) and angle n * golden angle. The anchor does not depend on anyone's size,
 *         rank or picture, and adding a new country (a higher slot) never moves an existing anchor. Neighbours in slot
 *         order are neighbours in space, so everyone recognises the same neighbourhoods.
 *
 * SIZE    radius = BASE_RADIUS * sqrt(areaWeight). Circle area is pi * r^2, so AREA is proportional to areaWeight:
 *         twice the Power, twice the area. The scale is absolute (weight 1.00 = a player who still has the 10,000 grant),
 *         so one player growing never shrinks anyone else.
 *
 * RELAX   When a country grows into a neighbour, a bounded, deterministic pass pushes the overlapping circles apart
 *         (the smaller one moves more) and never lets a circle drift far from its anchor. When nothing overlaps
 *         (for example everybody still has the grant) every circle sits exactly on its anchor. There is no physics
 *         simulation: the result is a pure function of the snapshot, computed once per update.
 */
export interface WorldInput {
  countryId: string;
  slot: number;
  areaWeight: number;
}

export interface Placement {
  countryId: string;
  slot: number;
  /** Where the circle is drawn (anchor, plus any local push-apart). */
  x: number;
  y: number;
  r: number;
  anchorX: number;
  anchorY: number;
}

export const BASE_RADIUS = 60;
export const ANCHOR_SPACING = 130;
/** A weight below this still gets a visible, selectable dot. */
export const MIN_WEIGHT = 0.04;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const GAP = 8;
const MAX_ITERATIONS = 60;
/** A circle never ends up further than this from its anchor, so neighbourhoods stay recognisable. */
const MAX_DRIFT = BASE_RADIUS * 6;

export const radiusFor = (areaWeight: number): number => BASE_RADIUS * Math.sqrt(Math.max(areaWeight, MIN_WEIGHT));

export function anchorFor(slot: number): { x: number; y: number } {
  const distance = ANCHOR_SPACING * Math.sqrt(slot);
  const angle = slot * GOLDEN_ANGLE;
  return { x: distance * Math.cos(angle), y: distance * Math.sin(angle) };
}

export function layoutWorld(countries: readonly WorldInput[]): Placement[] {
  const placements: Placement[] = [...countries]
    .sort((a, b) => a.slot - b.slot) // a fixed order, so the result never depends on how the data arrived
    .map((country) => {
      const anchor = anchorFor(country.slot);
      return { countryId: country.countryId, slot: country.slot, x: anchor.x, y: anchor.y, r: radiusFor(country.areaWeight), anchorX: anchor.x, anchorY: anchor.y };
    });

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let moved = false;
    for (let i = 0; i < placements.length; i++) {
      const a = placements[i]!;
      for (let j = i + 1; j < placements.length; j++) {
        const b = placements[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const need = a.r + b.r + GAP;
        // Cheap rejection before the square root.
        if (Math.abs(dx) >= need || Math.abs(dy) >= need) continue;
        const distance = Math.hypot(dx, dy);
        if (distance >= need) continue;
        // Exactly on top of each other: split along a direction fixed by the two slots (never random).
        const ux = distance > 1e-9 ? dx / distance : Math.cos((a.slot + b.slot) * GOLDEN_ANGLE);
        const uy = distance > 1e-9 ? dy / distance : Math.sin((a.slot + b.slot) * GOLDEN_ANGLE);
        const push = need - distance;
        const shareA = b.r / (a.r + b.r); // the smaller circle moves more
        a.x -= ux * push * shareA;
        a.y -= uy * push * shareA;
        b.x += ux * push * (1 - shareA);
        b.y += uy * push * (1 - shareA);
        moved = true;
      }
    }
    for (const p of placements) {
      const driftX = p.x - p.anchorX;
      const driftY = p.y - p.anchorY;
      const drift = Math.hypot(driftX, driftY);
      if (drift > MAX_DRIFT) {
        p.x = p.anchorX + (driftX / drift) * MAX_DRIFT;
        p.y = p.anchorY + (driftY / drift) * MAX_DRIFT;
      }
    }
    if (!moved) break;
  }
  return placements;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The box around every circle, plus `pad` on each side. An empty world is a unit box at the origin. */
export function worldBounds(placements: readonly Placement[], pad = 0): Bounds {
  if (placements.length === 0) return { minX: -BASE_RADIUS, minY: -BASE_RADIUS, maxX: BASE_RADIUS, maxY: BASE_RADIUS };
  return {
    minX: Math.min(...placements.map((p) => p.x - p.r)) - pad,
    minY: Math.min(...placements.map((p) => p.y - p.r)) - pad,
    maxX: Math.max(...placements.map((p) => p.x + p.r)) + pad,
    maxY: Math.max(...placements.map((p) => p.y + p.r)) + pad,
  };
}
