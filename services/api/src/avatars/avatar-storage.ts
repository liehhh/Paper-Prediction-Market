/**
 * Talks to Supabase Storage on the PLAYER'S behalf, with the player's own access token and the public publishable key.
 * No secret or service_role key exists in this project, so every write is checked by the database's Storage policies
 * (supabase/migrations/20261124120000_player_avatars.sql): a player can only add or delete objects inside the folder
 * of the country they own.
 *
 *   object path:  avatars/<country id>/<random uuid>.webp      (a NEW name for every picture)
 *   public URL:   <SUPABASE_URL>/storage/v1/object/public/avatars/<country id>/<random uuid>.webp
 *
 * The path holds the country id, which is already public, and an unguessable name. It never holds the account id,
 * an email, or the original file name.
 */
export const AVATAR_BUCKET = "avatars";

export interface AvatarStorageOptions {
  /** e.g. https://abcdxyz.supabase.co */
  url: string;
  publishableKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class AvatarStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarStorageError";
  }
}

export const avatarPath = (countryId: string, key: string) => `${countryId}/${key}`;

/** The public address of a stored picture. Pure string building: it does not check that the object exists. */
export function avatarPublicUrl(supabaseUrl: string, countryId: string, key: string): string {
  return new URL(`/storage/v1/object/public/${AVATAR_BUCKET}/${avatarPath(countryId, key)}`, supabaseUrl).toString();
}

const headers = (options: AvatarStorageOptions, accessToken: string) => ({ apikey: options.publishableKey, Authorization: `Bearer ${accessToken}` });

/** Stores a finished WebP under a brand-new name. Never overwrites: a name that already exists is refused. */
export async function uploadAvatarObject(options: AvatarStorageOptions, accessToken: string, countryId: string, key: string, webp: Buffer): Promise<void> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(new URL(`/storage/v1/object/${AVATAR_BUCKET}/${avatarPath(countryId, key)}`, options.url), {
      method: "POST",
      headers: { ...headers(options, accessToken), "content-type": "image/webp", "cache-control": "max-age=31536000", "x-upsert": "false" },
      body: new Uint8Array(webp),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new AvatarStorageError(`storage unreachable: ${error instanceof Error ? error.message : error}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AvatarStorageError(`storage upload responded ${response.status}`);
  }
}

/** Removes an old picture. Best effort: the profile already points elsewhere, so a failure only leaves an unused file. */
export async function deleteAvatarObject(options: AvatarStorageOptions, accessToken: string, countryId: string, key: string): Promise<boolean> {
  try {
    const response = await (options.fetchImpl ?? fetch)(new URL(`/storage/v1/object/${AVATAR_BUCKET}/${avatarPath(countryId, key)}`, options.url), {
      method: "DELETE",
      headers: headers(options, accessToken),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
