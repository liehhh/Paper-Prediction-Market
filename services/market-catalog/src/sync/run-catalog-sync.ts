/**
 * One catalog sync, end to end. Used by both the CLI (sync-cli.ts) and the internal
 * HTTP endpoint (POST /internal/v1/sync), so there is exactly one implementation.
 *
 *   page through every active event  ->  normalize each nested market  ->  publish in one transaction
 *
 * Nothing is written until every page was fetched, so an upstream failure halfway through
 * leaves the previous catalog untouched. A scan cut off by the page cap still publishes what
 * it saw, but never hides anything it did not see.
 */
import type pg from "pg";
import { fetchActiveEventPages, type GammaClientOptions } from "../polymarket/gamma-client.ts";
import { normalizeGammaEvent, type SkipDiagnostic, type SkipReason } from "../polymarket/normalize-market.ts";
import { publishSyncRun, recordFailedSyncRun, startSyncRun, type MarketToPublish, type PublishResult, type SyncTrigger } from "../catalog/sync-run-store.ts";

/** 181 pages covered the whole catalog on 2026-11-21; the cap leaves room to roughly double. */
export const DEFAULT_MAX_PAGES = 400;

export interface CatalogSyncDependencies {
  pool: pg.Pool;
  gamma: GammaClientOptions;
  maxPages?: number;
  log?: (message: string) => void;
}

/**
 * Counts kept apart on purpose:
 *   requestsMade    -> pages requested from Gamma (retries not counted)
 *   eventsFetched   -> upstream events received
 *   marketsEligible -> nested markets that are open binary YES/NO, i.e. what we store
 */
export interface CatalogSyncSummary {
  runId: number;
  status: PublishResult["status"] | "failed";
  requestsMade: number;
  eventsFetched: number;
  marketsEligible: number;
  marketsWritten: number;
  marketsDelisted: number;
  durationMs: number;
  skipCounts: Partial<Record<SkipReason, number>>;
  notableSkips: SkipDiagnostic[];
  statusDetail: string | null;
}

export async function runCatalogSync(deps: CatalogSyncDependencies, trigger: SyncTrigger): Promise<CatalogSyncSummary> {
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  const log = deps.log ?? (() => undefined);
  const startedAt = Date.now();
  const { runId } = await startSyncRun(deps.pool, { trigger, providerTagSlugs: ["(all active events)"], maxPagesPerTag: maxPages });
  log(`sync run ${runId} started (all active events, page cap ${maxPages})`);

  const summary: CatalogSyncSummary = {
    runId,
    status: "failed",
    requestsMade: 0,
    eventsFetched: 0,
    marketsEligible: 0,
    marketsWritten: 0,
    marketsDelisted: 0,
    durationMs: 0,
    skipCounts: {},
    notableSkips: [],
    statusDetail: null,
  };
  const finish = (patch: Partial<CatalogSyncSummary>): CatalogSyncSummary => ({ ...summary, ...patch, durationMs: Date.now() - startedAt });
  const fail = async (statusDetail: string) => {
    await recordFailedSyncRun(deps.pool, runId, statusDetail);
    return finish({ status: "failed", statusDetail });
  };

  // Keyed by provider market id: if a page boundary ever repeats an event, the later copy wins.
  const marketsById = new Map<string, MarketToPublish>();
  let truncated = false;
  try {
    for await (const page of fetchActiveEventPages(deps.gamma, maxPages)) {
      summary.requestsMade = page.pageNumber;
      summary.eventsFetched += page.events.length;
      truncated = page.hasMorePages; // still true after the last allowed page => cut off
      for (const rawEvent of page.events) {
        const { markets, skips } = normalizeGammaEvent(rawEvent, page.fetchedAt);
        for (const skipped of skips) {
          summary.skipCounts[skipped.reason] = (summary.skipCounts[skipped.reason] ?? 0) + 1;
          if (skipped.reason !== "not_open" && summary.notableSkips.length < 20) summary.notableSkips.push(skipped);
        }
        for (const market of markets) marketsById.set(market.providerMarketId, market);
      }
      if (page.pageNumber % 20 === 0) log(`  page ${page.pageNumber}: ${summary.eventsFetched} events, ${marketsById.size} eligible markets so far`);
    }
  } catch (error) {
    return fail(`Upstream fetch failed after ${summary.requestsMade} page(s); previous catalog kept. ${errorMessage(error)}`);
  }
  summary.marketsEligible = marketsById.size;

  // Zero markets is indistinguishable from an upstream glitch; never replace a catalog with it.
  if (marketsById.size === 0) return fail("Gamma returned no eligible markets; previous catalog kept.");

  try {
    const result = await publishSyncRun(deps.pool, {
      runId,
      markets: [...marketsById.values()],
      isComplete: !truncated,
      statusDetail: truncated ? `Scan cut off at ${maxPages} pages (raise the page cap). Nothing was delisted.` : null,
      pagesFetched: summary.requestsMade,
      skipCounts: summary.skipCounts,
    });
    return finish({
      status: result.status,
      marketsWritten: result.marketsWritten,
      marketsDelisted: result.marketsDelisted,
      statusDetail: result.statusDetail,
    });
  } catch (error) {
    // The publish transaction rolled back, so the previous catalog is intact.
    await recordFailedSyncRun(deps.pool, runId, `Publishing failed; previous catalog kept. ${errorMessage(error)}`).catch(() => undefined);
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
