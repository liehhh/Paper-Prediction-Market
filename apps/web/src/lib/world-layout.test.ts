import { describe, expect, it } from "vitest";
import { anchorFor, BASE_RADIUS, layoutWorld, radiusFor, worldBounds, type WorldInput } from "./world-layout.ts";

const country = (slot: number, areaWeight = 1): WorldInput => ({ countryId: `c${slot}`, slot, areaWeight });
const area = (r: number) => Math.PI * r * r;
const gap = (a: { x: number; y: number; r: number }, b: { x: number; y: number; r: number }) => Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
const find = (ps: ReturnType<typeof layoutWorld>, id: string) => ps.find((p) => p.countryId === id)!;

describe("size: circle AREA is proportional to the area weight (checked on areas, not radii by eye)", () => {
  it("A at 1.06 vs B at 1.00 (10,600 vs 10,000 Power) has 6% more area", () => {
    const ratio = area(radiusFor(1.06)) / area(radiusFor(1));
    expect(ratio).toBeCloseTo(1.06, 12);
    expect(radiusFor(1.06) / radiusFor(1)).toBeCloseTo(Math.sqrt(1.06), 12); // so radius grows only ~3%
  });
  it("twice the weight is twice the area; four times is four times", () => {
    expect(area(radiusFor(2)) / area(radiusFor(1))).toBeCloseTo(2, 12);
    expect(area(radiusFor(4)) / area(radiusFor(1))).toBeCloseTo(4, 12);
  });
  it("the player who still has the grant has the base radius", () => {
    expect(radiusFor(1)).toBe(BASE_RADIUS);
  });
  it("a near-zero weight still gets a visible dot", () => {
    expect(radiusFor(0)).toBeGreaterThan(5);
  });
  it("laid-out circles keep the area ratio exactly (relaxation moves circles, never resizes them)", () => {
    const [a, b] = layoutWorld([country(1, 1.06), country(2, 1)]);
    expect(area(a!.r) / area(b!.r)).toBeCloseTo(1.06, 12);
  });
});

describe("anchors: permanent, derived from the slot alone", () => {
  it("are the same every time and differ by slot", () => {
    expect(anchorFor(7)).toEqual(anchorFor(7));
    const points = Array.from({ length: 200 }, (_, i) => anchorFor(i + 1));
    expect(new Set(points.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)).size).toBe(200);
  });
  it("with everyone at the starting grant nothing overlaps, so every circle sits exactly on its anchor", () => {
    const placements = layoutWorld(Array.from({ length: 250 }, (_, i) => country(i + 1)));
    for (const p of placements) expect([p.x, p.y]).toEqual([p.anchorX, p.anchorY]);
    for (let i = 0; i < placements.length; i++) for (let j = i + 1; j < Math.min(placements.length, i + 40); j++) expect(gap(placements[i]!, placements[j]!)).toBeGreaterThan(0);
  });
  it("two users with the same data get the identical layout, whatever order it arrives in", () => {
    const input = [country(3, 1.4), country(1, 0.9), country(2, 2.5), country(4, 1)];
    expect(layoutWorld(input)).toEqual(layoutWorld([...input].reverse()));
  });
});

describe("stability: nothing shuffles", () => {
  const base = Array.from({ length: 60 }, (_, i) => country(i + 1));

  it("a new country joining leaves every existing country exactly where it was", () => {
    const before = layoutWorld(base);
    const after = layoutWorld([...base, country(61), country(62)]);
    for (const p of before) expect(find(after, p.countryId)).toMatchObject({ x: p.x, y: p.y, r: p.r });
  });

  it("moving up one rank (a slightly larger weight) moves nobody", () => {
    const before = layoutWorld(base);
    const after = layoutWorld(base.map((c) => (c.slot === 20 ? { ...c, areaWeight: 1.06 } : c)));
    for (const p of before) expect([find(after, p.countryId).x, find(after, p.countryId).y]).toEqual([p.x, p.y]);
  });

  it("one country growing a lot pushes only its near neighbours, and only a little", () => {
    const before = layoutWorld(base);
    const after = layoutWorld(base.map((c) => (c.slot === 30 ? { ...c, areaWeight: 12 } : c)));
    const big = find(after, "c30");
    let moved = 0;
    for (const p of before) {
      const now = find(after, p.countryId);
      const shift = Math.hypot(now.x - p.x, now.y - p.y);
      if (shift > 1e-6) {
        moved++;
        expect(Math.hypot(p.x - big.anchorX, p.y - big.anchorY)).toBeLessThan(big.r * 3 + 200); // only the neighbourhood
        expect(shift).toBeLessThan(big.r * 2); // and by a bounded amount
      }
    }
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(15); // never "everyone shuffles"
  });

  it("circles are separated after growth (no overlaps in a realistic mixed world)", () => {
    const weights = [1, 1.06, 0.8, 2.2, 1.5, 0.5, 3, 1.1];
    const world = Array.from({ length: 120 }, (_, i) => country(i + 1, weights[i % weights.length]));
    const placements = layoutWorld(world);
    let worst = Infinity;
    for (let i = 0; i < placements.length; i++) for (let j = i + 1; j < placements.length; j++) worst = Math.min(worst, gap(placements[i]!, placements[j]!));
    expect(worst).toBeGreaterThan(-0.5);
  });

  it("no circle drifts far from its anchor, and an exact tie is split deterministically", () => {
    const p = layoutWorld([country(1, 25), country(2, 25)]);
    for (const q of p) expect(Math.hypot(q.x - q.anchorX, q.y - q.anchorY)).toBeLessThanOrEqual(BASE_RADIUS * 6 + 1e-6);
    expect(layoutWorld([country(1, 25), country(2, 25)])).toEqual(p);
  });
});

describe("worldBounds", () => {
  it("wraps every circle with padding, and an empty world has a sensible box", () => {
    const placements = layoutWorld([country(1), country(2), country(3)]);
    const bounds = worldBounds(placements, 10);
    for (const p of placements) {
      expect(p.x - p.r).toBeGreaterThanOrEqual(bounds.minX + 10 - 1e-9);
      expect(p.x + p.r).toBeLessThanOrEqual(bounds.maxX - 10 + 1e-9);
    }
    expect(worldBounds([]).maxX).toBeGreaterThan(0);
  });
});
