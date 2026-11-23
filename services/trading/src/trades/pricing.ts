/**
 * Prices a paper trade by walking the executable side of an order book. Pure functions: no I/O, no clocks.
 *
 *   BUY  walks the ASKS, cheapest first.   SELL walks the BIDS, highest first.
 *   A buy spends at most the budget; unspent Power (rounding dust) simply stays in the player's balance.
 *
 * PAPER-LIQUIDITY POLICY (one policy, applied identically to preview and execution):
 *   Every player has an independent portfolio: other players' paper trades never consume the quantity you see.
 *   Within YOUR portfolio, the quantity you can fill at one price level is the level's displayed size MINUS what you
 *   yourself already filled at that exact (token, side, price) in the last 5 minutes (CONSUMPTION_WINDOW_SECONDS).
 *   So re-submitting orders against an unchanged quote cannot consume the same displayed shares again and again;
 *   the same shares become available to you again only after the window passes (or once the real displayed size
 *   grows). Level sizes are floored to whole hundredths of a share.
 */
import type { BookLevel } from "@league/catalog-contract";
import { costMicro, CS_PER_SHARE, divRoundHalfUp, parseDecimal } from "./money.ts";

export const CONSUMPTION_WINDOW_SECONDS = 300;

export interface Level {
  priceMicro: bigint;
  /** Displayed size floored to centishares. */
  sizeCs: bigint;
}
export interface Fill {
  priceMicro: bigint;
  quantityCs: bigint;
  amountMicro: bigint;
}
/** Centishares this player already filled at each price (same token and side, inside the window). */
export type Consumed = ReadonlyMap<bigint, bigint>;

export interface Walk {
  fills: Fill[];
  quantityCs: bigint;
  amountMicro: bigint;
}
export type WalkResult = ({ ok: true } & Walk) | { ok: false; reason: "insufficient_depth" | "budget_too_small"; availableCs: bigint };

/** Parses book levels. Throws for a price finer than 0.0001 or outside (0, 1]: a malformed book is never traded. */
export function toLevels(levels: readonly BookLevel[]): Level[] {
  return levels.map((level) => {
    const priceMicro = parseDecimal(level.price, 6);
    if (priceMicro <= 0n || priceMicro > 1_000_000n || priceMicro % 100n !== 0n) throw new RangeError(`unsupported price ${level.price}`);
    return { priceMicro, sizeCs: parseDecimal(level.size, 6) / 10_000n }; // 1e-6 -> 1e-2, floored
  });
}

const room = (level: Level, consumed: Consumed): bigint => {
  const left = level.sizeCs - (consumed.get(level.priceMicro) ?? 0n);
  return left > 0n ? left : 0n;
};

/** Total centishares this player could fill right now on this side. */
export function availableDepthCs(levels: readonly Level[], consumed: Consumed): bigint {
  return levels.reduce((sum, level) => sum + room(level, consumed), 0n);
}

/** Cost in micro of one centishare at a price (the smallest purchase), rounded up. */
const smallestPurchaseMicro = (priceMicro: bigint): bigint => (priceMicro + CS_PER_SHARE - 1n) / CS_PER_SHARE;

/** BUY with a Power budget: as many shares as the budget buys across the asks (best first). */
export function buyWithBudget(asks: readonly Level[], budgetMicro: bigint, consumed: Consumed): WalkResult {
  const fills: Fill[] = [];
  let remaining = budgetMicro;
  let endedByBudget = false;
  for (const level of asks) {
    const available = room(level, consumed);
    if (available === 0n) continue;
    const affordable = (remaining * CS_PER_SHARE) / level.priceMicro; // whole centishares the remaining budget buys here
    if (affordable === 0n) {
      endedByBudget = true; // asks only get pricier, so the budget (not the book) ended the walk
      break;
    }
    const take = affordable < available ? affordable : available;
    const amountMicro = costMicro(level.priceMicro, take);
    fills.push({ priceMicro: level.priceMicro, quantityCs: take, amountMicro });
    remaining -= amountMicro;
    if (take === affordable) {
      endedByBudget = true; // budget used up as far as this level allows
      break;
    }
  }
  const availableCs = availableDepthCs(asks, consumed);
  const quantityCs = fills.reduce((sum, fill) => sum + fill.quantityCs, 0n);
  if (quantityCs === 0n) return { ok: false, reason: availableCs === 0n ? "insufficient_depth" : "budget_too_small", availableCs };
  // The book ran out while the leftover budget could still buy more at the dearest ask. The order cannot be filled
  // in full and partial fills are out of scope, so refuse instead of silently under-filling.
  if (!endedByBudget && remaining >= smallestPurchaseMicro(asks.at(-1)?.priceMicro ?? 1_000_000n)) {
    return { ok: false, reason: "insufficient_depth", availableCs };
  }
  return { ok: true, fills, quantityCs, amountMicro: fills.reduce((sum, fill) => sum + fill.amountMicro, 0n) };
}

/** Exactly `quantityCs` shares, all-or-nothing: from asks for a buy, from bids for a sell. Levels best first. */
export function fillQuantity(levels: readonly Level[], quantityCs: bigint, consumed: Consumed): WalkResult {
  const fills: Fill[] = [];
  let remaining = quantityCs;
  for (const level of levels) {
    if (remaining === 0n) break;
    const available = room(level, consumed);
    if (available === 0n) continue;
    const take = remaining < available ? remaining : available;
    fills.push({ priceMicro: level.priceMicro, quantityCs: take, amountMicro: costMicro(level.priceMicro, take) });
    remaining -= take;
  }
  if (remaining > 0n) return { ok: false, reason: "insufficient_depth", availableCs: availableDepthCs(levels, consumed) };
  return { ok: true, fills, quantityCs, amountMicro: fills.reduce((sum, fill) => sum + fill.amountMicro, 0n) };
}

/** Average price per share in micro, rounded half up. Display only: accounting uses the exact fill amounts. */
export function averagePriceMicro(amountMicro: bigint, quantityCs: bigint): bigint {
  return divRoundHalfUp(amountMicro * CS_PER_SHARE, quantityCs);
}
