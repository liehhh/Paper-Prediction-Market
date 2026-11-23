/**
 * Calls the market-catalog service over HTTP. This is the API's only route to catalog data.
 * Responses are validated against the shared contract before they are re-served publicly.
 */
import {
  ErrorResponseSchema,
  MarketListResponseSchema,
  QuotesResponseSchema,
  type MarketListQuery,
  type MarketListResponse,
  type QuoteResponse,
} from "@league/catalog-contract";

export interface MarketCatalogClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Why the catalog call failed, in terms the API can map to a public status code. */
export class MarketCatalogError extends Error {
  readonly kind: "unavailable" | "rejected" | "invalid_response";
  readonly upstreamCode: string | undefined;
  constructor(kind: MarketCatalogError["kind"], message: string, upstreamCode?: string) {
    super(message);
    this.name = "MarketCatalogError";
    this.kind = kind;
    this.upstreamCode = upstreamCode;
  }
}

export async function fetchMarketPage(options: MarketCatalogClientOptions, query: MarketListQuery): Promise<MarketListResponse> {
  const url = new URL("/internal/v1/markets", options.baseUrl);
  url.searchParams.set("limit", String(query.limit));
  if (query.category) url.searchParams.set("category", query.category);
  if (query.cursor) url.searchParams.set("cursor", query.cursor);

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (error) {
    throw new MarketCatalogError("unavailable", `market-catalog unreachable: ${error instanceof Error ? error.message : error}`);
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (response.status === 400) {
    const parsed = ErrorResponseSchema.safeParse(body);
    throw new MarketCatalogError("rejected", "market-catalog rejected the query", parsed.success ? parsed.data.error.code : undefined);
  }
  if (!response.ok) throw new MarketCatalogError("unavailable", `market-catalog responded ${response.status}`);

  const parsed = MarketListResponseSchema.safeParse(body);
  if (!parsed.success) throw new MarketCatalogError("invalid_response", "market-catalog returned an unexpected response shape");
  return parsed.data;
}

/** One market's market facts and live quote. Null when the market does not exist. Counts as a viewer. */
export async function fetchQuote(options: MarketCatalogClientOptions, marketId: string): Promise<QuoteResponse | null> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(new URL("/internal/v1/quotes", options.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marketIds: [marketId], intent: "view" }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new MarketCatalogError("unavailable", `market-catalog unreachable: ${error instanceof Error ? error.message : error}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new MarketCatalogError("unavailable", `market-catalog responded ${response.status}`);
  }
  const parsed = QuotesResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new MarketCatalogError("invalid_response", "market-catalog returned an unexpected quote shape");
  return parsed.data.quotes[0] ?? null;
}
