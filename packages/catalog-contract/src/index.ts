/**
 * The catalog's HTTP contract, shared by three processes:
 * - services/market-catalog produces it (internal endpoint),
 * - services/api validates it at its boundary and re-serves it as GET /v1/markets,
 * - apps/web validates it again and renders it.
 *
 * Every process validates what it receives over the network instead of trusting the type.
 */
import { z } from "zod";

export const CATEGORY_SLUGS = ["politics", "pop-culture"] as const;
export const CategorySlugSchema = z.enum(CATEGORY_SLUGS);
export type CategorySlug = z.infer<typeof CategorySlugSchema>;

export const CATEGORY_LABELS: Record<CategorySlug, string> = {
  politics: "Politics",
  "pop-culture": "Pop culture",
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
