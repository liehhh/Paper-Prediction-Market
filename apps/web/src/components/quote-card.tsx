import type { BookLevel, QuoteResponse, TokenBook } from "@league/catalog-contract";
import { formatDateTimeUtc, formatRelative } from "@/lib/format";
import { formatShares, formatSharePrice } from "@/lib/format-credits";

const STATE_LABEL: Record<QuoteResponse["feed"]["state"], string> = {
  live: "Live",
  recovering: "Refreshing",
  disconnected: "Reconnecting",
  unavailable: "Waiting for prices",
};

/** The live YES and NO books: best prices and the first few levels of depth, with how fresh they are. */
export function QuoteCard({ quote, now }: { quote: QuoteResponse; now: Date }) {
  const { feed } = quote;
  const live = feed.state === "live";
  return (
    <section aria-label="Live quote" className="flex flex-col gap-3 rounded-xl bg-white p-4 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Order book</h2>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            live ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
          }`}
        >
          {STATE_LABEL[feed.state]}
        </span>
      </div>

      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        {feed.observedAt ? (
          <>
            {live ? "Prices confirmed" : "Last known prices from"} {formatDateTimeUtc(feed.observedAt)} ({formatRelative(feed.observedAt, now)}).
          </>
        ) : (
          "No live prices have arrived yet."
        )}{" "}
        Prices are Polymarket&apos;s order book, used for paper trading only.
      </p>
      {feed.pausedReason && <p className="text-sm font-medium text-amber-700 dark:text-amber-400">{feed.pausedReason}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Book title="Yes" tone="emerald" book={quote.yes} />
        <Book title="No" tone="rose" book={quote.no} />
      </div>
    </section>
  );
}

function Book({ title, tone, book }: { title: string; tone: "emerald" | "rose"; book: TokenBook | null }) {
  const box = tone === "emerald" ? "bg-emerald-50 dark:bg-emerald-950/40" : "bg-rose-50 dark:bg-rose-950/40";
  return (
    <div className={`rounded-lg p-3 ${box}`}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {book === null ? (
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">Not available yet.</p>
      ) : (
        <div className="mt-2 grid grid-cols-2 gap-3 text-xs tabular-nums">
          <Side label="Buy at (asks)" levels={book.asks} />
          <Side label="Sell at (bids)" levels={book.bids} />
        </div>
      )}
    </div>
  );
}

function Side({ label, levels }: { label: string; levels: BookLevel[] }) {
  return (
    <div>
      <p className="mb-1 text-zinc-600 dark:text-zinc-400">{label}</p>
      {levels.length === 0 ? (
        <p className="text-zinc-500">None</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {levels.slice(0, 5).map((level) => (
            <li key={level.price} className="flex justify-between gap-2">
              <span className="font-medium">{formatSharePrice(level.price)}</span>
              <span className="text-zinc-600 dark:text-zinc-400">{formatShares(level.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
