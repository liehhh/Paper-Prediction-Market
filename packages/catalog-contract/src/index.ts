/**
 * The catalog's HTTP contract, shared by three processes:
 * - services/market-catalog produces it (internal endpoint),
 * - services/api validates it at its boundary and re-serves it as GET /v1/markets,
 * - apps/web validates it again and renders it.
 *
 * Every process validates what it receives over the network instead of trusting the type.
 */
import { z } from "zod";

export const CATEGORY_SLUGS = [
  "politics",
  "sports",
  "crypto",
  "pop-culture",
  "geopolitics",
  "economy",
  "finance",
  "tech",
  "weather",
  "other",
] as const;
export const CategorySlugSchema = z.enum(CATEGORY_SLUGS);
export type CategorySlug = z.infer<typeof CategorySlugSchema>;

export const CATEGORY_LABELS: Record<CategorySlug, string> = {
  politics: "Politics",
  sports: "Sports",
  crypto: "Crypto",
  "pop-culture": "Pop culture",
  geopolitics: "Geopolitics",
  economy: "Economy",
  finance: "Finance",
  tech: "Tech",
  weather: "Weather",
  other: "Other",
};

export const MARKET_PAGE_SIZE_DEFAULT = 24;
export const MARKET_PAGE_SIZE_MAX = 100;

/** Query accepted by GET /v1/markets (public) and GET /internal/v1/markets (catalog). */
export const MarketListQuerySchema = z.object({
  category: CategorySlugSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MARKET_PAGE_SIZE_MAX).default(MARKET_PAGE_SIZE_DEFAULT),
  cursor: z.string().min(1).max(200).optional(),
});
export type MarketListQuery = z.infer<typeof MarketListQuerySchema>;

const isoDateTime = z.iso.datetime({ offset: true });

/**
 * Last prices seen during a sync. Informational only: they are not live
 * quotes and must be labelled as a snapshot wherever they are shown.
 */
export const SnapshotPricesSchema = z.object({
  yes: z.number().min(0).max(1),
  no: z.number().min(0).max(1),
  asOf: isoDateTime,
});

export const MarketSchema = z.object({
  id: z.string(),
  question: z.string(),
  eventTitle: z.string(),
  categories: z.array(CategorySlugSchema).min(1),
  expectedEndAt: isoDateTime.nullable(),
  snapshotPrices: SnapshotPricesSchema.nullable(),
  /** Reported 24-hour trading volume in USD (this question only). The list is ordered by it. */
  volume24hr: z.number().min(0),
  sourceUrl: z.url().nullable(),
  lastSyncedAt: isoDateTime,
});
export type Market = z.infer<typeof MarketSchema>;

export const SYNC_RUN_STATUSES = ["running", "succeeded", "partial", "failed", "superseded"] as const;
export const SyncRunStatusSchema = z.enum(SYNC_RUN_STATUSES);
export type SyncRunStatus = z.infer<typeof SyncRunStatusSchema>;

/**
 * Freshness is reported as two separate facts:
 * - lastSuccessfulRefreshAt: when a complete sync last finished publishing.
 * - latestAttempt: the most recent sync attempt, whatever its outcome.
 * A newer failed attempt never changes lastSuccessfulRefreshAt.
 */
export const CatalogFreshnessSchema = z.object({
  lastSuccessfulRefreshAt: isoDateTime.nullable(),
  latestAttempt: z
    .object({
      status: SyncRunStatusSchema,
      startedAt: isoDateTime,
      finishedAt: isoDateTime.nullable(),
    })
    .nullable(),
});
export type CatalogFreshness = z.infer<typeof CatalogFreshnessSchema>;

export const MarketListResponseSchema = z.object({
  markets: z.array(MarketSchema),
  nextCursor: z.string().nullable(),
  catalog: CatalogFreshnessSchema,
});
export type MarketListResponse = z.infer<typeof MarketListResponseSchema>;

/** The one error shape every service returns. Messages are safe to show to a browser. */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export function errorBody(code: string, message: string): ErrorResponse {
  return { error: { code, message } };
}

// ---------------------------------------------------------------------------------------------
// Trading data: market detail, live quotes, official resolutions.
// Prices and sizes are decimal STRINGS (never floats). Served by services/market-catalog,
// consumed by services/trading (execution, valuation, settlement) and re-served by services/api.
// ---------------------------------------------------------------------------------------------

export const DecimalStringSchema = z.string().regex(/^\d{1,14}(\.\d{1,8})?$/, "Expected a non-negative decimal string");

/** One price level of an order book. Bids are best-first (highest price), asks best-first (lowest price). */
export const BookLevelSchema = z.object({ price: DecimalStringSchema, size: DecimalStringSchema });
export type BookLevel = z.infer<typeof BookLevelSchema>;

export const TokenBookSchema = z.object({
  /** The CLOB token this book belongs to. YES and NO each have their own book and their own token. */
  tokenId: z.string().min(1),
  bids: z.array(BookLevelSchema),
  asks: z.array(BookLevelSchema),
  /** When this book was last confirmed by Polymarket (a feed event or a REST snapshot). Null if never. */
  observedAt: isoDateTime.nullable(),
});
export type TokenBook = z.infer<typeof TokenBookSchema>;

export const MARKET_STATUSES = ["open", "closed", "delisted"] as const;

/**
 * - live:         connected, snapshot applied, confirmed within the freshness window.
 * - recovering:   a gap or inconsistency was detected; a fresh snapshot is being fetched.
 * - disconnected: the shared feed connection is down (a reconnect is in progress).
 * - unavailable:  nobody has asked for this market yet / no snapshot has ever arrived.
 */
export const FEED_STATES = ["live", "recovering", "disconnected", "unavailable"] as const;
export const FeedStateSchema = z.enum(FEED_STATES);
export type FeedState = z.infer<typeof FeedStateSchema>;

export const QuoteMarketSchema = z.object({
  id: z.string(),
  question: z.string(),
  /** Polymarket's published resolution rules, verbatim. Null when none were published. */
  rules: z.string().nullable(),
  resolutionSource: z.string().nullable(),
  expectedEndAt: isoDateTime.nullable(),
  status: z.enum(MARKET_STATUSES),
  tradingSupported: z.boolean(),
  /** Why this market cannot be traded, when tradingSupported is false. Safe to show. */
  unsupportedReason: z.string().nullable(),
  sourceUrl: z.url().nullable(),
});

export const QuoteResponseSchema = z.object({
  market: QuoteMarketSchema,
  feed: z.object({
    state: FeedStateSchema,
    /** The older of the YES and NO books' confirmation times. Null when either was never observed. */
    observedAt: isoDateTime.nullable(),
    /** True only when a paper trade may execute against these books right now. */
    executable: z.boolean(),
    /** Why execution is paused, when executable is false. Safe to show. */
    pausedReason: z.string().nullable(),
  }),
  /** Null until the first snapshot arrives, or when the market is not tradable. */
  yes: TokenBookSchema.nullable(),
  no: TokenBookSchema.nullable(),
  tickSize: DecimalStringSchema.nullable(),
  serverTime: isoDateTime,
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

export const QuotesRequestSchema = z.object({
  marketIds: z.array(z.string().regex(/^\d{1,19}$/)).min(1).max(200),
  /**
   * "pin": keep tracking these markets until the pin expires (used by trading for markets with open positions).
   * "view": a viewer is looking; tracking lapses shortly after viewers stop asking.
   */
  intent: z.enum(["pin", "view"]).default("view"),
});
export type QuotesRequest = z.infer<typeof QuotesRequestSchema>;
export const QuotesResponseSchema = z.object({ quotes: z.array(QuoteResponseSchema) });
export type QuotesResponse = z.infer<typeof QuotesResponseSchema>;

export const RESOLUTION_STATES = ["open", "closed_unresolved", "resolved", "ambiguous", "unknown"] as const;
/**
 * Only "resolved" with a winningOutcome authorises a payout.
 * - closed_unresolved: trading closed but the provider has not published an outcome yet.
 * - ambiguous: the provider settled it in a way we do not support (e.g. 50/50). Positions are kept.
 * - unknown: the provider could not be asked, or the market is not known to the provider.
 */
export const ResolutionSchema = z.object({
  marketId: z.string(),
  state: z.enum(RESOLUTION_STATES),
  winningOutcome: z.enum(["YES", "NO"]).nullable(),
  checkedAt: isoDateTime,
  /** Short, safe description of the evidence (never raw upstream payloads). */
  detail: z.string(),
});
export type Resolution = z.infer<typeof ResolutionSchema>;
export const ResolutionsRequestSchema = z.object({ marketIds: z.array(z.string().regex(/^\d{1,19}$/)).min(1).max(200) });
export const ResolutionsResponseSchema = z.object({ resolutions: z.array(ResolutionSchema) });
