/**
 * Integration tests: the real sync + publish + read code against a throwaway PostgreSQL
 * (see support/test-database.ts). Polymarket is replaced by a fake HTTP layer serving
 * hand-written representative payloads, so these tests are deterministic and offline.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MarketListQuerySchema } from "@league/catalog-contract";
import { getCatalogFreshness, InvalidCursorError, listMarkets } from "../src/catalog/catalog-queries.ts";
import { publishSyncRun, startSyncRun } from "../src/catalog/sync-run-store.ts";
import { runCatalogSync } from "../src/sync/run-catalog-sync.ts";
import { fakeGamma, gammaEvent, gammaMarket, type FakePage } from "./support/gamma-builders.ts";
import { startTestDatabase, type TestDatabase } from "./support/test-database.ts";

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
}, 120_000);
afterAll(async () => db?.stop());
beforeEach(async () => db.reset());

const query = (input: Record<string, unknown> = {}) => MarketListQuerySchema.parse({ limit: 100, ...input });

/** Politics: two markets in one event (page 1) and a referendum (page 2). Pop culture: an album.
 * Market 9 carries both tags (politics page 2 and pop culture). */
function baseListing(prices = { a: "0.25", b: "0.60" }): Record<string, FakePage[]> {
  const shared = gammaMarket({ id: "9", question: "Will a celebrity win office?", endDate: "2027-06-01T00:00:00Z" });
  return {
    politics: [
      {
        events: [
          gammaEvent({
            id: "100",
            title: "Election by...?",
            markets: [
              gammaMarket({ id: "1", question: "Election by March?", outcomePrices: `["${prices.a}", "0.75"]`, endDate: "2027-03-01T00:00:00Z" }),
              gammaMarket({ id: "2", question: "Election by June?", outcomePrices: `["${prices.b}", "0.40"]`, endDate: "2027-06-01T00:00:00Z" }),
              gammaMarket({ id: "3", question: "Election by January?", closed: true }), // closed inside open event
            ],
          }),
        ],
        next_cursor: "1",
      },
      {
        events: [
          gammaEvent({ id: "300", title: "Crossover", markets: [shared] }),
          gammaEvent({ id: "400", title: "Referendum?", markets: [gammaMarket({ id: "5", question: "Referendum in 2027?" })] }),
        ],
      },
    ],
    "pop-culture": [
      {
        events: [
          gammaEvent({ id: "200", title: "Album?", markets: [gammaMarket({ id: "4", question: "New album in 2027?", endDate: null })] }),
          gammaEvent({ id: "300", title: "Crossover", markets: [shared] }),
        ],
      },
    ],
  };
}

const sync = (pages: Record<string, FakePage[]>, options: { failTag?: string; maxPagesPerTag?: number } = {}) =>
  runCatalogSync(
    { pool: db.pool, gamma: fakeGamma(pages, options).gamma, maxPagesPerTag: options.maxPagesPerTag ?? 10 },
    "test",
  );

async function marketRows() {
  const { rows } = await db.pool.query(
    `select provider_market_id, categories, yes_price::float8 as yes, listing_status, first_seen_at, last_seen_run_id
       from market_catalog.markets order by provider_market_id`,
  );
  return rows;
}

describe("catalog sync against PostgreSQL", () => {
  it("imports open YES/NO markets once, merging categories for markets in both tags", async () => {
    const summary = await sync(baseListing());
    expect(summary.status).toBe("succeeded");
    expect(summary.skipCounts).toEqual({ not_open: 1 });

    const rows = await marketRows();
    expect(rows.map((r) => r.provider_market_id)).toEqual(["1", "2", "4", "5", "9"]);
    expect(rows.find((r) => r.provider_market_id === "9")?.categories).toEqual(["politics", "pop-culture"]);
  });

  it("stores non-ASCII questions intact (live titles include names such as Erdoğan)", async () => {
    const question = "Erdoğan out as President of Türkiye by 2027? — «test» 選挙";
    await sync({
      politics: [{ events: [gammaEvent({ id: "1", title: "Türkiye", markets: [gammaMarket({ id: "77", question })] })] }],
      "pop-culture": baseListing()["pop-culture"]!,
    });
    const { markets } = await listMarkets(db.pool, query({ category: "politics" }));
    expect(markets.map((m) => m.question)).toContain(question);
  });

  it("re-running a sync updates existing rows instead of creating duplicates", async () => {
    await sync(baseListing());
    const before = await marketRows();
    const second = await sync(baseListing({ a: "0.31", b: "0.60" }));

    expect(second.status).toBe("succeeded");
    const after = await marketRows();
    expect(after).toHaveLength(5);
    const marketOne = after.find((r) => r.provider_market_id === "1")!;
    expect(marketOne.yes).toBe(0.31); // price refreshed
    expect(marketOne.first_seen_at).toEqual(before.find((r) => r.provider_market_id === "1")!.first_seen_at);
    expect(new Set(after.map((r) => Number(r.last_seen_run_id)))).toEqual(new Set([second.runId]));
  });

  it("a failed refresh keeps the previous catalog and its last-successful timestamp", async () => {
    await sync(baseListing());
    const freshnessBefore = await getCatalogFreshness(db.pool);
    const rowsBefore = await marketRows();

    // Politics succeeds, pop-culture fails on every attempt: nothing may be published.
    const failed = await sync(baseListing({ a: "0.99", b: "0.99" }), { failTag: "pop-culture" });
    expect(failed.status).toBe("failed");

    expect(await marketRows()).toEqual(rowsBefore); // no price changes, nothing delisted
    const freshnessAfter = await getCatalogFreshness(db.pool);
    expect(freshnessAfter.lastSuccessfulRefreshAt).toBe(freshnessBefore.lastSuccessfulRefreshAt);
    expect(freshnessAfter.latestAttempt?.status).toBe("failed");
    expect((await listMarkets(db.pool, query())).markets).toHaveLength(5);
  });

  it("a truncated listing publishes what it saw as 'partial' but never delists or drops categories", async () => {
    await sync(baseListing());
    // maxPagesPerTag=1 cuts politics off after page 1: market 5 is not seen at all,
    // and market 9 is seen only via pop-culture.
    const partial = await sync(baseListing(), { maxPagesPerTag: 1 });
    expect(partial.status).toBe("partial");
    expect(partial.statusDetail).toMatch(/truncated/);

    const rows = await marketRows();
    expect(rows.every((r) => r.listing_status === "listed")).toBe(true);
    expect(partial.marketsDelisted).toBe(0);
    expect(rows.find((r) => r.provider_market_id === "9")?.categories).toEqual(["politics", "pop-culture"]);
    const freshness = await getCatalogFreshness(db.pool);
    expect(freshness.latestAttempt?.status).toBe("partial");
  });

  it("a tag that returns nothing is treated as suspicious: partial, nothing delisted", async () => {
    await sync(baseListing());
    const result = await sync({ politics: baseListing().politics!, "pop-culture": [{ events: [] }] });
    expect(result.status).toBe("partial");
    expect((await marketRows()).every((r) => r.listing_status === "listed")).toBe(true);
  });

  it("a complete refresh delists markets that left the open listing (without calling them resolved)", async () => {
    await sync(baseListing());
    const listing = baseListing();
    listing["pop-culture"] = [{ events: [gammaEvent({ id: "300", title: "Crossover", markets: [gammaMarket({ id: "9" })] })] }];
    const result = await sync(listing);

    expect(result.status).toBe("succeeded");
    expect(result.marketsDelisted).toBe(1);
    expect((await marketRows()).find((r) => r.provider_market_id === "4")?.listing_status).toBe("delisted");
    expect((await listMarkets(db.pool, query())).markets.map((m) => m.question)).not.toContain("New album in 2027?");
  });

  it("an older run that finishes after a newer one is superseded and writes nothing", async () => {
    const tagInput = { trigger: "test" as const, providerTagSlugs: ["politics"], maxPagesPerTag: 1 };
    const older = await startSyncRun(db.pool, tagInput);
    const newer = await startSyncRun(db.pool, tagInput);
    const market = (id: string, yes: number) => ({
      providerMarketId: id,
      providerEventId: "1",
      eventTitle: "E",
      eventSlug: null,
      question: `Q${id}`,
      outcomeLabels: ["Yes", "No"] as [string, string],
      snapshotPrices: { yes, no: 1 - yes },
      sourceUrl: null,
      expectedEndAt: null,
      acceptingOrders: true,
      fetchedAt: new Date(),
      categories: ["politics" as const],
    });

    const publish = (runId: number, yes: number) =>
      publishSyncRun(db.pool, { runId, markets: [market("1", yes)], isComplete: true, statusDetail: null, pagesFetched: 1, skipCounts: {} });

    expect((await publish(newer.runId, 0.7)).status).toBe("succeeded");
    expect((await publish(older.runId, 0.1)).status).toBe("superseded");

    expect((await marketRows())[0].yes).toBe(0.7);
    const freshness = await getCatalogFreshness(db.pool);
    expect(freshness.latestAttempt?.status).toBe("succeeded"); // latest attempt = the newer run
  });
});

describe("catalog reads", () => {
  it("filters by category and pages with a stable cursor: soonest end first, unknown end last", async () => {
    await sync(baseListing());

    const politics = await listMarkets(db.pool, query({ category: "politics" }));
    expect(politics.markets.map((m) => m.question)).toEqual([
      "Referendum in 2027?", // ends 2027-01-01
      "Election by March?",
      "Election by June?", // ties with the next market on end date; id breaks the tie
      "Will a celebrity win office?",
    ]);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listMarkets(db.pool, query({ limit: 1, cursor }));
      seen.push(...page.markets.map((m) => m.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const all = await listMarkets(db.pool, query());
    expect(seen).toEqual(all.markets.map((m) => m.id));
    expect(all.markets.at(-1)?.question).toBe("New album in 2027?"); // null end date sorts last
    expect(all.markets[0]?.snapshotPrices).toMatchObject({ yes: 0.25, no: 0.75 });
  });

  it("rejects a tampered cursor", async () => {
    await expect(listMarkets(db.pool, query({ cursor: "not-a-cursor" }))).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("reports no freshness before the first sync", async () => {
    expect(await getCatalogFreshness(db.pool)).toEqual({ lastSuccessfulRefreshAt: null, latestAttempt: null });
  });
});
