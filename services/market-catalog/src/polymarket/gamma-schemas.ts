/**
 * Boundary schemas for the parts of Polymarket's Gamma API we rely on.
 * Unknown fields are ignored (zod strips them), so upstream additions do not break us.
 * Each event and market is validated individually so one bad entry cannot sink a page.
 */
import { z } from "zod";

/** GET /events/keyset response. `next_cursor` is omitted on the last page. */
export const GammaEventsPageSchema = z.object({
  events: z.array(z.unknown()),
  next_cursor: z.string().min(1).nullish(),
});

export const GammaEventSchema = z.object({
  id: z.string().min(1),
  slug: z.string().nullish(),
  title: z.string().nullish(),
  markets: z.array(z.unknown()).nullish(),
  // Event tags drive our categories. Only the slug is read; entries without one are ignored.
  tags: z.array(z.object({ slug: z.string().nullish() })).nullish(),
});
export type GammaEvent = z.infer<typeof GammaEventSchema>;

export const GammaMarketSchema = z.object({
  id: z.string().min(1),
  question: z.string().nullish(),
  // Observed 2026-11-20: JSON-encoded strings such as "[\"Yes\", \"No\"]" and "[\"0.0375\", \"0.9625\"]".
  // Typed loosely here; normalize-market.ts accepts either a real array or a JSON-encoded string.
  // The key can be absent entirely: placeholder markets ("Will Person AC win ...?") pre-created
  // inside multi-candidate events have no outcomePrices and active=false.
  outcomes: z.unknown().optional(),
  outcomePrices: z.unknown().optional(),
  active: z.boolean().nullish(),
  closed: z.boolean().nullish(),
  archived: z.boolean().nullish(),
  acceptingOrders: z.boolean().nullish(),
  endDate: z.string().nullish(),
  // Market-level 24h volume (USD). A number when present; absent on ~20% of markets
  // (observed 2026-11-20), which we treat as zero activity.
  volume24hr: z.number().nullish(),
  // Trading fields (verified 2026-11-23 against live Gamma responses). clobTokenIds is a JSON-encoded
  // string array that is positional with outcomes. description holds the resolution rules.
  clobTokenIds: z.unknown().optional(),
  conditionId: z.string().nullish(),
  description: z.string().nullish(),
  resolutionSource: z.string().nullish(),
  enableOrderBook: z.boolean().nullish(),
  orderPriceMinTickSize: z.number().nullish(),
  orderMinSize: z.number().nullish(),
});
export type GammaMarket = z.infer<typeof GammaMarketSchema>;
