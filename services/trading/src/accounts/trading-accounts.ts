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

/** Every account starts with a unique default name so it always has a country label. 12 hex chars of the id. */
export function defaultUsername(userId: string): string {
  return `player_${userId.replaceAll("-", "").slice(0, 12)}`;
}

/**
 * Points the player's profile at a new picture (or at none, with null) and returns what it pointed at before, so the
 * caller can delete the old object AFTER this switch succeeded. Changes nothing else: not the id, colour, slot or Power.
 * Returns null when the account does not exist.
 */
export async function setAvatarKey(pool: pg.Pool, userId: string, avatarKey: string | null): Promise<{ previousKey: string | null } | null> {
  const { rows } = await pool.query<{ previous: string | null }>(
    `with old as (select avatar_key from trading.accounts where user_id = $1 for update)
     update trading.accounts a set avatar_key = $2 from old where a.user_id = $1
     returning old.avatar_key as previous`,
    [userId, avatarKey],
  );
  return rows[0] ? { previousKey: rows[0].previous } : null;
}

export class UsernameTakenError extends Error {
  constructor() {
    super("That username is already taken.");
    this.name = "UsernameTakenError";
  }
}

/** Changes the caller's unique username (their country label). Returns false when the account does not exist. */
export async function setUsername(pool: pg.Pool, userId: string, username: string): Promise<boolean> {
  try {
    const result = await pool.query("update trading.accounts set username = $2 where user_id = $1", [userId, username]);
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new UsernameTakenError(); // unique_violation on lower(username)
    throw error;
  }
}

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
    await client.query("insert into trading.accounts (user_id, username) values ($1, $2) on conflict (user_id) do nothing", [userId, defaultUsername(userId)]);
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

/**
 * Read-only. Returns null when this user has no trading account yet.
 *
 * ONE statement, so ONE database round trip (about 165 ms to a remote Supabase pooler; every extra statement costs that
 * again). It is also still one snapshot: the cash figure and the activity list are computed by the same statement, so
 * they always describe the same ledger, without an explicit transaction.
 */
export async function getTradingAccount(pool: pg.Pool, userId: string): Promise<TradingAccountResponse | null> {
  return readAccount(pool, userId);
}

interface AccountRow {
  created_at: Date;
  username: string;
  country_id: string;
  avatar_key: string | null;
  cash: string;
  /** Newest first. Built inside the same statement, so it matches `cash`. */
  activity: Array<{ id: string; type: LedgerEntryType; amount: string; createdAt: string }>;
}

async function readAccount(db: Queryable, userId: string): Promise<TradingAccountResponse | null> {
  // ::text keeps Postgres's exact decimal; node-postgres would otherwise hand back a string anyway,
  // and nothing here ever turns it into a float.
  const account = await db.query<AccountRow>(
    `select a.created_at, a.username, a.country_id, a.avatar_key,
            (select coalesce(sum(l.amount), 0) from trading.ledger_entries l where l.account_id = a.user_id)::numeric(20, 6)::text as cash,
            coalesce((
              select json_agg(json_build_object('id', e.id::text, 'type', e.entry_type, 'amount', e.amount::text, 'createdAt', e.created_at) order by e.id desc)
                from (select id, entry_type, amount, created_at from trading.ledger_entries
                       where account_id = a.user_id order by id desc limit $2) e
            ), '[]'::json) as activity
       from trading.accounts a
      where a.user_id = $1`,
    [userId, ACTIVITY_LIMIT],
  );
  const row = account.rows[0];
  if (!row) return null;
  return {
    openedAt: row.created_at.toISOString(),
    username: row.username,
    countryId: row.country_id,
    avatarKey: row.avatar_key,
    cash: { available: row.cash },
    activity: row.activity.map((entry) => ({ id: entry.id, type: entry.type, amount: entry.amount, createdAt: new Date(entry.createdAt).toISOString() })),
  };
}
