/**
 * Server-side client for the signed-in endpoints of services/api. Runs only on the Next.js server, so the access token
 * and API_BASE_URL never reach page JavaScript.
 */
import "server-only";
import {
  PortfolioResponseSchema,
  TradeErrorSchema,
  TradePreviewSchema,
  TradeReceiptSchema,
  TradingAccountResponseSchema,
  type PortfolioResponse,
  type TradeConfirmRequest,
  type TradeError,
  type TradePreview,
  type TradePreviewRequest,
  type TradeReceipt,
  type TradingAccountResponse,
} from "@league/trading-contract";

export type TradingAccountResult =
  | { ok: true; data: TradingAccountResponse }
  | { ok: false; problem: "unauthenticated" | "not_found" | "unavailable" | "error" };

const apiUrl = (path: string) => new URL(path, process.env.API_BASE_URL ?? "http://localhost:4000");
const auth = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

/**
 * PUT is idempotent: it creates the account and the one-time 10,000 Power grant on the first call, and returns the
 * existing account unchanged on every later call. So the dashboard can call it on every visit, which also covers
 * users who registered before trading accounts existed.
 */
export async function ensureTradingAccount(accessToken: string): Promise<TradingAccountResult> {
  let response: Response;
  try {
    response = await fetch(apiUrl("/v1/me/trading-account"), { method: "PUT", headers: auth(accessToken), cache: "no-store", signal: AbortSignal.timeout(8000) });
  } catch {
    return { ok: false, problem: "unavailable" };
  }

  if (response.status === 401) return { ok: false, problem: "unauthenticated" };
  if (response.status === 503 || response.status === 502) return { ok: false, problem: "unavailable" };
  if (!response.ok) return { ok: false, problem: "error" };

  const parsed = TradingAccountResponseSchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, problem: "error" };
}

/**
 * Read-only: the caller's account, or problem "not_found" for a brand-new player who has none yet. One round trip, so
 * pages call this on every visit and only call ensureTradingAccount (the creating call) when it says "not_found".
 */
export async function fetchTradingAccount(accessToken: string): Promise<TradingAccountResult> {
  let response: Response;
  try {
    response = await fetch(apiUrl("/v1/me/trading-account"), { headers: auth(accessToken), cache: "no-store", signal: AbortSignal.timeout(8000) });
  } catch {
    return { ok: false, problem: "unavailable" };
  }
  if (response.status === 401) return { ok: false, problem: "unauthenticated" };
  if (response.status === 404) return { ok: false, problem: "not_found" };
  if (response.status === 503 || response.status === 502) return { ok: false, problem: "unavailable" };
  if (!response.ok) return { ok: false, problem: "error" };
  const parsed = TradingAccountResponseSchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, problem: "error" };
}

export type PortfolioResult = { ok: true; data: PortfolioResponse } | { ok: false; problem: "unauthenticated" | "unavailable" | "error" };

/** Read-only: the caller's private portfolio. */
export async function getPortfolio(accessToken: string): Promise<PortfolioResult> {
  let response: Response;
  try {
    response = await fetch(apiUrl("/v1/me/portfolio"), { headers: auth(accessToken), cache: "no-store", signal: AbortSignal.timeout(8000) });
  } catch {
    return { ok: false, problem: "unavailable" };
  }
  if (response.status === 401) return { ok: false, problem: "unauthenticated" };
  if (response.status === 503 || response.status === 502) return { ok: false, problem: "unavailable" };
  if (!response.ok) return { ok: false, problem: "error" };
  const parsed = PortfolioResponseSchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, problem: "error" };
}

export type TradeOutcome<T> = { ok: true; data: T } | { ok: false; refusal: TradeError["error"] & { preview?: TradePreview }; unavailable?: boolean };

/** The one thing postTrade needs from a zod schema, so this app does not need its own zod dependency. */
interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

async function postTrade<T>(accessToken: string, path: string, body: unknown, schema: Parser<T>): Promise<TradeOutcome<T>> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method: "POST",
      headers: { ...auth(accessToken), "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return unavailable();
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    const parsed = schema.safeParse(json);
    return parsed.success ? { ok: true, data: parsed.data } : unavailable();
  }
  const refusal = TradeErrorSchema.safeParse(json);
  if (refusal.success && response.status !== 503) return { ok: false, refusal: { ...refusal.data.error, ...(refusal.data.preview ? { preview: refusal.data.preview } : {}) } };
  return unavailable();
}

const unavailable = (): TradeOutcome<never> => ({
  ok: false,
  unavailable: true,
  refusal: { code: "catalog_unavailable", message: "Trading is temporarily unavailable. Nothing was traded; try again in a moment." },
});

export const previewTrade = (accessToken: string, request: TradePreviewRequest) => postTrade(accessToken, "/v1/me/trades/preview", request, TradePreviewSchema);
export const confirmTrade = (accessToken: string, request: TradeConfirmRequest) => postTrade(accessToken, "/v1/me/trades", request, TradeReceiptSchema);
export type { TradeReceipt };

/** null on success; otherwise a short reason KEY (the page maps keys to messages, never raw upstream text). */
export async function renameUsername(accessToken: string, username: string): Promise<null | "taken" | "invalid" | "unavailable"> {
  let response: Response;
  try {
    response = await fetch(apiUrl("/v1/me/username"), {
      method: "PUT",
      headers: { ...auth(accessToken), "content-type": "application/json" },
      body: JSON.stringify({ username }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return "unavailable";
  }
  if (response.ok) return null;
  const refusal = TradeErrorSchema.safeParse(await response.json().catch(() => undefined));
  if (refusal.success && refusal.data.error.code === "username_taken") return "taken";
  return response.status === 400 ? "invalid" : "unavailable";
}
