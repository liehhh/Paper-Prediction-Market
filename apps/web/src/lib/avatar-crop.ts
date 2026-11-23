/**
 * The square centre of an image: the part that will fill the country circle. Keeps the picture's aspect ratio (it is
 * cropped, never stretched). The same choice is made again on the server (services/api re-crops with "cover, centre"),
 * so what the player previews is what the World shows.
 */
export function centerCropSquare(width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.max(1, Math.min(width, height));
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

/** Accepted picture types, matching the server. (The server still checks the real bytes; this only avoids a wasted trip.) */
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** The browser shrinks the picture to 512 px before sending, so even a large phone photo uploads in a moment. */
export const UPLOAD_SIDE_PX = 512;
/** Refuse to even try to decode something enormous in the browser. */
export const MAX_PICKED_BYTES = 25 * 1024 * 1024;
