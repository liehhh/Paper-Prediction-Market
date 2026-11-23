/**
 * Total Power, calculated ONCE on the server:
 *
 *   total Power = available Power + Power reserved for open buys + marked value of every owned share
 *
 * Reserved Power is zero in this milestone (orders fill immediately). When sell reservations arrive, reserved
 * SHARES stay inside "owned shares", so a share is counted exactly once: in the marked value, never also as cash.
 *
 * VALUATION RULE (one rule; execution prices are a different thing and never used here):
 *   Each position is valued with the book of ITS OWN outcome token, per share:
 *     1. both sides present and the spread is at most 0.10  -> the midpoint of best bid and best ask;
 *     2. a wider spread, or only bids                       -> the best bid (what the shares could be sold for);
 *     3. no bid at all (empty or asks-only book)            -> carry forward the last known valuation;
 *     4. never valued yet                                   -> the position's average cost (so a new, unvalued
 *                                                              position never shows an invented gain or loss).
 *   If the book is not live (stale, recovering or disconnected), rule 1-3 still run on the last known book, but the
 *   mark is flagged `stale` and carries the book's own timestamp: the last known valuation stays visible, dated.
 *   Consequence: buying at an ask that is above the midpoint lowers total Power immediately by the half-spread.
 *   When the fill price equals the valuation price (a zero-spread book) the act of buying alone leaves total
 *   Power unchanged.
 *
 * All arithmetic is BigInt micro-Power; each position's value is rounded half up to micro.
 */
import type pg from "pg";
import type { QuoteResponse } from "@league/catalog-contract";
import type { Mark, Outcome } from "@league/trading-contract";
import { CatalogUnavailableError, type CatalogPort } from "../catalog-client.ts";
import { divRoundHalfUp, formatMicro, numericToCs, parseMicro, parseSignedMicro } from "../trades/money.ts";
import { toLevels, type Level } from "../trades/pricing.ts";

export const WIDE_SPREAD_MICRO = 100_000n; // 0.10
/** A cached valuation up to this old is served instantly while a refresh runs in the background. */
const MAX_SERVED_STALE_MS = 30_000;
const MARK_PERSIST_MIN_MOVE_MICRO = 5_000n; // 0.005
const MARK_PERSIST_MAX_AGE_MS = 5 * 60_000;

export interface BookView {
  bids: Level[];
  asks: Level[];
  live: boolean;
  observedAt: string | null;
}

export interface MarkResult {
  priceMicro: bigint;
  source: Mark["source"];
  asOf: string | null;
  stale: boolean;
}

/** Rules 1-4 above. Pure. */
export function markPosition(args: { book: BookView | null; lastMarkMicro: bigint | null; lastMarkAt: string | null; costPerShareMicro: bigint }): MarkResult {
  const { book } = args;
  if (book) {
    const bid = book.bids[0]?.priceMicro;
    const ask = book.asks[0]?.priceMicro;
    if (bid !== undefined) {
      const tight = ask !== undefined && ask - bid <= WIDE_SPREAD_MICRO && ask >= bid;
      return {
        priceMicro: tight ? divRoundHalfUp(bid + ask, 2n) : bid,
        source: tight ? "mid" : "bid",
        asOf: book.observedAt,
        stale: !book.live,
      };
    }
  }
  if (args.lastMarkMicro !== null) return { priceMicro: args.lastMarkMicro, source: "last_known", asOf: args.lastMarkAt, stale: true };
  return { priceMicro: args.costPerShareMicro, source: "cost_basis", asOf: null, stale: true };
}

export interface PositionValuation {
  tokenId: string;
  marketId: string;
  question: string;
  outcome: Outcome;
  status: "open" | "settled";
  quantityCs: bigint;
  costBasisMicro: bigint;
  realizedMicro: bigint;
  mark: MarkResult | null;
  valueMicro: bigint;
}

export interface PlayerValuation {
  userId: string;
  username: string;
  countryId: string;
  avatarKey: string | null;
  countrySeq: number;
  cashMicro: bigint;
  reservedMicro: bigint;
  positions: PositionValuation[];
  sharesValueMicro: bigint;
  totalMicro: bigint;
  /** Competition ranking: equal totals share a rank (1, 2, 2, 4). */
  rank: number;
}

export interface Valuation {
  computedAt: Date;
  /** Display order: total descending, then country slot ascending (stable). */
  players: PlayerValuation[];
  byUser: Map<string, PlayerValuation>;
}

interface AccountRow {
  user_id: string;
  username: string;
  country_id: string;
  avatar_key: string | null;
  country_seq: string;
  cash: string;
}
interface PositionRow {
  account_id: string;
  token_id: string;
  market_id: string;
  outcome: Outcome;
  question: string;
  quantity: string;
  cost_basis: string;
  realized_pnl: string;
  status: "open" | "settled";
  last_mark: string | null;
  /** An ISO timestamp (this row arrives inside a JSON document). */
  last_mark_at: string | null;
}

export class ValuationService {
  private readonly deps: { pool: pg.Pool; catalog: CatalogPort; now?: () => number; ttlMs?: number; log?: (message: string) => void };
  private cached: { at: number; value: Valuation } | null = null;
  private inflight: Promise<Valuation> | null = null;
  private dirty = false;

  constructor(deps: { pool: pg.Pool; catalog: CatalogPort; now?: () => number; ttlMs?: number; log?: (message: string) => void }) {
    this.deps = deps;
  }

  /** A trade or settlement committed: the next read recomputes. */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * The current valuation. Never writes marks.
   *  - right after a trade or settlement (dirty): recomputed first, because the trader must see their own trade;
   *  - fresh (under the TTL): served from memory;
   *  - a little old (under 30 s): served from memory at once, and refreshed in the background, so an ordinary page view
   *    never waits for the database round trips (the 15 s background worker keeps it this fresh anyway);
   *  - older, or never computed: computed now.
   * ttlMs of 0 turns caching off (used by tests that need every read to be recomputed).
   */
  async snapshot(): Promise<Valuation> {
    const now = (this.deps.now ?? Date.now)();
    const ttl = this.deps.ttlMs ?? 5_000;
    const cached = this.cached;
    if (cached && !this.dirty && ttl > 0) {
      const age = now - cached.at;
      if (age < ttl) return cached.value;
      if (age < MAX_SERVED_STALE_MS) {
        void this.refresh(false).catch((error) => this.deps.log?.(`valuation: background refresh failed: ${error instanceof Error ? error.message : error}`));
        return cached.value;
      }
    }
    return this.refresh(false);
  }

  /** Recomputes now. Concurrent callers share one computation. `persistMarks` is for the background worker only. */
  refresh(persistMarks: boolean): Promise<Valuation> {
    if (this.inflight) return this.inflight;
    this.dirty = false;
    const run = this.compute(persistMarks)
      .then((value) => {
        this.cached = { at: (this.deps.now ?? Date.now)(), value };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    this.inflight = run;
    return run;
  }

  private async compute(persistMarks: boolean): Promise<Valuation> {
    const { accounts, positions } = await this.readState();

    // Quotes for every market someone holds. "pin" keeps them tracked even if nobody is viewing them.
    const marketIds = [...new Set(positions.filter((p) => p.status === "open" && parseMicro(p.quantity) > 0n).map((p) => p.market_id))];
    const books = new Map<string, BookView>(); // by token id
    if (marketIds.length > 0) {
      try {
        for (let start = 0; start < marketIds.length; start += 200) {
          for (const quote of await this.deps.catalog.quotes(marketIds.slice(start, start + 200), "pin")) addBooks(books, quote);
        }
      } catch (error) {
        if (!(error instanceof CatalogUnavailableError)) throw error;
        this.deps.log?.(`valuation: live prices unavailable, using last known marks (${error.message})`);
      }
    }

    const players: PlayerValuation[] = accounts.map((account) => {
      const mine = positions.filter((p) => p.account_id === account.user_id);
      const valued = mine.map((row) => valuePosition(row, books.get(row.token_id) ?? null));
      const cashMicro = parseSignedMicro(account.cash);
      const sharesValueMicro = valued.reduce((sum, p) => sum + p.valueMicro, 0n);
      return {
        userId: account.user_id,
        username: account.username,
        countryId: account.country_id,
        avatarKey: account.avatar_key,
        countrySeq: Number(account.country_seq),
        cashMicro,
        reservedMicro: 0n,
        positions: valued,
        sharesValueMicro,
        totalMicro: cashMicro + sharesValueMicro, // + reserved (zero in this milestone)
        rank: 0,
      };
    });
    players.sort((a, b) => (a.totalMicro === b.totalMicro ? a.countrySeq - b.countrySeq : a.totalMicro > b.totalMicro ? -1 : 1));
    for (const player of players) player.rank = 1 + players.filter((other) => other.totalMicro > player.totalMicro).length;

    if (persistMarks) await this.persistMarks(players).catch((error) => this.deps.log?.(`valuation: could not save marks: ${error instanceof Error ? error.message : error}`));
    return { computedAt: new Date((this.deps.now ?? Date.now)()), players, byUser: new Map(players.map((p) => [p.userId, p])) };
  }

  /**
   * Accounts, cash and positions in ONE statement: one database round trip (about 165 ms to a remote Supabase pooler,
   * where the previous begin / select / select / commit cost four), and still one snapshot, because a single statement
   * sees the database at a single moment, so cash and shares always describe the same moment.
   */
  private async readState(): Promise<{ accounts: AccountRow[]; positions: PositionRow[] }> {
    const { rows } = await this.deps.pool.query<{ accounts: AccountRow[]; positions: PositionRow[] }>(
      `select
         coalesce((select json_agg(json_build_object(
                     'user_id', a.user_id, 'username', a.username, 'country_id', a.country_id, 'avatar_key', a.avatar_key,
                     'country_seq', a.country_seq::text,
                     'cash', (select coalesce(sum(l.amount), 0) from trading.ledger_entries l where l.account_id = a.user_id)::numeric(20, 6)::text))
                     from trading.accounts a), '[]'::json) as accounts,
         coalesce((select json_agg(json_build_object(
                     'account_id', p.account_id, 'token_id', p.token_id, 'market_id', p.market_id, 'outcome', p.outcome,
                     'question', p.question, 'quantity', p.quantity::text, 'cost_basis', p.cost_basis::text,
                     'realized_pnl', p.realized_pnl::text, 'status', p.status, 'last_mark', p.last_mark::text,
                     'last_mark_at', p.last_mark_at))
                     from trading.positions p), '[]'::json) as positions`,
    );
    return rows[0]!;
  }

  /**
   * Saves a position's last known mark, but only when it moved by at least 0.005 or the saved one is old: a handful of
   * small writes per minute at most, never one per tick. Only marks from a LIVE book are saved.
   */
  private async persistMarks(players: PlayerValuation[]): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const owners: string[] = [];
    const tokens: string[] = [];
    const prices: string[] = [];
    for (const player of players) {
      for (const p of player.positions) {
        if (p.status !== "open" || !p.mark || p.mark.stale || (p.mark.source !== "mid" && p.mark.source !== "bid")) continue;
        owners.push(player.userId);
        tokens.push(p.tokenId);
        prices.push(formatMicro(p.mark.priceMicro));
      }
    }
    if (owners.length === 0) return;
    await this.deps.pool.query(
      `update trading.positions p
          set last_mark = u.price, last_mark_at = to_timestamp($4::double precision / 1000)
         from unnest($1::uuid[], $2::text[], $3::numeric[]) as u(account_id, token_id, price)
        where p.account_id = u.account_id and p.token_id = u.token_id
          and (p.last_mark is null
               or abs(p.last_mark - u.price) >= $5::numeric
               or p.last_mark_at < to_timestamp(($4::double precision - $6::double precision) / 1000))`,
      [owners, tokens, prices, now, formatMicro(MARK_PERSIST_MIN_MOVE_MICRO), MARK_PERSIST_MAX_AGE_MS],
    );
  }
}

function addBooks(into: Map<string, BookView>, quote: QuoteResponse): void {
  const live = quote.feed.state === "live";
  for (const book of [quote.yes, quote.no]) {
    if (!book) continue;
    try {
      into.set(book.tokenId, { bids: toLevels(book.bids), asks: toLevels(book.asks), live, observedAt: book.observedAt });
    } catch {
      // A malformed book cannot value anything; the position falls back to its last known mark.
    }
  }
}

function valuePosition(row: PositionRow, book: BookView | null): PositionValuation {
  const quantityCs = numericToCs(row.quantity);
  const costBasisMicro = parseMicro(row.cost_basis);
  const base = {
    tokenId: row.token_id,
    marketId: row.market_id,
    question: row.question,
    outcome: row.outcome,
    status: row.status,
    quantityCs,
    costBasisMicro,
    realizedMicro: parseSignedMicro(row.realized_pnl),
  };
  if (row.status !== "open" || quantityCs === 0n) return { ...base, mark: null, valueMicro: 0n };
  const mark = markPosition({
    book,
    lastMarkMicro: row.last_mark === null ? null : parseMicro(row.last_mark),
    lastMarkAt: row.last_mark_at ? new Date(row.last_mark_at).toISOString() : null,
    costPerShareMicro: divRoundHalfUp(costBasisMicro * 100n, quantityCs),
  });
  return { ...base, mark, valueMicro: divRoundHalfUp(quantityCs * mark.priceMicro, 100n) };
}
