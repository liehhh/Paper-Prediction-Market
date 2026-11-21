/**
 * The trading-account HTTP contract, shared by three processes:
 * - services/trading produces it (internal endpoints),
 * - services/api validates it at its boundary and re-serves it as /v1/me/trading-account,
 * - apps/web validates it again and renders it.
 *
 * Credits are exact decimals, so they travel as STRINGS. A JavaScript number is a binary
 * float and cannot hold 0.1 exactly; no process may parse these into numbers to do arithmetic.
 * Precision: up to 14 integer digits and exactly 6 decimals (Postgres numeric(20, 6)).
 */
import { z } from "zod";

export const CREDIT_DECIMALS = 6;

/** e.g. "10000.000000" or "-12.500000". */
export const CreditAmountSchema = z.string().regex(/^-?\d{1,14}\.\d{6}$/, "Expected a decimal string with 6 decimals");

const isoDateTime = z.iso.datetime({ offset: true });

/** Why a ledger entry exists. New reasons (fills, settlements) are added here by later milestones. */
export const LEDGER_ENTRY_TYPES = ["starting_grant"] as const;
export const LedgerEntryTypeSchema = z.enum(LEDGER_ENTRY_TYPES);
export type LedgerEntryType = z.infer<typeof LedgerEntryTypeSchema>;

export const LedgerEntrySchema = z.object({
  id: z.string(),
  type: LedgerEntryTypeSchema,
  /** Signed: positive adds cash, negative removes it. */
  amount: CreditAmountSchema,
  createdAt: isoDateTime,
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** Deliberately carries no user ID, email, or username: the caller already knows who they are. */
export const TradingAccountResponseSchema = z.object({
  openedAt: isoDateTime,
  cash: z.object({ available: CreditAmountSchema }),
  /** Newest first, capped. The cash figure is computed from the whole ledger, not from this list. */
  activity: z.array(LedgerEntrySchema),
});
export type TradingAccountResponse = z.infer<typeof TradingAccountResponseSchema>;
