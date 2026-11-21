import Link from "next/link";
import { CATEGORY_LABELS, CategorySlugSchema, type CategorySlug } from "@league/catalog-contract";
import { CategoryTabs } from "@/components/category-tabs";
import { MarketCard } from "@/components/market-card";
import { NoticeBox } from "@/components/notice-box";
import { describeCatalog, type CatalogNotice } from "@/lib/catalog-notice";
import { formatDateTimeUtc, formatRelative } from "@/lib/format";
import { getMarketPage } from "@/lib/public-api";

// Always render on request: the catalog changes whenever a sync runs.
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CatalogPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const parsedCategory = CategorySlugSchema.safeParse(params.category);
  const category: CategorySlug | undefined = parsedCategory.success ? parsedCategory.data : undefined;
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined;

  const result = await getMarketPage({ category, cursor });
  const notice = result.ok ? describeCatalog(result.data) : null;
  const now = new Date();

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Paper Prediction League</p>
          <Link href="/dashboard" className="text-sm font-medium underline-offset-2 hover:underline">
            My account
          </Link>
        </div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Market catalog</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Open Polymarket questions, most-traded first (ranked by reported 24-hour volume). Virtual credits only — no real money.
        </p>
      </header>

      <CategoryTabs active={category} />

      {!result.ok ? (
        result.problem === "invalid_cursor" ? (
          <NoticeBox tone="warning" title="This page link has expired.">
            <Link href={category ? `/?category=${category}` : "/"} className="underline">
              Go back to the first page
            </Link>
          </NoticeBox>
        ) : (
          <NoticeBox tone="error" title="The league API cannot be reached right now.">
            The market list could not be loaded. Saved markets are not lost; try again in a moment.
          </NoticeBox>
        )
      ) : (
        <>
          {notice && <FreshnessNotice notice={notice} now={now} />}

          {result.data.markets.length === 0 ? (
            notice?.kind === "not_synced_yet" ? null : (
              <NoticeBox
                tone="neutral"
                title={category ? `No open ${CATEGORY_LABELS[category].toLowerCase()} markets right now.` : "No open markets right now."}
              >
                The latest saved catalog has no open YES/NO markets{category ? " in this category" : ""}.
              </NoticeBox>
            )
          ) : (
            <section aria-label="Markets" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {result.data.markets.map((market) => (
                <MarketCard key={market.id} market={market} now={now} />
              ))}
            </section>
          )}

          <nav aria-label="Pagination" className="flex justify-between text-sm">
            {cursor ? (
              <Link href={category ? `/?category=${category}` : "/"} className="font-medium underline-offset-2 hover:underline">
                ← First page
              </Link>
            ) : (
              <span />
            )}
            {result.data.nextCursor && (
              <Link
                href={`/?${new URLSearchParams({ ...(category ? { category } : {}), cursor: result.data.nextCursor })}`}
                className="font-medium underline-offset-2 hover:underline"
              >
                Next page →
              </Link>
            )}
          </nav>
        </>
      )}
    </main>
  );
}

function FreshnessNotice({ notice, now }: { notice: CatalogNotice; now: Date }) {
  const refreshed = (iso: string) => `${formatDateTimeUtc(iso)} (${formatRelative(iso, now)})`;

  switch (notice.kind) {
    case "not_synced_yet":
      return (
        <NoticeBox tone="info" title="No markets have been imported yet.">
          {notice.latestAttemptStatus === "failed"
            ? "The first catalog sync did not complete. Run the sync again once Polymarket is reachable."
            : notice.latestAttemptStatus === "running"
              ? "The first catalog sync is running. Refresh this page in a minute."
              : "The first catalog sync has not run yet. Run `pnpm catalog:sync` to import markets."}
        </NoticeBox>
      );
    case "refresh_problem":
      return (
        <NoticeBox
          tone="warning"
          title={notice.attemptStatus === "failed" ? "The latest refresh failed." : "The latest refresh was incomplete."}
        >
          {notice.lastSuccessfulRefreshAt
            ? `Showing the saved catalog from the last successful refresh: ${refreshed(notice.lastSuccessfulRefreshAt)}.`
            : "Showing the saved catalog; no complete refresh has finished yet."}{" "}
          Refresh attempted {refreshed(notice.attemptStartedAt)}.
        </NoticeBox>
      );
    case "refreshing":
      return (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          A refresh is in progress.
          {notice.lastSuccessfulRefreshAt && ` Last successful refresh: ${refreshed(notice.lastSuccessfulRefreshAt)}.`}
        </p>
      );
    case "fresh":
      return (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Last refreshed {refreshed(notice.lastSuccessfulRefreshAt)}.</p>
      );
  }
}
