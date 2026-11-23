/**
 * Verifies a Supabase access token by asking Supabase Auth who it belongs to.
 *
 *   GET {SUPABASE_URL}/auth/v1/user   Authorization: Bearer <access token>   apikey: <publishable key>
 *
 * Supabase Auth checks the signature, the expiry, and that the session still exists, then returns
 * the user. Asking the Auth server (instead of verifying the JWT locally) works regardless of the
 * project's signing-key type and honours sign-out, at the price of one HTTPS round trip per request.
 * The publishable key is public by design; no secret or service_role key is used or needed.
 */
import { z } from "zod";

export interface SupabaseAuthOptions {
  /** e.g. https://abcdxyz.supabase.co */
  url: string;
  publishableKey: string;
  timeoutMs: number;
  /**
   * How long a token that Supabase Auth confirmed stays trusted in this process's memory (milliseconds). 0 turns the
   * cache off. Asking Supabase Auth costs a network round trip (about 400 ms) on EVERY signed-in request, and one page
   * makes several; the cost of caching is that a token revoked by sign-out keeps working here for at most this long.
   */
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
}

/** Supabase Auth could not be asked (network, timeout, 5xx). NOT the same as "the token is invalid". */
export class SupabaseAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseAuthUnavailableError";
  }
}

const AuthUserSchema = z.object({ id: z.uuid() });

/** Returns the immutable Supabase user id, or null when the token is missing, expired, or forged. */
export async function verifyAccessToken(options: SupabaseAuthOptions, accessToken: string): Promise<{ userId: string } | null> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(new URL("/auth/v1/user", options.url), {
      headers: { apikey: options.publishableKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new SupabaseAuthUnavailableError(`Supabase Auth unreachable: ${error instanceof Error ? error.message : error}`);
  }

  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new SupabaseAuthUnavailableError(`Supabase Auth responded ${response.status}`);
  }
  const user = AuthUserSchema.safeParse(await response.json().catch(() => undefined));
  if (!user.success) throw new SupabaseAuthUnavailableError("Supabase Auth returned an unexpected response shape");
  return { userId: user.data.id };
}
