import { describe, expect, it } from "vitest";
import { EVENTS_PAGE_SIZE, fetchActiveEventPages, type GammaClientOptions } from "../src/polymarket/gamma-client.ts";
import { fakeGamma, gammaEvent } from "./support/gamma-builders.ts";

async function collect(options: GammaClientOptions, maxPages = 50) {
  const pages = [];
  for await (const page of fetchActiveEventPages(options, maxPages)) pages.push(page);
  return pages;
}

describe("fetchActiveEventPages (fake HTTP)", () => {
  it("follows next_cursor to the end with the stable id-ordered, open-and-active request", async () => {
    const { gamma, requests } = fakeGamma([{ events: [gammaEvent({ id: "1" })] }, { events: [gammaEvent({ id: "2" })] }, { events: [gammaEvent({ id: "3" })] }]);
    const pages = await collect(gamma);

    expect(pages.map((p) => p.events.length)).toEqual([1, 1, 1]);
    expect(pages.map((p) => p.hasMorePages)).toEqual([true, true, false]);
    expect(requests).toHaveLength(3);
    const first = Object.fromEntries(new URLSearchParams(requests[0]!.split("?")[1]));
    expect(first).toEqual({ closed: "false", active: "true", order: "id", ascending: "true", limit: String(EVENTS_PAGE_SIZE) });
    expect(new URLSearchParams(requests[1]!.split("?")[1]).get("after_cursor")).toBe("1");
  });

  it("stops at maxPages and reports the scan as cut off", async () => {
    const { gamma, requests } = fakeGamma([{ events: [] }, { events: [] }, { events: [] }]);
    const pages = await collect(gamma, 2);
    expect(requests).toHaveLength(2);
    expect(pages.at(-1)?.hasMorePages).toBe(true);
  });

  it("retries transient failures (429 honouring Retry-After, network error) and then succeeds", async () => {
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
    await collect(options);
    expect(calls).toBe(3);
    expect(waits[0]).toBeGreaterThanOrEqual(2000);
  });

  it("throws when a later page keeps failing, instead of returning the pages it had", async () => {
    const { gamma } = fakeGamma([{ events: [gammaEvent({ id: "1" })] }, { events: [gammaEvent({ id: "2" })] }], { failFromPage: 2, failStatus: 503 });
    await expect(collect(gamma)).rejects.toThrow(/503/);
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
    await expect(collect(options)).rejects.toThrow(/422/);
    expect(calls).toBe(1);
  });

  it("rejects a response whose shape is not the documented { events, next_cursor }", async () => {
    const options: GammaClientOptions = {
      baseUrl: "https://gamma.test",
      requestTimeoutMs: 1000,
      maxAttemptsPerRequest: 1,
      fetchImpl: (async () => Response.json([{ id: "1" }])) as typeof fetch,
    };
    await expect(collect(options)).rejects.toThrow(/Unexpected/);
  });
});
