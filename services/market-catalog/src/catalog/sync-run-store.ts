/**
 * Write side of the catalog: recording sync attempts and publishing their results.
 *
 * Correctness rules enforced here:
 * 1. A run publishes all of its markets in ONE transaction, or nothing.
 * 2. Publishes are serialized by a transaction-scoped advisory lock; an older run that
 *    finishes after a newer run already published is marked 'superseded' and writes nothing.
 * 3. Only a complete run ('succeeded') may delist markets it did not see, and even then not
 *    if that would hide a suspiciously large share of the catalog. A partial or failed run
 *    never hides markets, so the last usable catalog is preserved.
 * 4. Rows identical to what is already stored are not rewritten.
 */
import type pg from "pg";
import type { NormalizedMarket } from "../polymarket/normalize-market.ts";

export type SyncTrigger = "cli" | "http" | "test";

/** A normalized market already carries its categories (from the event's upstream tags). */
export type MarketToPublish = NormalizedMarket;

export interface PublishInput {
  runId: number;
  markets: MarketToPublish[];
  /** False when the scan was cut off: no delisting allowed. */
  isComplete: boolean;
  statusDetail: string | null;
  pagesFetched: number;
  skipCounts: Record<string, number>;
}

export interface PublishResult {
  status: "succeeded" | "partial" | "superseded";
  /** Rows actually inserted or changed. Rows identical to what we already had are not touched. */
  marketsWritten: number;
  marketsDelisted: number;
  statusDetail: string | null;
}

/** Any fixed 64-bit key works; it only has to be the same for every publisher. */
const PUBLISH_LOCK_KEY = 7_302_113_001;
const UPSERT_BATCH_SIZE = 1000;
/** A run still 'running' after this long belongs to a process that died mid-sync. */
const STALE_RUN_AFTER = "30 minutes";
/**
 * A scan that would hide more than this share of the listed catalog is far more likely to be
 * a broken upstream response than half the markets closing at once. It publishes, but delists nothing.
 */
const MAX_DELIST_SHARE = 0.5;
const DELIST_GUARD_MIN_LISTED = 100;

export async function startSyncRun(
  pool: pg.Pool,
  input: { trigger: SyncTrigger; providerTagSlugs: string[]; maxPagesPerTag: number },
): Promise<{ runId: number; startedAt: Date }> {
  await pool.query(
    `update market_catalog.sync_runs
        set status = 'failed', finished_at = now(),
            status_detail = 'Abandoned: the sync process stopped before finishing.'
      where status = 'running' and started_at < now() - $1::interval`,
    [STALE_RUN_AFTER],
  );
  const { rows } = await pool.query<{ id: string; started_at: Date }>(
    `insert into market_catalog.sync_runs (trigger, provider_tag_slugs, max_pages_per_tag)
     values ($1, $2, $3)
     returning id, started_at`,
    [input.trigger, input.providerTagSlugs, input.maxPagesPerTag],
  );
  return { runId: Number(rows[0]!.id), startedAt: rows[0]!.started_at };
}

export async function recordFailedSyncRun(pool: pg.Pool, runId: number, statusDetail: string): Promise<void> {
  await pool.query(
    `update market_catalog.sync_runs
        set status = 'failed', finished_at = now(), status_detail = $2
      where id = $1 and status = 'running'`,
    [runId, statusDetail],
  );
}

export async function publishSyncRun(pool: pg.Pool, input: PublishInput): Promise<PublishResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Released automatically at commit/rollback, so a crashed process cannot leave it held.
    await client.query("select pg_advisory_xact_lock($1)", [PUBLISH_LOCK_KEY]);

    const newer = await client.query(
      `select 1 from market_catalog.sync_runs
        where id > $1 and status in ('succeeded', 'partial') limit 1`,
      [input.runId],
    );
    if (newer.rowCount) {
      const detail = "A newer sync published first; this run's data was discarded.";
      await finishRun(client, input, "superseded", 0, 0, detail);
      await client.query("commit");
      return { status: "superseded", marketsWritten: 0, marketsDelisted: 0, statusDetail: detail };
    }

    // Ids seen in this run live in a temp table, so "not seen" can be answered without
    // touching (and rewriting) the rows that were seen.
    await client.query("create temp table seen_markets (provider_market_id text primary key) on commit drop");
    let marketsWritten = 0;
    for (let start = 0; start < input.markets.length; start += UPSERT_BATCH_SIZE) {
      marketsWritten += await upsertMarkets(client, input.markets.slice(start, start + UPSERT_BATCH_SIZE));
    }

    let marketsDelisted = 0;
    let statusDetail = input.statusDetail;
    let complete = input.isComplete;
    if (complete) {
      const { rows } = await client.query<{ listed: string; unseen: string }>(
        `select count(*) as listed,
                count(*) filter (where not exists (
                  select 1 from seen_markets s where s.provider_market_id = m.provider_market_id)) as unseen
           from market_catalog.markets m
          where listing_status = 'listed'`,
      );
      const listed = Number(rows[0]!.listed);
      const unseen = Number(rows[0]!.unseen);
      if (listed >= DELIST_GUARD_MIN_LISTED && unseen > listed * MAX_DELIST_SHARE) {
        complete = false;
        statusDetail = `Guard: ${unseen} of ${listed} listed markets were missing from this scan. Nothing was delisted.`;
      } else {
        const delisted = await client.query(
          `update market_catalog.markets m
              set listing_status = 'delisted', delisted_at = now()
            where listing_status = 'listed'
              and not exists (select 1 from seen_markets s where s.provider_market_id = m.provider_market_id)`,
        );
        marketsDelisted = delisted.rowCount ?? 0;
      }
    }

    const status = complete ? "succeeded" : "partial";
    await finishRun(client, input, status, marketsWritten, marketsDelisted, statusDetail);
    await client.query("commit");
    return { status, marketsWritten, marketsDelisted, statusDetail };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Inserts or updates one batch; returns how many rows really changed. Rows are passed as one
 * JSON array and expanded with jsonb_to_recordset. The unique constraint
 * (provider, provider_market_id) makes re-running a sync idempotent, and the
 * `where ... is distinct from` clause skips rows that are already identical, so a re-run
 * against unchanged data writes nothing.
 */
async function upsertMarkets(client: pg.PoolClient, markets: MarketToPublish[]): Promise<number> {
  const rows = markets.map((market) => ({
    provider_market_id: market.providerMarketId,
    provider_event_id: market.providerEventId,
    event_title: market.eventTitle,
    event_slug: market.eventSlug,
    question: market.question,
    categories: market.categories,
    outcome_labels: market.outcomeLabels,
    yes_price: market.snapshotPrices?.yes ?? null,
    no_price: market.snapshotPrices?.no ?? null,
    prices_as_of: market.snapshotPrices ? market.fetchedAt.toISOString() : null,
    volume24hr: market.volume24hr,
    source_url: market.sourceUrl,
    expected_end_at: market.expectedEndAt?.toISOString() ?? null,
    accepting_orders: market.acceptingOrders,
    last_seen_at: market.fetchedAt.toISOString(),
  }));
  const json = JSON.stringify(rows);

  await client.query(
    `insert into seen_markets (provider_market_id)
     select r.provider_market_id from jsonb_to_recordset($1::jsonb) as r(provider_market_id text)
     on conflict do nothing`,
    [json],
  );

  const result = await client.query(
    `insert into market_catalog.markets as m (
        provider_market_id, provider_event_id, event_title, event_slug, question, categories,
        outcome_labels, yes_price, no_price, prices_as_of, volume24hr, source_url, expected_end_at,
        accepting_orders, last_seen_at)
     select r.provider_market_id, r.provider_event_id, r.event_title, r.event_slug, r.question, r.categories,
            r.outcome_labels, r.yes_price, r.no_price, r.prices_as_of, r.volume24hr, r.source_url, r.expected_end_at,
            r.accepting_orders, r.last_seen_at
       from jsonb_to_recordset($1::jsonb) as r(
            provider_market_id text, provider_event_id text, event_title text, event_slug text,
            question text, categories text[], outcome_labels text[], yes_price numeric, no_price numeric,
            prices_as_of timestamptz, volume24hr numeric, source_url text, expected_end_at timestamptz,
            accepting_orders boolean, last_seen_at timestamptz)
     on conflict (provider, provider_market_id) do update set
            provider_event_id = excluded.provider_event_id,
            event_title = excluded.event_title,
            event_slug = excluded.event_slug,
            question = excluded.question,
            categories = excluded.categories,
            outcome_labels = excluded.outcome_labels,
            yes_price = excluded.yes_price,
            no_price = excluded.no_price,
            prices_as_of = excluded.prices_as_of,
            volume24hr = excluded.volume24hr,
            source_url = excluded.source_url,
            expected_end_at = excluded.expected_end_at,
            accepting_orders = excluded.accepting_orders,
            listing_status = 'listed',
            delisted_at = null,
            last_seen_at = excluded.last_seen_at
      -- last_seen_at and prices_as_of are deliberately not compared: they change on every run.
      where (m.provider_event_id, m.event_title, m.event_slug, m.question, m.categories, m.outcome_labels,
             m.yes_price, m.no_price, m.volume24hr, m.source_url, m.expected_end_at, m.accepting_orders, m.listing_status)
            is distinct from
            (excluded.provider_event_id, excluded.event_title, excluded.event_slug, excluded.question, excluded.categories,
             excluded.outcome_labels, excluded.yes_price, excluded.no_price, excluded.volume24hr, excluded.source_url,
             excluded.expected_end_at, excluded.accepting_orders, 'listed')`,
    [json],
  );
  return result.rowCount ?? 0;
}

async function finishRun(
  client: pg.PoolClient,
  input: PublishInput,
  status: PublishResult["status"],
  marketsWritten: number,
  marketsDelisted: number,
  statusDetail: string | null,
): Promise<void> {
  const marketsSkipped = Object.values(input.skipCounts).reduce((sum, count) => sum + count, 0);
  await client.query(
    `update market_catalog.sync_runs
        set status = $2, finished_at = now(), pages_fetched = $3, markets_published = $4,
            markets_skipped = $5, markets_delisted = $6, skip_counts = $7, status_detail = $8
      where id = $1`,
    [input.runId, status, input.pagesFetched, marketsWritten, marketsSkipped, marketsDelisted, JSON.stringify(input.skipCounts), statusDetail],
  );
}
