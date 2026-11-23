/**
 * Fixed-point arithmetic for Power and shares. NO floats anywhere in accounting.
 *
 * Units (all BigInt):
 *   micro  = 1e-6 Power. Power amounts AND prices are held in micro (Postgres numeric(20, 6)).
 *   cs     = 1e-2 share ("centishare"). Paper trades use whole hundredths of a share, the order-size
 *            precision Polymarket itself uses. Stored in Postgres as numeric(20, 6), always a multiple of 0.01.
 *
 * Cost of `cs` shares at `priceMicro` is priceMicro * cs / 100 micro. That division is EXACT whenever the price is a
 * multiple of 0.0001 (Polymarket's finest tick), so a fill's cost needs no rounding. Prices with more precision are
 * rejected as malformed instead of being silently rounded.
 *
 * Rounding rule everywhere else (averages, proportional cost basis, valuation of fractional marks): round half up,
 * to micro. Rounding never creates or destroys Power in the ledger: only exact fill costs move cash.
 */
export const CS_PER_SHARE = 100n;
/** micro-shares (numeric(20, 6)) per centishare. */
const MICRO_SHARES_PER_CS = 10_000n;

export class InvalidDecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDecimalError";
  }
}

/** Parses a plain non-negative decimal with at most `scale` decimals into a scaled integer. */
export function parseDecimal(value: string, scale: number): bigint {
  const match = /^(\d{1,14})(?:\.(\d{1,12}))?$/.exec(value);
  if (!match) throw new InvalidDecimalError(`not a plain decimal: ${value.slice(0, 30)}`);
  const fraction = match[2] ?? "";
  if (fraction.length > scale) throw new InvalidDecimalError(`more than ${scale} decimals: ${value.slice(0, 30)}`);
  return BigInt(match[1]!) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0"));
}

/** Formats a scaled integer with exactly `scale` decimals ("10000.000000"). Negative values keep their sign. */
export function formatDecimal(value: bigint, scale: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(scale);
  const text = `${abs / unit}.${(abs % unit).toString().padStart(scale, "0")}`;
  return negative ? `-${text}` : text;
}

export const parseMicro = (value: string) => parseDecimal(value, 6);
export const formatMicro = (value: bigint) => formatDecimal(value, 6);

/** Parses a signed numeric(20, 6) text such as "-12.500000" into micro. */
export function parseSignedMicro(value: string): bigint {
  return value.startsWith("-") ? -parseMicro(value.slice(1)) : parseMicro(value);
}

/** "4000.000000" (numeric(20, 6) text) -> 400000n centishares. Throws if it is not a whole number of centishares. */
export function numericToCs(value: string): bigint {
  const micro = parseMicro(value);
  if (micro % MICRO_SHARES_PER_CS !== 0n) throw new InvalidDecimalError(`not a whole number of hundredths: ${value}`);
  return micro / MICRO_SHARES_PER_CS;
}
export const csToNumeric = (cs: bigint) => formatMicro(cs * MICRO_SHARES_PER_CS);

/**
 * Parses a share quantity ("12.5", or the "12.500000" a preview returns) into centishares. Any number of zeros after
 * the second decimal is fine, but the value must be a whole number of hundredths of a share.
 */
export function parseSharesInput(value: string): bigint {
  const microShares = parseDecimal(value, 6);
  if (microShares % MICRO_SHARES_PER_CS !== 0n) throw new InvalidDecimalError(`shares are traded in hundredths: ${value.slice(0, 30)}`);
  return microShares / MICRO_SHARES_PER_CS;
}

/** Exact cost in micro of `cs` centishares at `priceMicro`. Throws if the price is finer than 0.0001. */
export function costMicro(priceMicro: bigint, cs: bigint): bigint {
  const numerator = priceMicro * cs;
  if (numerator % CS_PER_SHARE !== 0n) throw new InvalidDecimalError("price finer than 0.0001 is not supported");
  return numerator / CS_PER_SHARE;
}

/** Integer division rounding half up (for non-negative operands). */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}
