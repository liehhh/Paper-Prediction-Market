/**
 * Profile pictures, against a THROWAWAY PostgreSQL. The plain test database has no Supabase `storage` or `auth` schema,
 * so this file builds a minimal stand-in for both BEFORE applying the avatar migration. That lets the migration's real
 * policies run here and be checked: who may create or delete an avatar object, and who may not.
 * (Real Supabase Storage itself is not exercised here; see docs/world.md for what still needs a hosted check.)
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LeagueSnapshotSchema } from "@league/trading-contract";
import { getTradingAccount, provisionTradingAccount, setAvatarKey } from "../src/accounts/trading-accounts.ts";
import { createApp } from "../src/http/create-app.ts";
import { toLeagueSnapshot } from "../src/league/league.ts";
import { ValuationService } from "../src/league/valuation.ts";
import { FakeCatalog } from "./support/fake-catalog.ts";
import { startTestDatabase, type TestDatabase } from "./support/test-database.ts";

const MIGRATION = "20261124120000_player_avatars.sql";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY_1 = "11111111-1111-4111-8111-111111111111.webp";
const KEY_2 = "22222222-2222-4222-8222-222222222222.webp";

/** The slice of Supabase Storage and Auth the policies rely on, with the same names and semantics. */
const SUPABASE_STAND_IN = `
  create role authenticated nologin;
  create schema auth;
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid() to authenticated;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  create function storage.foldername(name text) returns text[] language plpgsql immutable
    as $$ declare parts text[]; begin parts := string_to_array(name, '/'); return parts[1:array_length(parts, 1) - 1]; end $$;
  alter table storage.objects enable row level security;
  grant usage on schema storage to authenticated;
  grant select, insert, delete on storage.objects to authenticated;
`;

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase({ stopBefore: MIGRATION });
  // Two players exist BEFORE the avatar migration, exactly like today's database.
  for (const [id, name] of [[A, "player_a"], [B, "player_b"]]) {
    await db.pool.query("insert into trading.accounts (user_id, username) values ($1, $2)", [id, name]);
    await db.pool.query("insert into trading.ledger_entries (account_id, entry_type, amount) values ($1, 'starting_grant', 10000)", [id]);
  }
  await db.pool.query(SUPABASE_STAND_IN);
  await db.applyRemainingMigrations();
}, 120_000);
afterAll(async () => db?.stop());

const countryOf = async (userId: string) => (await db.pool.query("select country_id::text as c from trading.accounts where user_id = $1", [userId])).rows[0].c as string;

/** Runs SQL as a signed-in Supabase user: role `authenticated` with that user's id in the JWT claims. */
async function asUser<T>(userId: string, fn: (query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    return await fn((sql, params) => client.query(sql, params));
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

describe("the upgrade keeps today's players exactly as they were", () => {
  it("adds the avatar column as NULL, issues no grant, and changes no balance, id or colour slot", async () => {
    const rows = (await db.pool.query("select user_id, avatar_key, username, country_seq::int as seq from trading.accounts order by country_seq")).rows;
    expect(rows.map((r) => [r.user_id, r.avatar_key, r.seq])).toEqual([[A, null, 1], [B, null, 2]]);
    const ledger = (await db.pool.query("select account_id, entry_type, amount::text from trading.ledger_entries order by id")).rows;
    expect(ledger).toEqual([
      { account_id: A, entry_type: "starting_grant", amount: "10000.000000" },
      { account_id: B, entry_type: "starting_grant", amount: "10000.000000" },
    ]);
    expect((await provisionTradingAccount(db.pool, A)).cash.available).toBe("10000.000000");
  });

  it("two existing players with only the grant have equal weight and tied ranks", async () => {
    const valuation = new ValuationService({ pool: db.pool, catalog: new FakeCatalog(), ttlMs: 0 });
    const snapshot = LeagueSnapshotSchema.parse(toLeagueSnapshot(await valuation.snapshot()));
    expect(snapshot.countries.map((c) => [c.rank, c.areaWeight, c.relativeSize, c.avatarKey])).toEqual([[1, 1, 0.5, null], [1, 1, 0.5, null]]);
  });
});

describe("avatar reference", () => {
  it("switching returns the previous key, and nothing else about the player changes", async () => {
    const before = await getTradingAccount(db.pool, A);
    expect(await setAvatarKey(db.pool, A, KEY_1)).toEqual({ previousKey: null });
    expect(await setAvatarKey(db.pool, A, KEY_2)).toEqual({ previousKey: KEY_1 });
    const after = await getTradingAccount(db.pool, A);
    expect(after!.avatarKey).toBe(KEY_2);
    expect({ ...after, avatarKey: null }).toEqual({ ...before, avatarKey: null }); // id, name, balance, history untouched
    const snapshot = toLeagueSnapshot(await new ValuationService({ pool: db.pool, catalog: new FakeCatalog(), ttlMs: 0 }).snapshot());
    expect(snapshot.countries.find((c) => c.countryId === after!.countryId)).toMatchObject({ avatarKey: KEY_2, rank: 1, areaWeight: 1 });
  });

  it("removing restores the colour-only country and keeps its id, colour slot, weight and rank", async () => {
    const valuation = new ValuationService({ pool: db.pool, catalog: new FakeCatalog(), ttlMs: 0 });
    const withPicture = toLeagueSnapshot(await valuation.snapshot()).countries.find((c) => c.avatarKey)!;
    expect(await setAvatarKey(db.pool, A, null)).toEqual({ previousKey: KEY_2 });
    const without = toLeagueSnapshot(await valuation.snapshot()).countries.find((c) => c.countryId === withPicture.countryId)!;
    expect(without).toEqual({ ...withPicture, avatarKey: null }); // same id, username, colour, slot, rank, weight
  });

  it("refuses keys that are not a generated avatar name, and unknown accounts", async () => {
    for (const bad of ["../../etc/passwd", "photo.webp", `${KEY_1}.exe`, "x/y.webp", KEY_1.toUpperCase()]) {
      await expect(setAvatarKey(db.pool, A, bad)).rejects.toThrow(/accounts_avatar_key_format/);
    }
    expect(await setAvatarKey(db.pool, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", KEY_1)).toBeNull();
  });
});

describe("Storage policies (the migration's own SQL, run against the stand-in schemas)", () => {
  it("creates the public avatars bucket limited to small WebP images", async () => {
    const bucket = (await db.pool.query("select id, public, file_size_limit::int as limit, allowed_mime_types from storage.buckets")).rows;
    expect(bucket).toEqual([{ id: "avatars", public: true, limit: 262144, allowed_mime_types: ["image/webp"] }]);
  });

  it("a player can add and remove pictures in their OWN country folder", async () => {
    const a = await countryOf(A);
    await asUser(A, async (q) => {
      await q("insert into storage.objects (bucket_id, name) values ('avatars', $1)", [`${a}/${KEY_1}`]);
      expect((await q("select name from storage.objects")).rows).toHaveLength(1); // can read own, which Storage needs to delete it
      expect((await q("delete from storage.objects where name = $1", [`${a}/${KEY_1}`])).rowCount).toBe(1);
    });
  });

  it("another signed-in player cannot add a picture to someone else's country", async () => {
    const a = await countryOf(A);
    await expect(asUser(B, (q) => q("insert into storage.objects (bucket_id, name) values ('avatars', $1)", [`${a}/${KEY_1}`]))).rejects.toThrow(/row-level security/);
    // Nor in a folder that is no country at all, nor in another bucket.
    await expect(asUser(B, (q) => q("insert into storage.objects (bucket_id, name) values ('avatars', 'whatever/x.webp')"))).rejects.toThrow(/row-level security/);
    await expect(asUser(B, async (q) => q("insert into storage.objects (bucket_id, name) values ('other', $1)", [`${await countryOf(B)}/${KEY_1}`]))).rejects.toThrow(/row-level security/);
  });

  it("another player cannot delete, see, or overwrite someone else's picture", async () => {
    const a = await countryOf(A);
    await db.pool.query("insert into storage.objects (bucket_id, name) values ('avatars', $1)", [`${a}/${KEY_2}`]); // A's, put there as the owner role
    await asUser(B, async (q) => {
      expect((await q("select * from storage.objects")).rows).toHaveLength(0); // not even visible
      expect((await q("delete from storage.objects where name = $1", [`${a}/${KEY_2}`])).rowCount).toBe(0);
      await expect(q("update storage.objects set name = 'x' where name = $1", [`${a}/${KEY_2}`])).rejects.toThrow(/permission denied/); // no UPDATE: never overwritten
    });
    expect((await db.pool.query("select count(*)::int as n from storage.objects where name = $1", [`${a}/${KEY_2}`])).rows[0].n).toBe(1);
  });

  it("an ordinary signed-in user still cannot read the trading tables through the helper function", async () => {
    await expect(asUser(A, (q) => q("select * from trading.accounts"))).rejects.toThrow(/permission denied/);
    await expect(asUser(A, (q) => q("select * from trading.ledger_entries"))).rejects.toThrow(/permission denied/);
    // The helper answers only about the caller, as a boolean.
    expect(await asUser(A, async (q) => (await q("select trading.owns_country($1) as yes", [await countryOf(B)])).rows[0]!.yes)).toBe(false);
    expect(await asUser(A, async (q) => (await q("select trading.owns_country($1) as yes", [await countryOf(A)])).rows[0]!.yes)).toBe(true);
  });
});

describe("internal HTTP", () => {
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    const catalog = new FakeCatalog();
    server = createServer(createApp({ pool: db.pool, catalog, valuation: new ValuationService({ pool: db.pool, catalog, ttlMs: 0 }) }));
    baseUrl = await new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  });
  afterAll(async () => new Promise((resolve) => server.close(resolve)));

  const put = (userId: string, body: unknown) =>
    fetch(`${baseUrl}/internal/v1/accounts/${userId}/avatar`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("sets and clears the reference, and the public snapshot carries it", async () => {
    expect(await (await put(B, { avatarKey: KEY_1 })).json()).toEqual({ previousKey: null });
    const league = LeagueSnapshotSchema.parse(await (await fetch(`${baseUrl}/internal/v1/league`)).json());
    expect(league.countries.find((c) => c.avatarKey === KEY_1)).toBeTruthy();
    expect(await (await put(B, { avatarKey: null })).json()).toEqual({ previousKey: KEY_1 });
  });

  it("rejects bad keys with 400 and unknown players with 404", async () => {
    expect((await put(B, { avatarKey: "../x.webp" })).status).toBe(400);
    expect((await put(B, {})).status).toBe(400);
    expect((await put("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { avatarKey: KEY_1 })).status).toBe(404);
  });
});
