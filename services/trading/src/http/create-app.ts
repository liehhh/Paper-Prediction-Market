/**
 * The trading service's internal HTTP interface. Only services/api should call it, and it is
 * bound to loopback. It trusts the user id in the URL because services/api has already verified
 * the caller's Supabase access token; browsers never reach this service.
 *
 *   GET  /health                                      liveness + database reachability
 *   PUT  /internal/v1/accounts/:userId                create the account + starting grant, or return it (idempotent)
 *   GET  /internal/v1/accounts/:userId                read-only view, 404 if the user has no account yet
 *   PUT  /internal/v1/accounts/:userId/username       change the unique username (the country label)
 *   PUT  /internal/v1/accounts/:userId/avatar         point the profile at a new picture (or null to remove it)
 *   POST /internal/v1/accounts/:userId/trades/preview price an order against a live quote; writes nothing
 *   POST /internal/v1/accounts/:userId/trades         confirm an order (idempotent); one atomic transaction
 *   GET  /internal/v1/accounts/:userId/portfolio      private portfolio; read-only
 *   GET  /internal/v1/league                          PUBLIC league snapshot (coarse data only); read-only
 */
import express, { type NextFunction, type Request, type Response } from "express";
import type pg from "pg";
import { z } from "zod";
import { errorBody } from "@league/catalog-contract";
import { AvatarKeyRequestSchema, TradeConfirmRequestSchema, TradePreviewRequestSchema, UsernameRequestSchema, type TradeError as TradeErrorBody } from "@league/trading-contract";
import type { CatalogPort } from "../catalog-client.ts";
import { getTradingAccount, provisionTradingAccount, setAvatarKey, setUsername, UsernameTakenError } from "../accounts/trading-accounts.ts";
import { getPortfolio, toLeagueSnapshot } from "../league/league.ts";
import type { ValuationService } from "../league/valuation.ts";
import { confirmTrade, previewTrade, TradeError } from "../trades/trade-service.ts";

const UserIdSchema = z.uuid();

export function createApp(deps: { pool: pg.Pool; catalog: CatalogPort; valuation: ValuationService }) {
  const app = express();
  app.disable("x-powered-by");
  const tradeDeps = { pool: deps.pool, catalog: deps.catalog, onChange: () => deps.valuation.invalidate() };

  app.get("/health", async (_req, res) => {
    try {
      await deps.pool.query("select 1");
      res.json({ status: "ok", service: "trading", database: "reachable" });
    } catch {
      res.status(503).json(errorBody("database_unavailable", "The trading database is not reachable."));
    }
  });

  const bad = (res: Response, message: string) => res.status(400).json(errorBody("invalid_request", message));
  const withUser = (handler: (userId: string, req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    const userId = UserIdSchema.safeParse(req.params.userId);
    if (!userId.success) return void bad(res, "The user id is not a valid UUID.");
    await handler(userId.data, req, res);
  };

  // No request body is ever read: the grant amount is decided by the server, not the caller.
  app.put(
    "/internal/v1/accounts/:userId",
    withUser(async (userId, _req, res) => {
      // Almost every call is for an account that already exists: answer with ONE read. Provisioning (a transaction of
      // several statements) and invalidating the cached valuation happen only when the account really is new.
      let account = await getTradingAccount(deps.pool, userId);
      if (!account) {
        account = await provisionTradingAccount(deps.pool, userId); // still safe if two requests race: the DATABASE settles it
        deps.valuation.invalidate(); // a new account joins the World
      }
      res.set("Cache-Control", "no-store").json(account);
    }),
  );

  app.get(
    "/internal/v1/accounts/:userId",
    withUser(async (userId, _req, res) => {
      const account = await getTradingAccount(deps.pool, userId);
      if (!account) return void res.status(404).json(errorBody("trading_account_not_found", "This user has no trading account yet."));
      res.set("Cache-Control", "no-store").json(account);
    }),
  );

  app.put(
    "/internal/v1/accounts/:userId/username",
    express.json({ limit: "2kb" }),
    withUser(async (userId, req, res) => {
      const body = UsernameRequestSchema.safeParse(req.body);
      if (!body.success) return void bad(res, "Usernames are 3-20 letters, numbers or underscores.");
      if (!(await setUsername(deps.pool, userId, body.data.username))) return void res.status(404).json(errorBody("trading_account_not_found", "This user has no trading account yet."));
      deps.valuation.invalidate();
      res.set("Cache-Control", "no-store").json({ username: body.data.username });
    }),
  );

  // Only the reference moves. The caller (services/api) uploaded the image first, and deletes the previous object after.
  app.put(
    "/internal/v1/accounts/:userId/avatar",
    express.json({ limit: "1kb" }),
    withUser(async (userId, req, res) => {
      const body = AvatarKeyRequestSchema.safeParse(req.body);
      if (!body.success) return void bad(res, "The avatar key is not valid.");
      const result = await setAvatarKey(deps.pool, userId, body.data.avatarKey);
      if (!result) return void res.status(404).json(errorBody("trading_account_not_found", "This user has no trading account yet."));
      deps.valuation.invalidate(); // the World snapshot carries the avatar reference
      res.set("Cache-Control", "no-store").json(result);
    }),
  );

  app.post(
    "/internal/v1/accounts/:userId/trades/preview",
    express.json({ limit: "4kb" }),
    withUser(async (userId, req, res) => {
      const body = TradePreviewRequestSchema.safeParse(req.body);
      if (!body.success) return void bad(res, "The order is not valid.");
      res.set("Cache-Control", "no-store").json(await previewTrade(tradeDeps, userId, body.data));
    }),
  );

  app.post(
    "/internal/v1/accounts/:userId/trades",
    express.json({ limit: "4kb" }),
    withUser(async (userId, req, res) => {
      const body = TradeConfirmRequestSchema.safeParse(req.body);
      if (!body.success) return void bad(res, "The order is not valid.");
      const receipt = await confirmTrade(tradeDeps, userId, body.data);
      res.set("Cache-Control", "no-store").status(receipt.replayed ? 200 : 201).json(receipt);
    }),
  );

  app.get(
    "/internal/v1/accounts/:userId/portfolio",
    withUser(async (userId, _req, res) => {
      const portfolio = await getPortfolio(deps.pool, await deps.valuation.snapshot(), userId);
      if (!portfolio) return void res.status(404).json(errorBody("trading_account_not_found", "This user has no trading account yet."));
      res.set("Cache-Control", "no-store").json(portfolio);
    }),
  );

  app.get("/internal/v1/league", async (_req, res) => {
    res.set("Cache-Control", "no-store").json(toLeagueSnapshot(await deps.valuation.snapshot()));
  });

  app.use((_req, res) => {
    res.status(404).json(errorBody("not_found", "Route not found."));
  });

  // Express 5 forwards rejected async handlers here. Details are logged, never returned.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof TradeError) {
      const body: TradeErrorBody = { error: { code: error.code, message: error.message }, ...(error.preview ? { preview: error.preview } : {}) };
      res.status(error.status).json(body);
      return;
    }
    if (error instanceof UsernameTakenError) {
      res.status(409).json({ error: { code: "username_taken", message: error.message } });
      return;
    }
    if ((error as { type?: string }).type === "entity.parse.failed" || (error as { type?: string }).type === "entity.too.large") {
      bad(res, "The request body is not valid JSON.");
      return;
    }
    console.error("[trading] request failed:", error);
    res.status(500).json(errorBody("internal_error", "The trading service failed to handle the request."));
  });

  return app;
}
