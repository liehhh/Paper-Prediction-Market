-- Full active catalog, ranked by reported 24-hour trading volume.
-- Owner: services/market-catalog.

-- Per-question 24h volume in whole USD, as reported by Polymarket at the last sync that changed it.
-- Rounded to dollars upstream of this column so jitter does not rewrite rows.
alter table market_catalog.markets
  add column volume24hr numeric(20, 0) not null default 0 check (volume24hr >= 0);

-- "Seen in this run" is now answered from a per-run temp table, so unchanged rows are not
-- rewritten just to stamp them. This column therefore has no writer any more.
alter table market_catalog.markets drop column last_seen_run_id;

-- Browse order is now: highest 24h volume first, id as the stable tie-breaker.
drop index if exists market_catalog.markets_listed_order_idx;
create index markets_trending_idx
  on market_catalog.markets (volume24hr desc, id)
  where listing_status = 'listed';
-- Category filtering uses the existing GIN index on categories; verify the plan with
-- EXPLAIN before adding a per-category composite index.
