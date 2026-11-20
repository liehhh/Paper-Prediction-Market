/**
 * Turns one raw Gamma event into catalog-ready markets, or skip diagnostics explaining
 * why a nested market was not imported. Pure function: no I/O, easy to test.
 *
 * Event vs market: a Polymarket *event* is a container ("Macron out by...?"); each nested
 * *market* is one tradable YES/NO question ("Macron out by June 30, 2026?"). We store markets.
 */
import { GammaEventSchema, GammaMarketSchema } from "./gamma-schemas.ts";

export interface NormalizedMarket {
  providerMarketId: string;
  providerEventId: string;
  eventTitle: string;
  eventSlug: string | null;
  question: string;
  outcomeLabels: [string, string];
  /** null when Polymarket sent no prices for this market. */
  snapshotPrices: { yes: number; no: number } | null;
  sourceUrl: string | null;
  expectedEndAt: Date | null;
  acceptingOrders: boolean;
  fetchedAt: Date;
}

export type SkipReason =
  | "malformed_event"
  | "malformed_market"
  | "not_open"
  | "missing_question"
  | "malformed_outcomes"
  | "not_binary_yes_no"
  | "malformed_prices"
  | "malformed_end_date";

export interface SkipDiagnostic {
  reason: SkipReason;
  providerEventId: string | null;
  providerMarketId: string | null;
  detail: string;
}

export interface NormalizedEvent {
  markets: NormalizedMarket[];
  skips: SkipDiagnostic[];
}

const EVENT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeGammaEvent(rawEvent: unknown, fetchedAt: Date): NormalizedEvent {
  const event = GammaEventSchema.safeParse(rawEvent);
  if (!event.success) {
    return {
      markets: [],
      skips: [skip("malformed_event", idOf(rawEvent), null, summarizeIssues(event.error.issues))],
    };
  }

  const { id: eventId, slug, title, markets: rawMarkets } = event.data;
  const eventSlug = slug && EVENT_SLUG_PATTERN.test(slug) ? slug : null;
  // Event URL format from Polymarket's docs examples: https://polymarket.com/event/{event slug}
  const sourceUrl = eventSlug ? `https://polymarket.com/event/${eventSlug}` : null;

  const result: NormalizedEvent = { markets: [], skips: [] };
  for (const rawMarket of rawMarkets ?? []) {
    const outcome = normalizeGammaMarket(rawMarket, {
      eventId,
      eventTitle: title?.trim() || null,
      eventSlug,
      sourceUrl,
      fetchedAt,
    });
    if ("reason" in outcome) result.skips.push(outcome);
    else result.markets.push(outcome);
  }
  return result;
}

interface EventContext {
  eventId: string;
  eventTitle: string | null;
  eventSlug: string | null;
  sourceUrl: string | null;
  fetchedAt: Date;
}

function normalizeGammaMarket(rawMarket: unknown, ctx: EventContext): NormalizedMarket | SkipDiagnostic {
  const parsed = GammaMarketSchema.safeParse(rawMarket);
  if (!parsed.success) {
    return skip("malformed_market", ctx.eventId, idOf(rawMarket), summarizeIssues(parsed.error.issues));
  }
  const market = parsed.data;
  const marketId = market.id;

  // An open event routinely contains closed markets (earlier deadlines of a "by...?" series).
  // The events listing filter `closed=false` applies to the event, not to each nested market.
  if (market.closed !== false || market.active !== true || market.archived === true || market.acceptingOrders !== true) {
    return skip(
      "not_open",
      ctx.eventId,
      marketId,
      `active=${market.active} closed=${market.closed} archived=${market.archived} acceptingOrders=${market.acceptingOrders}`,
    );
  }

  const question = market.question?.trim();
  if (!question) return skip("missing_question", ctx.eventId, marketId, "question is empty");

  const labels = parseJsonArrayField(market.outcomes);
  if (!labels || !labels.every((label): label is string => typeof label === "string")) {
    return skip("malformed_outcomes", ctx.eventId, marketId, `outcomes=${preview(market.outcomes)}`);
  }

  // Supported shape: exactly two outcomes, one "Yes" and one "No" (any order, any case).
  const normalizedLabels = labels.map((label) => label.trim().toLowerCase());
  const yesIndex = normalizedLabels.indexOf("yes");
  const noIndex = normalizedLabels.indexOf("no");
  if (labels.length !== 2 || yesIndex === -1 || noIndex === -1) {
    return skip("not_binary_yes_no", ctx.eventId, marketId, `outcomes=${JSON.stringify(labels)}`);
  }

  let snapshotPrices: NormalizedMarket["snapshotPrices"] = null;
  if (market.outcomePrices !== null && market.outcomePrices !== undefined) {
    const prices = parsePrices(market.outcomePrices);
    if (!prices || prices.length !== labels.length) {
      return skip("malformed_prices", ctx.eventId, marketId, `outcomePrices=${preview(market.outcomePrices)}`);
    }
    // Prices are positional: outcomePrices[i] is the price of outcomes[i].
    snapshotPrices = { yes: prices[yesIndex]!, no: prices[noIndex]! };
  }

  let expectedEndAt: Date | null = null;
  if (market.endDate) {
    expectedEndAt = new Date(market.endDate);
    if (Number.isNaN(expectedEndAt.getTime())) {
      return skip("malformed_end_date", ctx.eventId, marketId, `endDate=${preview(market.endDate)}`);
    }
  }

  return {
    providerMarketId: marketId,
    providerEventId: ctx.eventId,
    // Single-market events can have an empty title; the question is then the best label.
    eventTitle: ctx.eventTitle ?? question,
    eventSlug: ctx.eventSlug,
    question,
    outcomeLabels: [labels[0]!, labels[1]!],
    snapshotPrices,
    sourceUrl: ctx.sourceUrl,
    expectedEndAt,
    acceptingOrders: true,
    fetchedAt: ctx.fetchedAt,
  };
}

/**
 * Gamma documents `outcomes` / `outcomePrices` as strings, and in practice sends JSON-encoded
 * arrays inside a string. Accept a real array too, in case the API starts sending one.
 */
export function parseJsonArrayField(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const decoded: unknown = JSON.parse(value);
    return Array.isArray(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Prices arrive as decimal strings ("0.0375"). Every entry must be a finite number in [0, 1]. */
function parsePrices(value: unknown): number[] | null {
  const entries = parseJsonArrayField(value);
  if (!entries) return null;
  const prices: number[] = [];
  for (const entry of entries) {
    const price = typeof entry === "number" ? entry : typeof entry === "string" && entry.trim() !== "" ? Number(entry) : NaN;
    if (!Number.isFinite(price) || price < 0 || price > 1) return null;
    prices.push(price);
  }
  return prices;
}

function skip(reason: SkipReason, eventId: string | null, marketId: string | null, detail: string): SkipDiagnostic {
  return { reason, providerEventId: eventId, providerMarketId: marketId, detail };
}

function idOf(raw: unknown): string | null {
  if (raw && typeof raw === "object" && "id" in raw) {
    const id = (raw as { id: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return String(id);
  }
  return null;
}

function summarizeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
