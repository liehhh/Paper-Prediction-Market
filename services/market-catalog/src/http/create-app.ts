/**
 * The catalog service's internal HTTP interface. Only services/api should call it.
 *
 *   GET  /health               -> liveness + database reachability
 *   GET  /internal/v1/markets  -> published catalog page + freshness metadata
 *   POST /internal/v1/sync     -> run one sync (same code path as `pnpm catalog:sync`)
 */
import express, { type NextFunction, type Request, type Response } from "express";
import type pg from "pg";
import { errorBody, MarketListQuerySchema, type MarketListResponse } from "@league/catalog-contract";
import { getCatalogFreshness, InvalidCursorError, listMarkets } from "../catalog/catalog-queries.ts";
import { runCatalogSync, type CatalogSyncDependencies } from "../sync/run-catalog-sync.ts";

export function createApp(deps: CatalogSyncDependencies & { pool: pg.Pool }) {
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
