/**
 * How the trading service asks market-catalog for live quotes and official resolutions (HTTP, loopback).
 * market-catalog is the only service that talks to Polymarket; trading never does.
 *
 * `CatalogPort` is the small seam tests use to supply deterministic quotes. Nothing else is abstracted.
 */
import {
  QuotesResponseSchema,
  ResolutionsResponseSchema,
  type QuoteResponse,
  type Resolution,
} from "@league/catalog-contract";

export interface CatalogPort {
  /** intent "pin" keeps these markets tracked even when nobody is looking (used for open positions). */
  quotes(marketIds: readonly string[], intent: "view" | "pin"): Promise<QuoteResponse[]>;
  resolutions(marketIds: readonly string[]): Promise<Resolution[]>;
}

export class CatalogUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogUnavailableError";
  }
}

export interface HttpCatalogOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function createHttpCatalog(options: HttpCatalogOptions): CatalogPort {
  async function post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(new URL(path, options.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      throw new CatalogUnavailableError(`market-catalog unreachable: ${error instanceof Error ? error.message : error}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CatalogUnavailableError(`market-catalog responded ${response.status}`);
    }
    return response.json().catch(() => undefined);
  }

  return {
    async quotes(marketIds, intent) {
      if (marketIds.length === 0) return [];
      const parsed = QuotesResponseSchema.safeParse(await post("/internal/v1/quotes", { marketIds, intent }));
      if (!parsed.success) throw new CatalogUnavailableError("market-catalog returned an unexpected quote shape");
      return parsed.data.quotes;
    },
    async resolutions(marketIds) {
      if (marketIds.length === 0) return [];
      const parsed = ResolutionsResponseSchema.safeParse(await post("/internal/v1/resolutions", { marketIds }));
      if (!parsed.success) throw new CatalogUnavailableError("market-catalog returned an unexpected resolution shape");
      return parsed.data.resolutions;
    },
  };
}
