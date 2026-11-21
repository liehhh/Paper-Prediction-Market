/**
 * The trading service's internal HTTP interface. Only services/api should call it, and it is
 * bound to loopback. It trusts the user id in the URL because services/api has already verified
 * the caller's Supabase access token; browsers never reach this service.
 *
 *   GET /health                         -> liveness + database reachability
 *   PUT /internal/v1/accounts/:userId   -> create the account + starting grant, or return it (idempotent)
 *   GET /internal/v1/accounts/:userId   -> read-only view, 404 if the user has no account yet
 */
import express, { type NextFunction, type Request, type Response } from "express";
import type pg from "pg";
import { z } from "zod";
import { errorBody } from "@league/catalog-contract";
import { getTradingAccount, provisionTradingAccount } from "../accounts/trading-accounts.ts";

const UserIdSchema = z.uuid();

export function createApp(deps: { pool: pg.Pool }) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", async (_req, res) => {
    try {
      await deps.pool.query("select 1");
      res.json({ status: "ok", service: "trading", database: "reachable" });
    } catch {
      res.status(503).json(errorBody("database_unavailable", "The trading database is not reachable."));
    }
  });

  // No request body is ever read: the grant amount is decided by the server, not the caller.
  app.put("/internal/v1/accounts/:userId", async (req, res) => {
    const userId = UserIdSchema.safeParse(req.params.userId);
    if (!userId.success) {
      res.status(400).json(errorBody("invalid_request", "The user id is not a valid UUID."));
      return;
    }
    res.set("Cache-Control", "no-store").json(await provisionTradingAccount(deps.pool, userId.data));
  });

  app.get("/internal/v1/accounts/:userId", async (req, res) => {
    const userId = UserIdSchema.safeParse(req.params.userId);
    if (!userId.success) {
      res.status(400).json(errorBody("invalid_request", "The user id is not a valid UUID."));
      return;
    }
    const account = await getTradingAccount(deps.pool, userId.data);
    if (!account) {
      res.status(404).json(errorBody("trading_account_not_found", "This user has no trading account yet."));
      return;
    }
    res.set("Cache-Control", "no-store").json(account);
  });

  app.use((_req, res) => {
    res.status(404).json(errorBody("not_found", "Route not found."));
  });

  // Express 5 forwards rejected async handlers here. Details are logged, never returned.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[trading] request failed:", error);
    res.status(500).json(errorBody("internal_error", "The trading service failed to handle the request."));
  });

  return app;
}
