/**
 * One catalog sync, end to end. Used by both the CLI (sync-cli.ts) and the internal
 * HTTP endpoint (POST /internal/v1/sync), so there is exactly one implementation.
 *
 *   fetch every configured tag  ->  normalize + merge in memory  ->  publish in one transaction
 *
 * Nothing is written to the markets table until every page was fetched successfully,
 * so an upstream failure halfway through leaves the previous catalog untouched.
 */
import type pg from "pg";
import type { CategorySlug } from "@league/catalog-contract";
import { CATEGORY_PROVIDER_TAGS } from "../categories.ts";
import { fetchOpenEventPages, type GammaClientOptions } from "../polymarket/gamma-client.ts";
import { normalizeGammaEvent, type SkipDiagnostic, type SkipReason } from "../polymarket/normalize-market.ts";
import {
  publishSyncRun,
  recordFailedSyncRun,
  startSyncRun,
  type MarketToPublish,
  type PublishResult,
  type SyncTrigger,
} from "../catalog/sync-run-store.ts";

export interface CatalogSyncDependencies {
  pool: pg.Pool;
  gamma: GammaClientOptions;
  maxPagesPerTag: number;
  categoryTags?: ReadonlyArray<{ category: CategorySlug; polymarketTagSlug: string }>;
  log?: (message: string) => void;
}

export interface TagListingSummary {
  category: CategorySlug;
  polymarketTagSlug: string;
  pagesFetched: number;
  eventsFetched: number;
  marketsAccepted: number;
  truncated: boolean;
}

export interface CatalogSyncSummary {
  runId: number;
  status: PublishResult["status"] | "failed";
  tags: TagListingSummary[];
  marketsPublished: number;
  marketsDelisted: number;
  skipCounts: Partial<Record<SkipReason, number>>;
  /** Up to 20 skips worth a human look (excludes the routine "not_open" case). */
  notableSkips: SkipDiagnostic[];
  statusDetail: string | null;
}

export async function runCatalogSync(deps: CatalogSyncDependencies, trigger: SyncTrigger): Promise<CatalogSyncSummary> {
  const categoryTags = deps.categoryTags ?? CATEGORY_PROVIDER_TAGS;
  const log = deps.log ?? (() => undefined);
  const { runId } = await startSyncRun(deps.pool, {
    trigger,
    providerTagSlugs: categoryTags.map((tag) => tag.polymarketTagSlug),
    maxPagesPerTag: deps.maxPagesPerTag,
  });
  log(`sync run ${runId} started (tags: ${categoryTags.map((t) => t.polymarketTagSlug).join(", ")})`);

  const marketsById = new Map<string, MarketToPublish>();
  const skipCounts: Partial<Record<SkipReason, number>> = {};
  const notableSkips: SkipDiagnostic[] = [];
  const tags: TagListingSummary[] = [];

  try {
    for (const { category, polymarketTagSlug } of categoryTags) {
      const summary: TagListingSummary = {
        category,
        polymarketTagSlug,
        pagesFetched: 0,
        eventsFetched: 0,
        marketsAccepted: 0,
        truncated: false,
      };
      tags.push(summary);

      for await (const page of fetchOpenEventPages(deps.gamma, polymarketTagSlug, deps.maxPagesPerTag)) {
        summary.pagesFetched = page.pageNumber;
        summary.eventsFetched += page.events.length;
        summary.truncated = page.hasMorePages; // still true after the last allowed page => truncated
        for (const rawEvent of page.events) {
          const { markets, skips } = normalizeGammaEvent(rawEvent, page.fetchedAt);
          for (const skipped of skips) {
            skipCounts[skipped.reason] = (skipCounts[skipped.reason] ?? 0) + 1;
            if (skipped.reason !== "not_open" && notableSkips.length < 20) notableSkips.push(skipped);
          }
          for (const market of markets) {
            summary.marketsAccepted++;
            // The same market appears under several tags (and possibly twice in one listing).
            // Keep the most recently fetched copy and accumulate categories.
            const existing = marketsById.get(market.providerMarketId);
            const categories = new Set<CategorySlug>(existing?.categories ?? []);
            categories.add(category);
            marketsById.set(market.providerMarketId, { ...market, categories: [...categories].sort() });
          }
        }
        log(`  ${polymarketTagSlug}: page ${page.pageNumber} (${page.events.length} events)`);
      }
    }
  } catch (error) {
    const statusDetail = `Upstream fetch failed; previous catalog kept. ${errorMessage(error)}`;
    await recordFailedSyncRun(deps.pool, runId, statusDetail);
    return {
      runId,
      status: "failed",
      tags,
      marketsPublished: 0,
      marketsDelisted: 0,
      skipCounts,
      notableSkips,
      statusDetail,
    };
  }

  // A listing is only "complete" if every tag ended naturally and returned something.
  // An empty tag is indistinguishable from an upstream glitch, so it must not trigger delisting.
  const problems = [
    ...tags.filter((t) => t.truncated).map((t) => `tag "${t.polymarketTagSlug}" was truncated at ${t.pagesFetched} pages (raise SYNC_MAX_PAGES_PER_TAG)`),
    ...tags.filter((t) => t.marketsAccepted === 0).map((t) => `tag "${t.polymarketTagSlug}" returned no importable markets`),
  ];

  try {
    const result = await publishSyncRun(deps.pool, {
      runId,
      markets: [...marketsById.values()],
      isComplete: problems.length === 0,
      statusDetail: problems.length ? `Partial refresh: ${problems.join("; ")}. Nothing was delisted.` : null,
      pagesFetched: tags.reduce((sum, t) => sum + t.pagesFetched, 0),
      skipCounts,
    });
    return {
      runId,
      status: result.status,
      tags,
      marketsPublished: result.marketsPublished,
      marketsDelisted: result.marketsDelisted,
      skipCounts,
      notableSkips,
      statusDetail: problems.length ? problems.join("; ") : null,
    };
  } catch (error) {
    // The publish transaction rolled back, so the previous catalog is intact.
    await recordFailedSyncRun(deps.pool, runId, `Publishing failed; previous catalog kept. ${errorMessage(error)}`).catch(
      () => undefined,
    );
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
