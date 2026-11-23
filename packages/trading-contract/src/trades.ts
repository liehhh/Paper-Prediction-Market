/**
 * Paper trades, portfolio and the public league. Decimals are strings; shares and Power both use 6 decimals.
 * No process may parse these into JavaScript numbers to do arithmetic.
 */
import { z } from "zod";

const isoDateTime = z.iso.datetime({ offset: true });

export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;
export const UsernameSchema = z.string().regex(USERNAME_PATTERN, "3-20 letters, numbers or underscores");
export const UsernameRequestSchema = z.object({ username: UsernameSchema });

/** What a player types: up to 6 decimals. Servers re-validate; this only shapes the request. */
export const DecimalInputSchema = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/, "Expected a positive decimal number");
const Decimal6 = z.string().regex(/^\d{1,14}\.\d{6}$/);
const SignedDecimal6 = z.string().regex(/^-?\d{1,14}\.\d{6}$/);
const MarketIdSchema = z.string().regex(/^\d{1,19}$/);

export const OutcomeSchema = z.enum(["YES", "NO"]);
export type Outcome = z.infer<typeof OutcomeSchema>;
export const TradeSideSchema = z.enum(["buy", "sell"]);
export type TradeSide = z.infer<typeof TradeSideSchema>;

/** Preview: a buy states a Power budget, a sell states a share quantity. */
export const TradePreviewRequestSchema = z
  .object({ marketId: MarketIdSchema, outcome: OutcomeSchema, side: TradeSideSchema, budget: DecimalInputSchema.optional(), quantity: DecimalInputSchema.optional() })
  .refine((r) => (r.side === "buy" ? r.budget !== undefined && r.quantity === undefined : r.quantity !== undefined && r.budget === undefined), {
    message: "A buy needs a budget and a sell needs a quantity.",
  });
export type TradePreviewRequest = z.infer<typeof TradePreviewRequestSchema>;

export const FillLineSchema = z.object({ price: Decimal6, quantity: Decimal6, amount: Decimal6 });
export type FillLine = z.infer<typeof FillLineSchema>;

export const TradePreviewSchema = z.object({
  marketId: z.string(),
  question: z.string(),
  outcome: OutcomeSchema,
  side: TradeSideSchema,
  /** Shares that would be bought or sold. */
  quantity: Decimal6,
  /** Power that would be spent (buy) or received (sell). */
  amount: Decimal6,
  averagePrice: Decimal6,
  /** The price protection you accept by confirming: the most you will spend, or the least you will receive. */
  limit: z.object({ kind: z.enum(["max_spend", "min_proceeds"]), amount: Decimal6 }),
  /** Buys only: your budget, and the part of it that stays in your balance. */
  budget: Decimal6.nullable(),
  unspent: Decimal6.nullable(),
  fills: z.array(FillLineSchema),
  quoteObservedAt: isoDateTime,
  quoteServerTime: isoDateTime,
  availablePower: Decimal6,
  sharesOwned: Decimal6,
});
export type TradePreview = z.infer<typeof TradePreviewSchema>;

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
/** Confirm: the exact quantity and protection that were previewed, plus a key that makes retries safe. */
export const TradeConfirmRequestSchema = z.object({
  marketId: MarketIdSchema,
  outcome: OutcomeSchema,
  side: TradeSideSchema,
  quantity: DecimalInputSchema,
  limit: DecimalInputSchema,
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
});
export type TradeConfirmRequest = z.infer<typeof TradeConfirmRequestSchema>;

export const TradeReceiptSchema = z.object({
  orderId: z.uuid(),
  marketId: z.string(),
  question: z.string(),
  outcome: OutcomeSchema,
  side: TradeSideSchema,
  quantity: Decimal6,
  amount: Decimal6,
  averagePrice: Decimal6,
  unspent: Decimal6.nullable(),
  fills: z.array(FillLineSchema),
  quoteObservedAt: isoDateTime,
  executedAt: isoDateTime,
  /** True when this is the original receipt returned again for a retried request. */
  replayed: z.boolean(),
});
export type TradeReceipt = z.infer<typeof TradeReceiptSchema>;

export const TRADE_ERROR_CODES = [
  "invalid_order",
  "no_account",
  "market_not_found",
  "market_not_tradable",
  "quote_paused",
  "catalog_unavailable",
  "insufficient_depth",
  "budget_too_small",
  "insufficient_power",
  "insufficient_shares",
  "price_moved",
  "idempotency_key_reused",
  "username_taken",
] as const;
export type TradeErrorCode = (typeof TRADE_ERROR_CODES)[number];
export const TradeErrorSchema = z.object({
  error: z.object({ code: z.enum(TRADE_ERROR_CODES), message: z.string() }),
  /** Present for price_moved: the fresh preview to confirm instead. */
  preview: TradePreviewSchema.optional(),
});
export type TradeError = z.infer<typeof TradeErrorSchema>;

export const MarkSchema = z.object({
  price: Decimal6,
  /** mid / bid: from a book. last_known: carried forward. cost_basis: never priced yet. */
  source: z.enum(["mid", "bid", "last_known", "cost_basis"]),
  asOf: isoDateTime.nullable(),
  /** True when the book was not live: this is the last known valuation, shown with its time. */
  stale: z.boolean(),
});
export type Mark = z.infer<typeof MarkSchema>;

export const PositionSchema = z.object({
  marketId: z.string(),
  question: z.string(),
  outcome: OutcomeSchema,
  status: z.enum(["open", "settled"]),
  quantity: Decimal6,
  costBasis: Decimal6,
  averageCost: Decimal6.nullable(),
  mark: MarkSchema.nullable(),
  /** Marked value of the shares (zero once settled). */
  value: Decimal6,
  unrealizedPnl: SignedDecimal6,
  realizedPnl: SignedDecimal6,
});
export type Position = z.infer<typeof PositionSchema>;

export const PortfolioFillSchema = z.object({
  id: z.string(),
  orderId: z.uuid(),
  marketId: z.string(),
  question: z.string(),
  outcome: OutcomeSchema,
  side: TradeSideSchema,
  price: Decimal6,
  quantity: Decimal6,
  amount: Decimal6,
  quoteObservedAt: isoDateTime,
  createdAt: isoDateTime,
});

export const PortfolioResponseSchema = z.object({
  asOf: isoDateTime,
  username: z.string(),
  availablePower: Decimal6,
  /** Power reserved for open buys. Always zero in this milestone (orders fill immediately). */
  reservedPower: Decimal6,
  sharesValue: Decimal6,
  /** available + reserved + marked value of owned shares, computed once on the server. */
  totalPower: Decimal6,
  rank: z.number().int().positive(),
  realizedPnl: SignedDecimal6,
  unrealizedPnl: SignedDecimal6,
  positions: z.array(PositionSchema),
  fills: z.array(PortfolioFillSchema),
});
export type PortfolioResponse = z.infer<typeof PortfolioResponseSchema>;

/**
 * The ONLY league data any visitor can read. Deliberately nothing exact: no balance, no shares, no fills, no
 * markets. relativeSize is this country's share of all Power, rounded to 0.1% (a number between 0 and 1).
 */
export const AVATAR_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.webp$/;
export const AvatarKeySchema = z.string().regex(AVATAR_KEY_PATTERN);
/** Body of the trading service's internal "set my avatar" call. A null key removes the picture. */
export const AvatarKeyRequestSchema = z.object({ avatarKey: AvatarKeySchema.nullable() });

/**
 * Area weight: total Power in units of the 10,000 starting grant, rounded to 0.01. A country's circle AREA is
 * proportional to it (radius = k * sqrt(weight)), so 1.06 versus 1.00 means about 6% more area. It is the coarse public
 * stand-in for size: no exact balance, no holdings.
 */
export const AREA_WEIGHT_STEP = 0.01;

export const LeagueCountrySchema = z.object({
  countryId: z.uuid(),
  username: z.string(),
  /** Object name of the profile picture in the public avatars bucket; null when the player has none. */
  avatarKey: z.string().nullable(),
  areaWeight: z.number().min(0),
  color: z.string().regex(/^#[0-9a-f]{6}$/),
  /** Stable placement order on the map (never changes for a country). */
  slot: z.number().int().positive(),
  /** Equal totals share a rank (1, 2, 2, 4). */
  rank: z.number().int().positive(),
  relativeSize: z.number().min(0).max(1),
});
export type LeagueCountry = z.infer<typeof LeagueCountrySchema>;
export const LeagueSnapshotSchema = z.object({
  asOf: isoDateTime,
  /** Display order: rank, then slot. */
  countries: z.array(LeagueCountrySchema),
});
export type LeagueSnapshot = z.infer<typeof LeagueSnapshotSchema>;

/**
 * What a visitor to World receives from services/api: the same snapshot, with the avatar key turned into a public image
 * address. The address is built from the country id and an unguessable object name, never from the account id.
 */
export const WorldCountrySchema = LeagueCountrySchema.omit({ avatarKey: true }).extend({ avatarUrl: z.url().nullable() });
export type WorldCountry = z.infer<typeof WorldCountrySchema>;
export const WorldSnapshotSchema = z.object({ asOf: isoDateTime, countries: z.array(WorldCountrySchema) });
export type WorldSnapshot = z.infer<typeof WorldSnapshotSchema>;
