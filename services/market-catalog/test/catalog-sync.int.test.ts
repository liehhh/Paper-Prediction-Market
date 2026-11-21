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

/**
 * Event 100 (politics) is open but holds a closed question (3).
 * Event 200 is pop-culture. Event 300 carries BOTH tags. Event 400 carries no mapped tag -> "other".
 */
function basePages(prices = { a: "0.25", b: "0.60" }): FakePage[] {
  return [
    {
      events: [
        gammaEvent({
          id: "100",
          title: "Election by...?",
          markets: [
            gammaMarket({ id: "1", question: "Election by March?", outcomePrices: `["${prices.a}", "0.75"]`, volume24hr: 500.4 }),
            gammaMarket({ id: "2", question: "Election by June?", outcomePrices: `["${prices.b}", "0.40"]`, volume24hr: 300 }),
            gammaMarket({ id: "3", question: "Election by January?", closed: true, volume24hr: 9999 }),
          ],
        }),
        gammaEvent({ id: "200", title: "Album?", tags: [{ slug: "pop-culture" }], markets: [gammaMarket({ id: "4", question: "New album in 2027?", endDate: null, volume24hr: 5 })] }),
      ],
    },
    {
      events: [
        gammaEvent({ id: "300", title: "Crossover", tags: [{ slug: "politics" }, { slug: "pop-culture" }], markets: [gammaMarket({ id: "9", question: "Will a celebrity win office?", volume24hr: 40 })] }),
        gammaEvent({ id: "400", title: "Untagged", tags: [{ slug: "games" }], markets: [gammaMarket({ id: "5", question: "Something else?" })] }),
      ],
    },
  ];
}

function sync(pages: FakePage[], options: { failFromPage?: number; maxPages?: number } = {}) {
  const fake = fakeGamma(pages, options);
  return runCatalogSync({ pool: db.pool, gamma: fake.gamma, maxPages: options.maxPages }, "test").then((summary) => ({ summary, requests: fake.requests }));
}

async function marketRows() {
  const { rows } = await db.pool.query(
    `select provider_market_id, categories, yes_price::float8 as yes, volume24hr::float8 as volume, listing_status, first_seen_at
       from market_catalog.markets order by provider_market_id`,
  );
  return rows;
}

const listedQuestions = async () => (await listMarkets(db.pool, query())).markets.map((m) => m.question);

describe("full-catalog sync against PostgreSQL", () => {
  it("pages through every event and stores each open YES/NO question once, with categories from event tags", async () => {
    const { summary, requests } = await sync(basePages());

    expect(requests).toHaveLength(2);
    expect(summary).toMatchObject({ status: "succeeded", requestsMade: 2, eventsFetched: 4, marketsEligible: 5, marketsWritten: 5 });
    const rows = await marketRows();
    expect(rows.map((r) => r.provider_market_id)).toEqual(["1", "2", "4", "5", "9"]); // not 3: closed
    expect(rows.find((r) => r.provider_market_id === "9")?.categories).toEqual(["politics", "pop-culture"]);
    expect(rows.find((r) => r.provider_market_id === "5")?.categories).toEqual(["other"]);
    expect(rows.find((r) => r.provider_market_id === "1")?.volume).toBe(500); // whole dollars
  });

  it("re-running against unchanged data writes nothing", async () => {
    await sync(basePages());
    const before = await marketRows();
    const { summary } = await sync(basePages());

    expect(summary).toMatchObject({ status: "succeeded", marketsWritten: 0, marketsDelisted: 0 });
    expect(await marketRows()).toEqual(before);
  });

  it("re-running with one changed price writes exactly that row and keeps its identity", async () => {
    await sync(basePages());
    const before = await marketRows();
    const { summary } = await sync(basePages({ a: "0.31", b: "0.60" }));

    expect(summary.marketsWritten).toBe(1);
    const after = await marketRows();
    expect(after).toHaveLength(5);
    const one = after.find((r) => r.provider_market_id === "1")!;
    expect(one.yes).toBe(0.31);
    expect(one.first_seen_at).toEqual(before.find((r) => r.provider_market_id === "1")!.first_seen_at);
  });

  it("one nested market closing hides only that market while its parent event's other markets stay", async () => {
    await sync(basePages());
    const pages = basePages();
    const event100 = pages[0]!.events[0] as { markets: Array<Record<string, unknown>> };
    event100.markets.find((m) => m.id === "2")!.closed = true;
    const { summary } = await sync(pages);

    expect(summary).toMatchObject({ status: "succeeded", marketsDelisted: 1 });
    expect(await listedQuestions()).toContain("Election by March?");
    expect(await listedQuestions()).not.toContain("Election by June?");
    const rows = await marketRows();
    expect(rows.find((r) => r.provider_market_id === "2")?.listing_status).toBe("delisted"); // kept, just not browsable
  });

  it("a sync that fails halfway leaves every valid listing and the last-success time untouched", async () => {
    await sync(basePages());
    const freshnessBefore = await getCatalogFreshness(db.pool);
    const rowsBefore = await marketRows();

    const { summary } = await sync(basePages({ a: "0.99", b: "0.99" }), { failFromPage: 2 });
    expect(summary.status).toBe("failed");
    expect(summary.statusDetail).toMatch(/previous catalog kept/);

    expect(await marketRows()).toEqual(rowsBefore);
    const freshnessAfter = await getCatalogFreshness(db.pool);
    expect(freshnessAfter.lastSuccessfulRefreshAt).toBe(freshnessBefore.lastSuccessfulRefreshAt);
    expect(freshnessAfter.latestAttempt?.status).toBe("failed");
    expect(await listedQuestions()).toHaveLength(5);
  });

  it("a scan cut off by the page cap publishes what it saw but delists nothing", async () => {
    await sync(basePages());
    const { summary } = await sync([basePages()[0]!, ...basePages().slice(1)], { maxPages: 1 });

    expect(summary.status).toBe("partial");
    expect(summary.marketsDelisted).toBe(0);
    expect(await listedQuestions()).toHaveLength(5); // page 2's markets are still listed
  });

  it("an upstream that suddenly returns almost nothing cannot empty the catalog", async () => {
    const many = (n: number): FakePage[] => [
      { events: Array.from({ length: n }, (_, i) => gammaEvent({ id: String(i + 1), markets: [gammaMarket({ id: String(i + 1), question: `Q${i + 1}?` })] })) },
    ];
    await sync(many(150));
    const { summary } = await sync(many(10));

    expect(summary.status).toBe("partial");
    expect(summary.statusDetail).toMatch(/Nothing was delisted/);
    const { rows } = await db.pool.query("select count(*)::int as n from market_catalog.markets where listing_status = 'listed'");
    expect(rows[0].n).toBe(150);
  });

  it("an empty scan fails instead of replacing the catalog", async () => {
    await sync(basePages());
    const { summary } = await sync([{ events: [] }]);
    expect(summary.status).toBe("failed");
    expect(await listedQuestions()).toHaveLength(5);
  });

  it("stores non-ASCII questions intact (live titles include names such as Erdoğan)", async () => {
    const question = "Erdoğan out as President of Türkiye by 2027? — «test» 選挙";
    await sync([{ events: [gammaEvent({ id: "1", title: "Türkiye", markets: [gammaMarket({ id: "77", question })] })] }]);
    const { markets } = await listMarkets(db.pool, query({ category: "politics" }));
    expect(markets.map((m) => m.question)).toContain(question);
  });

  it("an older run that finishes after a newer one is superseded and writes nothing", async () => {
    const runInput = { trigger: "test" as const, providerTagSlugs: ["(all active events)"], maxPagesPerTag: 1 };
    const older = await startSyncRun(db.pool, runInput);
    const newer = await startSyncRun(db.pool, runInput);
    const market = (id: string, yes: number) => ({
      providerMarketId: id,
      providerEventId: "1",
      eventTitle: "E",
      eventSlug: null,
      question: `Q${id}`,
      categories: ["politics" as const],
      outcomeLabels: ["Yes", "No"] as [string, string],
      snapshotPrices: { yes, no: 1 - yes },
      sourceUrl: null,
      expectedEndAt: null,
      acceptingOrders: true,
      volume24hr: 0,
      fetchedAt: new Date(),
    });
    const publish = (runId: number, yes: number) =>
      publishSyncRun(db.pool, { runId, markets: [market("1", yes)], isComplete: true, statusDetail: null, pagesFetched: 1, skipCounts: {} });

    expect((await publish(newer.runId, 0.7)).status).toBe("succeeded");
    expect((await publish(older.runId, 0.1)).status).toBe("superseded");
    expect((await marketRows())[0].yes).toBe(0.7);
    expect((await getCatalogFreshness(db.pool)).latestAttempt?.status).toBe("succeeded");
  });
});

describe("Trending and category reads", () => {
  it("orders by 24h volume, ties by id, and filters by category", async () => {
    await sync(basePages());

    const all = await listMarkets(db.pool, query());
    expect(all.markets.map((m) => [m.question, m.volume24hr])).toEqual([
      ["Election by March?", 500],
      ["Election by June?", 300],
      ["Will a celebrity win office?", 40],
      ["New album in 2027?", 5],
      ["Something else?", 0],
    ]);
    const politics = await listMarkets(db.pool, query({ category: "politics" }));
    expect(politics.markets.map((m) => m.question)).toEqual(["Election by March?", "Election by June?", "Will a celebrity win office?"]);
    const popCulture = await listMarkets(db.pool, query({ category: "pop-culture" }));
    expect(popCulture.markets.map((m) => m.question)).toEqual(["Will a celebrity win office?", "New album in 2027?"]);
  });

  it("pages with a stable cursor, including through a run of equal volumes", async () => {
    const pages: FakePage[] = [
      { events: Array.from({ length: 7 }, (_, i) => gammaEvent({ id: String(i + 1), markets: [gammaMarket({ id: String(i + 1), question: `Q${i + 1}?`, volume24hr: i < 4 ? 100 : 50 })] })) },
    ];
    await sync(pages);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listMarkets(db.pool, query({ limit: 2, cursor }));
      seen.push(...page.markets.map((m) => m.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const all = (await listMarkets(db.pool, query())).markets.map((m) => m.id);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(7);
  });

  it("an event that falls from #10 to #11 moves down the list and stays browsable, with no cleanup", async () => {
    const ranked = (volumes: number[]): FakePage[] => [
      { events: volumes.map((v, i) => gammaEvent({ id: String(i + 1), markets: [gammaMarket({ id: String(i + 1), question: `Q${i + 1}?`, volume24hr: v })] })) },
    ];
    // Question 10 is 10th of 11 (Q11 is the smallest).
    const volumes = [1100, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100];
    await sync(ranked(volumes));
    const top10 = (await listMarkets(db.pool, query({ limit: 10 }))).markets.map((m) => m.question);
    expect(top10.at(-1)).toBe("Q10?");

    // Q10 loses volume and drops below Q11.
    const changed = [...volumes];
    changed[9] = 50;
    const { summary } = await sync(ranked(changed));
    expect(summary).toMatchObject({ status: "succeeded", marketsWritten: 1, marketsDelisted: 0 });

    const firstPage = await listMarkets(db.pool, query({ limit: 10 }));
    expect(firstPage.markets.map((m) => m.question)).not.toContain("Q10?");
    const everything = (await listMarkets(db.pool, query())).markets.map((m) => m.question);
    expect(everything.at(-1)).toBe("Q10?");
    expect(everything).toHaveLength(11);
  });

  it("rejects a tampered cursor", async () => {
    await expect(listMarkets(db.pool, query({ cursor: "not-a-cursor" }))).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("reports no freshness before the first sync", async () => {
    expect(await getCatalogFreshness(db.pool)).toEqual({ lastSuccessfulRefreshAt: null, latestAttempt: null });
  });
});
