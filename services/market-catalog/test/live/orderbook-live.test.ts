/**
 * LIVE smoke test (`pnpm test:live`): a REAL political market, REAL Polymarket order books over the REAL shared
 * WebSocket + REST snapshot path. Needs internet access and depends on today's markets, so it is not part of
 * `pnpm test`. It writes nothing anywhere: no database, no ledger.
 *
 * What it proves against the real service:
 *   - a real political market normalizes to the right YES and NO tokens (checked against the books themselves);
 *   - the feed reaches "live" with consistent, fresh books;
 *   - the production pricing walk prices a paper buy from the real asks and a sell from the real bids;
 *   - the resolution probe reads the same market as open (and does not mistake a high price for a resolution).
 */
import { describe, expect, it } from "vitest";
import { BookFeed } from "../../src/orderbook/book-feed.ts";
import { parseScaled } from "../../src/orderbook/order-book.ts";
import { ProviderStatus } from "../../src/orderbook/provider-status.ts";
import { unsupportedReason } from "../../src/orderbook/quote-service.ts";
import { normalizeGammaEvent, type NormalizedMarket } from "../../src/polymarket/normalize-market.ts";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

async function pickPoliticalMarket(): Promise<NormalizedMarket> {
  const url = new URL("/events/keyset", GAMMA);
  for (const [key, value] of Object.entries({ closed: "false", active: "true", tag_slug: "politics", order: "volume24hr", ascending: "false", limit: "40" })) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { accept: "application/json", "accept-encoding": "gzip" }, signal: AbortSignal.timeout(30_000) });
  expect(response.ok).toBe(true);
  const { events } = (await response.json()) as { events: unknown[] };
  const markets = events.flatMap((event) => normalizeGammaEvent(event, new Date()).markets);
  const supported = markets.filter(
    (m) =>
      unsupportedReason({ categories: m.categories, yes_token_id: m.yesTokenId, no_token_id: m.noTokenId, order_book_enabled: m.orderBookEnabled, rules: m.rules }) === null &&
      m.snapshotPrices !== null &&
      m.snapshotPrices.yes > 0.1 &&
      m.snapshotPrices.yes < 0.9 && // an actively two-sided market makes the check meaningful
      m.volume24hr > 1000 &&
      (m.expectedEndAt === null || m.expectedEndAt.getTime() > Date.now()), // a market past its end date is paused, by design
  );
  expect(supported.length, "no active supported political market found today").toBeGreaterThan(0);
  return supported[0]!;
}

const mid = (bids: Array<{ price: string }>, asks: Array<{ price: string }>) => Number(parseScaled(bids[0]!.price) + parseScaled(asks[0]!.price)) / 2e8;

describe("live: a real political market end to end (read-only)", () => {
  it("maps YES/NO tokens correctly, reaches a live consistent book, and prices paper trades from it", async () => {
    const market = await pickPoliticalMarket();
    console.log(`[live] market ${market.providerMarketId}: "${market.question}"`);

    const feed = new BookFeed({ wsUrl: WS, clobBaseUrl: CLOB, log: (message) => console.log(`[live] feed: ${message}`) });
    feed.start();
    try {
      feed.track([market.yesTokenId!, market.noTokenId!], "view");
      const deadline = Date.now() + 25_000;
      let yes = feed.read(market.yesTokenId!);
      let no = feed.read(market.noTokenId!);
      while ((yes?.state !== "live" || no?.state !== "live") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        yes = feed.read(market.yesTokenId!);
        no = feed.read(market.noTokenId!);
      }
      expect(feed.isConnected(), "the shared WebSocket should be connected").toBe(true);
      expect(yes?.state).toBe("live");
      expect(no?.state).toBe("live");
      expect(yes!.bids.length).toBeGreaterThan(0);
      expect(yes!.asks.length).toBeGreaterThan(0);
      expect(Date.now() - yes!.observedAt!).toBeLessThan(45_000); // fresh

      // The token mapping is right if the YES book trades near the YES snapshot price, and YES + NO sum to about 1.
      const yesMid = mid(yes!.bids, yes!.asks);
      const noMid = mid(no!.bids, no!.asks);
      console.log(`[live] YES mid ${yesMid.toFixed(4)}, NO mid ${noMid.toFixed(4)}, Gamma snapshot YES ${market.snapshotPrices!.yes}`);
      expect(Math.abs(yesMid - market.snapshotPrices!.yes)).toBeLessThan(0.08);
      expect(Math.abs(yesMid + noMid - 1)).toBeLessThan(0.08);

      // A live delta may or may not arrive in a few seconds; either way the book must stay consistent.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(feed.read(market.yesTokenId!)!.state).toBe("live");
    } finally {
      feed.stop();
    }
  }, 90_000);

  it("the production pricing walk prices a real buy from the asks and a real sell from the bids", async () => {
    const market = await pickPoliticalMarket();
    // The same snapshot endpoint the feed uses to recover.
    const response = await fetch(new URL("/books", CLOB), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ token_id: market.yesTokenId }]),
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.ok).toBe(true);
    const [book] = (await response.json()) as Array<{ asset_id: string; bids: Array<{ price: string; size: string }>; asks: Array<{ price: string; size: string }>; tick_size: string }>;
    expect(book!.asset_id).toBe(market.yesTokenId);
    expect(Number(book!.tick_size)).toBeGreaterThan(0);

    // Import lazily: these live in the trading service and are pure.
    const pricing = await import("../../../trading/src/trades/pricing.ts");
    const money = await import("../../../trading/src/trades/money.ts");
    const asks = pricing.toLevels([...book!.asks].sort((a, b) => Number(a.price) - Number(b.price)));
    const bids = pricing.toLevels([...book!.bids].sort((a, b) => Number(b.price) - Number(a.price)));
    const empty = new Map<bigint, bigint>();

    const buy = pricing.buyWithBudget(asks, money.parseMicro("25"), empty);
    expect(buy.ok).toBe(true);
    if (buy.ok) {
      console.log(`[live] paper buy of 25 Power: ${money.csToNumeric(buy.quantityCs)} YES shares at avg ${money.formatMicro(pricing.averagePriceMicro(buy.amountMicro, buy.quantityCs))}`);
      expect(buy.amountMicro <= money.parseMicro("25")).toBe(true);
      expect(buy.fills[0]!.priceMicro).toBe(asks[0]!.priceMicro); // starts at the best ask
      const sell = pricing.fillQuantity(bids, buy.quantityCs < bids[0]!.sizeCs ? buy.quantityCs : bids[0]!.sizeCs, empty);
      expect(sell.ok).toBe(true);
      if (sell.ok) expect(sell.fills[0]!.priceMicro).toBe(bids[0]!.priceMicro); // sells into the best bid
      expect(bids[0]!.priceMicro < asks[0]!.priceMicro).toBe(true);
    }
  }, 60_000);

  it("the resolution probe reads a real open market as open, never as resolved", async () => {
    const market = await pickPoliticalMarket();
    const state = await new ProviderStatus({ gammaBaseUrl: GAMMA }).get(market.providerMarketId);
    expect(state).not.toBeNull();
    expect(state!.closed).toBe(false);
    expect(state!.resolution).toMatchObject({ state: "open", winningOutcome: null });
  }, 30_000);
});
