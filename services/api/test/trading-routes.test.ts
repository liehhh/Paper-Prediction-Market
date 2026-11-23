/**
 * The API's trade, portfolio, league and market-quote routes over real HTTP. Supabase Auth, trading and the catalog are
 * tiny fake servers, so these tests prove WHO the API acts for and WHAT it is willing to say to whom.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKENS: Record<string, string> = { "token-a": A, "token-b": B };
const KEY = "retry-key-0001";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});
const listen = (server: Server): Promise<string> => {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
};
const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => resolve(text));
  });

const preview = {
  marketId: "1001", question: "Will the fixture happen?", outcome: "YES", side: "buy", quantity: "4000.000000", amount: "2000.000000",
  averagePrice: "0.500000", limit: { kind: "max_spend", amount: "2000.000000" }, budget: "2000.000000", unspent: "0.000000",
  fills: [{ price: "0.500000", quantity: "4000.000000", amount: "2000.000000" }], quoteObservedAt: "2026-11-23T12:00:00.000Z",
  quoteServerTime: "2026-11-23T12:00:01.000Z", availablePower: "10000.000000", sharesOwned: "0.000000",
};
const receipt = {
  orderId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", marketId: "1001", question: "Will the fixture happen?", outcome: "YES", side: "buy",
  quantity: "4000.000000", amount: "2000.000000", averagePrice: "0.500000", unspent: "0.000000", fills: preview.fills,
  quoteObservedAt: "2026-11-23T12:00:00.000Z", executedAt: "2026-11-23T12:00:02.000Z", replayed: false,
};
const portfolio = {
  asOf: "2026-11-23T12:00:00.000Z", username: "ada", availablePower: "8000.000000", reservedPower: "0.000000", sharesValue: "2000.000000",
  totalPower: "10000.000000", rank: 1, realizedPnl: "0.000000", unrealizedPnl: "0.000000", positions: [], fills: [],
};
const quote = {
  market: { id: "1001", question: "Will the fixture happen?", rules: "Rules text.", resolutionSource: null, expectedEndAt: null, status: "open", tradingSupported: true, unsupportedReason: null, sourceUrl: null },
  feed: { state: "live", observedAt: "2026-11-23T12:00:00.000Z", executable: true, pausedReason: null },
  yes: { tokenId: "1", bids: [], asks: [], observedAt: "2026-11-23T12:00:00.000Z" },
  no: { tokenId: "2", bids: [], asks: [], observedAt: "2026-11-23T12:00:00.000Z" },
  tickSize: "0.01", serverTime: "2026-11-23T12:00:01.000Z",
};

async function startApi(options: { tradingReply?: (path: string, body: string) => { status: number; body: unknown } } = {}) {
  const tradingSeen: Array<{ method: string; path: string; body: string }> = [];
  const catalogSeen: string[] = [];
  const authUrl = await listen(
    createServer((req, res) => {
      const userId = TOKENS[(req.headers.authorization ?? "").replace("Bearer ", "")];
      if (!userId) return void res.writeHead(401, { "content-type": "application/json" }).end("{}");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: userId }));
    }),
  );
  const tradingUrl = await listen(
    createServer(async (req, res) => {
      const body = await readBody(req);
      tradingSeen.push({ method: req.method!, path: req.url!, body });
      const reply = options.tradingReply?.(req.url!, body);
      if (reply) return void res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
      const path = req.url!;
      const json = path.endsWith("/trades/preview") ? preview : path.endsWith("/trades") ? receipt : path.endsWith("/portfolio") ? portfolio
        : path === "/internal/v1/league" ? { asOf: "2026-11-23T12:00:00.000Z", countries: [{ countryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", username: "ada", color: "#39d065", slot: 1, rank: 1, relativeSize: 0.515, avatarKey: null, areaWeight: 1.06,
              // Anything below must never reach a visitor, even if trading sent it by mistake:
              balance: "10600.000000", userId: A, shares: "4000.000000", cash: "8000.000000" }] }
        : { username: "ada" };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(json));
    }),
  );
  const catalogUrl = await listen(
    createServer(async (req, res) => {
      const body = await readBody(req);
      catalogSeen.push(`${req.method} ${req.url} ${body}`);
      const ids = (JSON.parse(body || "{}") as { marketIds?: string[] }).marketIds ?? [];
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ quotes: ids.includes("1001") ? [quote] : [] }));
    }),
  );
  const apiUrl = await listen(
    createServer(
      createApp({
        marketCatalog: { baseUrl: catalogUrl, timeoutMs: 2000 },
        trading: { baseUrl: tradingUrl, timeoutMs: 2000 },
        auth: { url: authUrl, publishableKey: "pk_test", timeoutMs: 2000 },
      }),
    ),
  );
  return { apiUrl, tradingSeen, catalogSeen };
}

const post = (url: string, token: string | null, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const buyPreview = { marketId: "1001", outcome: "YES", side: "buy", budget: "2000" };
const confirm = { marketId: "1001", outcome: "YES", side: "buy", quantity: "4000.000000", limit: "2000.000000", idempotencyKey: KEY };

describe("signed-in only", () => {
  it.each([
    ["POST", "/v1/me/trades/preview", buyPreview],
    ["POST", "/v1/me/trades", confirm],
    ["GET", "/v1/me/portfolio", undefined],
    ["PUT", "/v1/me/username", { username: "ada" }],
  ])("%s %s without a valid token is 401 and never reaches trading", async (method, path, body) => {
    const { apiUrl, tradingSeen } = await startApi();
    for (const token of [null, "forged"]) {
      const response = await fetch(apiUrl + path, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(response.status).toBe(401);
    }
    expect(tradingSeen).toHaveLength(0);
  });
});

describe("who is trading", () => {
  it("the player is the verified token's user; a user id in the body, query or headers is ignored", async () => {
    const { apiUrl, tradingSeen } = await startApi();
    const response = await fetch(`${apiUrl}/v1/me/trades?userId=${B}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token-a", "x-user-id": B },
      body: JSON.stringify({ ...confirm, userId: B, accountId: B }),
    });
    expect(response.status).toBe(201);
    expect(tradingSeen).toHaveLength(1);
    expect(tradingSeen[0]!.path).toBe(`/internal/v1/accounts/${A}/trades`);
    expect(JSON.parse(tradingSeen[0]!.body)).toEqual(confirm); // only the order itself is forwarded
  });

  it("each player's portfolio request names that player only", async () => {
    const { apiUrl, tradingSeen } = await startApi();
    await fetch(`${apiUrl}/v1/me/portfolio`, { headers: { authorization: "Bearer token-a" } });
    await fetch(`${apiUrl}/v1/me/portfolio`, { headers: { authorization: "Bearer token-b" } });
    expect(tradingSeen.map((r) => r.path)).toEqual([`/internal/v1/accounts/${A}/portfolio`, `/internal/v1/accounts/${B}/portfolio`]);
  });

  it("preview returns the quote summary; a replayed confirmation answers 200 with the original receipt", async () => {
    const { apiUrl } = await startApi({ tradingReply: (path) => (path.endsWith("/trades") ? { status: 200, body: { ...receipt, replayed: true } } : { status: 200, body: preview }) });
    expect(await (await post(`${apiUrl}/v1/me/trades/preview`, "token-a", buyPreview)).json()).toMatchObject({ quantity: "4000.000000", averagePrice: "0.500000" });
    const again = await post(`${apiUrl}/v1/me/trades`, "token-a", confirm);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ replayed: true, orderId: receipt.orderId });
  });
});

describe("validation", () => {
  it.each([
    ["a buy with no budget", `${"/v1/me/trades/preview"}`, { marketId: "1001", outcome: "YES", side: "buy" }],
    ["a sell with a budget", "/v1/me/trades/preview", { marketId: "1001", outcome: "YES", side: "sell", budget: "5" }],
    ["a negative budget", "/v1/me/trades/preview", { ...buyPreview, budget: "-5" }],
    ["scientific notation", "/v1/me/trades/preview", { ...buyPreview, budget: "1e3" }],
    ["an unknown outcome", "/v1/me/trades/preview", { ...buyPreview, outcome: "MAYBE" }],
    ["a missing idempotency key", "/v1/me/trades", { ...confirm, idempotencyKey: undefined }],
    ["a short idempotency key", "/v1/me/trades", { ...confirm, idempotencyKey: "abc" }],
  ])("rejects %s with 400 before trading is asked", async (_name, path, body) => {
    const { apiUrl, tradingSeen } = await startApi();
    const response = await post(apiUrl + path, "token-a", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(tradingSeen).toHaveLength(0);
  });

  it("rejects a bad username with 400 before trading is asked", async () => {
    const { apiUrl, tradingSeen } = await startApi();
    for (const username of ["a b", "ab", "x".repeat(21), "<script>"]) {
      const response = await fetch(`${apiUrl}/v1/me/username`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer token-a" }, body: JSON.stringify({ username }) });
      expect(response.status).toBe(400);
    }
    expect(tradingSeen).toHaveLength(0);
  });

  it("changes the caller's own username only", async () => {
    const { apiUrl, tradingSeen } = await startApi();
    const response = await fetch(`${apiUrl}/v1/me/username`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer token-b" }, body: JSON.stringify({ username: "Bea_2", userId: A }) });
    expect(response.status).toBe(200);
    expect(tradingSeen[0]!.path).toBe(`/internal/v1/accounts/${B}/username`);
    expect(JSON.parse(tradingSeen[0]!.body)).toEqual({ username: "Bea_2" });
  });

  it("rejects a body that is not JSON", async () => {
    const { apiUrl } = await startApi();
    const response = await fetch(`${apiUrl}/v1/me/trades`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token-a" }, body: "{oops" });
    expect(response.status).toBe(400);
  });
});

describe("refusals the player should read", () => {
  it("passes a price_moved refusal through with its fresh preview", async () => {
    const { apiUrl } = await startApi({ tradingReply: () => ({ status: 409, body: { error: { code: "price_moved", message: "The price moved." }, preview } }) });
    const response = await post(`${apiUrl}/v1/me/trades`, "token-a", confirm);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "price_moved" }, preview: { quantity: "4000.000000" } });
  });

  it.each([
    [409, "insufficient_power"],
    [409, "quote_paused"],
    [409, "idempotency_key_reused"],
    [404, "market_not_found"],
    [503, "catalog_unavailable"],
  ])("passes %s %s through unchanged", async (status, code) => {
    const { apiUrl } = await startApi({ tradingReply: () => ({ status, body: { error: { code, message: "Reason." } } }) });
    const response = await post(`${apiUrl}/v1/me/trades`, "token-a", confirm);
    if (status === 503) return void expect(response.status).toBe(503); // an outage is never presented as a refusal body
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  });

  it("never leaks internals when trading misbehaves", async () => {
    const { apiUrl } = await startApi({ tradingReply: () => ({ status: 500, body: { stack: "secret stack at C:/internal/path" } }) });
    const response = await post(`${apiUrl}/v1/me/trades`, "token-a", confirm);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/secret|stack|internal/);
  });
});

describe("public league", () => {
  it("needs no sign-in and exposes ONLY country id, username, colour, slot, rank and rounded size", async () => {
    const { apiUrl } = await startApi();
    const response = await fetch(`${apiUrl}/v1/league`);
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { countries: Array<Record<string, unknown>> };
    expect(Object.keys(body.countries[0]!).sort()).toEqual(["areaWeight", "avatarUrl", "color", "countryId", "rank", "relativeSize", "slot", "username"]);
    for (const secret of ["balance", "10600", "8000", "cash", "shares", "4000", A]) expect(text).not.toContain(secret);
  });

  it("serves no private route without a token: portfolio and trades are not public", async () => {
    const { apiUrl } = await startApi();
    expect((await fetch(`${apiUrl}/v1/me/portfolio`)).status).toBe(401);
    expect((await fetch(`${apiUrl}/v1/portfolio`)).status).toBe(404);
    expect((await fetch(`${apiUrl}/v1/accounts/${A}`)).status).toBe(404);
  });
});

describe("market detail and quote", () => {
  it("returns the question, rules, status and live quote without sign-in", async () => {
    const { apiUrl, catalogSeen } = await startApi();
    const response = await fetch(`${apiUrl}/v1/markets/1001`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ market: { question: "Will the fixture happen?", rules: "Rules text.", status: "open" }, feed: { state: "live", executable: true } });
    expect(JSON.parse(catalogSeen[0]!.split(" ").slice(2).join(" "))).toEqual({ marketIds: ["1001"], intent: "view" });
  });

  it("404 for an unknown market and for a malformed id (the catalog is not asked)", async () => {
    const { apiUrl, catalogSeen } = await startApi();
    expect((await fetch(`${apiUrl}/v1/markets/424242`)).status).toBe(404);
    expect((await fetch(`${apiUrl}/v1/markets/abc`)).status).toBe(404);
    expect((await fetch(`${apiUrl}/v1/markets/1%27%20or%201=1`)).status).toBe(404);
    expect(catalogSeen).toHaveLength(1); // only the well-formed unknown id was forwarded
  });
});
