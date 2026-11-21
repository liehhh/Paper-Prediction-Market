/**
 * Server-side client for the signed-in trading-account endpoint of services/api. Runs only on the
 * Next.js server, so the access token and API_BASE_URL never reach page JavaScript.
 */
import "server-only";
import { TradingAccountResponseSchema, type TradingAccountResponse } from "@league/trading-contract";

export type TradingAccountResult =
  | { ok: true; data: TradingAccountResponse }
  | { ok: false; problem: "unauthenticated" | "unavailable" | "error" };

/**
 * PUT is idempotent: it creates the account and the one-time 10,000-credit grant on the first call,
 * and returns the existing account unchanged on every later call. So the dashboard can call it on
 * every visit, which also covers users who registered before trading accounts existed.
 */
export async function ensureTradingAccount(accessToken: string): Promise<TradingAccountResult> {
  const url = new URL("/v1/me/trading-account", process.env.API_BASE_URL ?? "http://localhost:4000");
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, problem: "unavailable" };
  }

  if (response.status === 401) return { ok: false, problem: "unauthenticated" };
  if (response.status === 503 || response.status === 502) return { ok: false, problem: "unavailable" };
  if (!response.ok) return { ok: false, problem: "error" };

  const parsed = TradingAccountResponseSchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, problem: "error" };
}
