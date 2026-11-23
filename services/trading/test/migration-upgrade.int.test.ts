/**
 * Upgrading a database that ALREADY has players: accounts, balances and grant history survive, nobody receives a
 * second grant, and every existing account gets a unique country identity. Throwaway PostgreSQL, never the hosted one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTradingAccount, provisionTradingAccount } from "../src/accounts/trading-accounts.ts";
import { startTestDatabase, type TestDatabase } from "./support/test-database.ts";

const PAPER_TRADES_MIGRATION = "20261123130000_trading_paper_trades.sql";
const BEKA = "11111111-1111-4111-8111-111111111111";
const SAM = "22222222-2222-4222-8222-222222222222";

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase({ stopBefore: PAPER_TRADES_MIGRATION });
}, 120_000);
afterAll(async () => db?.stop());

describe("upgrading existing accounts to paper trading", () => {
  it("keeps every account, balance and grant, issues no second grant, and gives each account a unique identity", async () => {
    // The database as it is today: two players, each with the one starting grant, in the OLD schema.
    for (const id of [BEKA, SAM]) {
      await db.pool.query("insert into trading.accounts (user_id) values ($1)", [id]);
      await db.pool.query("insert into trading.ledger_entries (account_id, entry_type, amount) values ($1, 'starting_grant', 10000)", [id]);
    }
    const before = (await db.pool.query("select user_id, created_at from trading.accounts order by user_id")).rows;
    const grantsBefore = (await db.pool.query("select id::text, account_id, amount::text, created_at from trading.ledger_entries order by id")).rows;

    await db.applyRemainingMigrations();

    const after = (await db.pool.query("select user_id, created_at, username, country_id, country_seq::int from trading.accounts order by user_id")).rows;
    expect(after.map((r) => [r.user_id, r.created_at])).toEqual(before.map((r) => [r.user_id, r.created_at]));
    expect(new Set(after.map((r) => r.username)).size).toBe(2);
    expect(new Set(after.map((r) => r.country_id)).size).toBe(2);
    expect(new Set(after.map((r) => r.country_seq)).size).toBe(2);
    for (const row of after) expect(row.username).toMatch(/^player_[0-9a-f]{12}$/);

    // The grant rows are byte-for-byte what they were: same ids, amounts and timestamps. Still exactly one each.
    const grantsAfter = (await db.pool.query("select id::text, account_id, amount::text, created_at from trading.ledger_entries order by id")).rows;
    expect(grantsAfter).toEqual(grantsBefore);

    // Provisioning again (what every dashboard visit does) neither adds a grant nor changes the account.
    const account = await provisionTradingAccount(db.pool, BEKA);
    expect(account.cash.available).toBe("10000.000000");
    expect(account.activity).toHaveLength(1);
    expect((await getTradingAccount(db.pool, SAM))?.cash.available).toBe("10000.000000");
    const grants = await db.pool.query("select count(*)::int as n from trading.ledger_entries where entry_type = 'starting_grant'");
    expect(grants.rows[0].n).toBe(2);
  });

  it("still refuses a second starting grant", async () => {
    await expect(
      db.pool.query("insert into trading.ledger_entries (account_id, entry_type, amount) values ($1, 'starting_grant', 10000)", [BEKA]),
    ).rejects.toThrow(/ledger_one_starting_grant_per_account/);
  });
});
