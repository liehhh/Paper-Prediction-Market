/**
 * Exercises the public API over real HTTP, with the catalog service replaced by a tiny fake server.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { MarketListResponse } from "@league/catalog-contract";
import { createApp } from "../src/create-app.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

const samplePage: MarketListResponse = {
  markets: [
    {
      id: "1",
      question: "Will X happen?",
      eventTitle: "X?",
      categories: ["politics"],
      expectedEndAt: "2027-01-01T04:59:00.000Z",
      volume24hr: 1000,
      snapshotPrices: { yes: 0.25, no: 0.75, asOf: "2026-11-20T12:00:00.000Z" },
      sourceUrl: "https://polymarket.com/event/x",
      lastSyncedAt: "2026-11-20T12:00:00.000Z",
    },
  ],
  nextCursor: null,
  catalog: { lastSuccessfulRefreshAt: "2026-11-20T12:00:01.000Z", latestAttempt: null },
};

async function startApi(catalogHandler: (url: URL) => { status: number; body: unknown }) {
  const seen: URL[] = [];
  const catalogUrl = await listen(
    createServer((req, res) => {
      const url = new URL(req.url!, "http://catalog");
      seen.push(url);
      const { status, body } = catalogHandler(url);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    }),
  );
  const apiUrl = await listen(createServer(createApp({ marketCatalog: { baseUrl: catalogUrl, timeoutMs: 2000 } })));
  return { apiUrl, seen };
}

describe("GET /v1/markets", () => {
  it("forwards a validated query to the catalog service and returns its page", async () => {
    const { apiUrl, seen } = await startApi(() => ({ status: 200, body: samplePage }));
    const response = await fetch(`${apiUrl}/v1/markets?category=pop-culture&limit=10`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(samplePage);
    expect(seen[0]?.pathname).toBe("/internal/v1/markets");
    expect(seen[0]?.searchParams.get("category")).toBe("pop-culture");
    expect(seen[0]?.searchParams.get("limit")).toBe("10");
  });

  it.each([["category=chess"], ["limit=0"], ["limit=101"], ["limit=abc"]])("rejects %s with the standard error shape", async (qs) => {
    const { apiUrl, seen } = await startApi(() => ({ status: 200, body: samplePage }));
    const response = await fetch(`${apiUrl}/v1/markets?${qs}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(seen).toHaveLength(0);
  });

  it("returns 503 without leaking internals when the catalog service is unreachable", async () => {
    const app = createApp({ marketCatalog: { baseUrl: "http://127.0.0.1:1", timeoutMs: 500 } });
    const apiUrl = await listen(createServer(app));
    const response = await fetch(`${apiUrl}/v1/markets`);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "catalog_unavailable", message: "The market catalog is temporarily unavailable." } });
    expect(text).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|stack/i);
  });

  it("refuses to re-serve a catalog response that breaks the contract", async () => {
    const { apiUrl } = await startApi(() => ({ status: 200, body: { markets: "nope" } }));
    const response = await fetch(`${apiUrl}/v1/markets`);
    expect(response.status).toBe(503);
  });

  it("passes an invalid cursor through as a 400", async () => {
    const { apiUrl } = await startApi(() => ({ status: 400, body: { error: { code: "invalid_cursor", message: "x" } } }));
    const response = await fetch(`${apiUrl}/v1/markets?cursor=bad`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_cursor" } });
  });
});

describe("GET /health", () => {
  it("reports ok", async () => {
    const apiUrl = await listen(createServer(createApp({ marketCatalog: { baseUrl: "http://127.0.0.1:1", timeoutMs: 500 } })));
    expect(await (await fetch(`${apiUrl}/health`)).json()).toEqual({ status: "ok", service: "api" });
  });
});
