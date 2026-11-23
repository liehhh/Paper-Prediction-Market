-- Fields a paper trade needs from Polymarket: the order-book token ids, the resolution rules, tick size.
-- Owner: services/market-catalog. Additive only: existing rows keep working and are filled in by the next sync.

alter table market_catalog.markets
  add column condition_id text,
  -- CLOB order-book identifiers. Polymarket sends them as a JSON array that is positional with `outcomes`;
  -- the sync maps them by LABEL ("Yes" / "No"), never by assuming YES is first.
  add column yes_token_id text,
  add column no_token_id text,
  -- Polymarket's `description`: the market's resolution rules, exactly as published.
  add column rules text,
  add column resolution_source text,
  add column tick_size numeric(9, 6),
  add column min_order_size numeric(20, 6),
  add column order_book_enabled boolean not null default false,
  add constraint markets_tokens_both_or_neither check ((yes_token_id is null) = (no_token_id is null)),
  add constraint markets_tokens_distinct check (yes_token_id is null or yes_token_id <> no_token_id);

-- Lookup by id is the hot path for quotes; the primary key already covers it.
