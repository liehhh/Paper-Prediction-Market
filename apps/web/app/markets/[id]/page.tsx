import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { NoticeBox } from "@/components/notice-box";
import { QuoteCard } from "@/components/quote-card";
import { SiteNav } from "@/components/site-nav";
import { TradePanel } from "@/components/trade-panel";
import { formatDateTimeUtc } from "@/lib/format";
import { getMarketDetail } from "@/lib/public-api";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Live prices: always render on request.
export const dynamic = "force-dynamic";

const STATUS_LABEL = { open: "Open", closed: "Closed for trading", delisted: "No longer in the active catalog" } as const;

export default async function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getMarketDetail(id);
  if (!result.ok && result.problem === "not_found") notFound();

  const supabase = await createSupabaseServerClient();
  const signedIn = supabase ? Boolean((await supabase.auth.getSession()).data.session) : false;
  const now = new Date();

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex items-center justify-between gap-4">
        <Link href="/" className="text-sm font-medium underline-offset-2 hover:underline">
          ← Markets
        </Link>
        <SiteNav signedIn={signedIn} />
      </header>

      {!result.ok ? (
        <NoticeBox tone="error" title="This market could not be loaded.">
          The server cannot be reached right now. Nothing was lost; try again in a moment.
        </NoticeBox>
      ) : (
        <>
          <AutoRefresh everyMs={10_000} />
          <section className="flex flex-col gap-2">
            <h1 className="text-2xl font-bold leading-snug tracking-tight">{result.data.market.question}</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              <span className="font-medium">{STATUS_LABEL[result.data.market.status]}</span>
              {" · "}
              {result.data.market.expectedEndAt ? `Expected close ${formatDateTimeUtc(result.data.market.expectedEndAt)}` : "Expected close not provided"}
              {result.data.market.sourceUrl && (
                <>
                  {" · "}
                  <a href={result.data.market.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
                    Polymarket ↗
                  </a>
                </>
              )}
            </p>
            {!result.data.market.tradingSupported && (
              <NoticeBox tone="info" title="This market is browse-only.">
                {result.data.market.unsupportedReason}
              </NoticeBox>
            )}
          </section>

          <section aria-label="Resolution rules" className="rounded-xl bg-white p-4 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
            <h2 className="text-base font-semibold">How this market resolves</h2>
            {result.data.market.rules ? (
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{result.data.market.rules}</p>
            ) : (
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">No resolution rules were published for this market.</p>
            )}
            {result.data.market.resolutionSource && <p className="mt-2 text-xs text-zinc-500">Resolution source: {result.data.market.resolutionSource}</p>}
          </section>

          {result.data.market.tradingSupported && <QuoteCard quote={result.data} now={now} />}

          {result.data.market.tradingSupported &&
            (signedIn ? (
              <TradePanel marketId={result.data.market.id} tradable={result.data.feed.executable} pausedReason={result.data.feed.pausedReason} />
            ) : (
              <NoticeBox tone="neutral" title="Sign in to trade.">
                <Link href="/sign-in" className="font-medium underline">
                  Sign in
                </Link>{" "}
                or{" "}
                <Link href="/register" className="font-medium underline">
                  create an account
                </Link>{" "}
                to trade with Power. Power is virtual: no real money is ever involved.
              </NoticeBox>
            ))}
        </>
      )}
    </main>
  );
}
