/**
 * Trading accounts and their cash ledger. Everything that moves credits lives in this service,
 * in this schema, so later milestones can add "fill + cash entry + position change" to ONE
 * transaction here.
 *
 * Accounting rules:
 * 1. An account is identified by the Supabase Auth user id. Callers never choose the grant amount.
 * 2. Available cash is sum(ledger_entries.amount). There is no cached balance to disagree with it.
 * 3. Credits are exact decimals: they stay strings in JavaScript and are summed by Postgres.
 */
import type pg from "pg";
import type { LedgerEntryType, TradingAccountResponse } from "@league/trading-contract";

/** Every new player starts with exactly this many credits, once. Six decimals = numeric(20, 6). */
export const STARTING_GRANT_CREDITS = "10000.000000";
export const ACTIVITY_LIMIT = 50;

type Queryable = Pick<pg.PoolClient, "query">;

/**
 * Creates the account and its starting grant, or returns the existing account unchanged.
 * Safe to call any number of times, from any number of connections at once.
 *
 * Both inserts use `on conflict do nothing`, so the DATABASE settles races, not an
 * "if not exists" check in this code:
 *  - accounts.user_id is the primary key: a second concurrent insert WAITS for the first
 *    transaction to finish, then does nothing.
 *  - ledger_one_starting_grant_per_account is a unique index: only one grant row can ever exist.
 * If anything fails between the two inserts, the transaction rolls back and neither row remains.
 */
export async function provisionTradingAccount(pool: pg.Pool, userId: string): Promise<TradingAccountResponse> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("insert into trading.accounts (user_id) values ($1) on conflict (user_id) do nothing", [userId]);
    await client.query(
      `insert into trading.ledger_entries (account_id, entry_type, amount)
       values ($1, 'starting_grant', $2)
       on conflict (account_id) where entry_type = 'starting_grant' do nothing`,
      [userId, STARTING_GRANT_CREDITS],
    );
    const account = await readAccount(client, userId);
    await client.query("commit");
    if (!account) throw new Error("Trading account missing right after provisioning"); // unreachable unless the DB is broken
    return account;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Read-only. Returns null when this user has no trading account yet. */
export async function getTradingAccount(pool: pg.Pool, userId: string): Promise<TradingAccountResponse | null> {
  const client = await pool.connect();
  try {
    // One snapshot, so the cash figure and the activity list always describe the same ledger.
    await client.query("begin isolation level repeatable read read only");
    const account = await readAccount(client, userId);
    await client.query("commit");
    return account;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface AccountRow {
  created_at: Date;
  cash: string;
}
interface LedgerRow {
  id: string;
  entry_type: LedgerEntryType;
  amount: string;
  created_at: Date;
}

async function readAccount(db: Queryable, userId: string): Promise<TradingAccountResponse | null> {
  // ::text keeps Postgres's exact decimal; node-postgres would otherwise hand back a string anyway,
  // and nothing here ever turns it into a float.
  const account = await db.query<AccountRow>(
    `select a.created_at,
            (select coalesce(sum(l.amount), 0) from trading.ledger_entries l where l.account_id = a.user_id)::numeric(20, 6)::text as cash
       from trading.accounts a
      where a.user_id = $1`,
    [userId],
  );
  const row = account.rows[0];
  if (!row) return null;

  const entries = await db.query<LedgerRow>(
    `select id::text, entry_type, amount::text, created_at
       from trading.ledger_entries
      where account_id = $1
      order by id desc
      limit $2`,
    [userId, ACTIVITY_LIMIT],
  );
  return {
    openedAt: row.created_at.toISOString(),
    cash: { available: row.cash },
    activity: entries.rows.map((entry) => ({
      id: entry.id,
      type: entry.entry_type,
      amount: entry.amount,
      createdAt: entry.created_at.toISOString(),
    })),
  };
}
