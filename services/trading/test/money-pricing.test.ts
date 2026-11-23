/** Pure unit tests: fixed-point math, book walking, the paper-liquidity rule and the valuation rule. */
import { describe, expect, it } from "vitest";
import { costMicro, csToNumeric, divRoundHalfUp, formatMicro, InvalidDecimalError, numericToCs, parseMicro, parseSharesInput } from "../src/trades/money.ts";
import { averagePriceMicro, buyWithBudget, fillQuantity, toLevels } from "../src/trades/pricing.ts";
import { countryColor, toLeagueSnapshot } from "../src/league/league.ts";
import { markPosition, type BookView, type PlayerValuation, type Valuation } from "../src/league/valuation.ts";

const levels = (rows: Array<[string, string]>) => toLevels(rows.map(([price, size]) => ({ price, size })));
const none = new Map<bigint, bigint>();

describe("money", () => {
  it("parses and formats exactly, never through floats", () => {
    expect(formatMicro(parseMicro("10000"))).toBe("10000.000000");
    expect(formatMicro(parseMicro("0.1") + parseMicro("0.2"))).toBe("0.300000");
    expect(formatMicro(-parseMicro("12.5"))).toBe("-12.500000");
  });
  it("rejects malformed and over-precise input", () => {
    for (const bad of ["", "-1", "1e3", "0x10", "1.1234567", "abc", " 5"]) expect(() => parseMicro(bad)).toThrow(InvalidDecimalError);
    expect(() => parseSharesInput("1.234")).toThrow(InvalidDecimalError);
    expect(parseSharesInput("12.5")).toBe(1250n);
  });
  it("share quantities round-trip through numeric(20, 6) text", () => {
    expect(csToNumeric(400000n)).toBe("4000.000000");
    expect(numericToCs("4000.000000")).toBe(400000n);
    expect(() => numericToCs("0.001000")).toThrow(InvalidDecimalError);
  });
  it("cost is exact at 4-decimal prices and refuses finer ones", () => {
    expect(costMicro(500_000n, 400000n)).toBe(2_000_000_000n); // 4000 shares at 0.50 = 2000 Power
    expect(costMicro(1_230n * 100n, 1n)).toBe(1230n);
    expect(() => costMicro(500_001n, 1n)).toThrow(InvalidDecimalError);
  });
  it("rounds half up", () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
    expect(divRoundHalfUp(1n, 3n)).toBe(0n);
  });
});

describe("buyWithBudget (walks the asks)", () => {
  it("spends the budget across levels, cheapest first, and reports average price", () => {
    const asks = levels([["0.50", "1000"], ["0.60", "5000"]]);
    const result = buyWithBudget(asks, parseMicro("1000"), none);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 1000 shares at 0.50 = 500, then the remaining 500 buys 833.33 shares at 0.60 (499.998 spent).
    expect(result.fills.map((f) => [formatMicro(f.priceMicro), csToNumeric(f.quantityCs)])).toEqual([
      ["0.500000", "1000.000000"],
      ["0.600000", "833.330000"],
    ]);
    expect(formatMicro(result.amountMicro)).toBe("999.998000");
    expect(formatMicro(averagePriceMicro(result.amountMicro, result.quantityCs))).toBe("0.545454");
  });

  it("unspent Power is only the leftover that cannot buy a whole hundredth of a share", () => {
    const result = buyWithBudget(levels([["0.33", "100000"]]), parseMicro("100"), none);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(csToNumeric(result.quantityCs)).toBe("303.030000"); // 303.03 shares cost 99.9999
    expect(formatMicro(result.amountMicro)).toBe("99.999900");
    expect(parseMicro("100") - result.amountMicro).toBe(100n); // 0.0001 Power stays in the balance
  });

  it("refuses when the book runs out before the budget does (all-or-nothing)", () => {
    const result = buyWithBudget(levels([["0.50", "1000"]]), parseMicro("2000"), none);
    expect(result).toMatchObject({ ok: false, reason: "insufficient_depth" });
  });

  it("a budget too small for 0.01 share is its own error", () => {
    expect(buyWithBudget(levels([["0.50", "1000"]]), parseMicro("0.004"), none)).toMatchObject({ ok: false, reason: "budget_too_small" });
  });

  it("an empty side of the book cannot be bought from", () => {
    expect(buyWithBudget([], parseMicro("10"), none)).toMatchObject({ ok: false, reason: "insufficient_depth" });
  });
});

describe("fillQuantity (sells, and confirmation of a previewed quantity)", () => {
  it("walks the bids best first", () => {
    const bids = levels([["0.65", "300"], ["0.60", "1000"]]);
    const result = fillQuantity(bids, 50000n, none);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(formatMicro(result.amountMicro)).toBe("315.000000"); // 300 * 0.65 + 200 * 0.60
  });
  it("is all-or-nothing", () => {
    expect(fillQuantity(levels([["0.65", "300"]]), 40000n, none)).toMatchObject({ ok: false, reason: "insufficient_depth", availableCs: 30000n });
  });
});

describe("paper-liquidity policy: the same displayed shares cannot be consumed again within your portfolio", () => {
  it("subtracts what this player already filled at that price", () => {
    const asks = levels([["0.50", "5000"]]);
    const consumed = new Map([[500_000n, 400000n]]); // already took 4000 at 0.50
    expect(fillQuantity(asks, 400000n, consumed)).toMatchObject({ ok: false, availableCs: 100000n });
    expect(fillQuantity(asks, 100000n, consumed).ok).toBe(true);
  });
  it("another price level is unaffected", () => {
    const asks = levels([["0.50", "100"], ["0.51", "100"]]);
    const consumed = new Map([[500_000n, 10000n]]);
    const result = fillQuantity(asks, 10000n, consumed);
    expect(result.ok && result.fills.map((f) => formatMicro(f.priceMicro))).toEqual(["0.510000"]);
  });
});

describe("valuation rule", () => {
  const book = (bids: Array<[string, string]>, asks: Array<[string, string]>, live = true): BookView => ({
    bids: levels(bids),
    asks: levels(asks),
    live,
    observedAt: "2026-11-23T12:00:00.000Z",
  });
  const args = { lastMarkMicro: null, lastMarkAt: null, costPerShareMicro: 500_000n };

  it("tight spread: midpoint", () => {
    expect(markPosition({ ...args, book: book([["0.64", "1"]], [["0.66", "1"]]) })).toMatchObject({ priceMicro: 650_000n, source: "mid", stale: false });
  });
  it("zero spread: that price, so buying at it changes nothing", () => {
    expect(markPosition({ ...args, book: book([["0.5", "1"]], [["0.5", "1"]]) }).priceMicro).toBe(500_000n);
  });
  it("wide spread (> 0.10): the best bid, never a flattering midpoint", () => {
    expect(markPosition({ ...args, book: book([["0.30", "1"]], [["0.70", "1"]]) })).toMatchObject({ priceMicro: 300_000n, source: "bid" });
  });
  it("spread of exactly 0.10 still counts as tight", () => {
    expect(markPosition({ ...args, book: book([["0.45", "1"]], [["0.55", "1"]]) })).toMatchObject({ priceMicro: 500_000n, source: "mid" });
  });
  it("only bids: the best bid", () => {
    expect(markPosition({ ...args, book: book([["0.40", "1"]], []) })).toMatchObject({ priceMicro: 400_000n, source: "bid" });
  });
  it("no bid: carries the last known valuation forward", () => {
    expect(markPosition({ book: book([], [["0.7", "1"]]), lastMarkMicro: 610_000n, lastMarkAt: "2026-11-23T11:00:00.000Z", costPerShareMicro: 500_000n })).toMatchObject({
      priceMicro: 610_000n,
      source: "last_known",
      stale: true,
      asOf: "2026-11-23T11:00:00.000Z",
    });
  });
  it("never valued: average cost, so no invented gain or loss", () => {
    expect(markPosition({ ...args, book: null })).toMatchObject({ priceMicro: 500_000n, source: "cost_basis", stale: true });
  });
  it("a stale book still values from its last known prices, flagged stale with its own time", () => {
    expect(markPosition({ ...args, book: book([["0.64", "1"]], [["0.66", "1"]], false) })).toMatchObject({ priceMicro: 650_000n, stale: true, asOf: "2026-11-23T12:00:00.000Z" });
  });
});

describe("league projection (public data only)", () => {
  const player = (seq: number, username: string, totalMicro: bigint): PlayerValuation => ({
    userId: `00000000-0000-4000-8000-00000000000${seq}`,
    username,
    countryId: `10000000-0000-4000-8000-00000000000${seq}`,
    avatarKey: null,
    countrySeq: seq,
    cashMicro: totalMicro,
    reservedMicro: 0n,
    positions: [],
    sharesValueMicro: 0n,
    totalMicro,
    rank: 0,
  });
  const valuation = (players: PlayerValuation[]): Valuation => ({ computedAt: new Date("2026-11-23T12:00:00Z"), players, byUser: new Map() });

  it("equal totals share a rank and a size; display order is stable", () => {
    const snapshot = toLeagueSnapshot(valuation([{ ...player(1, "ada", 10_000_000_000n), rank: 1 }, { ...player(2, "bob", 10_000_000_000n), rank: 1 }]));
    expect(snapshot.countries.map((c) => [c.username, c.rank, c.relativeSize])).toEqual([["ada", 1, 0.5], ["bob", 1, 0.5]]);
  });
  it("exposes only coarse public fields", () => {
    const snapshot = toLeagueSnapshot(valuation([{ ...player(1, "ada", 10_600_000_000n), rank: 1 }, { ...player(2, "bob", 10_000_000_000n), rank: 2 }]));
    expect(Object.keys(snapshot.countries[0]!).sort()).toEqual(["areaWeight", "avatarKey", "color", "countryId", "rank", "relativeSize", "slot", "username"]);
    expect(snapshot.countries.map((c) => c.relativeSize)).toEqual([0.515, 0.485]); // ~6% more share
    expect(JSON.stringify(snapshot)).not.toMatch(/userId|cash|total|balance|shares/i);
  });
  it("area weight is total Power in starting-grant units rounded to 0.01: 10,600 vs 10,000 is 1.06 vs 1.00", () => {
    const snapshot = toLeagueSnapshot(valuation([{ ...player(1, "ada", 10_600_000_000n), rank: 1 }, { ...player(2, "bob", 10_000_000_000n), rank: 2 }]));
    expect(snapshot.countries.map((c) => c.areaWeight)).toEqual([1.06, 1]);
    // Circle area is proportional to weight, so the ratio of areas is the ratio of weights: 6% more.
    expect(snapshot.countries[0]!.areaWeight / snapshot.countries[1]!.areaWeight).toBeCloseTo(1.06, 10);
    // Rounded coarsely: 10,600.49 and 10,599.51 are the same public weight, so the exact balance cannot be read back.
    const near = toLeagueSnapshot(valuation([{ ...player(1, "a", 10_600_490_000n), rank: 1 }, { ...player(2, "b", 10_599_510_000n), rank: 1 }]));
    expect(near.countries.map((c) => c.areaWeight)).toEqual([1.06, 1.06]);
  });

  it("colours are stable per slot and distinct for neighbours", () => {
    expect(countryColor(1)).toBe(countryColor(1));
    expect(new Set([1, 2, 3, 4, 5, 6].map(countryColor)).size).toBe(6);
    expect(countryColor(7)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
