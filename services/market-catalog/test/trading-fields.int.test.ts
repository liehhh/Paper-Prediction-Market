/**
 * What a paper trade needs from the catalog: the YES/NO order-book tokens (mapped by LABEL), the resolution rules,
 * the support rules, and the official-resolution reading. Fixture payloads + a throwaway PostgreSQL. No network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QuoteResponseSchema } from "@league/catalog-contract";
import { mapTokenIds, normalizeGammaEvent } from "../src/polymarket/normalize-market.ts";
import type { BookFeed, TokenReading } from "../src/orderbook/book-feed.ts";
import { classifyResolution, ProviderStatus } from "../src/orderbook/provider-status.ts";
import { MIN_RULES_LENGTH, QuoteService } from "../src/orderbook/quote-service.ts";
import { runCatalogSync } from "../src/sync/run-catalog-sync.ts";
import { fakeGamma, gammaEvent, gammaMarket } from "./support/gamma-builders.ts";
import { startTestDatabase, type TestDatabase } from "./support/test-database.ts";

const RULES = "This market resolves YES if the fixture candidate wins the fixture election, otherwise NO.";

describe("YES/NO token mapping is by label, never by position", () => {
  it("YES is the second element when the outcomes are listed No, Yes", () => {
    expect(mapTokenIds('["11", "22"]', 2, 1, 0)).toEqual({ yes: "22", no: "11" });
  });

  it("normalizes a market listed No-first so the YES token and YES price follow the label", () => {
    const event = gammaEvent({
      markets: [gammaMarket({ outcomes: '["No", "Yes"]', outcomePrices: '["0.70", "0.30"]', clobTokenIds: '["900", "901"]', conditionId: "0xabc", description: RULES, enableOrderBook: true })],
    });
    const [market] = normalizeGammaEvent(event, new Date()).markets;
    expect(market).toMatchObject({ yesTokenId: "901", noTokenId: "900", conditionId: "0xabc", rules: RULES, orderBookEnabled: true });
    expect(market!.snapshotPrices).toEqual({ yes: 0.3, no: 0.7 });
  });

  it("refuses ambiguous token data: wrong count, non-numeric, duplicates", () => {
    expect(mapTokenIds('["1"]', 2, 0, 1)).toBeNull();
    expect(mapTokenIds('["1", "2", "3"]', 2, 0, 1)).toBeNull();
    expect(mapTokenIds('["abc", "2"]', 2, 0, 1)).toBeNull();
    expect(mapTokenIds('["5", "5"]', 2, 0, 1)).toBeNull();
    expect(mapTokenIds(undefined, 2, 0, 1)).toBeNull();
    expect(mapTokenIds("not json", 2, 0, 1)).toBeNull();
  });

  it("a market without usable tokens is still browsable, just not tradable", () => {
    const [market] = normalizeGammaEvent(gammaEvent({ markets: [gammaMarket({ clobTokenIds: "garbage" })] }), new Date()).markets;
    expect(market).toMatchObject({ yesTokenId: null, noTokenId: null, orderBookEnabled: false });
  });
});

describe("official resolution reading (Gamma /markets/{id})", () => {
  const closed = (extra: Record<string, unknown>) => ({ id: "1", closed: true, outcomes: '["Yes", "No"]', umaResolutionStatus: "resolved", ...extra });

  it("resolved YES and resolved NO, whatever the label order", () => {
    expect(classifyResolution(closed({ outcomePrices: '["1", "0"]' })).resolution).toMatchObject({ state: "resolved", winningOutcome: "YES" });
    expect(classifyResolution(closed({ outcomePrices: '["0", "1"]' })).resolution).toMatchObject({ state: "resolved", winningOutcome: "NO" });
    expect(classifyResolution(closed({ outcomes: '["No", "Yes"]', outcomePrices: '["1", "0"]' })).resolution).toMatchObject({ winningOutcome: "NO" });
  });

  it("a price near 1 on an open market is NOT a resolution", () => {
    const result = classifyResolution({ id: "1", closed: false, active: true, acceptingOrders: true, umaResolutionStatus: "resolved", outcomes: '["Yes", "No"]', outcomePrices: '["0.9999", "0.0001"]' });
    expect(result.resolution).toMatchObject({ state: "open", winningOutcome: null });
  });

  it("closed but not officially resolved: waiting, no outcome", () => {
    expect(classifyResolution(closed({ umaResolutionStatus: "proposed", outcomePrices: '["1", "0"]' })).resolution).toMatchObject({ state: "closed_unresolved", winningOutcome: null });
    expect(classifyResolution(closed({ umaResolutionStatus: null, outcomePrices: '["1", "0"]' })).resolution.state).toBe("closed_unresolved");
  });

  it("a 50/50 or otherwise unsupported settlement is ambiguous: positions are kept", () => {
    expect(classifyResolution(closed({ outcomePrices: '["0.5", "0.5"]' })).resolution).toMatchObject({ state: "ambiguous", winningOutcome: null });
    expect(classifyResolution(closed({ outcomes: '["Up", "Down"]', outcomePrices: '["1", "0"]' })).resolution.state).toBe("ambiguous");
    expect(classifyResolution(closed({ outcomePrices: undefined })).resolution.state).toBe("ambiguous");
  });

  it("garbage is unknown, and a failed lookup is null (never 'open')", async () => {
    expect(classifyResolution("nonsense").resolution.state).toBe("unknown");
    const down = new ProviderStatus({ gammaBaseUrl: "https://gamma.test", fetchImpl: (async () => new Response("no", { status: 503 })) as typeof fetch });
    expect(await down.get("1")).toBeNull();
  });

  it("caches lookups per market, but never caches a failure", async () => {
    let calls = 0;
    let fail = true;
    const provider = new ProviderStatus({
      gammaBaseUrl: "https://gamma.test",
      fetchImpl: (async () => {
        calls++;
        return fail ? new Response("no", { status: 500 }) : Response.json({ id: "1", closed: false, active: true, acceptingOrders: true });
      }) as typeof fetch,
    });
    expect(await provider.get("1")).toBeNull();
    fail = false;
    expect((await provider.get("1"))?.closed).toBe(false);
    await provider.get("1");
    expect(calls).toBe(2); // the failure was retried; the success is cached
  });
});

describe("QuoteService (real Postgres rows, fake feed)", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await startTestDatabase();
  }, 120_000);
  afterAll(async () => db?.stop());
  beforeEach(async () => db.reset());

  const levels = { bids: [{ price: "0.49", size: "100" }], asks: [{ price: "0.51", size: "100" }] };
  /** A feed stand-in: the test decides each token's state. */
  function fakeFeed(readings: Record<string, Partial<TokenReading>>) {
    const tracked: Array<[string[], string]> = [];
    const feed = {
      track: (ids: readonly string[], intent: string) => void tracked.push([[...ids], intent]),
      read: (id: string): TokenReading | null => (readings[id] ? { state: "live", ...levels, observedAt: Date.parse("2026-11-23T12:00:00Z"), tickSize: "0.01", ...readings[id] } : null),
    } as unknown as BookFeed;
    return { feed, tracked };
  }
  const openProvider = new ProviderStatus({ gammaBaseUrl: "https://gamma.test", fetchImpl: (async () => Response.json({ id: "x", closed: false, active: true, acceptingOrders: true })) as typeof fetch });

  async function publish(market: Record<string, unknown>, tags = [{ slug: "politics" }]) {
    const fake = fakeGamma([{ events: [gammaEvent({ tags, markets: [gammaMarket({ outcomes: '["Yes", "No"]', clobTokenIds: '["901", "902"]', description: RULES, enableOrderBook: true, conditionId: "0xabc", ...market })] })] }]);
    await runCatalogSync({ pool: db.pool, gamma: fake.gamma }, "test");
    return (await db.pool.query("select id::text from market_catalog.markets order by id desc limit 1")).rows[0].id as string;
  }
  const service = (feed: BookFeed, now = "2026-11-23T12:00:10Z", provider = openProvider) => new QuoteService({ pool: db.pool, feed, provider, now: () => Date.parse(now) });

  it("a supported political market is executable, with the right book for each outcome and its rules", async () => {
    const id = await publish({ question: "Will the fixture candidate win?" });
    const { feed, tracked } = fakeFeed({ "901": {}, "902": { bids: [{ price: "0.48", size: "5" }], asks: [{ price: "0.52", size: "5" }] } });
    const [quote] = await service(feed).quotes([id], "view");
    expect(QuoteResponseSchema.safeParse(quote).success).toBe(true);
    expect(quote!.market).toMatchObject({ question: "Will the fixture candidate win?", rules: RULES, status: "open", tradingSupported: true });
    expect(quote!.feed).toMatchObject({ state: "live", executable: true, pausedReason: null });
    expect(quote!.yes).toMatchObject({ tokenId: "901", asks: [{ price: "0.51", size: "100" }] });
    expect(quote!.no).toMatchObject({ tokenId: "902", asks: [{ price: "0.52", size: "5" }] });
    expect(tracked).toEqual([[["901", "902"], "view"]]);
  });

  it("unsupported markets (not political, no tokens, no order book, thin rules) are never executable", async () => {
    const reasons = [
      await service(fakeFeed({}).feed).quotes([await publish({ id: "10" }, [{ slug: "sports" }])], "view"),
      await service(fakeFeed({}).feed).quotes([await publish({ id: "11", clobTokenIds: undefined })], "view"),
      await service(fakeFeed({}).feed).quotes([await publish({ id: "12", enableOrderBook: false })], "view"),
      await service(fakeFeed({}).feed).quotes([await publish({ id: "13", description: "x".repeat(MIN_RULES_LENGTH - 1) })], "view"),
    ].map(([quote]) => quote!);
    for (const quote of reasons) {
      expect(quote.market.tradingSupported).toBe(false);
      expect(quote.feed.executable).toBe(false);
      expect(quote.market.unsupportedReason).toBeTruthy();
    }
    expect(reasons.map((q) => q.market.unsupportedReason)).toEqual([
      "Only political markets can be traded in this league.",
      "This market has no live order book we can price against.",
      "Polymarket has not enabled an order book for this market.",
      "This market does not publish clear resolution rules.",
    ]);
  });

  it("a feed that is down or recovering pauses execution but still returns the last known book with its timestamp", async () => {
    const id = await publish({});
    for (const state of ["disconnected", "recovering"] as const) {
      const [quote] = await service(fakeFeed({ "901": { state }, "902": { state } }).feed).quotes([id], "view");
      expect(quote!.feed).toMatchObject({ state, executable: false });
      expect(quote!.feed.pausedReason).toMatch(/paused/i);
      expect(quote!.yes!.asks).toEqual(levels.asks);
      expect(quote!.yes!.observedAt).toBe("2026-11-23T12:00:00.000Z");
    }
  });

  it("a market nobody has a book for yet is unavailable, not executable", async () => {
    const id = await publish({});
    const [quote] = await service(fakeFeed({}).feed).quotes([id], "view");
    expect(quote!.feed).toMatchObject({ state: "unavailable", executable: false, observedAt: null });
    expect(quote!.yes).toBeNull();
  });

  it("closing time, a closed provider status, or delisting stops execution", async () => {
    const live = fakeFeed({ "901": {}, "902": {} }).feed;
    const ended = await publish({ id: "20", endDate: "2026-11-23T11:00:00Z" });
    expect((await service(live).quotes([ended], "view"))[0]!.market.status).toBe("closed");

    const closedByProvider = new ProviderStatus({ gammaBaseUrl: "https://gamma.test", fetchImpl: (async () => Response.json({ id: "x", closed: true })) as typeof fetch });
    const open = await publish({ id: "21" });
    const [quote] = await service(live, "2026-11-23T12:00:10Z", closedByProvider).quotes([open], "view");
    expect(quote!.market.status).toBe("closed");
    expect(quote!.feed.executable).toBe(false);

    await db.pool.query("update market_catalog.markets set listing_status = 'delisted', delisted_at = now() where id = $1", [open]);
    const [delisted] = await service(live).quotes([open], "view");
    expect(delisted!.market.status).toBe("delisted");
    expect(delisted!.feed.executable).toBe(false);
  });

  it("'pin' keeps a market tracked even after it left the catalog or stopped being supported", async () => {
    const id = await publish({});
    await db.pool.query("update market_catalog.markets set listing_status = 'delisted', delisted_at = now(), categories = array['other'] where id = $1", [id]);
    const { feed, tracked } = fakeFeed({ "901": {}, "902": {} });
    await service(feed).quotes([id], "pin");
    expect(tracked).toEqual([[["901", "902"], "pin"]]);
  });

  it("quotes for several markets are built side by side, not one after another", async () => {
    const ids = [await publish({ id: "40" }), await publish({ id: "41" }), await publish({ id: "42" }), await publish({ id: "43" })];
    const slowProvider = new ProviderStatus({
      gammaBaseUrl: "https://gamma.test",
      fetchImpl: (async () => {
        await new Promise((resolve) => setTimeout(resolve, 200)); // each Polymarket lookup takes 200 ms
        return Response.json({ id: "x", closed: false, active: true, acceptingOrders: true });
      }) as typeof fetch,
    });
    const started = Date.now();
    const quotes = await service(fakeFeed({ "901": {}, "902": {} }).feed, undefined, slowProvider).quotes(ids, "pin");
    const elapsed = Date.now() - started;
    expect(quotes.map((q) => q.market.id)).toEqual(ids); // same order as asked
    expect(elapsed).toBeLessThan(550); // one after another would be 4 x 200 = 800 ms or more
  });

  it("unknown market ids are simply absent", async () => {
    expect(await service(fakeFeed({}).feed).quotes(["999999"], "view")).toEqual([]);
  });

  it("official resolutions: a lookup that fails is 'unknown', never open", async () => {
    const id = await publish({});
    const down = new ProviderStatus({ gammaBaseUrl: "https://gamma.test", fetchImpl: (async () => new Response("no", { status: 503 })) as typeof fetch });
    const [resolution] = await service(fakeFeed({}).feed, undefined, down).resolutions([id]);
    expect(resolution).toMatchObject({ marketId: id, state: "unknown", winningOutcome: null });

    const resolvedYes = new ProviderStatus({
      gammaBaseUrl: "https://gamma.test",
      fetchImpl: (async () => Response.json({ id: "x", closed: true, umaResolutionStatus: "resolved", outcomes: '["Yes","No"]', outcomePrices: '["1","0"]' })) as typeof fetch,
    });
    expect((await service(fakeFeed({}).feed, undefined, resolvedYes).resolutions([id]))[0]).toMatchObject({ state: "resolved", winningOutcome: "YES" });
  });

  it("a re-sync stores the trading fields once and does not rewrite unchanged rows", async () => {
    await publish({});
    const fake = fakeGamma([{ events: [gammaEvent({ markets: [gammaMarket({ outcomes: '["Yes", "No"]', clobTokenIds: '["901", "902"]', description: RULES, enableOrderBook: true, conditionId: "0xabc" })] })] }]);
    const again = await runCatalogSync({ pool: db.pool, gamma: fake.gamma }, "test");
    expect(again.marketsWritten).toBe(0);
    const row = (await db.pool.query("select yes_token_id, no_token_id, rules, condition_id, order_book_enabled from market_catalog.markets")).rows[0];
    expect(row).toEqual({ yes_token_id: "901", no_token_id: "902", rules: RULES, condition_id: "0xabc", order_book_enabled: true });
  });
});
