import { describe, expect, it } from "vitest";
import { selectShortlist } from "../src/sync/select-shortlist.ts";
import { gammaEvent, gammaMarket } from "./support/gamma-builders.ts";

const fetchedAt = new Date("2026-11-20T12:00:00Z");

describe("selectShortlist (pure)", () => {
  it("keeps the two most-traded eligible questions per event, ignoring closed and missing-volume ones", () => {
    const event = gammaEvent({
      id: "100",
      markets: [
        gammaMarket({ id: "1", volume24hr: 50 }),
        gammaMarket({ id: "2", volume24hr: 9000 }),
        gammaMarket({ id: "3", volume24hr: 99_999, closed: true }), // most traded, but not eligible
        gammaMarket({ id: "4" }), // volume24hr missing -> ranked as 0
        gammaMarket({ id: "5", volume24hr: 700 }),
      ],
    });
    const result = selectShortlist([{ category: "politics", events: [event], fetchedAt }]);

    expect(result.markets.map((m) => m.providerMarketId)).toEqual(["2", "5"]);
    expect(result.uniqueEventsSelected).toBe(1);
    expect(result.skipCounts).toEqual({ not_open: 1 });
  });

  it("deduplicates an event that is top-10 in both categories and gives its questions both categories", () => {
    const shared = gammaEvent({ id: "300", markets: [gammaMarket({ id: "9", volume24hr: 10 })] });
    const result = selectShortlist([
      { category: "politics", events: [shared, gammaEvent({ id: "100", markets: [gammaMarket({ id: "1" })] })], fetchedAt },
      { category: "pop-culture", events: [shared], fetchedAt },
    ]);

    expect(result.uniqueEventsFetched).toBe(2);
    expect(result.markets.filter((m) => m.providerMarketId === "9")).toHaveLength(1);
    expect(result.markets.find((m) => m.providerMarketId === "9")?.categories).toEqual(["politics", "pop-culture"]);
    expect(result.questionsByCategory).toEqual({ politics: 2, "pop-culture": 1 });
  });

  it("does not select an event with no eligible question", () => {
    const result = selectShortlist([
      { category: "politics", events: [gammaEvent({ id: "1", markets: [gammaMarket({ outcomes: '["Up","Down"]' })] })], fetchedAt },
    ]);
    expect(result.markets).toEqual([]);
    expect(result.uniqueEventsFetched).toBe(1);
    expect(result.uniqueEventsSelected).toBe(0);
  });

  it("caps the shortlist at 20 events and 40 questions for two categories of 10 events", () => {
    const tenEvents = (prefix: string) =>
      Array.from({ length: 10 }, (_, e) =>
        gammaEvent({
          id: `${prefix}${e}`,
          markets: Array.from({ length: 5 }, (_, m) => gammaMarket({ id: `${prefix}${e}-${m}`, volume24hr: m })),
        }),
      );
    const result = selectShortlist([
      { category: "politics", events: tenEvents("p"), fetchedAt },
      { category: "pop-culture", events: tenEvents("c"), fetchedAt },
    ]);
    expect(result.uniqueEventsSelected).toBe(20);
    expect(result.markets).toHaveLength(40);
  });
});
