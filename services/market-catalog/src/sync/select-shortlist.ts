/**
 * Builds the catalog shortlist from the top events of each category. Pure function: no I/O.
 *
 * Two separate popularity decisions, because they rank different things:
 *   1. Which EVENTS: Gamma already sorted each category's events by event-level 24h volume.
 *      An event's volume is the sum over ALL its markets, so it says "this topic is hot".
 *   2. Which QUESTIONS inside an event: a hot event can hold dozens of markets
 *      (one live politics event had 58 open ones), most of them barely traded.
 *      We rank those by market-level 24h volume and keep the top few.
 */
import type { CategorySlug } from "@league/catalog-contract";
import type { MarketToPublish } from "../catalog/sync-run-store.ts";
import { normalizeGammaEvent, type NormalizedMarket, type SkipDiagnostic, type SkipReason } from "../polymarket/normalize-market.ts";

export const MARKETS_PER_EVENT = 2;

export interface CategoryListing {
  category: CategorySlug;
  events: unknown[];
  fetchedAt: Date;
}

export interface Shortlist {
  markets: MarketToPublish[];
  /** Distinct provider event IDs received across all categories (an event in both counts once). */
  uniqueEventsFetched: number;
  /** Distinct provider event IDs that contributed at least one question. */
  uniqueEventsSelected: number;
  questionsByCategory: Partial<Record<CategorySlug, number>>;
  skipCounts: Partial<Record<SkipReason, number>>;
  /** Up to 20 skips worth a human look (excludes the routine "not_open" case). */
  notableSkips: SkipDiagnostic[];
}

export function selectShortlist(listings: CategoryListing[], marketsPerEvent = MARKETS_PER_EVENT): Shortlist {
  const skipCounts: Shortlist["skipCounts"] = {};
  const notableSkips: SkipDiagnostic[] = [];
  const recordSkip = (skip: SkipDiagnostic) => {
    skipCounts[skip.reason] = (skipCounts[skip.reason] ?? 0) + 1;
    if (skip.reason !== "not_open" && notableSkips.length < 20) notableSkips.push(skip);
  };

  // Step 1: deduplicate events by provider ID. The same event can be top-10 in both categories;
  // it is kept once and simply gains both categories.
  const eventsById = new Map<string, { categories: Set<CategorySlug>; eligibleMarkets: NormalizedMarket[] }>();
  for (const listing of listings) {
    for (const rawEvent of listing.events) {
      const { markets, skips } = normalizeGammaEvent(rawEvent, listing.fetchedAt);
      const eventId = markets[0]?.providerEventId ?? skips[0]?.providerEventId ?? null;
      const alreadySeen = eventId !== null ? eventsById.get(eventId) : undefined;
      if (alreadySeen) {
        alreadySeen.categories.add(listing.category); // second sighting: don't double-count skips
        continue;
      }
      skips.forEach(recordSkip);
      if (eventId !== null) eventsById.set(eventId, { categories: new Set([listing.category]), eligibleMarkets: markets });
    }
  }

  // Step 2: inside each event, keep its most-traded eligible questions.
  const markets: MarketToPublish[] = [];
  const questionsByCategory: Shortlist["questionsByCategory"] = {};
  let uniqueEventsSelected = 0;
  for (const { categories, eligibleMarkets } of eventsById.values()) {
    const chosen = [...eligibleMarkets]
      .sort((a, b) => b.volume24hr - a.volume24hr || a.providerMarketId.localeCompare(b.providerMarketId)) // id = deterministic tie-break
      .slice(0, marketsPerEvent);
    if (chosen.length === 0) continue;

    uniqueEventsSelected++;
    const sortedCategories = [...categories].sort();
    for (const market of chosen) {
      markets.push({ ...market, categories: sortedCategories });
      for (const category of sortedCategories) questionsByCategory[category] = (questionsByCategory[category] ?? 0) + 1;
    }
  }

  return { markets, uniqueEventsFetched: eventsById.size, uniqueEventsSelected, questionsByCategory, skipCounts, notableSkips };
}
