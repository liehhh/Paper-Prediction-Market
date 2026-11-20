/**
 * The public, client-facing API. Today it exposes only the catalog; later it becomes the single
 * entry point for catalog, portfolio, and league data (and the place to authenticate players).
 *
 *   GET /health      -> liveness of this process (does not check dependencies)
 *   GET /v1/markets  -> catalog page with freshness metadata
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { errorBody, MarketListQuerySchema } from "@league/catalog-contract";
import { fetchMarketPage, MarketCatalogError, type MarketCatalogClientOptions } from "./market-catalog-client.ts";

export function createApp(deps: { marketCatalog: MarketCatalogClientOptions }) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "api" });
  });

  app.get("/v1/markets", async (req, res) => {
    const query = MarketListQuerySchema.safeParse(req.query);
    if (!query.success) {
      const fields = [...new Set(query.error.issues.map((issue) => issue.path.join(".")))].join(", ");
      res.status(400).json(errorBody("invalid_request", `Invalid query parameter(s): ${fields}.`));
      return;
    }
    const page = await fetchMarketPage(deps.marketCatalog, query.data);
    res.set("Cache-Control", "no-store").json(page);
  });

  app.use((_req, res) => {
    res.status(404).json(errorBody("not_found", "Route not found."));
  });

  // Internal details (hostnames, upstream messages, stacks) are logged here, never sent to clients.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof MarketCatalogError) {
      if (error.kind === "rejected" && error.upstreamCode === "invalid_cursor") {
        res.status(400).json(errorBody("invalid_cursor", "The cursor is not valid. Start again from the first page."));
        return;
      }
      console.error(`[api] catalog call failed (${error.kind}): ${error.message}`);
      res.status(503).json(errorBody("catalog_unavailable", "The market catalog is temporarily unavailable."));
      return;
    }
    console.error("[api] request failed:", error);
    res.status(500).json(errorBody("internal_error", "Something went wrong."));
  });

  return app;
}
