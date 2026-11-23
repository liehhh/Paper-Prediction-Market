/**
 * The public, client-facing API. Today it exposes only the catalog; later it becomes the single
 * entry point for catalog, portfolio, and league data (and the place to authenticate players).
 *
 *   GET /health      -> liveness of this process (does not check dependencies)
 *   GET /v1/markets  -> catalog page with freshness metadata
 *
 *   GET /v1/markets/:id  -> one market: question, rules, status, and its live quote (no sign-in needed)
 *   GET /v1/world        -> PUBLIC World snapshot: country id, username, avatar address, colour, slot, rank, rounded sizes
 *   GET /v1/league       -> the same data under its original name (kept so existing links keep working)
 *
 * Signed-in routes (Authorization: Bearer <Supabase access token>); the user is always the token's user:
 *   PUT  /v1/me/trading-account  -> create the caller's account + starting grant, or return it (idempotent)
 *   GET  /v1/me/trading-account  -> read-only view, 404 if the caller has no account yet
 *   PUT  /v1/me/avatar           -> set or replace the caller's profile picture (raw image body, validated and re-encoded here)
 *   DELETE /v1/me/avatar         -> remove it (the country goes back to its colour)
 *   PUT  /v1/me/username         -> change the caller's unique username (their country label)
 *   POST /v1/me/trades/preview   -> price an order against a live quote; changes nothing
 *   POST /v1/me/trades           -> confirm a previewed order (idempotent by idempotencyKey)
 *   GET  /v1/me/portfolio        -> the caller's private portfolio; read-only
 */
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { errorBody, MarketListQuerySchema } from "@league/catalog-contract";
import { TradeConfirmRequestSchema, TradePreviewRequestSchema, UsernameRequestSchema, type LeagueSnapshot, type WorldSnapshot } from "@league/trading-contract";
import { AvatarImageError, MAX_UPLOAD_BYTES, processAvatar } from "./avatars/avatar-image.ts";
import { AvatarStorageError, avatarPublicUrl, deleteAvatarObject, uploadAvatarObject } from "./avatars/avatar-storage.ts";
import { requireUser, verifiedAccessToken, verifiedUserId } from "./auth/require-user.ts";
import { SupabaseAuthUnavailableError, type SupabaseAuthOptions } from "./auth/supabase-auth.ts";
import { fetchMarketPage, fetchQuote, MarketCatalogError, type MarketCatalogClientOptions } from "./market-catalog-client.ts";
import {
  changeUsername,
  confirmTrade,
  fetchAccount,
  fetchLeague,
  fetchPortfolio,
  previewTrade,
  provisionAccount,
  setAvatarKey,
  TradingRejectedError,
  TradingServiceError,
  type TradingClientOptions,
} from "./trading-client.ts";

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

  app.get("/v1/markets/:id", async (req, res) => {
    const id = /^\d{1,19}$/.exec(req.params.id ?? "")?.[0];
    if (!id) {
      res.status(404).json(errorBody("market_not_found", "This market does not exist."));
      return;
    }
    const quote = await fetchQuote(deps.marketCatalog, id);
    if (!quote) {
      res.status(404).json(errorBody("market_not_found", "This market does not exist."));
      return;
    }
    res.set("Cache-Control", "no-store").json(quote);
  });

  // Public on purpose, and coarse on purpose: trading validates it against a contract with no exact balances,
  // shares, fills or markets in it, and fetchLeague() would drop any such field even if one slipped through.
  // The one place avatar keys become public image addresses.
  const toWorld = (league: LeagueSnapshot): WorldSnapshot => ({
    asOf: league.asOf,
    countries: league.countries.map(({ avatarKey, ...country }) => ({
      ...country,
      avatarUrl: avatarKey && deps.auth ? avatarPublicUrl(deps.auth.url, country.countryId, avatarKey) : null,
    })),
  });
  const world = async (_req: Request, res: Response) => {
    if (!deps.trading) throw new TradingServiceError("unavailable", "trading service is not configured");
    res.set("Cache-Control", "public, max-age=2").json(toWorld(await fetchLeague(deps.trading)));
  };
  app.get("/v1/world", world);
  app.get("/v1/league", world);

  const signedIn = requireUser(deps.auth);
  const json = express.json({ limit: "4kb" });
  const invalid = (res: Response, message: string) => res.status(400).json(errorBody("invalid_request", message));

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

  // ---- profile picture -------------------------------------------------------------------------------------------
  // Order matters, and it is what keeps the old picture safe when anything fails:
  //   1. validate and re-encode the upload (nothing stored yet);  2. store it under a NEW name;
  //   3. only then switch the profile to the new name;           4. only then delete the old object.
  app.put("/v1/me/avatar", signedIn, express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    if (!deps.trading) throw new TradingServiceError("unavailable", "trading service is not configured");
    if (!deps.auth) throw new AvatarStorageError("sign-in/storage is not configured");
    const userId = verifiedUserId(res);
    const webp = await processAvatar(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    const account = await fetchAccount(deps.trading, userId);
    if (!account) return void res.status(404).json(errorBody("trading_account_not_found", "You have no trading account yet."));

    const key = `${randomUUID()}.webp`;
    await uploadAvatarObject(deps.auth, verifiedAccessToken(res), account.countryId, key, webp); // throws: profile untouched
    let previousKey: string | null;
    try {
      previousKey = (await setAvatarKey(deps.trading, userId, key)).previousKey;
    } catch (error) {
      await deleteAvatarObject(deps.auth, verifiedAccessToken(res), account.countryId, key); // do not leave an orphan behind
      throw error;
    }
    if (previousKey) await deleteAvatarObject(deps.auth, verifiedAccessToken(res), account.countryId, previousKey);
    res.set("Cache-Control", "no-store").json({ avatarUrl: avatarPublicUrl(deps.auth.url, account.countryId, key) });
  });

  app.delete("/v1/me/avatar", signedIn, async (_req, res) => {
    if (!deps.trading) throw new TradingServiceError("unavailable", "trading service is not configured");
    if (!deps.auth) throw new AvatarStorageError("sign-in/storage is not configured");
    const userId = verifiedUserId(res);
    const account = await fetchAccount(deps.trading, userId);
    if (!account) return void res.status(404).json(errorBody("trading_account_not_found", "You have no trading account yet."));
    const { previousKey } = await setAvatarKey(deps.trading, userId, null); // the country is a plain colour again, now
    if (previousKey) await deleteAvatarObject(deps.auth, verifiedAccessToken(res), account.countryId, previousKey);
    res.set("Cache-Control", "no-store").json({ avatarUrl: null });
  });

  app.put("/v1/me/username", signedIn, json, async (req, res) => {
    if (!deps.trading) throw new TradingServiceError("unavailable", "trading service is not configured");
    const body = UsernameRequestSchema.safeParse(req.body);
    if (!body.success) return void invalid(res, "Usernames are 3-20 letters, numbers or underscores.");
    res.set("Cache-Control", "no-store").json({ username: await changeUsername(deps.trading, verifiedUserId(res), body.data.username) });
  });

  // The player id below is ALWAYS verifiedUserId(res). The body carries only the order itself.
  app.post("/v1/me/trades/preview", signedIn, json, async (req, res) => {
    if (!deps.trading) throw new TradingServiceError("unavailable", "trading service is not configured");
    const body = TradePreviewRequestSchema.safeParse(req.body);
    if (!body.success) return void invalid(res, "The order is not valid.");
    res.set("Cache-Control", "no-store").json(await previewTrade(deps.trading, verifiedUserId(res), body.data));
  });

  app.post("/v1/me/trades", signedIn, json, async (req, res) => {
    if (!deps.trading) throw new TradingServiceError("unavailable", "trading service is not configured");
    const body = TradeConfirmRequestSchema.safeParse(req.body);
    if (!body.success) return void invalid(res, "The order is not valid.");
    const receipt = await confirmTrade(deps.trading, verifiedUserId(res), body.data);
    res.set("Cache-Control", "no-store").status(receipt.replayed ? 200 : 201).json(receipt);
  });

  app.get("/v1/me/portfolio", signedIn, async (_req, res) => {
    if (!deps.trading) throw new TradingServiceError("unavailable", "trading service is not configured");
    const portfolio = await fetchPortfolio(deps.trading, verifiedUserId(res));
    if (!portfolio) {
      res.status(404).json(errorBody("trading_account_not_found", "You have no trading account yet."));
      return;
    }
    res.set("Cache-Control", "no-store").json(portfolio);
  });

  app.use((_req, res) => {
    res.status(404).json(errorBody("not_found", "Route not found."));
  });

  // Internal details (hostnames, upstream messages, stacks) are logged here, never sent to clients.
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AvatarImageError) {
      res.status(error.status).json(errorBody(error.code, error.message));
      return;
    }
    if (error instanceof AvatarStorageError) {
      console.error(`[api] avatar storage failed: ${error.message}`);
      res.status(503).json(errorBody("avatar_storage_unavailable", "We could not save your picture right now. Your current picture is unchanged; try again in a moment."));
      return;
    }
    if ((error as { type?: string }).type === "entity.too.large" && req.path === "/v1/me/avatar") {
      res.status(413).json(errorBody("avatar_too_large", "That picture is too large. Choose one under 2 MB."));
      return;
    }
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
    if (error instanceof TradingRejectedError) {
      res.status(error.status).json(error.body); // a refusal the player should read: code + message (+ fresh preview)
      return;
    }
    if ((error as { type?: string }).type === "entity.parse.failed" || (error as { type?: string }).type === "entity.too.large") {
      res.status(400).json(errorBody("invalid_request", "The request body is not valid JSON."));
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
