/**
 * Performance guards, written as COUNTS of database statements. Against a remote Supabase pooler every statement costs a
 * full network round trip (about 165 ms measured from a developer machine), so page load time is, almost exactly, the
 * number of sequential statements times that. A throwaway local Postgres is too fast to show the difference in
 * milliseconds, so these tests assert the number instead: a regression to the old behaviour fails them immediately.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTradingAccount, provisionTradingAccount } from "../src/accounts/trading-accounts.ts";
import { createApp } from "../src/http/create-app.ts";
import { getPortfolio } from "../src/league/league.ts";
import { ValuationService } from "../src/league/valuation.ts";
import { confirmTrade, previewTrade } from "../src/trades/trade-service.ts";
import { FakeCatalog } from "./support/fake-catalog.ts";
import { startTestDatabase, type TestDatabase } from "./support/test-database.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
}, 120_000);
afterAll(async () => db?.stop());
beforeEach(async () => db.reset());

/** A pool that counts every statement sent through it, including those on a connection checked out with connect(). */
function counted(pool: pg.Pool) {
  let statements = 0;
  const proxy = new Proxy(pool, {
    get(target, property) {
      if (property === "query") {
        return (...args: unknown[]) => {
          statements++;
          return (target.query as unknown as (...a: unknown[]) => unknown)(...args);
        };
      }
      if (property === "connect") {
        return async () => {
          const client = await target.connect();
          // Wrap, never modify: the pool reuses this same connection object for later callers.
          return new Proxy(client, {
            get(inner, key) {
              if (key === "query") {
                return (...args: unknown[]) => {
                  statements++;
                  return (inner.query as unknown as (...a: unknown[]) => unknown)(...args);
                };
              }
              const member = Reflect.get(inner, key, inner) as unknown;
              return typeof member === "function" ? (member as (...a: unknown[]) => unknown).bind(inner) : member;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as pg.Pool;
  return { pool: proxy, count: () => statements, reset: () => void (statements = 0) };
}

describe("reading an account", () => {
  it("is ONE statement, and returns exactly what the multi-statement version did (cash and history agree)", async () => {
    const created = await provisionTradingAccount(db.pool, A);
    const spy = counted(db.pool);
    const read = await getTradingAccount(spy.pool, A);
    expect(spy.count()).toBe(1);
    expect(read).toEqual(created);
    expect(read!.activity).toHaveLength(1);
    expect(read!.cash.available).toBe("10000.000000");
  });

  it("an unknown player is also ONE statement", async () => {
    const spy = counted(db.pool);
    expect(await getTradingAccount(spy.pool, A)).toBeNull();
    expect(spy.count()).toBe(1);
  });

  it("history is newest first and capped, still in one statement", async () => {
    await provisionTradingAccount(db.pool, A);
    for (let i = 0; i < 60; i++) await db.pool.query("insert into trading.ledger_entries (account_id, entry_type, amount, settlement_market_id) values ($1, 'settlement_payout', 1, $2)", [A, `m${i}`]);
    const spy = counted(db.pool);
    const account = await getTradingAccount(spy.pool, A);
    expect(spy.count()).toBe(1);
    expect(account!.activity).toHaveLength(50);
    expect(account!.activity[0]!.type).toBe("settlement_payout");
    expect(account!.cash.available).toBe("10060.000000");
  });
});

describe("the account endpoint that /dashboard and /world call", () => {
  let server: Server;
  let baseUrl: string;
  let spy: ReturnType<typeof counted>;
  let valuation: ValuationService;
  beforeAll(async () => {
    spy = counted(db.pool);
    const catalog = new FakeCatalog();
    valuation = new ValuationService({ pool: spy.pool, catalog, ttlMs: 5_000 });
    server = createServer(createApp({ pool: spy.pool, catalog, valuation }));
    baseUrl = await new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  });
  afterAll(async () => new Promise((resolve) => server.close(resolve)));
  const put = (id: string) => fetch(`${baseUrl}/internal/v1/accounts/${id}`, { method: "PUT" });

  it("for a player who already exists: ONE statement, and it does NOT throw away the cached valuation", async () => {
    await put(A); // creates it
    await valuation.snapshot(); // warm the cache
    spy.reset();
    for (let i = 0; i < 5; i++) expect((await put(A)).status).toBe(200); // five page views
    expect(spy.count()).toBe(5); // one statement each, nothing else
    await valuation.snapshot();
    await valuation.snapshot();
    expect(spy.count()).toBe(5); // the valuation was still cached: page views no longer force a recompute
  });

  it("for a brand-new player: it creates the account and grant once, and the World learns about them", async () => {
    await valuation.snapshot();
    spy.reset();
    const response = await put(B);
    expect(response.status).toBe(200);
    expect(spy.count()).toBeGreaterThan(1); // the creating transaction
    const before = spy.count();
    const snapshot = await valuation.snapshot(); // the new account invalidated the cache, so this recomputes
    expect(spy.count()).toBe(before + 1);
    expect(snapshot.byUser.has(B)).toBe(true);
    const grants = await db.pool.query("select count(*)::int as n from trading.ledger_entries where entry_type = 'starting_grant' and account_id = $1", [B]);
    expect(grants.rows[0].n).toBe(1);
    await put(B);
    await put(B);
    expect((await db.pool.query("select count(*)::int as n from trading.ledger_entries where account_id = $1", [B])).rows[0].n).toBe(1); // never a second grant
  });

  it("two simultaneous first visits still create exactly one account and one grant", async () => {
    const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const responses = await Promise.all([put(C), put(C), put(C), put(C)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect((await db.pool.query("select count(*)::int as n from trading.accounts where user_id = $1", [C])).rows[0].n).toBe(1);
    expect((await db.pool.query("select count(*)::int as n from trading.ledger_entries where account_id = $1", [C])).rows[0].n).toBe(1);
  });
});

describe("the valuation", () => {
  it("is computed with ONE statement (it used to be four: begin, select, select, commit)", async () => {
    await provisionTradingAccount(db.pool, A);
    await provisionTradingAccount(db.pool, B);
    const spy = counted(db.pool);
    const valuation = new ValuationService({ pool: spy.pool, catalog: new FakeCatalog(), ttlMs: 0 });
    const snapshot = await valuation.snapshot();
    expect(spy.count()).toBe(1);
    expect(snapshot.players.map((p) => [p.rank, p.totalMicro])).toEqual([[1, 10_000_000_000n], [1, 10_000_000_000n]]);
  });

  it("serves a slightly old snapshot at once and refreshes in the background; a page view never waits for it", async () => {
    await provisionTradingAccount(db.pool, A);
    const spy = counted(db.pool);
    let clock = 1_000_000;
    const valuation = new ValuationService({ pool: spy.pool, catalog: new FakeCatalog(), ttlMs: 5_000, now: () => clock });
    const first = await valuation.snapshot();
    expect(spy.count()).toBe(1);

    clock += 3_000; // fresh
    expect(await valuation.snapshot()).toBe(first);
    expect(spy.count()).toBe(1);

    clock += 10_000; // expired, but only a little: returned immediately, refreshed behind the scenes
    expect(await valuation.snapshot()).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(spy.count()).toBe(2);
    expect(await valuation.snapshot()).not.toBe(first); // the background refresh replaced it

    clock += 120_000; // far too old to show: computed before answering
    const old = await valuation.snapshot();
    expect(await valuation.snapshot()).toBe(old);
  });

  it("right after a trade the trader sees it at once, never the old snapshot", async () => {
    await provisionTradingAccount(db.pool, A);
    const catalog = new FakeCatalog();
    catalog.addMarket("1");
    const valuation = new ValuationService({ pool: db.pool, catalog, ttlMs: 5_000 });
    const deps = { pool: db.pool, catalog, onChange: () => valuation.invalidate() };
    const cashBefore = (await getPortfolio(db.pool, await valuation.snapshot(), A))!.availablePower;
    const preview = await previewTrade(deps, A, { marketId: "1", outcome: "YES", side: "buy", budget: "1000" });
    await confirmTrade(deps, A, { marketId: "1", outcome: "YES", side: "buy", quantity: preview.quantity, limit: preview.limit.amount, idempotencyKey: "perf-key-0001" });
    const after = (await getPortfolio(db.pool, await valuation.snapshot(), A))!;
    expect(cashBefore).toBe("10000.000000");
    expect(after.availablePower).toBe("9000.000000");
    expect(after.positions).toHaveLength(1);
  });
});
