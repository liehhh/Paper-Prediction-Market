/**
 * DETERMINISTIC FIXTURE quotes. This is not Polymarket data and must never be presented as live: it exists so the
 * accounting tests are repeatable. Every number a test asserts comes from the books set here.
 */
import type { BookLevel, FeedState, QuoteResponse, Resolution } from "@league/catalog-contract";
import { CatalogUnavailableError, type CatalogPort } from "../../src/catalog-client.ts";

export interface FakeBook {
  bids: Array<[price: string, size: string]>;
  asks: Array<[price: string, size: string]>;
}

interface FakeMarket {
  id: string;
  question: string;
  yesToken: string;
  noToken: string;
  yes: FakeBook;
  no: FakeBook;
  feed: FeedState;
  status: "open" | "closed" | "delisted";
  supported: boolean;
  /** Milliseconds since epoch when the books were last confirmed. */
  observedAt: number;
  resolution: Pick<Resolution, "state" | "winningOutcome" | "detail">;
}

const levels = (rows: FakeBook["bids"]): BookLevel[] => rows.map(([price, size]) => ({ price, size }));

export class FakeCatalog implements CatalogPort {
  readonly markets = new Map<string, FakeMarket>();
  /** The fixture clock. Quotes are stamped with it, so tests control "now" and "how old the quote is". */
  clock = Date.parse("2026-11-23T12:00:00Z");
  unavailable = false;
  pinned = new Set<string>();

  addMarket(id: string, options: { yes?: FakeBook; no?: FakeBook; question?: string } = {}): FakeMarket {
    const market: FakeMarket = {
      id,
      question: options.question ?? `Will fixture event ${id} happen?`,
      yesToken: `${id}1111`,
      noToken: `${id}2222`,
      yes: options.yes ?? flat("0.5"),
      no: options.no ?? flat("0.5"),
      feed: "live",
      status: "open",
      supported: true,
      observedAt: this.clock,
      resolution: { state: "open", winningOutcome: null, detail: "The market is still open." },
    };
    this.markets.set(id, market);
    return market;
  }

  market(id: string): FakeMarket {
    return this.markets.get(id)!;
  }

  /** Moves the price: a zero-spread book at `yes`, and the complementary NO book. */
  setPrice(id: string, yes: string) {
    const market = this.market(id);
    market.yes = flat(yes);
    market.no = flat((1 - Number(yes)).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
    market.observedAt = this.clock;
  }

  async quotes(marketIds: readonly string[], intent: "view" | "pin"): Promise<QuoteResponse[]> {
    if (this.unavailable) throw new CatalogUnavailableError("fixture: catalog unavailable");
    return marketIds.flatMap((id) => {
      const m = this.markets.get(id);
      if (!m) return [];
      if (intent === "pin") this.pinned.add(id);
      const paused = !m.supported ? "This market cannot be traded." : m.status !== "open" ? "This market is closed." : m.feed !== "live" ? "The live price feed is reconnecting. Trading is paused." : null;
      const observedAt = new Date(m.observedAt).toISOString();
      return [
        {
          market: {
            id,
            question: m.question,
            rules: "Fixture rules: resolves YES if the fixture event happens, otherwise NO.",
            resolutionSource: null,
            expectedEndAt: null,
            status: m.status,
            tradingSupported: m.supported,
            unsupportedReason: m.supported ? null : "Only political markets can be traded in this league.",
            sourceUrl: null,
          },
          feed: { state: m.feed, observedAt, executable: paused === null, pausedReason: paused },
          yes: { tokenId: m.yesToken, bids: levels(m.yes.bids), asks: levels(m.yes.asks), observedAt },
          no: { tokenId: m.noToken, bids: levels(m.no.bids), asks: levels(m.no.asks), observedAt },
          tickSize: "0.01",
          serverTime: new Date(this.clock).toISOString(),
        },
      ];
    });
  }

  async resolutions(marketIds: readonly string[]): Promise<Resolution[]> {
    if (this.unavailable) throw new CatalogUnavailableError("fixture: catalog unavailable");
    return marketIds.flatMap((id) => {
      const m = this.markets.get(id);
      return m ? [{ marketId: id, checkedAt: new Date(this.clock).toISOString(), ...m.resolution }] : [];
    });
  }
}

/** A zero-spread book: bid and ask at the same price, deep. Lets fill price equal valuation price exactly. */
export function flat(price: string, size = "100000"): FakeBook {
  return { bids: [[price, size]], asks: [[price, size]] };
}
