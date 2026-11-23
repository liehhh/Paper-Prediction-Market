/**
 * Paper trading end to end, against a THROWAWAY real PostgreSQL (never the hosted project) and DETERMINISTIC FIXTURE
 * quotes (test/support/fake-catalog.ts). Nothing here is live Polymarket data.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LeagueSnapshotSchema, PortfolioResponseSchema, type TradeConfirmRequest } from "@league/trading-contract";
import { provisionTradingAccount, setUsername, UsernameTakenError } from "../src/accounts/trading-accounts.ts";
import { createApp } from "../src/http/create-app.ts";
import { getPortfolio, toLeagueSnapshot } from "../src/league/league.ts";
import { ValuationService } from "../src/league/valuation.ts";
import { runSettlementPass, settleMarket } from "../src/settlement/settlement.ts";
import { confirmTrade, previewTrade, TradeError, type TradeDeps } from "../src/trades/trade-service.ts";
import { FakeCatalog, flat } from "./support/fake-catalog.ts";
import { startTestDatabase, type TestDatabase } from "./support/test-database.ts";

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
}, 120_000);
afterAll(async () => db?.stop());

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const M = "1001";

let catalog: FakeCatalog;
let valuation: ValuationService;
let deps: TradeDeps;

beforeEach(async () => {
  await db.reset();
  catalog = new FakeCatalog();
  catalog.addMarket(M, { yes: flat("0.5"), no: flat("0.5") });
  valuation = new ValuationService({ pool: db.pool, catalog, ttlMs: 0 });
  deps = { pool: db.pool, catalog, onChange: () => valuation.invalidate() };
  await provisionTradingAccount(db.pool, A);
  await provisionTradingAccount(db.pool, B);
});

let keyCounter = 0;
const key = () => `key-${String(++keyCounter).padStart(8, "0")}`;

/** Preview a buy by budget, then confirm exactly what was previewed. */
async function buy(userId: string, budget: string, options: { idempotencyKey?: string; outcome?: "YES" | "NO"; marketId?: string } = {}) {
  const request = { marketId: options.marketId ?? M, outcome: options.outcome ?? ("YES" as const), side: "buy" as const, budget };
  const preview = await previewTrade(deps, userId, request);
  return confirmTrade(deps, userId, confirmFor(preview, options.idempotencyKey ?? key()));
}
async function sell(userId: string, quantity: string, options: { idempotencyKey?: string } = {}) {
  const preview = await previewTrade(deps, userId, { marketId: M, outcome: "YES", side: "sell", quantity });
  return confirmTrade(deps, userId, confirmFor(preview, options.idempotencyKey ?? key()));
}
const confirmFor = (preview: Awaited<ReturnType<typeof previewTrade>>, idempotencyKey: string): TradeConfirmRequest => ({
  marketId: preview.marketId,
  outcome: preview.outcome,
  side: preview.side,
  quantity: preview.quantity,
  limit: preview.limit.amount,
  idempotencyKey,
});

const portfolio = async (userId: string) => (await getPortfolio(db.pool, await valuation.snapshot(), userId))!;
const sum = async (sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows[0].v as string;
const cashOf = (userId: string) => sum("select coalesce(sum(amount), 0)::text as v from trading.ledger_entries where account_id = $1", [userId]);
const count = async (table: string, userId?: string) =>
  Number(await sum(`select count(*)::text as v from trading.${table}${userId ? " where account_id = $1" : ""}`, userId ? [userId] : []));
const expectTradeError = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TradeError);
  expect((error as TradeError).code).toBe(code);
  return error as TradeError;
};

describe("ACCEPTANCE: the exact numbers from the milestone", () => {
  it("A and B start equal; A buys 4,000 YES at 0.50; YES moves to 0.65; YES officially wins; settlement replays safely", async () => {
    // 1. A and B each start with 10,000 Power and share the same rank and area.
    let league = toLeagueSnapshot(await valuation.snapshot());
    expect(league.countries.map((c) => [c.rank, c.relativeSize])).toEqual([[1, 0.5], [1, 0.5]]);
    expect((await portfolio(A)).totalPower).toBe("10000.000000");

    // 2. A spends 2,000 Power on 4,000 YES shares at 0.50.
    const receipt = await buy(A, "2000");
    expect(receipt).toMatchObject({ quantity: "4000.000000", amount: "2000.000000", averagePrice: "0.500000", unspent: "0.000000", replayed: false });
    expect(receipt.fills).toEqual([{ price: "0.500000", quantity: "4000.000000", amount: "2000.000000" }]);

    //    At a 0.50 valuation A has 8,000 available, 2,000 in shares, 10,000 total. Both countries still have equal area.
    let a = await portfolio(A);
    expect([a.availablePower, a.sharesValue, a.totalPower]).toEqual(["8000.000000", "2000.000000", "10000.000000"]);
    expect(a.reservedPower).toBe("0.000000");
    league = toLeagueSnapshot(await valuation.snapshot());
    expect(league.countries.map((c) => [c.rank, c.relativeSize])).toEqual([[1, 0.5], [1, 0.5]]);

    // 3. YES moves to 0.65: A has 10,600, B has 10,000. A ranks first with ~6% more area.
    catalog.setPrice(M, "0.65");
    a = await portfolio(A);
    const b = await portfolio(B);
    expect([a.availablePower, a.sharesValue, a.totalPower, a.rank]).toEqual(["8000.000000", "2600.000000", "10600.000000", 1]);
    expect([b.totalPower, b.rank]).toEqual(["10000.000000", 2]);
    league = toLeagueSnapshot(await valuation.snapshot());
    const [first, second] = league.countries;
    expect(first!.username).toBe(a.username);
    expect([first!.rank, second!.rank]).toEqual([1, 2]);
    expect(first!.relativeSize / second!.relativeSize).toBeCloseTo(1.06, 1); // ~6% more visible area
    expect(a.unrealizedPnl).toBe("600.000000");

    // 4. YES officially wins: A ends with 12,000 available and zero open shares.
    catalog.market(M).resolution = { state: "resolved", winningOutcome: "YES", detail: "Officially resolved YES." };
    const pass = await runSettlementPass({ pool: db.pool, catalog, onChange: () => valuation.invalidate() });
    expect(pass.marketsSettled).toEqual([M]);
    a = await portfolio(A);
    expect([a.availablePower, a.sharesValue, a.totalPower]).toEqual(["12000.000000", "0.000000", "12000.000000"]);
    expect(a.positions).toMatchObject([{ status: "settled", quantity: "0.000000", realizedPnl: "2000.000000" }]);

    // 5. Replaying settlement leaves A at 12,000, and pays exactly once.
    await runSettlementPass({ pool: db.pool, catalog });
    await settleMarket(db.pool, M, "YES", "replayed by hand");
    expect(await cashOf(A)).toBe("12000.000000");
    expect(await count("ledger_entries", A)).toBe(3); // grant, buy, payout
    expect(await sum("select count(*)::text as v from trading.ledger_entries where entry_type = 'settlement_payout'")).toBe("1");
    expect(await cashOf(B)).toBe("10000.000000");

    // 6. A "refresh" (a brand-new valuation service and connections) sees the same state: nothing lives in memory.
    const fresh = new pg.Pool({ connectionString: db.databaseUrl, max: 2 });
    try {
      const reloaded = await getPortfolio(fresh, await new ValuationService({ pool: fresh, catalog, ttlMs: 0 }).snapshot(), A);
      expect(reloaded?.totalPower).toBe("12000.000000");
      expect(reloaded?.fills).toHaveLength(1);
    } finally {
      await fresh.end();
    }
  });

  it("a settled market cannot be traded any more", async () => {
    await buy(A, "100");
    catalog.market(M).resolution = { state: "resolved", winningOutcome: "NO", detail: "Officially resolved NO." };
    await runSettlementPass({ pool: db.pool, catalog });
    await expectTradeError(buy(B, "100"), "market_not_tradable");
  });
});

describe("pricing, spread and valuation", () => {
  it("a wide book: buying at the ask lowers total Power immediately; execution price and valuation price stay distinct", async () => {
    catalog.market(M).yes = { bids: [["0.49", "100000"]], asks: [["0.51", "100000"]] };
    await buy(A, "2040"); // 4,000 shares at the 0.51 ask
    const a = await portfolio(A);
    expect(a.availablePower).toBe("7960.000000");
    expect(a.positions[0]!.mark).toMatchObject({ price: "0.500000", source: "mid", stale: false });
    expect(a.totalPower).toBe("9960.000000"); // 7,960 + 4,000 x 0.50 midpoint: the half-spread is lost immediately
    expect(a.unrealizedPnl).toBe("-40.000000");
  });

  it("when fill price equals valuation price, the act of buying alone leaves total Power unchanged", async () => {
    const before = (await portfolio(A)).totalPower;
    await buy(A, "1234.56");
    expect((await portfolio(A)).totalPower).toBe(before);
  });

  it("a book with no bids carries the last known valuation forward (flagged stale)", async () => {
    await buy(A, "2000");
    await valuation.refresh(true); // the worker saves the live mark (0.50)
    catalog.setPrice(M, "0.65");
    await valuation.refresh(true);
    catalog.market(M).yes = { bids: [], asks: [["0.9", "100"]] };
    const a = await portfolio(A);
    expect(a.positions[0]!.mark).toMatchObject({ price: "0.650000", source: "last_known", stale: true });
    expect(a.totalPower).toBe("10600.000000");
  });

  it("a stale or disconnected feed keeps the last known valuation visible, with its timestamp", async () => {
    await buy(A, "2000");
    catalog.setPrice(M, "0.65");
    const observed = new Date(catalog.market(M).observedAt).toISOString();
    catalog.market(M).feed = "disconnected";
    const a = await portfolio(A);
    expect(a.positions[0]!.mark).toMatchObject({ price: "0.650000", source: "mid", stale: true, asOf: observed });
    expect(a.totalPower).toBe("10600.000000");
  });

  it("marks are saved only when they move meaningfully, never per tick", async () => {
    await buy(A, "2000");
    await valuation.refresh(true);
    const read = async () => (await db.pool.query("select last_mark::text, last_mark_at from trading.positions where account_id = $1", [A])).rows[0];
    const first = await read();
    expect(first.last_mark).toBe("0.500000");
    catalog.setPrice(M, "0.501"); // tiny tick
    await valuation.refresh(true);
    expect((await read()).last_mark_at).toEqual(first.last_mark_at); // unchanged: no write
    catalog.setPrice(M, "0.52");
    await valuation.refresh(true);
    expect((await read()).last_mark).toBe("0.520000");
  });

  it("holding both outcomes of one market counts each share exactly once", async () => {
    await buy(A, "1000", { outcome: "YES" });
    await buy(A, "500", { outcome: "NO" });
    const a = await portfolio(A);
    expect(a.sharesValue).toBe("1500.000000");
    expect(a.totalPower).toBe("10000.000000");
  });
});

describe("sells", () => {
  it("sells owned shares against the bids and tracks realized and unrealized gain", async () => {
    await buy(A, "2000"); // 4,000 shares, basis 2,000
    catalog.setPrice(M, "0.65");
    const receipt = await sell(A, "1000"); // 1,000 x 0.65
    expect(receipt).toMatchObject({ quantity: "1000.000000", amount: "650.000000", averagePrice: "0.650000", unspent: null });
    const a = await portfolio(A);
    expect(a.availablePower).toBe("8650.000000");
    expect(a.positions[0]).toMatchObject({ quantity: "3000.000000", costBasis: "1500.000000", realizedPnl: "150.000000", unrealizedPnl: "450.000000" });
    expect(a.totalPower).toBe("10600.000000");
    expect([a.realizedPnl, a.unrealizedPnl]).toEqual(["150.000000", "450.000000"]);
  });

  it("selling everything takes all the cost basis (no dust left)", async () => {
    await buy(A, "333.33");
    catalog.setPrice(M, "0.6");
    const owned = (await portfolio(A)).positions[0]!.quantity;
    await sell(A, String(Number(owned)));
    const p = (await portfolio(A)).positions[0]!;
    expect([p.quantity, p.costBasis]).toEqual(["0.000000", "0.000000"]);
  });

  it("refuses to oversell, in preview and in confirm", async () => {
    await buy(A, "100"); // 200 shares
    await expectTradeError(previewTrade(deps, A, { marketId: M, outcome: "YES", side: "sell", quantity: "200.01" }), "insufficient_shares");
    await expectTradeError(previewTrade(deps, B, { marketId: M, outcome: "YES", side: "sell", quantity: "1" }), "insufficient_shares");
    await expectTradeError(previewTrade(deps, A, { marketId: M, outcome: "NO", side: "sell", quantity: "1" }), "insufficient_shares");
  });

  it("two simultaneous sells of the same shares: exactly one succeeds, nothing is oversold", async () => {
    await buy(A, "1500"); // 3,000 shares
    const preview = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "sell", quantity: "2000" });
    const results = await Promise.allSettled([confirmTrade(deps, A, confirmFor(preview, key())), confirmTrade(deps, A, confirmFor(preview, key()))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as TradeError).code).toBe("insufficient_shares");
    expect((await portfolio(A)).positions[0]!.quantity).toBe("1000.000000");
  });
});

describe("idempotency", () => {
  it("retrying a committed request returns the original receipt and moves Power once", async () => {
    const preview = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "2000" });
    const request = confirmFor(preview, "retry-key-0001");
    const first = await confirmTrade(deps, A, request);
    const second = await confirmTrade(deps, A, request);
    expect(second).toEqual({ ...first, replayed: true });
    expect(await cashOf(A)).toBe("8000.000000");
    expect(await count("orders", A)).toBe(1);
    expect(await count("fills", A)).toBe(1);
  });

  it("a retry still returns the original receipt while the price feed is down", async () => {
    const preview = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "500" });
    const request = confirmFor(preview, "retry-key-0002");
    const first = await confirmTrade(deps, A, request);
    catalog.market(M).feed = "disconnected";
    catalog.unavailable = true;
    expect(await confirmTrade(deps, A, request)).toEqual({ ...first, replayed: true });
  });

  it("the same key for a different order is rejected, and changes nothing", async () => {
    const preview = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "100" });
    await confirmTrade(deps, A, confirmFor(preview, "reused-key-0001"));
    const other = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "200" });
    await expectTradeError(confirmTrade(deps, A, confirmFor(other, "reused-key-0001")), "idempotency_key_reused");
    expect(await cashOf(A)).toBe("9900.000000");
  });

  it("keys are scoped per player: B can use A's key for B's own order", async () => {
    const pa = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "100" });
    await confirmTrade(deps, A, confirmFor(pa, "shared-key-0001"));
    const pb = await previewTrade(deps, B, { marketId: M, outcome: "YES", side: "buy", budget: "100" });
    const receipt = await confirmTrade(deps, B, confirmFor(pb, "shared-key-0001"));
    expect(receipt.replayed).toBe(false);
    expect(await cashOf(B)).toBe("9900.000000");
  });

  it("the same request sent by two tabs at once creates one order", async () => {
    const preview = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "1000" });
    const request = confirmFor(preview, "double-tab-0001");
    const [one, two] = await Promise.all([confirmTrade(deps, A, request), confirmTrade(deps, A, request)]);
    expect(one.orderId).toBe(two.orderId);
    expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
    expect(await cashOf(A)).toBe("9000.000000");
    expect(await count("orders", A)).toBe(1);
  });
});

describe("concurrency: Power can never be overspent", () => {
  it("two simultaneous purchases using the same funds: exactly one succeeds", async () => {
    const preview = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "6000" });
    const results = await Promise.allSettled([confirmTrade(deps, A, confirmFor(preview, key())), confirmTrade(deps, A, confirmFor(preview, key()))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as TradeError).code).toBe("insufficient_power");
    expect(await cashOf(A)).toBe("4000.000000");
    expect(await count("orders", A)).toBe(1);
  });

  it("many parallel buys never push Power below zero, and the ledger equals the orders", async () => {
    const preview = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "3000" });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => confirmTrade(deps, A, confirmFor(preview, key()))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await cashOf(A)).toBe("1000.000000");
    expect(await sum("select coalesce(sum(amount), 0)::text as v from trading.orders where account_id = $1 and side = 'buy'", [A])).toBe("9000.000000");
  });

  it("different players trade at the same moment without blocking each other's accounting", async () => {
    const [ra, rb] = await Promise.all([buy(A, "2000"), buy(B, "1000")]);
    expect([ra.amount, rb.amount]).toEqual(["2000.000000", "1000.000000"]);
    expect([await cashOf(A), await cashOf(B)]).toEqual(["8000.000000", "9000.000000"]);
  });
});

describe("atomicity", () => {
  it("if anything fails mid-trade, no order, fill, ledger entry or position remains", async () => {
    await db.pool.query(`
      create function trading.test_fail_position() returns trigger language plpgsql as
      $$ begin raise exception 'simulated failure while updating the position'; end $$`);
    await db.pool.query("create trigger test_fail_position before insert on trading.positions for each row execute function trading.test_fail_position()");
    try {
      await expect(buy(A, "2000")).rejects.toThrow(/simulated failure/);
    } finally {
      await db.pool.query("drop trigger test_fail_position on trading.positions");
      await db.pool.query("drop function trading.test_fail_position()");
    }
    expect(await cashOf(A)).toBe("10000.000000");
    expect([await count("orders"), await count("fills"), await count("positions")]).toEqual([0, 0, 0]);
    // And the player can simply try again.
    expect((await buy(A, "2000")).amount).toBe("2000.000000");
  });

  it("history is append-only and every fill records the token, price and quote time", async () => {
    const receipt = await buy(A, "2000");
    await expect(db.pool.query("update trading.fills set price = 0.1")).rejects.toThrow(/append-only/);
    await expect(db.pool.query("delete from trading.orders")).rejects.toThrow(/append-only/);
    const fill = (await db.pool.query("select token_id, outcome, side, price::text, quantity::text, quote_observed_at from trading.fills where order_id = $1", [receipt.orderId])).rows[0];
    expect(fill).toMatchObject({ token_id: `${M}1111`, outcome: "YES", side: "buy", price: "0.500000", quantity: "4000.000000" });
    expect(fill.quote_observed_at.toISOString()).toBe(receipt.quoteObservedAt);
  });
});

describe("preview", () => {
  it("writes nothing", async () => {
    const before = [await count("orders"), await count("fills"), await count("ledger_entries"), await count("positions")];
    const preview = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "2000" });
    expect(preview).toMatchObject({ quantity: "4000.000000", amount: "2000.000000", averagePrice: "0.500000", unspent: "0.000000", availablePower: "10000.000000" });
    expect(preview.limit).toEqual({ kind: "max_spend", amount: "2000.000000" });
    expect(preview.quoteObservedAt).toBeTruthy();
    expect([await count("orders"), await count("fills"), await count("ledger_entries"), await count("positions")]).toEqual(before);
  });

  it("a budget that cannot buy an exact quantity leaves the remainder unspent and says so", async () => {
    const preview = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "100.007" });
    expect(preview.quantity).toBe("200.010000"); // 200.01 shares cost 100.005; the 0.002 left stays available
    expect(preview.amount).toBe("100.005000");
    expect(preview.unspent).toBe("0.002000");
    const receipt = await confirmTrade(deps, A, confirmFor(preview, key()));
    expect(receipt.unspent).toBe("0.002000");
    expect(await cashOf(A)).toBe("9899.995000");
  });

  it("shows the executable depth: sells use the bids, buys use the asks, across several levels", async () => {
    catalog.market(M).yes = { bids: [["0.40", "100"], ["0.39", "100"]], asks: [["0.60", "100"], ["0.62", "1000"]] };
    const buyPreview = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "100" });
    expect(buyPreview.fills.map((f) => f.price)).toEqual(["0.600000", "0.620000"]);
    expect(buyPreview.averagePrice).not.toBe("0.600000");
  });

  it("explains insufficient depth, and rejects a new preview request for a missing market", async () => {
    catalog.market(M).yes = { bids: [["0.50", "100"]], asks: [["0.50", "1000"]] };
    const error = await expectTradeError(previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "2000" }), "insufficient_depth");
    expect(error.message).toMatch(/1,000 shares/);
    await expectTradeError(previewTrade(deps, A, { marketId: "9999", outcome: "YES", side: "buy", budget: "10" }), "market_not_found");
  });

  it("rejects bad input and spending more Power than available", async () => {
    await expectTradeError(previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "0" }), "invalid_order");
    await expectTradeError(previewTrade(deps, A, { marketId: M, outcome: "YES", side: "sell", quantity: "1.234" }), "invalid_order");
    await expectTradeError(previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "10000.01" }), "insufficient_power");
    await expectTradeError(previewTrade(deps, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", { marketId: M, outcome: "YES", side: "buy", budget: "1" }), "no_account");
  });
});

describe("price protection, freshness and paused feeds", () => {
  it("if the price moved outside what the player accepted: nothing is written and a new preview is returned", async () => {
    const preview = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "2000" });
    catalog.market(M).yes = flat("0.52"); // the ask moved up
    const error = await expectTradeError(confirmTrade(deps, A, confirmFor(preview, key())), "price_moved");
    expect(error.preview).toMatchObject({ side: "buy", averagePrice: "0.520000", quantity: "3846.150000" }); // 2000 / 0.52
    expect(await cashOf(A)).toBe("10000.000000");
    expect(await count("orders")).toBe(0);
    // Confirming the NEW preview works.
    const receipt = await confirmTrade(deps, A, confirmFor(error.preview!, key()));
    expect(receipt.averagePrice).toBe("0.520000");
  });

  it("a price that moved in the player's favour fills at the better price and leaves more unspent", async () => {
    const preview = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "2000" });
    catalog.market(M).yes = flat("0.45");
    const receipt = await confirmTrade(deps, A, confirmFor(preview, key()));
    expect(receipt).toMatchObject({ quantity: "4000.000000", amount: "1800.000000", unspent: "200.000000" });
    expect(await cashOf(A)).toBe("8200.000000");
  });

  it("a sell accepts only proceeds within the previewed floor (0.5% tolerance)", async () => {
    await buy(A, "2000");
    catalog.setPrice(M, "0.65");
    const preview = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "sell", quantity: "1000" });
    expect(preview.limit).toEqual({ kind: "min_proceeds", amount: "646.750000" }); // 650 - 0.5%
    catalog.setPrice(M, "0.60");
    await expectTradeError(confirmTrade(deps, A, confirmFor(preview, key())), "price_moved");
  });

  it("a feed disconnect between preview and confirm pauses execution; nothing is written", async () => {
    const preview = await previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "2000" });
    catalog.market(M).feed = "disconnected";
    const error = await expectTradeError(confirmTrade(deps, A, confirmFor(preview, "paused-key-0001")), "quote_paused");
    expect(error.message).toMatch(/paused/i);
    expect(await cashOf(A)).toBe("10000.000000");
    expect([await count("orders"), await count("fills")]).toEqual([0, 0]);
    // New previews are refused too, and the same key works once the feed has recovered.
    await expectTradeError(previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "10" }), "quote_paused");
    catalog.market(M).feed = "live";
    catalog.market(M).observedAt = catalog.clock;
    expect((await confirmTrade(deps, A, confirmFor(preview, "paused-key-0001"))).replayed).toBe(false);
  });

  it("a quote older than 30 seconds is not executable even if the catalog still calls it live", async () => {
    catalog.market(M).observedAt = catalog.clock - 31_000;
    await expectTradeError(previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "10" }), "quote_paused");
    catalog.market(M).observedAt = catalog.clock - 5_000;
    await expect(previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "10" })).resolves.toBeTruthy();
  });

  it("closed, unsupported or unreachable markets are refused with a clear reason", async () => {
    catalog.market(M).status = "closed";
    await expectTradeError(previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "10" }), "market_not_tradable");
    catalog.market(M).status = "open";
    catalog.market(M).supported = false;
    await expectTradeError(previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "10" }), "market_not_tradable");
    catalog.market(M).supported = true;
    catalog.unavailable = true;
    await expectTradeError(previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "10" }), "catalog_unavailable");
  });
});

describe("paper-liquidity policy", () => {
  it("re-submitting orders against the same unchanged quote cannot consume the same displayed shares again", async () => {
    catalog.market(M).yes = { bids: [["0.50", "5000"]], asks: [["0.50", "5000"]] };
    await buy(A, "2000"); // 4,000 of the 5,000 displayed
    // Same quote, unchanged: only 1,000 are left for A.
    const error = await expectTradeError(previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "2000" }), "insufficient_depth");
    expect(error.message).toMatch(/1,000 shares/);
    expect((await buy(A, "500")).quantity).toBe("1000.000000"); // exactly the remainder is still available
    await expectTradeError(previewTrade(deps, A, { marketId: M, outcome: "YES", side: "buy", budget: "1" }), "insufficient_depth");
  });

  it("portfolios are independent: another player's trade never reduces what you can fill", async () => {
    catalog.market(M).yes = { bids: [["0.50", "5000"]], asks: [["0.50", "5000"]] };
    await buy(A, "2000");
    expect((await buy(B, "2000")).quantity).toBe("4000.000000");
  });
});

describe("settlement safety", () => {
  beforeEach(async () => {
    await buy(A, "2000");
    await buy(B, "1000", { outcome: "NO" });
  });

  it("pays 1 Power per winning share and 0 for losing shares", async () => {
    catalog.market(M).resolution = { state: "resolved", winningOutcome: "NO", detail: "Officially resolved NO." };
    await runSettlementPass({ pool: db.pool, catalog });
    expect(await cashOf(A)).toBe("8000.000000"); // lost the 2,000 stake
    expect(await cashOf(B)).toBe("11000.000000"); // 2,000 NO shares pay 2,000: 9,000 + 2,000
    const a = await portfolio(A);
    expect(a.positions[0]).toMatchObject({ status: "settled", realizedPnl: "-2000.000000" });
    expect(await sum("select count(*)::text as v from trading.ledger_entries where entry_type = 'settlement_payout'")).toBe("1"); // nothing to pay A
  });

  it("closing, an empty book or a price near 1 never pays: only a verified provider outcome does", async () => {
    catalog.market(M).status = "closed";
    catalog.market(M).yes = { bids: [], asks: [] };
    catalog.market(M).resolution = { state: "closed_unresolved", winningOutcome: null, detail: "Trading is closed; no official outcome yet." };
    const pass = await runSettlementPass({ pool: db.pool, catalog });
    expect(pass.marketsSettled).toEqual([]);
    expect(pass.waiting).toEqual([{ marketId: M, state: "closed_unresolved" }]);
    expect(await cashOf(A)).toBe("8000.000000");
    catalog.setPrice(M, "0.9999");
    await runSettlementPass({ pool: db.pool, catalog });
    expect((await portfolio(A)).positions[0]!.status).toBe("open");
  });

  it("an ambiguous or unsupported outcome keeps the positions pending reconciliation", async () => {
    catalog.market(M).resolution = { state: "ambiguous", winningOutcome: null, detail: "split payout" };
    const pass = await runSettlementPass({ pool: db.pool, catalog });
    expect(pass.waiting).toEqual([{ marketId: M, state: "ambiguous" }]);
    expect((await portfolio(A)).positions[0]).toMatchObject({ status: "open", quantity: "4000.000000" });
  });

  it("an unreachable provider changes nothing and the next pass completes the settlement (worker restart)", async () => {
    catalog.market(M).resolution = { state: "resolved", winningOutcome: "YES", detail: "Officially resolved YES." };
    catalog.unavailable = true;
    expect((await runSettlementPass({ pool: db.pool, catalog })).catalogUnavailable).toBe(true);
    expect(await cashOf(A)).toBe("8000.000000");
    catalog.unavailable = false;
    await runSettlementPass({ pool: db.pool, catalog }); // "after the restart"
    expect(await cashOf(A)).toBe("12000.000000");
  });

  it("settling the same market several times at once, then again after a restart, pays exactly once", async () => {
    catalog.market(M).resolution = { state: "resolved", winningOutcome: "YES", detail: "Officially resolved YES." };
    await Promise.all([settleMarket(db.pool, M, "YES", "worker 1"), settleMarket(db.pool, M, "YES", "worker 2"), runSettlementPass({ pool: db.pool, catalog })]);
    await runSettlementPass({ pool: db.pool, catalog }); // "after the restart"
    expect(await cashOf(A)).toBe("12000.000000");
    expect(await cashOf(B)).toBe("9000.000000"); // B held NO: nothing owed
    expect(await sum("select count(*)::text as v from trading.ledger_entries where entry_type = 'settlement_payout'")).toBe("1");
  });

  it("never accepts a different winner for an already-settled market", async () => {
    await settleMarket(db.pool, M, "YES", "first");
    await expect(settleMarket(db.pool, M, "NO", "conflicting")).rejects.toThrow(/Settlement conflict/);
  });

  it("positions in a market that left the active catalog are still valued and settled", async () => {
    catalog.market(M).status = "delisted";
    expect((await portfolio(A)).positions[0]!.mark).toMatchObject({ price: "0.500000" });
    catalog.market(M).resolution = { state: "resolved", winningOutcome: "YES", detail: "Officially resolved YES." };
    await runSettlementPass({ pool: db.pool, catalog });
    expect(await cashOf(A)).toBe("12000.000000");
  });
});

describe("valuation keeps tracking held markets", () => {
  it("asks the catalog to PIN every market with an open position, even if nobody is viewing it", async () => {
    await buy(A, "100");
    catalog.pinned.clear();
    await valuation.refresh(true);
    expect([...catalog.pinned]).toEqual([M]);
  });

  it("falls back to last known marks when the catalog cannot be reached, and still ranks everyone", async () => {
    await buy(A, "2000");
    await valuation.refresh(true);
    catalog.unavailable = true;
    const a = await portfolio(A);
    expect(a.totalPower).toBe("10000.000000");
    expect(a.positions[0]!.mark).toMatchObject({ source: "last_known", stale: true });
  });
});

describe("country identity, ranking and privacy", () => {
  it("every account has a unique username, stable country id and slot", async () => {
    const rows = (await db.pool.query("select username, country_id, country_seq::int from trading.accounts order by country_seq")).rows;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.username)).size).toBe(2);
    expect(rows[0].username).toBe("player_aaaaaaaaaaaa");
    const again = await provisionTradingAccount(db.pool, A);
    expect(again.countryId).toBe(rows[0].country_id);
    expect(await sum("select count(*)::text as v from trading.ledger_entries where entry_type = 'starting_grant'")).toBe("2");
  });

  it("usernames are unique ignoring case, and renaming keeps the country", async () => {
    expect(await setUsername(db.pool, A, "Ada")).toBe(true);
    await expect(setUsername(db.pool, B, "ada")).rejects.toBeInstanceOf(UsernameTakenError);
    expect(await setUsername(db.pool, B, "Bob_2")).toBe(true);
    const league = toLeagueSnapshot(await valuation.snapshot());
    expect(league.countries.map((c) => c.username).sort()).toEqual(["Ada", "Bob_2"]);
  });

  it("equal totals share a rank; the display order is stable (by slot)", async () => {
    const league = toLeagueSnapshot(await valuation.snapshot());
    expect(league.countries.map((c) => c.rank)).toEqual([1, 1]);
    expect(league.countries.map((c) => c.slot)).toEqual([1, 2]);
    await buy(A, "100");
    await buy(B, "100");
    expect(toLeagueSnapshot(await valuation.snapshot()).countries.map((c) => c.slot)).toEqual([1, 2]);
  });

  it("a leader ranks 1 and everyone tied behind them shares rank 2", async () => {
    const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await provisionTradingAccount(db.pool, C);
    await provisionTradingAccount(db.pool, D);
    catalog.setPrice(M, "0.5");
    await buy(A, "2000");
    catalog.setPrice(M, "0.65");
    const league = toLeagueSnapshot(await valuation.snapshot());
    expect(league.countries.map((c) => c.rank)).toEqual([1, 2, 2, 2]);
  });
});

describe("HTTP: the public league endpoint reveals nothing private", () => {
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    const http = new FakeCatalog();
    http.addMarket(M);
    const service = new ValuationService({ pool: db.pool, catalog: http, ttlMs: 0 });
    server = createServer(createApp({ pool: db.pool, catalog: http, valuation: service }));
    baseUrl = await new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  });
  afterAll(async () => new Promise((resolve) => server.close(resolve)));

  it("serves only country id, username, colour, slot, rank and a rounded size", async () => {
    await buy(A, "2000");
    const response = await fetch(`${baseUrl}/internal/v1/league`);
    const body = LeagueSnapshotSchema.parse(await response.json());
    const text = JSON.stringify(body);
    for (const secret of [A, B, "cash", "balance", "shares", "fill", "token", "market"]) expect(text).not.toContain(secret);
    for (const country of body.countries) expect(Object.keys(country).sort()).toEqual(["areaWeight", "avatarKey", "color", "countryId", "rank", "relativeSize", "slot", "username"]);
  });

  it("the portfolio endpoint is per player and validates against the contract", async () => {
    await buy(A, "2000");
    const mine = await fetch(`${baseUrl}/internal/v1/accounts/${A}/portfolio`);
    expect(PortfolioResponseSchema.parse(await mine.json()).availablePower).toBe("8000.000000");
    const theirs = await fetch(`${baseUrl}/internal/v1/accounts/${B}/portfolio`);
    const b = PortfolioResponseSchema.parse(await theirs.json());
    expect([b.availablePower, b.positions.length, b.fills.length]).toEqual(["10000.000000", 0, 0]);
  });

  it("GET endpoints have no financial side effects", async () => {
    await buy(A, "2000");
    const snapshot = async () => [await count("orders"), await count("fills"), await count("ledger_entries"), await cashOf(A)];
    const before = await snapshot();
    for (const path of ["/internal/v1/league", `/internal/v1/accounts/${A}/portfolio`, `/internal/v1/accounts/${A}`]) await fetch(baseUrl + path);
    expect(await snapshot()).toEqual(before);
  });

  it("bad bodies are refused with 400 and trade errors carry their code", async () => {
    const preview = await fetch(`${baseUrl}/internal/v1/accounts/${A}/trades/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(preview.status).toBe(400);
    const sellTooMuch = await fetch(`${baseUrl}/internal/v1/accounts/${A}/trades/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marketId: M, outcome: "YES", side: "sell", quantity: "5" }),
    });
    expect(sellTooMuch.status).toBe(409);
    expect(((await sellTooMuch.json()) as { error: { code: string } }).error.code).toBe("insufficient_shares");
  });
});
