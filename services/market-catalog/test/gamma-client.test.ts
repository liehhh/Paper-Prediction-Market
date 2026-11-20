import { describe, expect, it } from "vitest";
import { fetchOpenEventPages, type GammaClientOptions } from "../src/polymarket/gamma-client.ts";
import { fakeGamma, gammaEvent } from "./support/gamma-builders.ts";

async function collect(options: GammaClientOptions, tag: string, maxPages: number) {
  const pages = [];
  for await (const page of fetchOpenEventPages(options, tag, maxPages)) pages.push(page);
  return pages;
}

describe("fetchOpenEventPages (fake HTTP)", () => {
  it("follows next_cursor until the last page and requests open events by tag", async () => {
    const { gamma, requests } = fakeGamma({
      politics: [{ events: [gammaEvent()], next_cursor: "1" }, { events: [gammaEvent({ id: "502" })] }],
    });
    const pages = await collect(gamma, "politics", 10);
    expect(pages.map((p) => [p.pageNumber, p.events.length, p.hasMorePages])).toEqual([
      [1, 1, true],
      [2, 1, false],
    ]);
    expect(requests[0]).toContain("tag_slug=politics");
    expect(requests[0]).toContain("closed=false");
    expect(requests[0]).toContain("limit=100");
    expect(requests[1]).toContain("after_cursor=1");
  });

  it("stops at the per-run page limit and leaves hasMorePages=true so the caller sees truncation", async () => {
    const { gamma, requests } = fakeGamma({
      politics: [{ events: [], next_cursor: "1" }, { events: [], next_cursor: "2" }, { events: [] }],
    });
    const pages = await collect(gamma, "politics", 2);
    expect(pages).toHaveLength(2);
    expect(pages.at(-1)?.hasMorePages).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it("retries transient failures and then succeeds", async () => {
    let calls = 0;
    const waits: number[] = [];
    const options: GammaClientOptions = {
      baseUrl: "https://gamma.test",
      requestTimeoutMs: 1000,
      maxAttemptsPerRequest: 3,
      sleep: async (ms) => void waits.push(ms),
      fetchImpl: (async () => {
        calls++;
        if (calls === 1) return new Response("busy", { status: 429, headers: { "Retry-After": "2" } });
        if (calls === 2) throw new TypeError("fetch failed");
        return Response.json({ events: [] });
      }) as typeof fetch,
    };
    const pages = await collect(options, "politics", 5);
    expect(pages).toHaveLength(1);
    expect(calls).toBe(3);
    expect(waits[0]).toBeGreaterThanOrEqual(2000); // Retry-After honoured
  });

  it("gives up after the attempt limit instead of returning a short listing", async () => {
    const { gamma } = fakeGamma({}, { failTag: "politics", failStatus: 503 });
    await expect(collect(gamma, "politics", 5)).rejects.toThrow(/503/);
  });

  it("does not retry client errors such as 422", async () => {
    let calls = 0;
    const options: GammaClientOptions = {
      baseUrl: "https://gamma.test",
      requestTimeoutMs: 1000,
      maxAttemptsPerRequest: 4,
      sleep: async () => undefined,
      fetchImpl: (async () => {
        calls++;
        return new Response("bad", { status: 422 });
      }) as typeof fetch,
    };
    await expect(collect(options, "politics", 5)).rejects.toThrow(/422/);
    expect(calls).toBe(1);
  });

  it("rejects a page whose shape is not the documented { events, next_cursor }", async () => {
    const options: GammaClientOptions = {
      baseUrl: "https://gamma.test",
      requestTimeoutMs: 1000,
      maxAttemptsPerRequest: 1,
      fetchImpl: (async () => Response.json([{ id: "1" }])) as typeof fetch,
    };
    await expect(collect(options, "politics", 5)).rejects.toThrow(/Unexpected/);
  });
});
