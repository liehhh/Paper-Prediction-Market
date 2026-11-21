/**
 * Credits arrive as exact decimal STRINGS ("10000.000000") and are only ever formatted, never
 * calculated on, in the browser. Intl.NumberFormat accepts a numeric string and formats it
 * without first rounding it through a binary float, so large or fractional balances stay exact.
 * Display rounds to 2 decimals; the ledger keeps 6.
 */
const creditFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "10000.000000" -> "10,000.00" */
export function formatCredits(amount: string): string {
  // The shared contract has already validated the string as a decimal; the cast only satisfies
  // TypeScript's `${number}` type and does NOT convert it to a float.
  return creditFormat.format(amount as `${number}`);
}

/** "10000.000000" -> "+10,000.00"; "-12.5" -> "-12.50" */
export function formatSignedCredits(amount: string): string {
  const negative = amount.startsWith("-");
  const formatted = formatCredits(negative ? amount.slice(1) : amount);
  return `${negative ? "-" : "+"}${formatted}`;
}
