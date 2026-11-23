/**
 * The viewer's camera: pan and zoom over world coordinates. It belongs to ONE browser tab and is never sent anywhere,
 * so a background update to the data can replace the countries without touching it.
 *
 *   screen = world * k + (tx, ty)          (k = screen pixels per world unit)
 *
 * Pure functions only; the component feeds them pointer, wheel and button events.
 */
import type { Bounds } from "./world-layout.ts";

export interface Camera {
  tx: number;
  ty: number;
  k: number;
}
export interface Viewport {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}

export const MAX_K = 8;
export const ZOOM_STEP = 1.4;

/** The camera that shows the whole box with `padding` screen pixels around it. */
export function fitBounds(bounds: Bounds, viewport: Viewport, padding = 24): Camera {
  const width = Math.max(bounds.maxX - bounds.minX, 1);
  const height = Math.max(bounds.maxY - bounds.minY, 1);
  const k = Math.min((viewport.width - padding * 2) / width, (viewport.height - padding * 2) / height, MAX_K);
  const safeK = Number.isFinite(k) && k > 0 ? k : 1;
  return {
    k: safeK,
    tx: viewport.width / 2 - ((bounds.minX + bounds.maxX) / 2) * safeK,
    ty: viewport.height / 2 - ((bounds.minY + bounds.maxY) / 2) * safeK,
  };
}

/** Zooming out further than half of "fit everything" only shows empty space. */
export const minKFor = (fit: Camera): number => fit.k * 0.5;

export const clampK = (k: number, minK: number): number => Math.min(Math.max(k, minK), MAX_K);

export const worldToScreen = (camera: Camera, p: Point): Point => ({ x: p.x * camera.k + camera.tx, y: p.y * camera.k + camera.ty });
export const screenToWorld = (camera: Camera, p: Point): Point => ({ x: (p.x - camera.tx) / camera.k, y: (p.y - camera.ty) / camera.k });

/** Zoom by `factor` keeping the world point under `screenPoint` exactly where it is (cursor or pinch centre). */
export function zoomAt(camera: Camera, factor: number, screenPoint: Point, minK: number): Camera {
  const k = clampK(camera.k * factor, minK);
  const world = screenToWorld(camera, screenPoint);
  return { k, tx: screenPoint.x - world.x * k, ty: screenPoint.y - world.y * k };
}

export const panBy = (camera: Camera, dx: number, dy: number): Camera => ({ ...camera, tx: camera.tx + dx, ty: camera.ty + dy });

/**
 * A camera that puts `world` in the middle of the viewport. `minRadiusPx` raises the zoom when needed so a small
 * country is big enough to see and tap; it never zooms OUT (a viewer who zoomed in stays zoomed in).
 */
export function centerOn(camera: Camera, world: Point, viewport: Viewport, radius: number, minRadiusPx: number, minK: number): Camera {
  const k = clampK(Math.max(camera.k, minRadiusPx / Math.max(radius, 1e-6)), minK);
  return { k, tx: viewport.width / 2 - world.x * k, ty: viewport.height / 2 - world.y * k };
}

/** Keeps what was at the centre of the old viewport at the centre of the new one (window resize, phone rotation). */
export function resizeKeepingCenter(camera: Camera, from: Viewport, to: Viewport): Camera {
  return { ...camera, tx: camera.tx + (to.width - from.width) / 2, ty: camera.ty + (to.height - from.height) / 2 };
}

/** Linear blend for the short "fly to" animation. */
export const lerpCamera = (a: Camera, b: Camera, t: number): Camera => ({ tx: a.tx + (b.tx - a.tx) * t, ty: a.ty + (b.ty - a.ty) * t, k: a.k + (b.k - a.k) * t });
