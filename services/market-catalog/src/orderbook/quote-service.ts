/**
 * Turns "market id" into a quote: market facts from the catalog table plus the shared live books.
 * This is the ONLY place that decides whether a market may be traded right now.
 *
 * A market is tradable (execution allowed) only when ALL of these hold; the first failing reason is reported:
 *   1. supported: a political, binary Yes/No market with both order-book tokens, an enabled order book and
 *      published resolution rules of real length;
 *   2. open: still accepting orders, not past its expected end, and the provider does not say it is closed;
 *   3. in the active catalog (a delisted market is only valued/settled, never opened further);
 *   4. both its books are live (see book-feed.ts).
 */
import type pg from "pg";
import type { FeedState, QuoteResponse, Resolution } from "@league/catalog-contract";
import type { BookFeed } from "./book-feed.ts";
import type { ProviderStatus } from "./provider-status.ts";

/** Rules shorter than this are not "clear resolution rules" (real Polymarket rules run to several sentences). */
export const MIN_RULES_LENGTH = 40;

interface MarketRow {
  id: string;
  provider_market_id: string;
  question: string;
  rules: string | null;
  resolution_source: string | null;
  expected_end_at: Date | null;
  accepting_orders: boolean;
  listing_status: "listed" | "delisted";
  categories: string[];
  yes_token_id: string | null;
  no_token_id: string | null;
  order_book_enabled: boolean;
  tick_size: string | null;
  source_url: string | null;
}

const COLUMNS = `id::text, provider_market_id, question, rules, resolution_source, expected_end_at, accepting_orders,
  listing_status, categories, yes_token_id, no_token_id, order_book_enabled, tick_size::text as tick_size, source_url`;

export class QuoteService {
  private readonly deps: { pool: pg.Pool; feed: BookFeed; provider: ProviderStatus; now?: () => number };
  constructor(deps: { pool: pg.Pool; feed: BookFeed; provider: ProviderStatus; now?: () => number }) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async loadMarkets(ids: readonly string[]): Promise<Map<string, MarketRow>> {
    const { rows } = await this.deps.pool.query<MarketRow>(`select ${COLUMNS} from market_catalog.markets where id = any($1::bigint[])`, [ids]);
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** Quotes for several markets. Unknown ids are omitted. Also records the caller's tracking intent. */
  async quotes(ids: readonly string[], intent: "view" | "pin"): Promise<QuoteResponse[]> {
    const markets = await this.loadMarkets(ids);
    const builds: Array<Promise<QuoteResponse>> = [];
    for (const id of ids) {
      const market = markets.get(id);
      if (!market) continue;
      if (market.yes_token_id && market.no_token_id && unsupportedReason(market) === null) {
        this.deps.feed.track([market.yes_token_id, market.no_token_id], intent);
      } else if (market.yes_token_id && market.no_token_id && intent === "pin") {
        // A position may exist in a market that later stopped meeting the support rules: keep valuing it.
        this.deps.feed.track([market.yes_token_id, market.no_token_id], "pin");
      }
      builds.push(this.build(market));
    }
    // Side by side, not one after another: each market's status check may be a round trip to Polymarket.
    return Promise.all(builds);
  }

  private async build(market: MarketRow): Promise<QuoteResponse> {
    const unsupported = unsupportedReason(market);
    const provider = await this.deps.provider.get(market.provider_market_id);
    const endPassed = market.expected_end_at !== null && market.expected_end_at.getTime() <= this.now();
    const closed = !market.accepting_orders || endPassed || provider?.closed === true;
    const status = closed ? "closed" : market.listing_status === "delisted" ? "delisted" : "open";

    const yes = market.yes_token_id ? this.deps.feed.read(market.yes_token_id) : null;
    const no = market.no_token_id ? this.deps.feed.read(market.no_token_id) : null;
    const states: FeedState[] = [yes?.state ?? "unavailable", no?.state ?? "unavailable"];
    // The worst of the two books describes the quote.
    const feedState: FeedState = (["disconnected", "recovering", "unavailable"] as const).find((s) => states.includes(s)) ?? "live";
    const observed = yes?.observedAt != null && no?.observedAt != null ? Math.min(yes.observedAt, no.observedAt) : null;

    let pausedReason: string | null = null;
    if (unsupported) pausedReason = unsupported;
    else if (status === "closed") pausedReason = "This market has closed for trading.";
    else if (status === "delisted") pausedReason = "This market is no longer in the active catalog.";
    else if (feedState === "disconnected") pausedReason = "The live price feed is reconnecting. Trading is paused.";
    else if (feedState === "recovering") pausedReason = "Refreshing the order book. Trading is paused for a moment.";
    else if (feedState === "unavailable") pausedReason = "Waiting for the first live order book.";

    return {
      market: {
        id: market.id,
        question: market.question,
        rules: market.rules,
        resolutionSource: market.resolution_source,
        expectedEndAt: market.expected_end_at?.toISOString() ?? null,
        status,
        tradingSupported: unsupported === null,
        unsupportedReason: unsupported,
        sourceUrl: market.source_url,
      },
      feed: { state: feedState, observedAt: observed === null ? null : new Date(observed).toISOString(), executable: pausedReason === null, pausedReason },
      yes: market.yes_token_id && yes ? { tokenId: market.yes_token_id, bids: yes.bids, asks: yes.asks, observedAt: iso(yes.observedAt) } : null,
      no: market.no_token_id && no ? { tokenId: market.no_token_id, bids: no.bids, asks: no.asks, observedAt: iso(no.observedAt) } : null,
      tickSize: yes?.tickSize ?? market.tick_size,
      serverTime: new Date(this.now()).toISOString(),
    };
  }

  /** Official outcomes. Only the provider can authorise a payout, so a lookup that fails is "unknown", not "open". */
  async resolutions(ids: readonly string[]): Promise<Resolution[]> {
    const markets = await this.loadMarkets(ids);
    const checkedAt = new Date(this.now()).toISOString();
    return Promise.all(
      ids.flatMap((id) => {
        const market = markets.get(id);
        if (!market) return [];
        return [
          this.deps.provider.get(market.provider_market_id).then((state): Resolution =>
            state
              ? { marketId: id, checkedAt, ...state.resolution }
              : { marketId: id, checkedAt, state: "unknown", winningOutcome: null, detail: "Polymarket could not be reached; nothing was decided." },
          ),
        ];
      }),
    );
  }
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** Why a market is not supported for paper trading, or null if it is. Order matters only for the message shown. */
export function unsupportedReason(market: Pick<MarketRow, "categories" | "yes_token_id" | "no_token_id" | "order_book_enabled" | "rules">): string | null {
  if (!market.categories.includes("politics")) return "Only political markets can be traded in this league.";
  if (!market.yes_token_id || !market.no_token_id) return "This market has no live order book we can price against.";
  if (!market.order_book_enabled) return "Polymarket has not enabled an order book for this market.";
  if (!market.rules || market.rules.trim().length < MIN_RULES_LENGTH) return "This market does not publish clear resolution rules.";
  return null;
}
