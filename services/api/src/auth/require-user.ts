/**
 * Express middleware: turns "Authorization: Bearer <token>" into a verified user id.
 *
 * The ONLY source of the user id is the verified token. Nothing from the request body, query
 * string or other headers is ever used to decide who the caller is.
 */
import type { NextFunction, Request, Response } from "express";
import { errorBody } from "@league/catalog-contract";
import { verifyAccessToken, type SupabaseAuthOptions } from "./supabase-auth.ts";

export function requireUser(auth: SupabaseAuthOptions | undefined) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!auth) {
      res.status(503).json(errorBody("auth_unavailable", "Sign-in is not configured on this server."));
      return;
    }
    const match = /^Bearer (\S+)$/i.exec(req.get("authorization") ?? "");
    const user = match ? await verifyAccessToken(auth, match[1]!) : null;
    if (!user) {
      res.set("WWW-Authenticate", "Bearer").status(401).json(errorBody("unauthenticated", "Sign in to continue."));
      return;
    }
    res.locals.userId = user.userId;
    next();
  };
}

/** Only call inside a handler that sits behind requireUser. */
export function verifiedUserId(res: Response): string {
  const userId: unknown = res.locals.userId;
  if (typeof userId !== "string") throw new Error("verifiedUserId used on a route without requireUser");
  return userId;
}
