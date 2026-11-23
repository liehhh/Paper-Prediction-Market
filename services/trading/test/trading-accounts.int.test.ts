/**
 * Integration tests: the real provisioning transaction against a throwaway PostgreSQL
 * (see support/test-database.ts). Never the hosted development project.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TradingAccountResponseSchema } from "@league/trading-contract";
import { getTradingAccount, provisionTradingAccount, STARTING_GRANT_CREDITS } from "../src/accounts/trading-accounts.ts";
import { createApp } from "../src/http/create-app.ts";
import { ValuationService } from "../src/league/valuation.ts";
import { FakeCatalog } from "./support/fake-catalog.ts";
import { startTestDatabase, type TestDatabase } from "./support/test-database.ts";

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
}, 120_000);
afterAll(async () => db?.stop());
beforeEach(async () => db.reset());

const BEKA = "11111111-1111-4111-8111-111111111111";
const SAM = "22222222-2222-4222-8222-222222222222";

const counts = async () => {
  const { rows } = await db.pool.query(
    `select (select count(*)::int from trading.accounts) as accounts,
            (select count(*)::int from trading.ledger_entries where entry_type = 'starting_grant') as grants`,
  );
  return rows[0] as { accounts: number; grants: number };
};

/** The ledger is the source of truth; this is the independent, in-database sum a test compares against. */
const ledgerSum = async (userId: string) => {
  const { rows } = await db.pool.query("select coalesce(sum(amount), 0)::text as total from trading.ledger_entries where account_id = $1", [userId]);
  return rows[0].total as string;
};

describe("provisionTradingAccount", () => {
  it("creates one account and one grant of exactly 10,000 credits", async () => {
    const account = await provisionTradingAccount(db.pool, BEKA);

    expect(TradingAccountResponseSchema.safeParse(account).success).toBe(true);
    expect(account.cash.available).toBe("10000.000000");
    expect(account.activity).toHaveLength(1);
    expect(account.activity[0]).toMatchObject({ type: "starting_grant", amount: "10000.000000" });
    expect(await counts()).toEqual({ accounts: 1, grants: 1 });
    expect(await ledgerSum(BEKA)).toBe("10000.000000");
    expect(STARTING_GRANT_CREDITS).toBe("10000.000000");
  });

  it("repeated provisioning (every sign-in, every retry) returns the same account and leaves the balance unchanged", async () => {
    const first = await provisionTradingAccount(db.pool, BEKA);
    const second = await provisionTradingAccount(db.pool, BEKA);
    const third = await provisionTradingAccount(db.pool, BEKA);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(await counts()).toEqual({ accounts: 1, grants: 1 });
    expect(third.cash.available).toBe("10000.000000");
  });

  it("if the first request commits but the client never saw the response, a retry returns the same account", async () => {
    await provisionTradingAccount(db.pool, BEKA); // response "lost": the result is thrown away
    const retried = await provisionTradingAccount(db.pool, BEKA);
    const readBack = await getTradingAccount(db.pool, BEKA);

    expect(retried).toEqual(readBack);
    expect(retried.activity).toHaveLength(1);
    expect(await counts()).toEqual({ accounts: 1, grants: 1 });
  });

  it("concurrent first-time requests on independent connections produce one account and one grant", async () => {
    // Each pool holds its own physical connection, so these 12 transactions genuinely overlap in Postgres.
    const pools = Array.from({ length: 12 }, () => new pg.Pool({ connectionString: db.databaseUrl, max: 1 }));
    try {
      const results = await Promise.all(pools.map((pool) => provisionTradingAccount(pool, BEKA)));

      expect(await counts()).toEqual({ accounts: 1, grants: 1 });
      expect(await ledgerSum(BEKA)).toBe("10000.000000");
      for (const result of results) {
        expect(result.cash.available).toBe("10000.000000");
        expect(result.activity).toHaveLength(1);
        expect(result.activity[0]!.id).toBe(results[0]!.activity[0]!.id); // everyone saw the SAME grant row
        expect(result.openedAt).toBe(results[0]!.openedAt);
      }
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });

  it("a failure between creating the account and inserting the grant rolls back both", async () => {
    // Make the SECOND statement of the transaction fail, after the account insert already ran.
    await db.pool.query(`
      create function trading.test_fail_grant() returns trigger language plpgsql as
      $$ begin raise exception 'simulated failure while inserting the grant'; end $$`);
    await db.pool.query("create trigger test_fail_grant before insert on trading.ledger_entries for each row execute function trading.test_fail_grant()");
    try {
      await expect(provisionTradingAccount(db.pool, BEKA)).rejects.toThrow(/simulated failure/);
      expect(await counts()).toEqual({ accounts: 0, grants: 0 }); // no half-built account
      expect(await getTradingAccount(db.pool, BEKA)).toBeNull();
    } finally {
      await db.pool.query("drop trigger test_fail_grant on trading.ledger_entries");
      await db.pool.query("drop function trading.test_fail_grant()");
    }

    // And the user can simply retry afterwards.
    const retried = await provisionTradingAccount(db.pool, BEKA);
    expect(retried.cash.available).toBe("10000.000000");
    expect(await counts()).toEqual({ accounts: 1, grants: 1 });
  });

  it("gives a second user their own account, and activity never leaks between users", async () => {
    const beka = await provisionTradingAccount(db.pool, BEKA);
    const sam = await provisionTradingAccount(db.pool, SAM);

    expect(await counts()).toEqual({ accounts: 2, grants: 2 });
    expect(sam.activity).toHaveLength(1);
    expect(sam.activity[0]!.id).not.toBe(beka.activity[0]!.id);
    const bekaAgain = await getTradingAccount(db.pool, BEKA);
    expect(bekaAgain).toEqual(beka);
    expect(await ledgerSum(SAM)).toBe("10000.000000");
  });
});

describe("ledger integrity (enforced by Postgres)", () => {
  it("allows only one starting grant per account even if code tried to insert a second", async () => {
    await provisionTradingAccount(db.pool, BEKA);
    await expect(
      db.pool.query("insert into trading.ledger_entries (account_id, entry_type, amount) values ($1, 'starting_grant', 10000)", [BEKA]),
    ).rejects.toThrow(/ledger_one_starting_grant_per_account/);
  });

  it("is append-only: entries cannot be edited or deleted", async () => {
    await provisionTradingAccount(db.pool, BEKA);
    await expect(db.pool.query("update trading.ledger_entries set amount = 1")).rejects.toThrow(/append-only/);
    await expect(db.pool.query("delete from trading.ledger_entries")).rejects.toThrow(/append-only/);
    expect(await ledgerSum(BEKA)).toBe("10000.000000");
  });

  it("does exact decimal arithmetic: 0.1 + 0.2 is exactly 0.3 in the ledger, unlike a JavaScript number", async () => {
    const { rows } = await db.pool.query("select (0.1::numeric(20, 6) + 0.2::numeric(20, 6))::text as total");
    expect(rows[0].total).toBe("0.300000");
    expect(0.1 + 0.2).not.toBe(0.3); // the reason credits never become JS numbers
  });
});

describe("internal HTTP interface", () => {
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    const catalog = new FakeCatalog();
    server = createServer(createApp({ pool: db.pool, catalog, valuation: new ValuationService({ pool: db.pool, catalog, ttlMs: 0 }) }));
    baseUrl = await new Promise<string>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
    );
  });
  afterAll(async () => new Promise((resolve) => server.close(resolve)));

  it("GET before provisioning is 404, PUT provisions, GET then reads it", async () => {
    expect((await fetch(`${baseUrl}/internal/v1/accounts/${BEKA}`)).status).toBe(404);

    const put = await fetch(`${baseUrl}/internal/v1/accounts/${BEKA}`, { method: "PUT" });
    expect(put.status).toBe(200);
    expect(TradingAccountResponseSchema.parse(await put.json()).cash.available).toBe("10000.000000");

    const get = await fetch(`${baseUrl}/internal/v1/accounts/${BEKA}`);
    expect(get.status).toBe(200);
    expect(TradingAccountResponseSchema.parse(await get.json()).activity).toHaveLength(1);
  });

  it("ignores any amount or owner the caller tries to send", async () => {
    const response = await fetch(`${baseUrl}/internal/v1/accounts/${BEKA}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-user-id": SAM },
      body: JSON.stringify({ amount: "999999.000000", userId: SAM, grant: 5 }),
    });
    expect(response.status).toBe(200);
    expect(TradingAccountResponseSchema.parse(await response.json()).cash.available).toBe("10000.000000");
    expect(await counts()).toEqual({ accounts: 1, grants: 1 });
    expect(await getTradingAccount(db.pool, SAM)).toBeNull();
  });

  it("rejects a user id that is not a UUID", async () => {
    expect((await fetch(`${baseUrl}/internal/v1/accounts/not-a-uuid`, { method: "PUT" })).status).toBe(400);
    expect(await counts()).toEqual({ accounts: 0, grants: 0 });
  });
});
