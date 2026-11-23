/**
 * Power (the game's virtual currency) arrives as exact decimal STRINGS ("10000.000000") and is only ever formatted,
 * never calculated on, in the browser. Intl.NumberFormat accepts a numeric string and formats it without first
 * rounding it through a binary float, so large or fractional balances stay exact.
 * Display rounds Power to 2 decimals; the ledger keeps 6. (The file keeps its original name; users only see "Power".)
 */
const powerFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sharesFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** "10000.000000" -> "10,000.00" */
export function formatCredits(amount: string): string {
  // The shared contract has already validated the string as a decimal; the cast only satisfies
  // TypeScript's `${number}` type and does NOT convert it to a float.
  return powerFormat.format(amount as `${number}`);
}
export const formatPower = formatCredits;

/** "10000.000000" -> "+10,000.00"; "-12.5" -> "-12.50" */
export function formatSignedCredits(amount: string): string {
  const negative = amount.startsWith("-");
  const formatted = formatCredits(negative ? amount.slice(1) : amount);
  return `${negative ? "-" : "+"}${formatted}`;
}
export const formatSignedPower = formatSignedCredits;

/** "4000.000000" -> "4,000"; "3846.150000" -> "3,846.15" */
export function formatShares(quantity: string): string {
  return sharesFormat.format(quantity as `${number}`);
}

/** A price per share in Power, "0.650000" -> "0.65", "0.0045" -> "0.0045": trailing zeros trimmed, at least 2 decimals. */
export function formatSharePrice(price: string): string {
  const [whole = "0", fraction = ""] = price.split(".");
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${trimmed}`;
}
