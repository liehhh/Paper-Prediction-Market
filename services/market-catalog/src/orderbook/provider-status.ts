/**
 * Asks Polymarket's Gamma API about ONE market by id: is it closed, and did it officially resolve?
 *
 * Verified 2026-11-23 against live responses of GET https://gamma-api.polymarket.com/markets/{id}:
 *   closed: true, umaResolutionStatus: "resolved", outcomes: ["Yes","No"], outcomePrices: ["0","1"]
 * A market that resolved NO reports outcomePrices ["0","1"]; resolved YES reports ["1","0"].
 *
 * RULE for paying out (see classifyResolution): only closed + umaResolutionStatus "resolved" + prices that are
 * exactly one "1" and one "0" count as an official outcome. A price near 1 on an open market, an empty book, or a
 * passed end date never does. Anything resolved in another way (for example 50/50, prices "0.5"/"0.5") is
 * "ambiguous": positions are kept until someone reconciles them.
 */
import { z } from "zod";
import type { Resolution } from "@league/catalog-contract";
import { parseJsonArrayField } from "../polymarket/normalize-market.ts";

const GammaMarketStateSchema = z.object({
  id: z.union([z.string(), z.number()]),
  closed: z.boolean().nullish(),
  active: z.boolean().nullish(),
  acceptingOrders: z.boolean().nullish(),
  umaResolutionStatus: z.string().nullish(),
  outcomes: z.unknown().optional(),
  outcomePrices: z.unknown().optional(),
});

export interface ProviderMarketState {
  closed: boolean;
  acceptingOrders: boolean;
  resolution: Pick<Resolution, "state" | "winningOutcome" | "detail">;
}

export interface ProviderStatusOptions {
  gammaBaseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}

export function classifyResolution(raw: unknown): ProviderMarketState {
  const parsed = GammaMarketStateSchema.safeParse(raw);
  if (!parsed.success) return { closed: false, acceptingOrders: false, resolution: { state: "unknown", winningOutcome: null, detail: "Unexpected provider response." } };
  const m = parsed.data;
  const closed = m.closed === true;
  const acceptingOrders = m.acceptingOrders === true && !closed;
  if (!closed) return { closed, acceptingOrders, resolution: { state: "open", winningOutcome: null, detail: "The market is still open." } };

  if (m.umaResolutionStatus !== "resolved") {
    return { closed, acceptingOrders, resolution: { state: "closed_unresolved", winningOutcome: null, detail: "Trading is closed; no official outcome yet." } };
  }
  const labels = parseJsonArrayField(m.outcomes);
  const prices = parseJsonArrayField(m.outcomePrices);
  if (!labels || !prices || labels.length !== 2 || prices.length !== 2) {
    return { closed, acceptingOrders, resolution: { state: "ambiguous", winningOutcome: null, detail: "Resolved, but the outcome shape is not a plain two-outcome market." } };
  }
  const lower = labels.map((label) => (typeof label === "string" ? label.trim().toLowerCase() : ""));
  const yesIndex = lower.indexOf("yes");
  const noIndex = lower.indexOf("no");
  const asNumber = (value: unknown) => (typeof value === "string" || typeof value === "number" ? Number(value) : NaN);
  if (yesIndex === -1 || noIndex === -1) {
    return { closed, acceptingOrders, resolution: { state: "ambiguous", winningOutcome: null, detail: "Resolved, but the outcomes are not Yes/No." } };
  }
  const yes = asNumber(prices[yesIndex]);
  const no = asNumber(prices[noIndex]);
  if (yes === 1 && no === 0) return { closed, acceptingOrders, resolution: { state: "resolved", winningOutcome: "YES", detail: "Officially resolved YES." } };
  if (yes === 0 && no === 1) return { closed, acceptingOrders, resolution: { state: "resolved", winningOutcome: "NO", detail: "Officially resolved NO." } };
  return { closed, acceptingOrders, resolution: { state: "ambiguous", winningOutcome: null, detail: "Resolved with a split or unsupported payout; positions are kept pending reconciliation." } };
}

interface CacheEntry {
  at: number;
  value: Promise<ProviderMarketState | null>;
  /** The result once it arrived (null while the first lookup is in flight, or if it failed). */
  settled: ProviderMarketState | null;
  /** The previous known result, served while this refresh is still in flight. */
  stale: ProviderMarketState | null;
}

/**
 * Cached, coalesced lookups: many callers asking about one market cost one upstream request per TTL.
 *
 * Stale-while-revalidate: once a market has been looked up, a request never WAITS for Polymarket again unless the last
 * known answer is more than twice the TTL old. Between one and two TTLs it gets the last known answer immediately and a
 * refresh runs in the background. Only the very first lookup of a market (or one that went cold) blocks, which is a
 * network round trip to a third party (hundreds of milliseconds) that a page view should not normally pay.
 */
export class ProviderStatus {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly options: ProviderStatusOptions;
  constructor(options: ProviderStatusOptions) {
    this.options = options;
  }

  /** Null when Polymarket could not be asked (network, 5xx, unknown market). Callers must treat that as "unknown", never as "open". */
  get(providerMarketId: string): Promise<ProviderMarketState | null> {
    const now = (this.options.now ?? Date.now)();
    const ttl = this.options.ttlMs ?? 30_000;
    const hit = this.cache.get(providerMarketId);
    if (hit) {
      const age = now - hit.at;
      // Fresh, or a refresh already running: answer from what we have, without waiting.
      if (age < ttl) return hit.settled || hit.stale ? Promise.resolve(hit.settled ?? hit.stale) : hit.value;
      if (hit.settled && age < ttl * 2) {
        void this.refresh(providerMarketId, now, hit);
        return Promise.resolve(hit.settled);
      }
    }
    return this.refresh(providerMarketId, now, hit);
  }

  private refresh(providerMarketId: string, now: number, previous: CacheEntry | undefined): Promise<ProviderMarketState | null> {
    const entry: CacheEntry = { at: now, value: this.fetchState(providerMarketId), settled: null, stale: previous?.settled ?? previous?.stale ?? null };
    this.cache.set(providerMarketId, entry);
    void entry.value.then((result) => {
      if (result) {
        entry.settled = result;
      } else if (this.cache.get(providerMarketId) === entry) {
        // A failed lookup must not be cached: keep the previous answer's age (so the next call retries), or forget it.
        if (previous?.settled) this.cache.set(providerMarketId, previous);
        else this.cache.delete(providerMarketId);
      }
    });
    return entry.value;
  }

  private async fetchState(providerMarketId: string): Promise<ProviderMarketState | null> {
    try {
      const url = new URL(`/markets/${encodeURIComponent(providerMarketId)}`, this.options.gammaBaseUrl);
      const response = await (this.options.fetchImpl ?? fetch)(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      return classifyResolution(await response.json());
    } catch {
      return null;
    }
  }
}
