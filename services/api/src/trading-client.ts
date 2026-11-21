/**
 * Calls the trading service over HTTP. This is the API's only route to account and ledger data.
 * Responses are validated against the shared contract before they are re-served publicly.
 */
import { TradingAccountResponseSchema, type TradingAccountResponse } from "@league/trading-contract";

export interface TradingClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class TradingServiceError extends Error {
  readonly kind: "unavailable" | "invalid_response";
  constructor(kind: TradingServiceError["kind"], message: string) {
    super(message);
    this.name = "TradingServiceError";
    this.kind = kind;
  }
}

/** Create the account and starting grant, or return the existing account (idempotent). */
export function provisionAccount(options: TradingClientOptions, userId: string): Promise<TradingAccountResponse> {
  return call(options, userId, "PUT").then((account) => {
    if (!account) throw new TradingServiceError("invalid_response", "trading service answered 404 to a provisioning request");
    return account;
  });
}

/** Read-only. Returns null when the user has no trading account yet. */
export function fetchAccount(options: TradingClientOptions, userId: string): Promise<TradingAccountResponse | null> {
  return call(options, userId, "GET");
}

async function call(options: TradingClientOptions, userId: string, method: "GET" | "PUT"): Promise<TradingAccountResponse | null> {
  // The user id comes from the verified token and is a UUID; encoding is belt and braces.
  const url = new URL(`/internal/v1/accounts/${encodeURIComponent(userId)}`, options.baseUrl);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, { method, signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (error) {
    throw new TradingServiceError("unavailable", `trading unreachable: ${error instanceof Error ? error.message : error}`);
  }
  if (response.status === 404 && method === "GET") {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new TradingServiceError("unavailable", `trading responded ${response.status}`);
  }
  const parsed = TradingAccountResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new TradingServiceError("invalid_response", "trading returned an unexpected response shape");
  return parsed.data;
}
