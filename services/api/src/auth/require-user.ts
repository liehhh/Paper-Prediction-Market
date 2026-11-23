/**
 * Express middleware: turns "Authorization: Bearer <token>" into a verified user id.
 *
 * The ONLY source of the user id is the verified token. Nothing from the request body, query
 * string or other headers is ever used to decide who the caller is.
 */
import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { errorBody } from "@league/catalog-contract";
import { verifyAccessToken, type SupabaseAuthOptions } from "./supabase-auth.ts";

/** Default trust window for a token Supabase Auth has confirmed. Short on purpose (see SupabaseAuthOptions.cacheTtlMs). */
export const DEFAULT_AUTH_CACHE_TTL_MS = 20_000;
const MAX_CACHED_TOKENS = 1000;

export function requireUser(auth: SupabaseAuthOptions | undefined) {
  // Only CONFIRMED tokens are remembered (never a rejected or failed check), keyed by a hash of the token.
  const confirmed = new Map<string, { userId: string; expiresAt: number }>();
  // Checks in progress. A page that makes three calls at once would otherwise ask Supabase Auth three times at once.
  const inFlight = new Map<string, Promise<{ userId: string } | null>>();
  const ttl = auth?.cacheTtlMs ?? DEFAULT_AUTH_CACHE_TTL_MS;

  async function whoOwns(options: SupabaseAuthOptions, token: string): Promise<{ userId: string } | null> {
    if (ttl <= 0) return verifyAccessToken(options, token);
    const key = createHash("sha256").update(token).digest("hex");
    const now = Date.now();
    const hit = confirmed.get(key);
    if (hit && hit.expiresAt > now) return { userId: hit.userId };
    const running = inFlight.get(key);
    if (running) return running; // share the check that is already on its way
    const check = verifyAccessToken(options, token);
    inFlight.set(key, check);
    let user: { userId: string } | null;
    try {
      user = await check;
    } finally {
      inFlight.delete(key);
    }
    if (user) {
      if (confirmed.size >= MAX_CACHED_TOKENS) {
        for (const [k, v] of confirmed) if (v.expiresAt <= now) confirmed.delete(k);
        if (confirmed.size >= MAX_CACHED_TOKENS) confirmed.delete(confirmed.keys().next().value!); // drop the oldest
      }
      confirmed.set(key, { userId: user.userId, expiresAt: now + ttl });
    } else confirmed.delete(key);
    return user;
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!auth) {
      res.status(503).json(errorBody("auth_unavailable", "Sign-in is not configured on this server."));
      return;
    }
    const match = /^Bearer (\S+)$/i.exec(req.get("authorization") ?? "");
    const user = match ? await whoOwns(auth, match[1]!) : null;
    if (!user) {
      res.set("WWW-Authenticate", "Bearer").status(401).json(errorBody("unauthenticated", "Sign in to continue."));
      return;
    }
    res.locals.userId = user.userId;
    // Kept so services/api can act for the player toward Supabase Storage with the player's OWN token (no secret key exists).
    res.locals.accessToken = match![1];
    next();
  };
}

/** The caller's verified access token. Only call inside a handler that sits behind requireUser. */
export function verifiedAccessToken(res: Response): string {
  const token: unknown = res.locals.accessToken;
  if (typeof token !== "string") throw new Error("verifiedAccessToken used on a route without requireUser");
  return token;
}

/** Only call inside a handler that sits behind requireUser. */
export function verifiedUserId(res: Response): string {
  const userId: unknown = res.locals.userId;
  if (typeof userId !== "string") throw new Error("verifiedUserId used on a route without requireUser");
  return userId;
}
