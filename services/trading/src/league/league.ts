/**
 * The PUBLIC league view and the PRIVATE portfolio view, both projected from one Valuation snapshot so the map, the
 * leaderboard and a player's own page always agree.
 *
 * Public data is deliberately coarse: country id, username, colour, slot, rank and a rounded relative size.
 * Exact Power, shares, fills and market choices never leave this module through the public projection.
 */
import type pg from "pg";
import type { LeagueSnapshot, PortfolioResponse } from "@league/trading-contract";
import { csToNumeric, divRoundHalfUp, formatDecimal, formatMicro } from "../trades/money.ts";
import type { PlayerValuation, Valuation } from "./valuation.ts";

/** Area weight unit: 0.01 of the 10,000 Power starting grant, in micro-Power. Weight 1.00 = a player who still has the grant. */
const AREA_WEIGHT_UNIT_MICRO = 100_000_000n;

/** Public relative size: this country's share of all Power, rounded half up to 0.1% (permille). */
export const RELATIVE_SIZE_PERMILLE = 1000n;

export function toLeagueSnapshot(valuation: Valuation): LeagueSnapshot {
  const sum = valuation.players.reduce((total, p) => total + p.totalMicro, 0n);
  return {
    asOf: valuation.computedAt.toISOString(),
    countries: valuation.players.map((p) => ({
      countryId: p.countryId,
      username: p.username,
      avatarKey: p.avatarKey,
      // Total Power in grant units, rounded half up to 0.01: coarse on purpose (about +-50 Power), never the exact balance.
      areaWeight: Number(divRoundHalfUp(p.totalMicro, AREA_WEIGHT_UNIT_MICRO)) / 100,
      color: countryColor(p.countrySeq),
      slot: p.countrySeq,
      rank: p.rank,
      relativeSize: sum === 0n ? 0 : Number(divRoundHalfUp(p.totalMicro * RELATIVE_SIZE_PERMILLE, sum)) / 1000,
    })),
  };
}

/**
 * A stable colour per country, derived only from its slot: successive slots step around the colour wheel by the
 * golden angle, so neighbours differ clearly and a country never changes colour. (Display only: not accounting.)
 */
export function countryColor(slot: number): string {
  const hue = (slot * 137.508) % 360;
  return hslToHex(hue, 0.62, 0.52);
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

interface FillRow {
  id: string;
  order_id: string;
  market_id: string;
  outcome: "YES" | "NO";
  side: "buy" | "sell";
  price: string;
  quantity: string;
  amount: string;
  quote_observed_at: Date;
  created_at: Date;
  question: string | null;
}

export const FILL_LIMIT = 50;

/** The caller's own portfolio. Pure read: it changes nothing. Null when the player has no account. */
export async function getPortfolio(pool: pg.Pool, valuation: Valuation, userId: string): Promise<PortfolioResponse | null> {
  const me: PlayerValuation | undefined = valuation.byUser.get(userId);
  if (!me) return null;

  const { rows } = await pool.query<FillRow>(
    `select f.id::text, f.order_id, f.market_id, f.outcome, f.side, f.price::text, f.quantity::text, f.amount::text,
            f.quote_observed_at, f.created_at,
            (select p.question from trading.positions p where p.account_id = f.account_id and p.token_id = f.token_id) as question
       from trading.fills f where f.account_id = $1 order by f.id desc limit $2`,
    [userId, FILL_LIMIT],
  );

  let unrealized = 0n;
  let realized = 0n;
  const positions = me.positions
    // Show open positions, settled ones, and fully sold ones that realized a gain or loss (their P&L still counts).
    .filter((p) => p.quantityCs > 0n || p.status === "settled" || p.realizedMicro !== 0n)
    .map((p) => {
      const open = p.status === "open";
      const pnl = open ? p.valueMicro - p.costBasisMicro : 0n;
      unrealized += pnl;
      realized += p.realizedMicro;
      return {
        marketId: p.marketId,
        question: p.question,
        outcome: p.outcome,
        status: p.status,
        quantity: csToNumeric(p.quantityCs),
        costBasis: formatMicro(p.costBasisMicro),
        averageCost: open && p.quantityCs > 0n ? formatMicro(divRoundHalfUp(p.costBasisMicro * 100n, p.quantityCs)) : null,
        mark: p.mark ? { price: formatMicro(p.mark.priceMicro), source: p.mark.source, asOf: p.mark.asOf, stale: p.mark.stale } : null,
        value: formatMicro(p.valueMicro),
        unrealizedPnl: formatMicro(pnl),
        realizedPnl: formatMicro(p.realizedMicro),
      };
    });

  return {
    asOf: valuation.computedAt.toISOString(),
    username: me.username,
    availablePower: formatMicro(me.cashMicro),
    reservedPower: formatDecimal(me.reservedMicro, 6),
    sharesValue: formatMicro(me.sharesValueMicro),
    totalPower: formatMicro(me.totalMicro),
    rank: me.rank,
    realizedPnl: formatMicro(realized),
    unrealizedPnl: formatMicro(unrealized),
    positions,
    fills: rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      marketId: row.market_id,
      question: row.question ?? "",
      outcome: row.outcome,
      side: row.side,
      price: row.price,
      quantity: row.quantity,
      amount: row.amount,
      quoteObservedAt: row.quote_observed_at.toISOString(),
      createdAt: row.created_at.toISOString(),
    })),
  };
}
