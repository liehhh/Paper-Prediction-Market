/**
 * Calls the trading service over HTTP. This is the API's only route to account, ledger, trade and league data.
 * Responses are validated against the shared contract before they are re-served publicly, so a field the contract
 * does not name can never leak through this API.
 *
 * Callers pass the user id the API VERIFIED from the access token; nothing the browser sent decides who is acting.
 */
import { z } from "zod";
import {
  LeagueSnapshotSchema,
  PortfolioResponseSchema,
  TradeErrorSchema,
  TradePreviewSchema,
  TradeReceiptSchema,
  TradingAccountResponseSchema,
  type LeagueSnapshot,
  type PortfolioResponse,
  type TradeConfirmRequest,
  type TradeError,
  type TradePreview,
  type TradePreviewRequest,
  type TradeReceipt,
  type TradingAccountResponse,
} from "@league/trading-contract";

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

/** The trading service understood the request and refused it (insufficient Power, price moved, ...). Safe to show. */
export class TradingRejectedError extends Error {
  readonly status: number;
  readonly body: TradeError | { error: { code: string; message: string } };
  constructor(status: number, body: TradingRejectedError["body"]) {
    super(`trading rejected the request (${status} ${body.error.code})`);
    this.name = "TradingRejectedError";
    this.status = status;
    this.body = body;
  }
}

interface CallOptions {
  method: "GET" | "PUT" | "POST";
  body?: unknown;
  /** Treat 404 as "no such thing" instead of an error. */
  allow404?: boolean;
}

async function call<S extends z.ZodType>(options: TradingClientOptions, path: string, schema: S, init: CallOptions): Promise<z.infer<S> | null> {
  const url = new URL(path, options.baseUrl);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: init.method,
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new TradingServiceError("unavailable", `trading unreachable: ${error instanceof Error ? error.message : error}`);
  }
  if (response.status === 404 && init.allow404) {
    await response.body?.cancel();
    return null;
  }
  if (response.status === 400 || response.status === 404 || response.status === 409) {
    // A refusal with a reason the player should see. Anything else about it is not trusted: only code + message pass.
    const rejected = TradeErrorSchema.safeParse(await response.json().catch(() => undefined));
    if (rejected.success) throw new TradingRejectedError(response.status, rejected.data);
    throw new TradingServiceError("invalid_response", `trading responded ${response.status} with an unexpected body`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new TradingServiceError("unavailable", `trading responded ${response.status}`);
  }
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new TradingServiceError("invalid_response", "trading returned an unexpected response shape");
  return parsed.data;
}

const account = (userId: string) => `/internal/v1/accounts/${encodeURIComponent(userId)}`;

/** Create the account and starting grant, or return the existing account (idempotent). */
export async function provisionAccount(options: TradingClientOptions, userId: string): Promise<TradingAccountResponse> {
  const result = await call(options, account(userId), TradingAccountResponseSchema, { method: "PUT" });
  if (!result) throw new TradingServiceError("invalid_response", "trading answered 404 to a provisioning request");
  return result;
}

/** Read-only. Returns null when the user has no account yet. */
export function fetchAccount(options: TradingClientOptions, userId: string): Promise<TradingAccountResponse | null> {
  return call(options, account(userId), TradingAccountResponseSchema, { method: "GET", allow404: true });
}

export async function changeUsername(options: TradingClientOptions, userId: string, username: string): Promise<string> {
  const result = await call(options, `${account(userId)}/username`, UsernameResultSchema, { method: "PUT", body: { username } });
  if (!result) throw new TradingServiceError("invalid_response", "trading answered 404 to a rename");
  return result.username;
}

/** Points the caller's profile at a new picture (or null for none). Returns the key it pointed at before. */
export async function setAvatarKey(options: TradingClientOptions, userId: string, avatarKey: string | null): Promise<{ previousKey: string | null }> {
  const result = await call(options, `${account(userId)}/avatar`, PreviousKeySchema, { method: "PUT", body: { avatarKey } });
  if (!result) throw new TradingServiceError("invalid_response", "trading answered 404 to an avatar change");
  return result;
}

export async function previewTrade(options: TradingClientOptions, userId: string, request: TradePreviewRequest): Promise<TradePreview> {
  const result = await call(options, `${account(userId)}/trades/preview`, TradePreviewSchema, { method: "POST", body: request });
  if (!result) throw new TradingServiceError("invalid_response", "trading answered 404 to a preview");
  return result;
}

export async function confirmTrade(options: TradingClientOptions, userId: string, request: TradeConfirmRequest): Promise<TradeReceipt> {
  const result = await call(options, `${account(userId)}/trades`, TradeReceiptSchema, { method: "POST", body: request });
  if (!result) throw new TradingServiceError("invalid_response", "trading answered 404 to a confirmation");
  return result;
}

export function fetchPortfolio(options: TradingClientOptions, userId: string): Promise<PortfolioResponse | null> {
  return call(options, `${account(userId)}/portfolio`, PortfolioResponseSchema, { method: "GET", allow404: true });
}

/** Public data only. The schema is the filter: fields it does not name are dropped. */
export async function fetchLeague(options: TradingClientOptions): Promise<LeagueSnapshot> {
  const result = await call(options, "/internal/v1/league", LeagueSnapshotSchema, { method: "GET" });
  if (!result) throw new TradingServiceError("invalid_response", "trading answered 404 for the league");
  return result;
}

const UsernameResultSchema = z.object({ username: z.string() });
const PreviousKeySchema = z.object({ previousKey: z.string().nullable() });
