import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeGammaEvent } from "../src/polymarket/normalize-market.ts";
import { gammaEvent, gammaMarket } from "./support/gamma-builders.ts";

const fetchedAt = new Date("2026-11-20T12:00:00Z");

describe("normalizeGammaEvent with a recorded Gamma page (fixture)", () => {
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/gamma-events-page.recorded.json", import.meta.url), "utf8")) as {
    page: { events: unknown[] };
  };
  const results = recorded.page.events.map((event) => normalizeGammaEvent(event, fetchedAt));
  const markets = results.flatMap((r) => r.markets);
  const skips = results.flatMap((r) => r.skips);

  it("imports each open nested market and skips closed ones inside open events", () => {
    expect(markets).toHaveLength(10);
    expect(skips).toHaveLength(3);
    expect(skips.every((s) => s.reason === "not_open")).toBe(true);
    // "Taylor Swift pregnant in 2025?" is closed although its parent event is open.
    expect(skips.map((s) => s.providerMarketId)).toContain("535013");
  });

  it("decodes JSON-encoded outcomes and prices and maps them by position", () => {
    const musk = markets.find((m) => m.providerMarketId === "676937")!;
    expect(musk).toMatchObject({
      question: "Will Elon Musk be richest person on December 31?",
      providerEventId: "79090",
      eventTitle: "Richest person on December 31, 2026?",
      outcomeLabels: ["Yes", "No"],
      snapshotPrices: { yes: 0.976, no: 0.024 },
      sourceUrl: "https://polymarket.com/event/richest-person-on-december-31-2026",
    });
    expect(musk.expectedEndAt?.toISOString()).toBe("2027-01-03T04:59:00.000Z");
  });
});

describe("normalizeGammaEvent with representative edge cases (hand-written)", () => {
  const normalizeOne = (market: Record<string, unknown>, event: Record<string, unknown> = {}) =>
    normalizeGammaEvent(gammaEvent({ markets: [gammaMarket(market)], ...event }), fetchedAt);

  it("maps prices by position when outcomes are listed No-first", () => {
    const { markets } = normalizeOne({ outcomes: '["No", "Yes"]', outcomePrices: '["0.9", "0.1"]' });
    expect(markets[0]?.snapshotPrices).toEqual({ yes: 0.1, no: 0.9 });
    expect(markets[0]?.outcomeLabels).toEqual(["No", "Yes"]);
  });

  it("accepts real JSON arrays as well as JSON-encoded strings", () => {
    const { markets } = normalizeOne({ outcomes: ["Yes", "No"], outcomePrices: [0.4, 0.6] });
    expect(markets[0]?.snapshotPrices).toEqual({ yes: 0.4, no: 0.6 });
  });

  it("keeps a market without prices, with no snapshot instead of invented numbers", () => {
    const { markets, skips } = normalizeOne({ outcomePrices: null });
    expect(skips).toEqual([]);
    expect(markets[0]?.snapshotPrices).toBeNull();
  });

  it("treats an open market whose outcomePrices key is absent as having no snapshot", () => {
    const { markets } = normalizeOne({ outcomePrices: undefined });
    expect(markets[0]?.snapshotPrices).toBeNull();
  });

  it("skips an inactive placeholder market without prices as not_open, not malformed", () => {
    // Shape observed live on 2026-11-20 (market 559710, "Will Person AC win ...?").
    const placeholder = gammaMarket({ question: "Will Person AC win?", active: false, outcomePrices: undefined });
    delete placeholder.outcomePrices;
    const { skips } = normalizeGammaEvent(gammaEvent({ markets: [placeholder] }), fetchedAt);
    expect(skips[0]?.reason).toBe("not_open");
  });

  it.each([
    ["non-binary outcomes", { outcomes: '["Labour", "National"]' }, "not_binary_yes_no"],
    ["three outcomes", { outcomes: '["Yes", "No", "Maybe"]', outcomePrices: '["0.3","0.3","0.4"]' }, "not_binary_yes_no"],
    ["outcomes that are not JSON", { outcomes: "Yes,No" }, "malformed_outcomes"],
    ["fewer prices than outcomes", { outcomePrices: '["0.5"]' }, "malformed_prices"],
    ["a price above 1", { outcomePrices: '["1.5", "0.5"]' }, "malformed_prices"],
    ["a non-numeric price", { outcomePrices: '["abc", "0.5"]' }, "malformed_prices"],
    ["an empty question", { question: "  " }, "missing_question"],
    ["an unparseable end date", { endDate: "next tuesday" }, "malformed_end_date"],
    ["a market that no longer accepts orders", { acceptingOrders: false }, "not_open"],
    ["a market without an id", { id: undefined }, "malformed_market"],
  ])("skips %s with a diagnostic", (_label, overrides, reason) => {
    const { markets, skips } = normalizeOne(overrides);
    expect(markets).toEqual([]);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ reason, providerEventId: "501" });
    expect(skips[0]?.detail).toBeTruthy();
  });

  it("skips a malformed event without throwing", () => {
    const { markets, skips } = normalizeGammaEvent({ title: "no id", markets: [gammaMarket()] }, fetchedAt);
    expect(markets).toEqual([]);
    expect(skips[0]?.reason).toBe("malformed_event");
  });

  it("falls back to the question when the event title is empty, and omits unsafe source links", () => {
    const { markets } = normalizeOne({}, { title: "", slug: "../../evil" });
    expect(markets[0]?.eventTitle).toBe("Will the test pass?");
    expect(markets[0]?.sourceUrl).toBeNull();
  });
});
