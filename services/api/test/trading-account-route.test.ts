/**
 * Exercises /v1/me/trading-account over real HTTP. Supabase Auth and the trading service are
 * replaced by tiny fake servers, so the test proves WHO the API asks the trading service about.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { TradingAccountResponse } from "@league/trading-contract";
import { createApp } from "../src/create-app.ts";

const BEKA = "11111111-1111-4111-8111-111111111111";
const SAM = "22222222-2222-4222-8222-222222222222";
const TOKENS: Record<string, string> = { "token-beka": BEKA, "token-sam": SAM };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

const account: TradingAccountResponse = {
  openedAt: "2026-11-22T10:00:00.000Z",
  username: "player_111111111111",
  avatarKey: null,
  countryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  cash: { available: "10000.000000" },
  activity: [{ id: "1", type: "starting_grant", amount: "10000.000000", createdAt: "2026-11-22T10:00:00.000Z" }],
};

async function startApi(options: { tradingStatus?: number; authStatus?: number; withAuth?: boolean } = {}) {
  const authSeen: Array<{ authorization?: string; apikey?: string }> = [];
  const tradingSeen: Array<{ method: string; path: string }> = [];

  const authUrl = await listen(
    createServer((req, res) => {
      authSeen.push({ authorization: req.headers.authorization, apikey: req.headers.apikey as string | undefined });
      if (options.authStatus) return void res.writeHead(options.authStatus).end();
      const userId = TOKENS[(req.headers.authorization ?? "").replace("Bearer ", "")];
      if (!userId) return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ msg: "invalid JWT" }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: userId, email: "private@example.com" }));
    }),
  );
  const tradingUrl = await listen(
    createServer((req, res) => {
      tradingSeen.push({ method: req.method!, path: req.url! });
      if (options.tradingStatus === 404) return void res.writeHead(404, { "content-type": "application/json" }).end("{}");
      if (options.tradingStatus) return void res.writeHead(options.tradingStatus).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(account));
    }),
  );
  const apiUrl = await listen(
    createServer(
      createApp({
        marketCatalog: { baseUrl: "http://127.0.0.1:1", timeoutMs: 100 },
        trading: { baseUrl: tradingUrl, timeoutMs: 2000 },
        auth: options.withAuth === false ? undefined : { url: authUrl, publishableKey: "pk_test", timeoutMs: 2000 },
      }),
    ),
  );
  return { apiUrl, authSeen, tradingSeen };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("unauthenticated requests", () => {
  it.each([
    ["no Authorization header", {}],
    ["a malformed header", { authorization: "Token abc" }],
    ["a token Supabase rejects", { authorization: "Bearer forged" }],
  ])("get 401 for %s on both methods, and never reach the trading service", async (_name, headers) => {
    const { apiUrl, tradingSeen } = await startApi();
    for (const method of ["GET", "PUT"]) {
      const response = await fetch(`${apiUrl}/v1/me/trading-account`, { method, headers });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    }
    expect(tradingSeen).toHaveLength(0);
  });
});

describe("authenticated requests", () => {
  it("asks Supabase Auth about the token, then asks trading about THAT user", async () => {
    const { apiUrl, authSeen, tradingSeen } = await startApi();
    const response = await fetch(`${apiUrl}/v1/me/trading-account`, { method: "PUT", headers: bearer("token-beka") });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(account);
    expect(authSeen[0]).toEqual({ authorization: "Bearer token-beka", apikey: "pk_test" });
    expect(tradingSeen).toEqual([{ method: "PUT", path: `/internal/v1/accounts/${BEKA}` }]);
  });

  it("two users each get their own account lookup; neither can name the other", async () => {
    const { apiUrl, tradingSeen } = await startApi();
    await fetch(`${apiUrl}/v1/me/trading-account`, { headers: bearer("token-beka") });
    await fetch(`${apiUrl}/v1/me/trading-account`, { headers: bearer("token-sam") });

    expect(tradingSeen.map((r) => r.path)).toEqual([`/internal/v1/accounts/${BEKA}`, `/internal/v1/accounts/${SAM}`]);
  });

  it("ignores an owner or grant amount supplied by the client (headers, query, body)", async () => {
    const { apiUrl, tradingSeen } = await startApi();
    const response = await fetch(`${apiUrl}/v1/me/trading-account?userId=${SAM}`, {
      method: "PUT",
      headers: { ...bearer("token-beka"), "content-type": "application/json", "x-user-id": SAM },
      body: JSON.stringify({ userId: SAM, amount: "999999.000000" }),
    });

    expect(response.status).toBe(200);
    expect(tradingSeen).toEqual([{ method: "PUT", path: `/internal/v1/accounts/${BEKA}` }]); // the token's user, only
  });

  it("GET returns 404 trading_account_not_found when the user has no account yet", async () => {
    const { apiUrl } = await startApi({ tradingStatus: 404 });
    const response = await fetch(`${apiUrl}/v1/me/trading-account`, { headers: bearer("token-beka") });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "trading_account_not_found" } });
  });

  it("never exposes the user's email or id in the response", async () => {
    const { apiUrl } = await startApi();
    const text = await (await fetch(`${apiUrl}/v1/me/trading-account`, { headers: bearer("token-beka") })).text();
    expect(text).not.toContain("private@example.com");
    expect(text).not.toContain(BEKA);
  });
});

describe("failure modes", () => {
  it("answers 503 auth_unavailable (not 401) when Supabase Auth itself is down, so the client may retry", async () => {
    const { apiUrl } = await startApi({ authStatus: 500 });
    const response = await fetch(`${apiUrl}/v1/me/trading-account`, { headers: bearer("token-beka") });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "auth_unavailable" } });
  });

  it("answers 503 trading_unavailable when the trading service fails", async () => {
    const { apiUrl } = await startApi({ tradingStatus: 500 });
    const response = await fetch(`${apiUrl}/v1/me/trading-account`, { method: "PUT", headers: bearer("token-beka") });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "trading_unavailable" } });
  });

  it("answers 503 auth_unavailable when sign-in is not configured", async () => {
    const { apiUrl } = await startApi({ withAuth: false });
    const response = await fetch(`${apiUrl}/v1/me/trading-account`, { headers: bearer("token-beka") });
    expect(response.status).toBe(503);
  });
});
