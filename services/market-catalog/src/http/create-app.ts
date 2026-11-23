/**
 * The catalog service's internal HTTP interface. Only services/api should call it.
 *
 *   GET  /health               -> liveness + database reachability
 *   GET  /internal/v1/markets  -> published catalog page + freshness metadata
 *   POST /internal/v1/sync     -> run one sync (same code path as `pnpm catalog:sync`)
 */
import express, { type NextFunction, type Request, type Response } from "express";
import type pg from "pg";
import {
  errorBody,
  MarketListQuerySchema,
  QuotesRequestSchema,
  ResolutionsRequestSchema,
  type MarketListResponse,
  type QuotesResponse,
} from "@league/catalog-contract";
import type { QuoteService } from "../orderbook/quote-service.ts";
import { getCatalogFreshness, InvalidCursorError, listMarkets } from "../catalog/catalog-queries.ts";
import { runCatalogSync, type CatalogSyncDependencies } from "../sync/run-catalog-sync.ts";

export function createApp(deps: CatalogSyncDependencies & { pool: pg.Pool; quotes?: QuoteService }) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", async (_req, res) => {
    try {
      await deps.pool.query("select 1");
      res.json({ status: "ok", service: "market-catalog", database: "reachable" });
    } catch {
      res.status(503).json(errorBody("database_unavailable", "The catalog database is not reachable."));
    }
  });

  app.get("/internal/v1/markets", async (req, res) => {
    const query = MarketListQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json(errorBody("invalid_request", "Invalid query parameters."));
      return;
    }
    const [page, catalog] = await Promise.all([listMarkets(deps.pool, query.data), getCatalogFreshness(deps.pool)]);
    const body: MarketListResponse = { ...page, catalog };
    res.json(body);
  });

  // Live quotes and official resolutions for trading. POST because the market list is a body, not a URL.
  // intent "pin" is how services/trading keeps markets with open positions tracked while nobody is looking.
  app.post("/internal/v1/quotes", express.json({ limit: "16kb" }), async (req, res) => {
    const body = QuotesRequestSchema.safeParse(req.body);
    if (!body.success || !deps.quotes) {
      res.status(body.success ? 503 : 400).json(errorBody(body.success ? "quotes_unavailable" : "invalid_request", body.success ? "Live quotes are not enabled." : "Invalid request body."));
      return;
    }
    const quotes = await deps.quotes.quotes(body.data.marketIds, body.data.intent);
    const response: QuotesResponse = { quotes };
    res.set("Cache-Control", "no-store").json(response);
  });

  app.post("/internal/v1/resolutions", express.json({ limit: "16kb" }), async (req, res) => {
    const body = ResolutionsRequestSchema.safeParse(req.body);
    if (!body.success || !deps.quotes) {
      res.status(body.success ? 503 : 400).json(errorBody(body.success ? "quotes_unavailable" : "invalid_request", body.success ? "Resolutions are not enabled." : "Invalid request body."));
      return;
    }
    res.set("Cache-Control", "no-store").json({ resolutions: await deps.quotes.resolutions(body.data.marketIds) });
  });

  let syncInProgress = false;
  app.post("/internal/v1/sync", async (_req, res) => {
    // Cheap guard for this process. Cross-process overlap is handled in publishSyncRun.
    if (syncInProgress) {
      res.status(409).json(errorBody("sync_in_progress", "A sync is already running in this service."));
      return;
    }
    syncInProgress = true;
    try {
      res.json(await runCatalogSync(deps, "http"));
    } finally {
      syncInProgress = false;
    }
  });

  app.use((_req, res) => {
    res.status(404).json(errorBody("not_found", "Route not found."));
  });

  // Express 5 forwards rejected async handlers here. Details are logged, never returned.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof InvalidCursorError) {
      res.status(400).json(errorBody("invalid_cursor", error.message));
      return;
    }
    console.error("[market-catalog] request failed:", error);
    res.status(500).json(errorBody("internal_error", "The catalog service failed to handle the request."));
  });

  return app;
}
