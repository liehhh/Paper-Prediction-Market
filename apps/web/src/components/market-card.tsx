import Link from "next/link";
import { CATEGORY_LABELS, type Market } from "@league/catalog-contract";
import { formatDate, formatDateTimeUtc, formatPriceCents } from "@/lib/format";

export function MarketCard({ market, now }: { market: Market; now: Date }) {
  const endPassed = market.expectedEndAt !== null && Date.parse(market.expectedEndAt) < now.getTime();
  const showEventTitle = market.eventTitle.trim() !== market.question.trim();

  return (
    <article className="flex flex-col gap-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="flex flex-wrap gap-1.5">
        {market.categories.map((category) => (
          <span
            key={category}
            className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
          >
            {CATEGORY_LABELS[category]}
          </span>
        ))}
      </div>

      <div>
        {showEventTitle && <p className="text-xs text-zinc-500 dark:text-zinc-400">{market.eventTitle}</p>}
        <h2 className="text-base font-semibold leading-snug">
          <Link href={`/markets/${market.id}`} className="underline-offset-2 hover:underline">
            {market.question}
          </Link>
        </h2>
      </div>

      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {market.expectedEndAt === null
          ? "Expected end: not provided"
          : endPassed
            ? `Expected end ${formatDate(market.expectedEndAt)} has passed — awaiting result`
            : `Expected end: ${formatDate(market.expectedEndAt)}`}
      </p>

      <div className="mt-auto">
        {market.snapshotPrices ? (
          <>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-lg bg-emerald-50 px-3 py-2 dark:bg-emerald-950/40">
                <dt className="text-xs text-emerald-800 dark:text-emerald-300">Yes</dt>
                <dd className="font-semibold tabular-nums">{formatPriceCents(market.snapshotPrices.yes)}</dd>
              </div>
              <div className="rounded-lg bg-rose-50 px-3 py-2 dark:bg-rose-950/40">
                <dt className="text-xs text-rose-800 dark:text-rose-300">No</dt>
                <dd className="font-semibold tabular-nums">{formatPriceCents(market.snapshotPrices.no)}</dd>
              </div>
            </dl>
            <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-500">
              Snapshot from last sync ({formatDateTimeUtc(market.snapshotPrices.asOf)}) · not live
            </p>
          </>
        ) : (
          <p className="text-xs text-zinc-500">No price snapshot available.</p>
        )}
      </div>

      {market.sourceUrl && (
        <a
          href={market.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
        >
          Source: Polymarket ↗
        </a>
      )}
    </article>
  );
}
