/**
 * Server-side client for the public API (services/api). Runs only on the Next.js server,
 * so API_BASE_URL never reaches the browser.
 */
import "server-only";
import {
  ErrorResponseSchema,
  MarketListResponseSchema,
  QuoteResponseSchema,
  type CategorySlug,
  type MarketListResponse,
  type QuoteResponse,
} from "@league/catalog-contract";
import { WorldSnapshotSchema, type WorldSnapshot } from "@league/trading-contract";

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
    return { ok: false, problem: "api_unreachable", message: "The server could not be reached." };
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = ErrorResponseSchema.safeParse(body);
    const code = error.success ? error.data.error.code : undefined;
    if (code === "invalid_cursor") return { ok: false, problem: "invalid_cursor", message: error.success ? error.data.error.message : "" };
    // 503 catalog_unavailable is still "the API cannot serve the catalog" from the reader's view.
    const problem = response.status === 503 || response.status === 502 ? "api_unreachable" : "api_error";
    return { ok: false, problem, message: error.success ? error.data.error.message : `The server responded ${response.status}.` };
  }

  const parsed = MarketListResponseSchema.safeParse(body);
  if (!parsed.success) return { ok: false, problem: "api_error", message: "The server returned an unexpected response." };
  return { ok: true, data: parsed.data };
}

export type MarketDetailResult =
  | { ok: true; data: QuoteResponse }
  | { ok: false; problem: "not_found" | "api_unreachable" | "api_error" };

/** One market with its rules and live quote. Public: no sign-in needed to look. */
export async function getMarketDetail(marketId: string): Promise<MarketDetailResult> {
  if (!/^\d{1,19}$/.test(marketId)) return { ok: false, problem: "not_found" };
  let response: Response;
  try {
    response = await fetch(new URL(`/v1/markets/${marketId}`, process.env.API_BASE_URL ?? "http://localhost:4000"), { cache: "no-store", signal: AbortSignal.timeout(8000) });
  } catch {
    return { ok: false, problem: "api_unreachable" };
  }
  if (response.status === 404) return { ok: false, problem: "not_found" };
  if (response.status === 503 || response.status === 502) return { ok: false, problem: "api_unreachable" };
  if (!response.ok) return { ok: false, problem: "api_error" };
  const parsed = QuoteResponseSchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, problem: "api_error" };
}

export type WorldResult = { ok: true; data: WorldSnapshot } | { ok: false };

/** The public World snapshot (coarse data only: no exact Power, holdings, orders or email). */
export async function getWorld(): Promise<WorldResult> {
  try {
    const response = await fetch(new URL("/v1/world", process.env.API_BASE_URL ?? "http://localhost:4000"), { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { ok: false };
    const parsed = WorldSnapshotSchema.safeParse(await response.json().catch(() => undefined));
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}
