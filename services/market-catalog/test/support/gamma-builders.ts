/**
 * Hand-written, *representative* Gamma payloads for tests (not recorded data).
 * Shapes mirror the real API: outcomes/outcomePrices are JSON-encoded strings.
 */
import type { GammaClientOptions } from "../../src/polymarket/gamma-client.ts";

export function gammaMarket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1001",
    question: "Will the test pass?",
    outcomes: '["Yes", "No"]',
    outcomePrices: '["0.25", "0.75"]',
    active: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    endDate: "2027-01-01T04:59:00Z",
    ...overrides,
  };
}

export function gammaEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "501", slug: "test-event", title: "Test event", markets: [gammaMarket()], ...overrides };
}

export interface FakePage {
  events: unknown[];
  next_cursor?: string;
}

/**
 * A fetch stand-in for GET /events/keyset. `pagesByTag[tag][n]` is served for the n-th page;
 * the cursor is simply the next page index. `failTag` makes every request for that tag fail.
 */
export function fakeGamma(pagesByTag: Record<string, FakePage[]>, options: { failTag?: string; failStatus?: number } = {}) {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(`${url.pathname}?${url.searchParams}`);
    const tag = url.searchParams.get("tag_slug") ?? "";
    if (tag === options.failTag) return new Response("upstream down", { status: options.failStatus ?? 503 });
    const pageIndex = Number(url.searchParams.get("after_cursor") ?? "0");
    const page = pagesByTag[tag]?.[pageIndex] ?? { events: [] };
    return Response.json(page);
  }) as typeof fetch;

  const gamma: GammaClientOptions = {
    baseUrl: "https://gamma.test",
    requestTimeoutMs: 1000,
    maxAttemptsPerRequest: 2,
    fetchImpl,
    sleep: async () => undefined,
  };
  return { gamma, requests };
}
