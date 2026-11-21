/**
 * LIVE upstream check (`pnpm test:live`): fetches the first few pages of the real catalog and runs
 * them through production normalization. Detects upstream drift (page size, ordering, tags, encoding).
 * Not part of `pnpm test`, because it depends on the network and on today's markets.
 */
import { describe, expect, it } from "vitest";
import { EVENTS_PAGE_SIZE, fetchActiveEventPages } from "../../src/polymarket/gamma-client.ts";
import { normalizeGammaEvent } from "../../src/polymarket/normalize-market.ts";

const gamma = { baseUrl: "https://gamma-api.polymarket.com", requestTimeoutMs: 30_000, maxAttemptsPerRequest: 3 };

describe("live Gamma active-event scan", () => {
  it("serves full pages in ascending id order and yields categorised YES/NO questions", async () => {
    const pages = [];
    for await (const page of fetchActiveEventPages(gamma, 3)) pages.push(page);

    expect(pages).toHaveLength(3);
    expect(pages[0]!.events).toHaveLength(EVENTS_PAGE_SIZE); // a larger limit is silently capped here
    const ids = pages.flatMap((p) => p.events.map((e) => Number((e as { id: string }).id)));
    expect(new Set(ids).size).toBe(ids.length); // no repeats across page boundaries
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    const normalized = pages.flatMap((p) => p.events.map((e) => normalizeGammaEvent(e, p.fetchedAt)));
    const markets = normalized.flatMap((n) => n.markets);
    expect(markets.length).toBeGreaterThan(0);
    expect(markets.every((m) => m.categories.length >= 1)).toBe(true);
    const skipReasons = normalized.flatMap((n) => n.skips.map((s) => s.reason));
    expect(skipReasons.filter((reason) => reason.startsWith("malformed"))).toEqual([]);
  });
});
