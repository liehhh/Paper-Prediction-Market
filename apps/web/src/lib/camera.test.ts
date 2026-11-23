import { describe, expect, it } from "vitest";
import { centerOn, clampK, fitBounds, lerpCamera, MAX_K, minKFor, panBy, resizeKeepingCenter, screenToWorld, worldToScreen, zoomAt } from "./camera.ts";

const viewport = { width: 800, height: 600 };
const bounds = { minX: -400, minY: -300, maxX: 400, maxY: 300 };

describe("fitBounds", () => {
  it("shows the whole world, centred, with padding", () => {
    const camera = fitBounds(bounds, viewport, 20);
    expect(camera.k).toBeCloseTo(Math.min(760 / 800, 560 / 600), 12);
    const corner = worldToScreen(camera, { x: -400, y: -300 });
    expect(corner.x).toBeGreaterThanOrEqual(20 - 1e-9);
    expect(corner.y).toBeGreaterThanOrEqual(20 - 1e-9);
    expect(worldToScreen(camera, { x: 0, y: 0 })).toEqual({ x: 400, y: 300 });
  });
  it("never zooms in past the maximum for a tiny world, and survives a zero-size viewport", () => {
    expect(fitBounds({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, viewport).k).toBe(MAX_K);
    expect(Number.isFinite(fitBounds(bounds, { width: 0, height: 0 }).k)).toBe(true);
  });
});

describe("zoomAt keeps the point under the cursor (or pinch centre) fixed", () => {
  it("for zooming in and out", () => {
    const camera = fitBounds(bounds, viewport);
    const minK = minKFor(camera);
    for (const factor of [1.4, 0.7, 3]) {
      const cursor = { x: 123, y: 456 };
      const before = screenToWorld(camera, cursor);
      const after = zoomAt(camera, factor, cursor, minK);
      const stillThere = worldToScreen(after, before);
      expect(stillThere.x).toBeCloseTo(cursor.x, 8);
      expect(stillThere.y).toBeCloseTo(cursor.y, 8);
    }
  });
  it("is limited at both ends", () => {
    const camera = fitBounds(bounds, viewport);
    const minK = minKFor(camera);
    expect(zoomAt(camera, 1e-6, { x: 0, y: 0 }, minK).k).toBeCloseTo(minK, 12);
    expect(zoomAt(camera, 1e6, { x: 0, y: 0 }, minK).k).toBe(MAX_K);
    expect(clampK(0.0001, minK)).toBe(minK);
  });
});

describe("panning, centring, resizing", () => {
  it("panBy moves the picture by exactly the drag distance", () => {
    const camera = fitBounds(bounds, viewport);
    const moved = panBy(camera, 30, -12);
    const before = worldToScreen(camera, { x: 10, y: 20 });
    const after = worldToScreen(moved, { x: 10, y: 20 });
    expect([after.x - before.x, after.y - before.y]).toEqual([30, -12]);
  });
  it("centerOn puts a country in the middle, and zooms in only as far as needed to be tappable", () => {
    const camera = fitBounds(bounds, viewport);
    const minK = minKFor(camera);
    const centred = centerOn(camera, { x: 250, y: -100 }, viewport, 60, 40, minK);
    expect(worldToScreen(centred, { x: 250, y: -100 })).toEqual({ x: 400, y: 300 });
    expect(60 * centred.k).toBeGreaterThanOrEqual(40 - 1e-9); // radius on screen is at least 40 px
    // A viewer who is already zoomed in stays zoomed in.
    const close = { ...camera, k: 3 };
    expect(centerOn(close, { x: 0, y: 0 }, viewport, 60, 40, minK).k).toBe(3);
  });
  it("a resize keeps the centre of the view where it was", () => {
    const camera = fitBounds(bounds, viewport);
    const centreWorld = screenToWorld(camera, { x: 400, y: 300 });
    const next = { width: 390, height: 700 };
    const resized = resizeKeepingCenter(camera, viewport, next);
    const back = screenToWorld(resized, { x: 195, y: 350 });
    expect([back.x, back.y].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([centreWorld.x, centreWorld.y].map((v) => Math.round(v * 1e6) / 1e6));
  });
  it("lerpCamera blends endpoints", () => {
    const a = { tx: 0, ty: 0, k: 1 };
    const b = { tx: 100, ty: -50, k: 3 };
    expect(lerpCamera(a, b, 0)).toEqual(a);
    expect(lerpCamera(a, b, 1)).toEqual(b);
    expect(lerpCamera(a, b, 0.5)).toEqual({ tx: 50, ty: -25, k: 2 });
  });
});
