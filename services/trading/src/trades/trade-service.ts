/**
 * Preview and execute paper trades.
 *
 * PREVIEW  reads only: it never writes a row. It prices the order against a fresh live quote.
 * CONFIRM  derives nothing from the client except the order itself. In ONE Postgres transaction it records the
 *          order, its fills, the Power ledger entry and the position change, or none of them.
 *
 * Safety rules (each is enforced here or by the database):
 *  - the player id comes from the verified session (services/api), never from the request body;
 *  - one lock per player (`select ... for update` on their account row) serialises that player's orders, so two
 *    tabs can neither overspend Power nor oversell shares: the second request waits, then sees the first's result;
 *  - idempotency: (account_id, idempotency_key) is unique. A retry of a committed request returns the ORIGINAL
 *    receipt even if the price feed is down now; the same key with a different order is rejected;
 *  - price protection: a buy never spends more than the accepted maximum, a sell never receives less than the
 *    accepted minimum. If the price moved outside it, nothing is written and a fresh preview is returned instead;
 *  - execution only against a live, fresh, consistent book (see market-catalog's book-feed.ts) of an open,
 *    supported market that has no official outcome yet.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { QuoteResponse } from "@league/catalog-contract";
import type {
  FillLine,
  Outcome,
  TradeConfirmRequest,
  TradeErrorCode,
  TradePreview,
  TradePreviewRequest,
  TradeReceipt,
  TradeSide,
} from "@league/trading-contract";
import { CatalogUnavailableError, type CatalogPort } from "../catalog-client.ts";
import {
  csToNumeric,
  divRoundHalfUp,
  formatMicro,
  InvalidDecimalError,
  numericToCs,
  parseMicro,
  parseSharesInput,
} from "./money.ts";
import { averagePriceMicro, buyWithBudget, CONSUMPTION_WINDOW_SECONDS, fillQuantity, toLevels, type Consumed, type Fill, type Level, type WalkResult } from "./pricing.ts";

/** The trading service accepts a book confirmed within this long. (The catalog's own limit is 45 s.) */
export const MAX_QUOTE_AGE_MS = 30_000;
/** A sell accepts proceeds down to this share of what the preview showed. A buy's protection is its own budget. */
export const SELL_TOLERANCE_BPS = 50n; // 0.5%

export class TradeError extends Error {
  readonly code: TradeErrorCode;
  readonly status: number;
  readonly preview: TradePreview | undefined;
  constructor(code: TradeErrorCode, message: string, preview?: TradePreview) {
    super(message);
    this.name = "TradeError";
    this.code = code;
    this.preview = preview;
    this.status = code === "invalid_order" ? 400 : code === "no_account" || code === "market_not_found" ? 404 : code === "catalog_unavailable" ? 503 : 409;
  }
}

export interface TradeDeps {
  pool: pg.Pool;
  catalog: CatalogPort;
  /** Called after a committed trade so cached valuations are recomputed. */
  onChange?: () => void;
  now?: () => number;
}

type Queryable = Pick<pg.PoolClient, "query">;

interface Context {
  quote: QuoteResponse;
  tokenId: string;
  levels: Level[];
}

// ---------------------------------------------------------------------------------------------------------
// Quote handling
// ---------------------------------------------------------------------------------------------------------

async function loadContext(deps: TradeDeps, marketId: string, outcome: Outcome, side: TradeSide): Promise<Context> {
  let quote: QuoteResponse | undefined;
  try {
    quote = (await deps.catalog.quotes([marketId], "view"))[0];
  } catch (error) {
    if (error instanceof CatalogUnavailableError) throw new TradeError("catalog_unavailable", "Live prices are temporarily unavailable. Nothing was traded.");
    throw error;
  }
  if (!quote) throw new TradeError("market_not_found", "This market does not exist.");

  if (!quote.market.tradingSupported) throw new TradeError("market_not_tradable", quote.market.unsupportedReason ?? "This market cannot be traded.");
  if (quote.market.status !== "open") throw new TradeError("market_not_tradable", quote.feed.pausedReason ?? "This market is not open for trading.");
  if (!quote.feed.executable || !quote.yes || !quote.no || quote.feed.observedAt === null) {
    throw new TradeError("quote_paused", quote.feed.pausedReason ?? "The live order book is not available right now. Trading is paused.");
  }
  const age = Date.parse(quote.serverTime) - Date.parse(quote.feed.observedAt);
  if (age > MAX_QUOTE_AGE_MS) throw new TradeError("quote_paused", "The live order book is out of date. Trading is paused while it refreshes.");

  // YES and NO each have their own token and book. The outcome picks the book; the side picks bids or asks.
  const book = outcome === "YES" ? quote.yes : quote.no;
  try {
    return { quote, tokenId: book.tokenId, levels: toLevels(side === "buy" ? book.asks : book.bids) };
  } catch {
    throw new TradeError("quote_paused", "The order book looked malformed, so trading is paused until it refreshes.");
  }
}

// ---------------------------------------------------------------------------------------------------------
// Reads shared by preview and confirm
// ---------------------------------------------------------------------------------------------------------

async function readCash(db: Queryable, userId: string): Promise<bigint> {
  const { rows } = await db.query<{ cash: string }>("select coalesce(sum(amount), 0)::numeric(20, 6)::text as cash from trading.ledger_entries where account_id = $1", [userId]);
  return parseMicro(rows[0]!.cash);
}

async function readOwned(db: Queryable, userId: string, tokenId: string): Promise<bigint> {
  const { rows } = await db.query<{ quantity: string }>("select quantity::text from trading.positions where account_id = $1 and token_id = $2", [userId, tokenId]);
  return rows[0] ? numericToCs(rows[0].quantity) : 0n;
}

/** What THIS player already filled at each price on this token and side inside the liquidity window. */
async function readConsumed(db: Queryable, userId: string, tokenId: string, side: TradeSide): Promise<Consumed> {
  const { rows } = await db.query<{ price: string; quantity: string }>(
    `select price::text, sum(quantity)::numeric(20, 6)::text as quantity
       from trading.fills
      where account_id = $1 and token_id = $2 and side = $3 and created_at > now() - make_interval(secs => $4)
      group by price`,
    [userId, tokenId, side, CONSUMPTION_WINDOW_SECONDS],
  );
  return new Map(rows.map((row) => [parseMicro(row.price), numericToCs(row.quantity)]));
}

async function accountExists(db: Queryable, userId: string): Promise<boolean> {
  const { rowCount } = await db.query("select 1 from trading.accounts where user_id = $1", [userId]);
  return (rowCount ?? 0) > 0;
}

const lines = (fills: readonly Fill[]): FillLine[] =>
  fills.map((fill) => ({ price: formatMicro(fill.priceMicro), quantity: csToNumeric(fill.quantityCs), amount: formatMicro(fill.amountMicro) }));

function explainWalkFailure(result: Extract<WalkResult, { ok: false }>, side: TradeSide): TradeError {
  const shares = formatShares(result.availableCs);
  if (result.reason === "budget_too_small") return new TradeError("budget_too_small", "That budget is too small to buy even 0.01 of a share at the current price.");
  return new TradeError(
    "insufficient_depth",
    side === "buy"
      ? `Not enough shares are offered to fill this order. About ${shares} shares are available to you right now. Lower your budget, then preview again.`
      : `Not enough buyers are bidding to fill this order. About ${shares} shares can be sold right now. Lower the quantity, then preview again.`,
  );
}

const formatShares = (cs: bigint) => (Number(cs) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });

/** The shared pricing step. `target` is either a budget (buy preview) or an exact quantity. */
function price(ctx: Context, side: TradeSide, consumed: Consumed, target: { budgetMicro: bigint } | { quantityCs: bigint }): Extract<WalkResult, { ok: true }> {
  const result = "budgetMicro" in target ? buyWithBudget(ctx.levels, target.budgetMicro, consumed) : fillQuantity(ctx.levels, target.quantityCs, consumed);
  if (!result.ok) throw explainWalkFailure(result, side);
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// Preview (read-only)
// ---------------------------------------------------------------------------------------------------------

export async function previewTrade(deps: TradeDeps, userId: string, request: TradePreviewRequest): Promise<TradePreview> {
  const parsed = parseRequest(request);
  if (!(await accountExists(deps.pool, userId))) throw new TradeError("no_account", "You have no trading account yet.");
  const ctx = await loadContext(deps, request.marketId, request.outcome, request.side);
  return buildPreview(deps.pool, userId, ctx, request, parsed);
}

function parseRequest(request: TradePreviewRequest): { budgetMicro?: bigint; quantityCs?: bigint } {
  try {
    if (request.side === "buy") {
      const budgetMicro = parseMicro(request.budget ?? "");
      if (budgetMicro <= 0n) throw new TradeError("invalid_order", "Enter a Power budget above zero.");
      return { budgetMicro };
    }
    const quantityCs = parseSharesInput(request.quantity ?? "");
    if (quantityCs <= 0n) throw new TradeError("invalid_order", "Enter a quantity above zero.");
    return { quantityCs };
  } catch (error) {
    if (error instanceof InvalidDecimalError) throw new TradeError("invalid_order", request.side === "buy" ? "Enter a valid Power budget." : "Enter a valid share quantity (at most 2 decimals).");
    throw error;
  }
}

async function buildPreview(
  db: Queryable,
  userId: string,
  ctx: Context,
  request: Pick<TradePreviewRequest, "marketId" | "outcome" | "side">,
  parsed: { budgetMicro?: bigint; quantityCs?: bigint },
): Promise<TradePreview> {
  const { side } = request;
  // One after another: `db` may be a transaction's single connection, which runs one query at a time.
  const cash = await readCash(db, userId);
  const owned = await readOwned(db, userId, ctx.tokenId);
  const consumed = await readConsumed(db, userId, ctx.tokenId, side);

  let walk: Extract<WalkResult, { ok: true }>;
  let limit: TradePreview["limit"];
  let budget: string | null = null;
  let unspent: string | null = null;
  if (side === "buy") {
    walk = price(ctx, side, consumed, { budgetMicro: parsed.budgetMicro! });
    if (parsed.budgetMicro! > cash) throw new TradeError("insufficient_power", "You do not have enough available Power for that budget.");
    limit = { kind: "max_spend", amount: formatMicro(parsed.budgetMicro!) };
    budget = formatMicro(parsed.budgetMicro!);
    unspent = formatMicro(parsed.budgetMicro! - walk.amountMicro);
  } else {
    if (parsed.quantityCs! > owned) throw new TradeError("insufficient_shares", `You only own ${formatShares(owned)} ${request.outcome} shares in this market.`);
    walk = price(ctx, side, consumed, { quantityCs: parsed.quantityCs! });
    limit = { kind: "min_proceeds", amount: formatMicro((walk.amountMicro * (10_000n - SELL_TOLERANCE_BPS)) / 10_000n) };
  }
  return {
    marketId: ctx.quote.market.id,
    question: ctx.quote.market.question,
    outcome: request.outcome,
    side,
    quantity: csToNumeric(walk.quantityCs),
    amount: formatMicro(walk.amountMicro),
    averagePrice: formatMicro(averagePriceMicro(walk.amountMicro, walk.quantityCs)),
    limit,
    budget,
    unspent,
    fills: lines(walk.fills),
    quoteObservedAt: ctx.quote.feed.observedAt!,
    quoteServerTime: ctx.quote.serverTime,
    availablePower: formatMicro(cash),
    sharesOwned: csToNumeric(owned),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------------------------------------

interface OrderRow {
  id: string;
  request_fingerprint: string;
  market_id: string;
  outcome: Outcome;
  side: TradeSide;
  quantity: string;
  amount: string;
  average_price: string;
  unspent: string | null;
  quote_observed_at: Date;
  created_at: Date;
  question: string;
}

/** The meaning of an order, hashed. Two requests with the same idempotency key must hash identically. */
function fingerprint(request: TradeConfirmRequest, quantityCs: bigint, limitMicro: bigint): string {
  return createHash("sha256").update(JSON.stringify([request.marketId, request.outcome, request.side, quantityCs.toString(), limitMicro.toString()])).digest("hex");
}

async function findOrder(db: Queryable, userId: string, key: string): Promise<OrderRow | null> {
  const { rows } = await db.query<OrderRow>(
    `select o.id, o.request_fingerprint, o.market_id, o.outcome, o.side, o.quantity::text, o.amount::text, o.average_price::text,
            o.unspent::text, o.quote_observed_at, o.created_at,
            coalesce((select p.question from trading.positions p where p.account_id = o.account_id and p.token_id = o.token_id), '') as question
       from trading.orders o where o.account_id = $1 and o.idempotency_key = $2`,
    [userId, key],
  );
  return rows[0] ?? null;
}

async function receiptFrom(db: Queryable, order: OrderRow, replayed: boolean): Promise<TradeReceipt> {
  const { rows } = await db.query<{ price: string; quantity: string; amount: string }>(
    "select price::text, quantity::text, amount::text from trading.fills where order_id = $1 order by id",
    [order.id],
  );
  return {
    orderId: order.id,
    marketId: order.market_id,
    question: order.question,
    outcome: order.outcome,
    side: order.side,
    quantity: order.quantity,
    amount: order.amount,
    averagePrice: order.average_price,
    unspent: order.unspent,
    fills: rows.map((row) => ({ price: row.price, quantity: row.quantity, amount: row.amount })),
    quoteObservedAt: order.quote_observed_at.toISOString(),
    executedAt: order.created_at.toISOString(),
    replayed,
  };
}

export async function confirmTrade(deps: TradeDeps, userId: string, request: TradeConfirmRequest): Promise<TradeReceipt> {
  let quantityCs: bigint;
  let limitMicro: bigint;
  try {
    quantityCs = parseSharesInput(request.quantity);
    limitMicro = parseMicro(request.limit);
  } catch {
    throw new TradeError("invalid_order", "The order quantity or limit is not valid.");
  }
  if (quantityCs <= 0n || limitMicro <= 0n) throw new TradeError("invalid_order", "The order quantity and limit must be above zero.");
  const fp = fingerprint(request, quantityCs, limitMicro);

  // A retry of a committed order must succeed even if prices are unavailable right now.
  const earlier = await findOrder(deps.pool, userId, request.idempotencyKey);
  if (earlier) return replay(deps.pool, earlier, fp);

  if (!(await accountExists(deps.pool, userId))) throw new TradeError("no_account", "You have no trading account yet.");
  const ctx = await loadContext(deps, request.marketId, request.outcome, request.side);

  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    // The player's lock. Everything below happens while no other order of theirs can run.
    await client.query("select 1 from trading.accounts where user_id = $1 for update", [userId]);

    // Two tabs sending the same key: the second waited for the lock, and now finds the first's order.
    const raced = await findOrder(client, userId, request.idempotencyKey);
    if (raced) {
      await client.query("rollback");
      return replay(client, raced, fp);
    }
    const settled = await client.query("select 1 from trading.settlements where market_id = $1", [request.marketId]);
    if (settled.rowCount) throw new TradeError("market_not_tradable", "This market has an official outcome and is closed for trading.");

    const cash = await readCash(client, userId);
    const owned = await readOwned(client, userId, ctx.tokenId);
    const consumed = await readConsumed(client, userId, ctx.tokenId, request.side);

    const walkResult = fillQuantity(ctx.levels, quantityCs, consumed);
    if (!walkResult.ok) throw explainWalkFailure(walkResult, request.side);

    const protectionBroken = request.side === "buy" ? walkResult.amountMicro > limitMicro : walkResult.amountMicro < limitMicro;
    if (protectionBroken) {
      // Nothing was written. Give the player a fresh preview to confirm instead.
      const fresh = await buildPreview(client, userId, ctx, request, request.side === "buy" ? { budgetMicro: limitMicro } : { quantityCs });
      throw new TradeError(
        "price_moved",
        request.side === "buy" ? "The price moved above the limit you accepted. Review the new quote." : "The price moved below the limit you accepted. Review the new quote.",
        fresh,
      );
    }
    if (request.side === "buy" && walkResult.amountMicro > cash) throw new TradeError("insufficient_power", "You do not have enough available Power.");
    if (request.side === "sell" && quantityCs > owned) throw new TradeError("insufficient_shares", `You only own ${formatShares(owned)} ${request.outcome} shares in this market.`);

    const averageMicro = averagePriceMicro(walkResult.amountMicro, quantityCs);
    const unspent = request.side === "buy" ? formatMicro(limitMicro - walkResult.amountMicro) : null;
    const { rows } = await client.query<{ id: string }>(
      `insert into trading.orders (account_id, idempotency_key, request_fingerprint, market_id, token_id, outcome, side, quantity, amount,
                                   limit_amount, average_price, unspent, quote_observed_at, quote_served_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       returning id`,
      [
        userId, request.idempotencyKey, fp, request.marketId, ctx.tokenId, request.outcome, request.side, csToNumeric(quantityCs),
        formatMicro(walkResult.amountMicro), formatMicro(limitMicro), formatMicro(averageMicro), unspent,
        ctx.quote.feed.observedAt, ctx.quote.serverTime,
      ],
    );
    const orderId = rows[0]!.id;

    for (const fill of walkResult.fills) {
      await client.query(
        `insert into trading.fills (order_id, account_id, market_id, token_id, outcome, side, price, quantity, amount, quote_observed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [orderId, userId, request.marketId, ctx.tokenId, request.outcome, request.side, formatMicro(fill.priceMicro), csToNumeric(fill.quantityCs), formatMicro(fill.amountMicro), ctx.quote.feed.observedAt],
      );
    }

    // Power: a buy removes exactly the fills' cost; a sell adds exactly the fills' proceeds. Nothing else moves.
    await client.query(
      "insert into trading.ledger_entries (account_id, entry_type, amount, order_id) values ($1, $2, $3, $4)",
      [userId, request.side === "buy" ? "trade_buy" : "trade_sell", formatMicro(request.side === "buy" ? -walkResult.amountMicro : walkResult.amountMicro), orderId],
    );

    if (request.side === "buy") {
      await client.query(
        `insert into trading.positions (account_id, token_id, market_id, outcome, question, quantity, cost_basis)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (account_id, token_id) do update
           set quantity = trading.positions.quantity + excluded.quantity,
               cost_basis = trading.positions.cost_basis + excluded.cost_basis,
               question = excluded.question, updated_at = now()`,
        [userId, ctx.tokenId, request.marketId, request.outcome, ctx.quote.market.question, csToNumeric(quantityCs), formatMicro(walkResult.amountMicro)],
      );
    } else {
      // Average-cost method: the shares sold take their proportional share of the cost basis. Selling everything
      // takes ALL of it, so no rounding dust is left behind on an empty position.
      const position = await client.query<{ quantity: string; cost_basis: string }>(
        "select quantity::text, cost_basis::text from trading.positions where account_id = $1 and token_id = $2",
        [userId, ctx.tokenId],
      );
      const heldCs = numericToCs(position.rows[0]!.quantity);
      const basis = parseMicro(position.rows[0]!.cost_basis);
      const basisSold = quantityCs === heldCs ? basis : divRoundHalfUp(basis * quantityCs, heldCs);
      await client.query(
        `update trading.positions
            set quantity = quantity - $3, cost_basis = cost_basis - $4, realized_pnl = realized_pnl + $5, updated_at = now()
          where account_id = $1 and token_id = $2`,
        [userId, ctx.tokenId, csToNumeric(quantityCs), formatMicro(basisSold), formatMicro(walkResult.amountMicro - basisSold)],
      );
    }

    const stored = await findOrder(client, userId, request.idempotencyKey);
    await client.query("commit");
    deps.onChange?.();
    return await receiptFrom(client, { ...stored!, question: ctx.quote.market.question }, false);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Same key, same order: the original receipt. Same key, different order: refused. */
async function replay(db: Queryable, order: OrderRow, expectedFingerprint: string): Promise<TradeReceipt> {
  if (order.request_fingerprint !== expectedFingerprint) {
    throw new TradeError("idempotency_key_reused", "That idempotency key was already used for a different order.");
  }
  return receiptFrom(db, order, true);
}

