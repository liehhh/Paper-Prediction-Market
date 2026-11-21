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
  return { id: "501", slug: "test-event", title: "Test event", tags: [{ slug: "politics" }], markets: [gammaMarket()], ...overrides };
}

export interface FakePage {
  events: unknown[];
  next_cursor?: string;
}

/**
 * A fetch stand-in for GET /events/keyset. `pages[n]` is served for the n-th page; the cursor is
 * simply the next page index, and the last page has no next_cursor. `failFromPage` (1-based)
 * makes that page and every later one fail, which simulates a scan dying halfway.
 */
export function fakeGamma(pages: FakePage[], options: { failFromPage?: number; failStatus?: number } = {}) {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(`${url.pathname}?${url.searchParams}`);
    const pageIndex = Number(url.searchParams.get("after_cursor") ?? "0");
    if (options.failFromPage !== undefined && pageIndex + 1 >= options.failFromPage) {
      return new Response("upstream down", { status: options.failStatus ?? 503 });
    }
    const page = pages[pageIndex] ?? { events: [] };
    return Response.json({ events: page.events, ...(pageIndex + 1 < pages.length ? { next_cursor: String(pageIndex + 1) } : {}) });
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
