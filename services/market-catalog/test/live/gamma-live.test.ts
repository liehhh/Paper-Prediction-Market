/**
 * LIVE upstream check (`pnpm test:live`): fetches one real page per configured tag and runs it
 * through the same normalizer as production. Detects upstream drift (shape, tags, encoding).
 * Not part of `pnpm test`, because it depends on the network and on today's markets.
 */
import { describe, expect, it } from "vitest";
import { CATEGORY_PROVIDER_TAGS } from "../../src/categories.ts";
import { fetchOpenEventPages } from "../../src/polymarket/gamma-client.ts";
import { normalizeGammaEvent } from "../../src/polymarket/normalize-market.ts";

const gamma = { baseUrl: "https://gamma-api.polymarket.com", requestTimeoutMs: 30_000, maxAttemptsPerRequest: 3 };

describe.each(CATEGORY_PROVIDER_TAGS)("live Gamma tag $polymarketTagSlug", ({ polymarketTagSlug }) => {
  it("returns open events whose markets normalize into YES/NO questions", async () => {
    const pages = fetchOpenEventPages(gamma, polymarketTagSlug, 1);
    const next = await pages.next();
    if (next.done) throw new Error("Gamma returned no page");
    const first = next.value;
    expect(first.events.length).toBeGreaterThan(0);

    const results = first.events.map((event) => normalizeGammaEvent(event, first.fetchedAt));
    const markets = results.flatMap((r) => r.markets);
    const malformed = results.flatMap((r) => r.skips).filter((s) => s.reason.startsWith("malformed"));

    expect(markets.length).toBeGreaterThan(0);
    expect(malformed).toEqual([]);
    for (const market of markets) {
      if (market.snapshotPrices) expect(market.snapshotPrices.yes + market.snapshotPrices.no).toBeGreaterThan(0);
    }
  });
});
