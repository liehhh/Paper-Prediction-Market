/**
 * One side-aware, in-memory order book for ONE outcome token (YES and NO each have their own).
 *
 * Prices and sizes arrive as decimal strings. They are held as scaled integers (BigInt, 8 decimals)
 * so levels compare and merge exactly, and are turned back into decimal strings only on the way out.
 * Pure data structure: no I/O, no clocks. Everything about freshness lives in book-feed.ts.
 */
import type { BookLevel } from "@league/catalog-contract";

const SCALE = 8;
const ONE = 10n ** BigInt(SCALE);

export class MalformedBookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedBookError";
  }
}

export interface RawLevel {
  price: string;
  size: string;
}

/** "0.5" -> 50000000n. Rejects anything that is not a plain non-negative decimal with <= 8 decimals. */
export function parseScaled(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d{1,14}(\.\d{1,8})?$/.test(value)) throw new MalformedBookError(`bad decimal: ${String(value).slice(0, 30)}`);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * ONE + BigInt(fraction.padEnd(SCALE, "0"));
}

/** 50000000n -> "0.5"; 100000000n -> "1". Trailing zeros are trimmed. */
export function formatScaled(value: bigint): string {
  const whole = value / ONE;
  const fraction = (value % ONE).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

export class OrderBook {
  private bids = new Map<bigint, bigint>(); // price -> size
  private asks = new Map<bigint, bigint>();

  /** Replaces the whole book with a snapshot. Throws (and leaves the old book untouched) if any level is malformed. */
  replace(bids: readonly RawLevel[], asks: readonly RawLevel[]): void {
    const nextBids = toMap(bids);
    const nextAsks = toMap(asks);
    this.bids = nextBids;
    this.asks = nextAsks;
  }

  /** Applies one `price_change`: the level's new TOTAL size at that price (0 removes the level). */
  applyChange(side: "BUY" | "SELL", price: string, size: string): void {
    const p = parseScaled(price);
    const s = parseScaled(size);
    if (p <= 0n || p > ONE) throw new MalformedBookError("price outside (0, 1]");
    const levels = side === "BUY" ? this.bids : this.asks;
    if (s === 0n) levels.delete(p);
    else levels.set(p, s);
  }

  /** Best-first: bids from the highest price, asks from the lowest. */
  levels(): { bids: BookLevel[]; asks: BookLevel[] } {
    const sorted = (levels: Map<bigint, bigint>, descending: boolean) =>
      [...levels.entries()]
        .sort(([a], [b]) => (a === b ? 0 : (a < b) !== descending ? -1 : 1))
        .map(([price, size]) => ({ price: formatScaled(price), size: formatScaled(size) }));
    return { bids: sorted(this.bids, true), asks: sorted(this.asks, false) };
  }

  bestBid(): bigint | null {
    return extreme(this.bids, "max");
  }
  bestAsk(): bigint | null {
    return extreme(this.asks, "min");
  }

  /**
   * A real book never has a bid at or above the best ask (the matching engine would have traded them).
   * Seeing one means we missed an update, so the book cannot be trusted until a fresh snapshot replaces it.
   */
  isConsistent(): boolean {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    return bid === null || ask === null || bid < ask;
  }
}

function toMap(levels: readonly RawLevel[]): Map<bigint, bigint> {
  const map = new Map<bigint, bigint>();
  for (const level of levels) {
    const price = parseScaled(level.price);
    const size = parseScaled(level.size);
    if (price <= 0n || price > ONE) throw new MalformedBookError("price outside (0, 1]");
    if (size > 0n) map.set(price, size);
  }
  return map;
}

function extreme(levels: Map<bigint, bigint>, which: "min" | "max"): bigint | null {
  let best: bigint | null = null;
  for (const price of levels.keys()) if (best === null || (which === "min" ? price < best : price > best)) best = price;
  return best;
}
