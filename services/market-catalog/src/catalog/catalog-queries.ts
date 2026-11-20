/**
 * Read side of the catalog: the queries behind GET /internal/v1/markets.
 * Reads only published data; they never contact Polymarket, so the saved catalog
 * stays readable when the upstream API is down.
 */
import type pg from "pg";
import type { CatalogFreshness, CategorySlug, Market, MarketListQuery, SyncRunStatus } from "@league/catalog-contract";

/** Stable ordering: soonest expected end first, unknown end dates last, then by id. */
interface CursorPosition {
  sortKey: string; // ISO timestamp or "infinity"
  id: string;
}

export class InvalidCursorError extends Error {
  constructor() {
    super("The cursor is not valid. Start again from the first page.");
    this.name = "InvalidCursorError";
  }
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.sortKey, position.id])).toString("base64url");
}

export function decodeCursor(cursor: string): CursorPosition {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(decoded) && decoded.length === 2) {
      const [sortKey, id] = decoded;
      const validSortKey = sortKey === "infinity" || (typeof sortKey === "string" && !Number.isNaN(Date.parse(sortKey)));
      if (validSortKey && typeof id === "string" && /^\d{1,19}$/.test(id)) return { sortKey, id };
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError();
}

interface MarketRow {
  id: string;
  question: string;
  event_title: string;
  categories: string[];
  expected_end_at: Date | null;
  yes_price: number | null;
  no_price: number | null;
  prices_as_of: Date | null;
  source_url: string | null;
  last_seen_at: Date;
  sort_key: string;
}

export async function listMarkets(
  pool: pg.Pool,
  query: MarketListQuery,
): Promise<{ markets: Market[]; nextCursor: string | null }> {
  const after = query.cursor ? decodeCursor(query.cursor) : null;
  const { rows } = await pool.query<MarketRow>(
    `select id::text, question, event_title, categories, expected_end_at,
            yes_price::float8 as yes_price, no_price::float8 as no_price, prices_as_of,
            source_url, last_seen_at,
            case when expected_end_at is null then 'infinity'
                 else to_char(expected_end_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end as sort_key
       from market_catalog.markets
      where listing_status = 'listed'
        and ($1::text is null or $1 = any (categories))
        and ($2::timestamptz is null
             or (coalesce(expected_end_at, 'infinity'::timestamptz), id) > ($2::timestamptz, $3::bigint))
      order by coalesce(expected_end_at, 'infinity'::timestamptz), id
      limit $4`,
    [query.category ?? null, after?.sortKey ?? null, after?.id ?? null, query.limit + 1],
  );

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const last = pageRows.at(-1);
  return {
    markets: pageRows.map(toMarket),
    nextCursor: hasMore && last ? encodeCursor({ sortKey: last.sort_key, id: last.id }) : null,
  };
}

function toMarket(row: MarketRow): Market {
  return {
    id: row.id,
    question: row.question,
    eventTitle: row.event_title,
    categories: row.categories as CategorySlug[],
    expectedEndAt: row.expected_end_at?.toISOString() ?? null,
    snapshotPrices:
      row.yes_price !== null && row.no_price !== null && row.prices_as_of
        ? { yes: row.yes_price, no: row.no_price, asOf: row.prices_as_of.toISOString() }
        : null,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_seen_at.toISOString(),
  };
}

export async function getCatalogFreshness(pool: pg.Pool): Promise<CatalogFreshness> {
  const { rows } = await pool.query<{
    last_success_at: Date | null;
    latest_status: SyncRunStatus | null;
    latest_started_at: Date | null;
    latest_finished_at: Date | null;
  }>(
    `select
        (select finished_at from market_catalog.sync_runs
          where status = 'succeeded' order by id desc limit 1) as last_success_at,
        latest.status as latest_status,
        latest.started_at as latest_started_at,
        latest.finished_at as latest_finished_at
       from (select 1) as one
       left join lateral (
         select status, started_at, finished_at from market_catalog.sync_runs order by id desc limit 1
       ) as latest on true`,
  );
  const row = rows[0]!;
  return {
    lastSuccessfulRefreshAt: row.last_success_at?.toISOString() ?? null,
    latestAttempt:
      row.latest_status && row.latest_started_at
        ? {
            status: row.latest_status,
            startedAt: row.latest_started_at.toISOString(),
            finishedAt: row.latest_finished_at?.toISOString() ?? null,
          }
        : null,
  };
}
