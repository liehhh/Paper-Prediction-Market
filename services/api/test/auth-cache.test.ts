/**
 * Asking Supabase Auth who owns a token is a network round trip (about 400 ms measured) made on EVERY signed-in request,
 * and one page makes several. These tests pin the short in-memory memory of CONFIRMED tokens, and what it must never do.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKENS: Record<string, string> = { "token-a": A, "token-b": B };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});
const listen = (server: Server): Promise<string> => {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
};

async function start(cacheTtlMs?: number) {
  const authCalls: string[] = [];
  const tradingPaths: string[] = [];
  const authUrl = await listen(
    createServer((req, res) => {
      const token = (req.headers.authorization ?? "").replace("Bearer ", "");
      authCalls.push(token);
      const userId = TOKENS[token];
      if (!userId) return void res.writeHead(401).end("{}");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: userId }));
    }),
  );
  const tradingUrl = await listen(
    createServer((req, res) => {
      tradingPaths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ openedAt: "2026-11-22T10:00:00.000Z", username: "u", countryId: "ca000000-0000-4000-8000-00000000000a", avatarKey: null, cash: { available: "10000.000000" }, activity: [] }),
      );
    }),
  );
  const apiUrl = await listen(
    createServer(
      createApp({
        marketCatalog: { baseUrl: "http://127.0.0.1:1", timeoutMs: 100 },
        trading: { baseUrl: tradingUrl, timeoutMs: 2000 },
        auth: { url: authUrl, publishableKey: "pk", timeoutMs: 2000, ...(cacheTtlMs === undefined ? {} : { cacheTtlMs }) },
      }),
    ),
  );
  const get = (token: string) => fetch(`${apiUrl}/v1/me/trading-account`, { headers: { authorization: `Bearer ${token}` } });
  return { get, authCalls, tradingPaths };
}

describe("confirmed-token memory", () => {
  it("by default, several requests with one good token ask Supabase Auth once", async () => {
    const { get, authCalls } = await start();
    for (let i = 0; i < 5; i++) expect((await get("token-a")).status).toBe(200);
    expect(authCalls).toEqual(["token-a"]);
  });

  it("it still tells users apart: each token is checked, and each request acts for its own user", async () => {
    const { get, authCalls, tradingPaths } = await start();
    await get("token-a");
    await get("token-b");
    await get("token-a");
    await get("token-b");
    expect(authCalls).toEqual(["token-a", "token-b"]);
    expect(tradingPaths).toEqual([`/internal/v1/accounts/${A}`, `/internal/v1/accounts/${B}`, `/internal/v1/accounts/${A}`, `/internal/v1/accounts/${B}`]);
  });

  it("a rejected or forged token is NEVER remembered: every attempt is checked and refused", async () => {
    const { get, authCalls, tradingPaths } = await start();
    for (let i = 0; i < 3; i++) expect((await get("forged")).status).toBe(401);
    expect(authCalls).toEqual(["forged", "forged", "forged"]);
    expect(tradingPaths).toHaveLength(0);
  });

  it("requests that arrive AT THE SAME TIME share one check (a page makes several calls at once)", async () => {
    const { get, authCalls } = await start();
    const responses = await Promise.all([get("token-a"), get("token-a"), get("token-a"), get("token-a")]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(authCalls).toEqual(["token-a"]);
  });

  it("simultaneous requests with a forged token are all refused", async () => {
    const { get } = await start();
    const responses = await Promise.all([get("forged"), get("forged"), get("forged")]);
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401]);
  });

  it("the memory expires: after the window, the token is checked again", async () => {
    const { get, authCalls } = await start(60);
    await get("token-a");
    await get("token-a");
    expect(authCalls).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await get("token-a");
    expect(authCalls).toHaveLength(2);
  });

  it("AUTH_CACHE_TTL_MS=0 turns it off: Supabase Auth is asked every time", async () => {
    const { get, authCalls } = await start(0);
    for (let i = 0; i < 3; i++) await get("token-a");
    expect(authCalls).toHaveLength(3);
  });
});
