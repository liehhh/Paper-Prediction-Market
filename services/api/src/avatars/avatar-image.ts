/**
 * The TRUSTED check on a profile picture. Nothing the browser says about the file is believed: not its type, not its
 * size, not its name. Whatever arrives is measured, decoded, and re-drawn as a fresh 256 x 256 WebP.
 *
 * Re-encoding is also the privacy step: the new file has no EXIF block (no GPS position, camera, or timestamps), no
 * original filename and no embedded profile. Only pixels survive.
 *
 * Limits: 2 MB in, JPEG / PNG / WebP only (a GIF or SVG is refused, so nothing animated or scriptable), at least
 * 32 px on the short side, and a decode budget of 40 megapixels so a tiny file cannot expand into a huge image.
 */
import sharp from "sharp";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const AVATAR_SIZE = 256;
const MIN_SIDE = 32;
const MAX_PIXELS = 40_000_000;
const ACCEPTED = new Set(["jpeg", "png", "webp"]);

export class AvatarImageError extends Error {
  readonly code: "avatar_too_large" | "avatar_unsupported_type" | "avatar_invalid_image";
  readonly status: number;
  constructor(code: AvatarImageError["code"], message: string) {
    super(message);
    this.name = "AvatarImageError";
    this.code = code;
    this.status = code === "avatar_too_large" ? 413 : code === "avatar_unsupported_type" ? 415 : 400;
  }
}

/** Returns the finished 256 x 256 WebP, or throws an AvatarImageError whose message is safe to show the player. */
export async function processAvatar(upload: Buffer): Promise<Buffer> {
  if (upload.length === 0) throw new AvatarImageError("avatar_invalid_image", "No image was received. Choose a picture and try again.");
  if (upload.length > MAX_UPLOAD_BYTES) throw new AvatarImageError("avatar_too_large", "That picture is too large. Choose one under 2 MB.");

  try {
    const probe = sharp(upload, { limitInputPixels: MAX_PIXELS, failOn: "error" });
    const meta = await probe.metadata();
    // Judged by what the bytes ARE (sharp reads the real file signature), not by the declared content type or file name.
    if (!meta.format || !ACCEPTED.has(meta.format) || (meta.pages ?? 1) > 1) {
      throw new AvatarImageError("avatar_unsupported_type", "That file type is not supported. Use a JPEG, PNG or WebP picture.");
    }
    if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_SIDE) {
      throw new AvatarImageError("avatar_invalid_image", "That picture is too small. Use one at least 32 pixels wide and tall.");
    }
    return await sharp(upload, { limitInputPixels: MAX_PIXELS, failOn: "error" })
      .rotate() // honour the camera's orientation flag, then the flag is dropped with the rest of the metadata
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "centre" }) // center-crop, aspect ratio preserved
      .webp({ quality: 82 })
      .toBuffer();
  } catch (error) {
    if (error instanceof AvatarImageError) throw error;
    throw new AvatarImageError("avatar_invalid_image", "We could not read that picture. Try a different JPEG, PNG or WebP file.");
  }
}
