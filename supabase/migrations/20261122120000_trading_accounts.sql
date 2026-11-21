-- Trading accounts and the cash ledger.
-- Owner: services/trading. Only that service may read or write objects in the trading schema.
--
-- One database, one schema, one owner: a future fill, its cash movement and its position change
-- must be able to commit in a single transaction, so none of them live in a separate service.

create schema if not exists trading;

-- Not exposed through Supabase's Data API, and no browser-facing role gets any access.
revoke all on schema trading from public;
do $$
declare
  browser_role text;
begin
  foreach browser_role in array array['anon', 'authenticated'] loop
    -- These roles exist on hosted Supabase but not in the plain throwaway test database.
    if exists (select 1 from pg_roles where rolname = browser_role) then
      execute format('revoke all on schema trading from %I', browser_role);
      execute format('revoke all on all tables in schema trading from %I', browser_role);
      execute format('revoke all on all sequences in schema trading from %I', browser_role);
    end if;
  end loop;
end
$$;

-- One row per player. The key is the immutable Supabase Auth user id (auth.users.id), never a
-- username or email. Deliberately no foreign key into Supabase's managed auth schema.
-- The primary key IS the "one trading account per user" guarantee.
create table trading.accounts (
  user_id uuid primary key,
  created_at timestamptz not null default now()
);

-- Every credit movement is a row here. The ledger is the single source of truth: available cash
-- is sum(amount). There is no cached balance column to drift out of agreement with it.
--
-- amount is numeric(20, 6): exact decimal arithmetic, up to 14 integer digits and 6 decimals.
-- It is signed (positive adds cash, negative removes it). Never read it into a JavaScript number.
create table trading.ledger_entries (
  id bigint generated always as identity primary key,
  account_id uuid not null references trading.accounts (user_id),
  entry_type text not null check (entry_type in ('starting_grant')),
  amount numeric(20, 6) not null check (amount <> 0),
  created_at timestamptz not null default now()
);

-- "One starting grant per account", enforced by the database. Two concurrent first requests can
-- both try to insert a grant; this unique index lets exactly one of them win.
create unique index ledger_one_starting_grant_per_account
  on trading.ledger_entries (account_id)
  where entry_type = 'starting_grant';

create index ledger_entries_account_idx on trading.ledger_entries (account_id, id desc);

-- Append-only: money history is corrected by adding an entry, never by editing or deleting one.
create function trading.forbid_ledger_change() returns trigger
language plpgsql as $$
begin
  raise exception 'trading.ledger_entries is append-only';
end
$$;

create trigger ledger_entries_append_only
  before update or delete on trading.ledger_entries
  for each row execute function trading.forbid_ledger_change();

-- Defense in depth: if this schema were ever exposed through the Data API, RLS with no
-- policies denies every non-owner role. The trading service connects as the owner.
alter table trading.accounts enable row level security;
alter table trading.ledger_entries enable row level security;
