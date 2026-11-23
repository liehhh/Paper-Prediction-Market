import { describe, expect, it } from "vitest";
import { formatScaled, MalformedBookError, OrderBook, parseScaled } from "../src/orderbook/order-book.ts";

describe("decimal helpers", () => {
  it("round-trips exactly", () => {
    expect(formatScaled(parseScaled("0.5"))).toBe("0.5");
    expect(formatScaled(parseScaled("0.001"))).toBe("0.001");
    expect(formatScaled(parseScaled("1"))).toBe("1");
    expect(formatScaled(parseScaled("163939.58"))).toBe("163939.58");
  });
  it("rejects anything that is not a plain decimal", () => {
    for (const bad of ["", "-1", "1e3", "NaN", "0x1", " 1", "1.123456789", 5 as unknown as string]) expect(() => parseScaled(bad)).toThrow(MalformedBookError);
  });
});

describe("OrderBook", () => {
  it("sorts bids high-to-low and asks low-to-high regardless of arrival order", () => {
    const book = new OrderBook();
    book.replace(
      [{ price: "0.48", size: "30" }, { price: "0.50", size: "15" }, { price: "0.49", size: "20" }],
      [{ price: "0.54", size: "10" }, { price: "0.52", size: "25" }, { price: "0.53", size: "5" }],
    );
    const { bids, asks } = book.levels();
    expect(bids.map((l) => l.price)).toEqual(["0.5", "0.49", "0.48"]);
    expect(asks.map((l) => l.price)).toEqual(["0.52", "0.53", "0.54"]);
    expect(book.isConsistent()).toBe(true);
  });

  it("price_change sets a level's TOTAL size, and size 0 removes the level", () => {
    const book = new OrderBook();
    book.replace([{ price: "0.5", size: "100" }], [{ price: "0.6", size: "100" }]);
    book.applyChange("BUY", "0.5", "40");
    book.applyChange("SELL", "0.6", "0");
    book.applyChange("SELL", "0.7", "9");
    expect(book.levels().bids).toEqual([{ price: "0.5", size: "40" }]);
    expect(book.levels().asks).toEqual([{ price: "0.7", size: "9" }]);
  });

  it("a bid at or above the best ask means we missed an update", () => {
    const book = new OrderBook();
    book.replace([{ price: "0.5", size: "1" }], [{ price: "0.6", size: "1" }]);
    book.applyChange("BUY", "0.6", "1");
    expect(book.isConsistent()).toBe(false);
  });

  it("a malformed snapshot throws and leaves the previous book untouched", () => {
    const book = new OrderBook();
    book.replace([{ price: "0.5", size: "1" }], []);
    expect(() => book.replace([{ price: "abc", size: "1" }], [])).toThrow(MalformedBookError);
    expect(book.levels().bids).toEqual([{ price: "0.5", size: "1" }]);
  });

  it("rejects prices outside (0, 1]", () => {
    const book = new OrderBook();
    expect(() => book.replace([{ price: "0", size: "1" }], [])).toThrow(MalformedBookError);
    expect(() => book.replace([], [{ price: "1.5", size: "1" }])).toThrow(MalformedBookError);
  });
});
