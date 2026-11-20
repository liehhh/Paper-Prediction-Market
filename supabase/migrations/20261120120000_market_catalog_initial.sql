-- Owner: services/market-catalog
-- Only the market-catalog service may read or write objects in the market_catalog schema.
-- Other services reach catalog data through the catalog service's HTTP interface.

create schema if not exists market_catalog;

-- Not exposed through Supabase's Data API (only "public" and "graphql_public" are by default),
-- and no role except the owner gets access.
revoke all on schema market_catalog from public;

-- One row per sync attempt. Freshness is derived from this table:
--   last successful refresh = newest 'succeeded' run
--   last attempted refresh  = newest run of any status
create table market_catalog.sync_runs (
  id bigint generated always as identity primary key,
  trigger text not null check (trigger in ('cli', 'http', 'test')),
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'partial', 'failed', 'superseded')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- Which Polymarket tags this run imported, recorded for auditability.
  provider_tag_slugs text[] not null,
  max_pages_per_tag integer not null check (max_pages_per_tag > 0),
  pages_fetched integer,
  markets_published integer,
  markets_skipped integer,
  markets_delisted integer,
  -- Why a run did not fully succeed (truncated listing, empty tag, upstream error, ...).
  -- Safe, human-readable text only; never contains credentials.
  status_detail text,
  skip_counts jsonb,
  check ((status = 'running') = (finished_at is null))
);

create index sync_runs_status_id_idx on market_catalog.sync_runs (status, id desc);

-- One row per Polymarket market (the tradable YES/NO question), never per event.
create table market_catalog.markets (
  id bigint generated always as identity primary key,
  provider text not null default 'polymarket' check (provider = 'polymarket'),
  provider_market_id text not null,
  provider_event_id text not null,
  event_title text not null,
  event_slug text,
  question text not null,
  -- Our product categories (not Polymarket tag ids). A market can belong to several.
  categories text[] not null check (cardinality(categories) >= 1),
  -- Exactly as received, e.g. {Yes,No}; yes_price/no_price were matched by position.
  outcome_labels text[] not null check (cardinality(outcome_labels) = 2),
  yes_price numeric(9, 6) check (yes_price between 0 and 1),
  no_price numeric(9, 6) check (no_price between 0 and 1),
  prices_as_of timestamptz,
  source_url text,
  expected_end_at timestamptz,
  accepting_orders boolean not null,
  -- 'listed'   = present in the most recent complete listing of open markets.
  -- 'delisted' = absent from a later complete listing. This is NOT a resolution:
  --              we never infer closed/resolved outcomes from an absence.
  listing_status text not null default 'listed' check (listing_status in ('listed', 'delisted')),
  delisted_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null,
  last_seen_run_id bigint not null references market_catalog.sync_runs (id),
  constraint markets_provider_market_unique unique (provider, provider_market_id),
  check ((yes_price is null) = (no_price is null)),
  check ((yes_price is null) = (prices_as_of is null)),
  check ((listing_status = 'delisted') = (delisted_at is not null))
);

-- Supports the catalog's stable ordering: soonest expected end first, unknown end last, id as tie-breaker.
create index markets_listed_order_idx
  on market_catalog.markets ((coalesce(expected_end_at, 'infinity'::timestamptz)), id)
  where listing_status = 'listed';

create index markets_categories_idx on market_catalog.markets using gin (categories);

-- Defense in depth: if this schema were ever exposed through the Data API, RLS with no
-- policies denies every non-owner role. The catalog service connects as the owner.
alter table market_catalog.sync_runs enable row level security;
alter table market_catalog.markets enable row level security;
