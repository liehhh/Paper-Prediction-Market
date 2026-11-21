/**
 * HTTP access to Polymarket's Gamma API: paging through every active event, timeouts, retries.
 * Returns raw (unvalidated) events; normalize-market.ts validates each one.
 */
import { GammaEventsPageSchema } from "./gamma-schemas.ts";

export interface GammaClientOptions {
  baseUrl: string;
  requestTimeoutMs: number;
  maxAttemptsPerRequest: number;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Observed 2026-11-21: /events/keyset returns at most 100 events per page, whatever larger
 * `limit` is sent (200 and 500 still gave 100). So this is the real page size.
 */
export const EVENTS_PAGE_SIZE = 100;
const MAX_RETRY_AFTER_MS = 30_000;

export class GammaRequestError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "GammaRequestError";
    this.retryable = retryable;
  }
}

export interface GammaEventsPage {
  pageNumber: number;
  events: unknown[];
  fetchedAt: Date;
  /** True when Gamma still offered a next_cursor after this page (the scan was cut off by maxPages). */
  hasMorePages: boolean;
}

/**
 * Yields every open, active event, one request at a time (no concurrency), following
 * `next_cursor` for at most `maxPages` pages.
 *
 * Ordered by event id, ascending. Ids never change, so the scan is not disturbed by trading
 * activity: a volume-sorted scan reshuffles while we page through it and can skip events.
 * Popularity ranking is done later, by our own database.
 *
 * Any request that still fails after retries throws, so a caller never mistakes a failed
 * scan for a short one. The caller detects a cut-off scan when the last yielded page still
 * has `hasMorePages === true`.
 */
export async function* fetchActiveEventPages(options: GammaClientOptions, maxPages: number): AsyncGenerator<GammaEventsPage> {
  let cursor: string | undefined;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const url = new URL("/events/keyset", options.baseUrl);
    url.searchParams.set("closed", "false"); // filters events; nested markets can still be closed
    url.searchParams.set("active", "true");
    url.searchParams.set("order", "id");
    url.searchParams.set("ascending", "true");
    url.searchParams.set("limit", String(EVENTS_PAGE_SIZE));
    if (cursor) url.searchParams.set("after_cursor", cursor);

    const body = await getJsonWithRetry(options, url);
    const page = GammaEventsPageSchema.safeParse(body);
    if (!page.success) {
      throw new GammaRequestError(`Unexpected /events/keyset response shape on page ${pageNumber}`, false);
    }

    cursor = page.data.next_cursor ?? undefined;
    yield { pageNumber, events: page.data.events, fetchedAt: new Date(), hasMorePages: cursor !== undefined };
    if (!cursor) return;
  }
}

async function getJsonWithRetry(options: GammaClientOptions, url: URL): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const label = `${url.pathname}?${url.searchParams.toString()}`;

  for (let attempt = 1; ; attempt++) {
    let failure: GammaRequestError;
    let retryAfterMs: number | undefined;
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          // Gamma serves /events pages with limit > 50 compressed only and answers
          // 406 "gzip_required" without this header (observed 2026-11-20).
          "Accept-Encoding": "gzip",
        },
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      });
      if (response.ok) return await response.json();

      const retryable = response.status === 429 || response.status >= 500;
      failure = new GammaRequestError(`Gamma ${label} responded ${response.status}`, retryable);
      if (response.status === 429) retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      await response.body?.cancel();
    } catch (error) {
      // Network errors (ECONNRESET was seen on oversized pages), timeouts, truncated/invalid JSON.
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      failure = new GammaRequestError(`Gamma ${label} failed: ${reason}`, true);
    }

    if (!failure.retryable || attempt >= options.maxAttemptsPerRequest) throw failure;
    // Exponential backoff with jitter: ~0.5s, 1s, 2s, ... ; a 429 Retry-After wins when longer.
    const backoffMs = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    await sleep(Math.max(backoffMs, retryAfterMs ?? 0));
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
}
