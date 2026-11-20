/**
 * Server-side client for the public API (services/api). Runs only on the Next.js server,
 * so API_BASE_URL never reaches the browser.
 */
import "server-only";
import { ErrorResponseSchema, MarketListResponseSchema, type CategorySlug, type MarketListResponse } from "@league/catalog-contract";

export type MarketPageResult =
  | { ok: true; data: MarketListResponse }
  | { ok: false; problem: "api_unreachable" | "invalid_cursor" | "api_error"; message: string };

export async function getMarketPage(params: { category?: CategorySlug; cursor?: string }): Promise<MarketPageResult> {
  const url = new URL("/v1/markets", process.env.API_BASE_URL ?? "http://localhost:4000");
  if (params.category) url.searchParams.set("category", params.category);
  if (params.cursor) url.searchParams.set("cursor", params.cursor);

  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  } catch {
    return { ok: false, problem: "api_unreachable", message: "The league API could not be reached." };
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = ErrorResponseSchema.safeParse(body);
    const code = error.success ? error.data.error.code : undefined;
    if (code === "invalid_cursor") return { ok: false, problem: "invalid_cursor", message: error.success ? error.data.error.message : "" };
    // 503 catalog_unavailable is still "the API cannot serve the catalog" from the reader's view.
    const problem = response.status === 503 || response.status === 502 ? "api_unreachable" : "api_error";
    return { ok: false, problem, message: error.success ? error.data.error.message : `The league API responded ${response.status}.` };
  }

  const parsed = MarketListResponseSchema.safeParse(body);
  if (!parsed.success) return { ok: false, problem: "api_error", message: "The league API returned an unexpected response." };
  return { ok: true, data: parsed.data };
}
