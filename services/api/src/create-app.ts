/**
 * The public, client-facing API. Today it exposes only the catalog; later it becomes the single
 * entry point for catalog, portfolio, and league data (and the place to authenticate players).
 *
 *   GET /health      -> liveness of this process (does not check dependencies)
 *   GET /v1/markets  -> catalog page with freshness metadata
 *
 * Signed-in routes (Authorization: Bearer <Supabase access token>); the user is always the token's user:
 *   PUT /v1/me/trading-account  -> create the caller's account + starting grant, or return it (idempotent)
 *   GET /v1/me/trading-account  -> read-only view, 404 if the caller has no account yet
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { errorBody, MarketListQuerySchema } from "@league/catalog-contract";
import { requireUser, verifiedUserId } from "./auth/require-user.ts";
import { SupabaseAuthUnavailableError, type SupabaseAuthOptions } from "./auth/supabase-auth.ts";
import { fetchMarketPage, MarketCatalogError, type MarketCatalogClientOptions } from "./market-catalog-client.ts";
import { fetchAccount, provisionAccount, TradingServiceError, type TradingClientOptions } from "./trading-client.ts";

export function createApp(deps: { marketCatalog: MarketCatalogClientOptions; trading?: TradingClientOptions; auth?: SupabaseAuthOptions }) {
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

  const signedIn = requireUser(deps.auth);

  // No request body is read: the owner is the verified token's user and the grant is the server's decision.
  app.put("/v1/me/trading-account", signedIn, async (_req, res) => {
    if (!deps.trading) throw new TradingServiceError("unavailable", "trading service is not configured");
    res.set("Cache-Control", "no-store").json(await provisionAccount(deps.trading, verifiedUserId(res)));
  });

  app.get("/v1/me/trading-account", signedIn, async (_req, res) => {
    if (!deps.trading) throw new TradingServiceError("unavailable", "trading service is not configured");
    const account = await fetchAccount(deps.trading, verifiedUserId(res));
    if (!account) {
      res.status(404).json(errorBody("trading_account_not_found", "You have no trading account yet."));
      return;
    }
    res.set("Cache-Control", "no-store").json(account);
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
    if (error instanceof SupabaseAuthUnavailableError) {
      console.error(`[api] sign-in check failed: ${error.message}`);
      res.status(503).json(errorBody("auth_unavailable", "Sign-in is temporarily unavailable."));
      return;
    }
    if (error instanceof TradingServiceError) {
      console.error(`[api] trading call failed (${error.kind}): ${error.message}`);
      res.status(503).json(errorBody("trading_unavailable", "Your trading account is temporarily unavailable."));
      return;
    }
    console.error("[api] request failed:", error);
    res.status(500).json(errorBody("internal_error", "Something went wrong."));
  });

  return app;
}
