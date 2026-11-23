-- Paper trades: orders, fills, positions, settlements, and the public identity of a player's "country".
-- Owner: services/trading. Additive: existing accounts, balances and the starting grant are not touched,
-- and no second grant can ever be issued (ledger_one_starting_grant_per_account still stands).
--
-- "Power" is only a display name for the currency. Stored names (ledger_entries.amount, ...) keep their identifiers.

-- ---------------------------------------------------------------------------------------------
-- Player identity: unique username (the country label), a stable public country id, a stable slot.
-- ---------------------------------------------------------------------------------------------
alter table trading.accounts
  add column username text,
  add column country_id uuid not null default gen_random_uuid(),
  -- Assigned once, never reused: drives the country's colour and its place on the map.
  add column country_seq bigint generated always as identity;

-- Existing accounts get a default name derived from their id; players can change it.
update trading.accounts
   set username = 'player_' || substr(replace(user_id::text, '-', ''), 1, 12)
 where username is null;

alter table trading.accounts
  alter column username set not null,
  add constraint accounts_username_format check (username ~ '^[A-Za-z0-9_]{3,20}$');

-- Unique ignoring case, so "Ada" and "ada" cannot both exist.
create unique index accounts_username_unique on trading.accounts (lower(username));
create unique index accounts_country_id_unique on trading.accounts (country_id);
create unique index accounts_country_seq_unique on trading.accounts (country_seq);

-- ---------------------------------------------------------------------------------------------
-- Ledger: new reasons for a Power movement. Still append-only; the starting-grant index is unchanged.
-- ---------------------------------------------------------------------------------------------
alter table trading.ledger_entries drop constraint ledger_entries_entry_type_check;
alter table trading.ledger_entries
  add constraint ledger_entries_entry_type_check
  check (entry_type in ('starting_grant', 'trade_buy', 'trade_sell', 'settlement_payout')),
  add column order_id uuid,
  add column settlement_market_id text,
  add constraint ledger_reference_matches_type check (
    (entry_type in ('trade_buy', 'trade_sell')) = (order_id is not null)
    and (entry_type = 'settlement_payout') = (settlement_market_id is not null)
  );

-- One payout per account per market, enforced by the database: replaying a settlement can never pay twice.
create unique index ledger_one_payout_per_market
  on trading.ledger_entries (account_id, settlement_market_id)
  where entry_type = 'settlement_payout';

-- ---------------------------------------------------------------------------------------------
-- Orders and fills (immutable history).
-- ---------------------------------------------------------------------------------------------
create table trading.orders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references trading.accounts (user_id),
  -- Player-scoped idempotency: the same key from the same player is the same order, always.
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{8,80}$'),
  -- Hash of the order's meaning. Reusing a key with a different order is detected by comparing it.
  request_fingerprint text not null,
  market_id text not null,
  token_id text not null,
  outcome text not null check (outcome in ('YES', 'NO')),
  side text not null check (side in ('buy', 'sell')),
  status text not null default 'filled' check (status = 'filled'),
  quantity numeric(20, 6) not null check (quantity > 0),
  -- Power spent (buy) or received (sell): exactly the sum of the fills' amounts.
  amount numeric(20, 6) not null check (amount > 0),
  -- The protection the player accepted: the most to spend (buy) or the least to receive (sell).
  limit_amount numeric(20, 6) not null check (limit_amount > 0),
  -- Display only: amount / quantity, rounded half up to 6 decimals. Accounting uses the exact fills.
  average_price numeric(20, 6) not null,
  -- Buys only: limit_amount - amount, which was never debited and stays available.
  unspent numeric(20, 6),
  quote_observed_at timestamptz not null,
  quote_served_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (account_id, idempotency_key)
);

create table trading.fills (
  id bigint generated always as identity primary key,
  order_id uuid not null references trading.orders (id),
  account_id uuid not null references trading.accounts (user_id),
  market_id text not null,
  -- The outcome token the price came from: YES and NO have separate books.
  token_id text not null,
  outcome text not null check (outcome in ('YES', 'NO')),
  side text not null check (side in ('buy', 'sell')),
  price numeric(20, 6) not null check (price > 0 and price <= 1),
  quantity numeric(20, 6) not null check (quantity > 0),
  -- price * quantity, exact.
  amount numeric(20, 6) not null check (amount > 0),
  quote_observed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index fills_account_idx on trading.fills (account_id, id desc);
-- Serves the per-player paper-liquidity rule: "what did I already fill at this price lately?"
create index fills_liquidity_idx on trading.fills (account_id, token_id, side, price, created_at);

create function trading.forbid_history_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end
$$;
create trigger orders_append_only before update or delete on trading.orders for each row execute function trading.forbid_history_change();
create trigger fills_append_only before update or delete on trading.fills for each row execute function trading.forbid_history_change();

-- ---------------------------------------------------------------------------------------------
-- Positions: what a player holds per outcome token. Average-cost method.
-- ---------------------------------------------------------------------------------------------
create table trading.positions (
  account_id uuid not null references trading.accounts (user_id),
  token_id text not null,
  market_id text not null,
  outcome text not null check (outcome in ('YES', 'NO')),
  -- Kept so the position stays readable after the market leaves the active catalog.
  question text not null,
  quantity numeric(20, 6) not null default 0 check (quantity >= 0),
  -- Power paid for the shares still held (average-cost method).
  cost_basis numeric(20, 6) not null default 0 check (cost_basis >= 0),
  realized_pnl numeric(20, 6) not null default 0,
  status text not null default 'open' check (status in ('open', 'settled')),
  settled_at timestamptz,
  -- Last known valuation. Written by the valuation worker only when it moved meaningfully (never per tick).
  last_mark numeric(20, 6) check (last_mark is null or (last_mark >= 0 and last_mark <= 1)),
  last_mark_at timestamptz,
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, token_id),
  check ((status = 'settled') = (settled_at is not null))
);

create index positions_open_by_market_idx on trading.positions (market_id) where quantity > 0 and status = 'open';

-- ---------------------------------------------------------------------------------------------
-- Settlements: one row per market the provider officially resolved. Existence blocks further trading in it.
-- ---------------------------------------------------------------------------------------------
create table trading.settlements (
  market_id text primary key,
  winning_outcome text not null check (winning_outcome in ('YES', 'NO')),
  detail text not null,
  recorded_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Same defence in depth as the rest of this schema: no browser-facing role, RLS with no policies.
-- ---------------------------------------------------------------------------------------------
alter table trading.orders enable row level security;
alter table trading.fills enable row level security;
alter table trading.positions enable row level security;
alter table trading.settlements enable row level security;
do $$
declare
  browser_role text;
begin
  foreach browser_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = browser_role) then
      execute format('revoke all on all tables in schema trading from %I', browser_role);
      execute format('revoke all on all sequences in schema trading from %I', browser_role);
    end if;
  end loop;
end
$$;
