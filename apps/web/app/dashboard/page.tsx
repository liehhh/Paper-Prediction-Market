import Link from "next/link";
import { redirect } from "next/navigation";
import type { PortfolioResponse } from "@league/trading-contract";
import { AutoRefresh } from "@/components/auto-refresh";
import { AvatarEditor } from "@/components/avatar-editor";
import { NoticeBox } from "@/components/notice-box";
import { SiteNav } from "@/components/site-nav";
import { formatPower, formatSharePrice, formatShares, formatSignedPower } from "@/lib/format-credits";
import { formatDateTimeUtc } from "@/lib/format";
import { getWorld } from "@/lib/public-api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureTradingAccount, fetchTradingAccount, getPortfolio } from "@/lib/trading-api";
import { changeUsername } from "./actions";

// Per-user and always fresh: never cached, never shared.
export const dynamic = "force-dynamic";

const USERNAME_MESSAGES: Record<string, string> = {
  taken: "That username is already taken.",
  invalid: "Usernames are 3-20 letters, numbers or underscores.",
  unavailable: "We could not change your username. Try again in a moment.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return (
      <Shell>
        <NoticeBox tone="warning" title="Sign-in is not configured on this server yet." />
      </Shell>
    );
  }

  // The session comes from the cookies (proxy.ts has already refreshed it if it was expired).
  // This is NOT where trust is decided: services/api verifies the token with Supabase Auth.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect("/sign-in");

  // Three independent reads, side by side: each is a round trip through the API (and on to the database), so doing them
  // one after another would add their waits together. Only a brand-new player has no account yet; then, and only then,
  // create it and read again.
  const token = session.access_token;
  let [result, portfolio, world] = await Promise.all([fetchTradingAccount(token), getPortfolio(token), getWorld()]);
  if (!result.ok && result.problem === "not_found") {
    result = await ensureTradingAccount(token);
    [portfolio, world] = await Promise.all([getPortfolio(token), getWorld()]);
  }
  if (!result.ok && result.problem === "unauthenticated") redirect("/sign-in");
  // My country as everyone else sees it (colour and current picture), straight from the public World snapshot.
  const myCountry = result.ok && world?.ok ? world.data.countries.find((country) => country.countryId === result.data.countryId) : undefined;

  const usernameError = typeof params.username_error === "string" ? USERNAME_MESSAGES[params.username_error] : undefined;
  const usernameSaved = params.username === "saved";

  return (
    <Shell signedIn>
      {!result.ok ? (
        // Deliberately no balance of any kind: a failed request must not look like "0" or "10,000".
        <NoticeBox tone="error" title="We could not load your account.">
          {result.problem === "unavailable" ? "The trading service is temporarily unavailable." : "Something went wrong on our side."} You are still signed in and
          nothing was lost.{" "}
          <Link href="/dashboard" className="font-medium underline">
            Try again
          </Link>
        </NoticeBox>
      ) : (
        <>
          <AutoRefresh everyMs={15_000} />
          {portfolio.ok ? (
            <PortfolioView portfolio={portfolio.data} />
          ) : (
            <section aria-label="Available Power" className="rounded-xl bg-white p-6 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
              <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Available Power</p>
              <p className="mt-1 text-3xl font-bold tabular-nums">{formatPower(result.data.cash.available)} Power</p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Your positions could not be loaded right now. Account opened {formatDateTimeUtc(result.data.openedAt)}.</p>
            </section>
          )}

          <section id="country" aria-label="Your country" className="flex scroll-mt-4 flex-col gap-3 rounded-xl bg-white p-4 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
            <h2 className="text-base font-semibold">Your country</h2>
            <AvatarEditor currentUrl={myCountry?.avatarUrl ?? null} color={myCountry?.color ?? "#71717a"} username={result.data.username} />
            <hr className="border-zinc-200 dark:border-zinc-800" />
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Your username is your country&apos;s name on the{" "}
              <Link href="/world" className="underline underline-offset-2">
                World
              </Link>
              . It must be unique.
            </p>
            <form action={changeUsername} className="flex gap-2">
              <input
                name="username"
                defaultValue={result.data.username}
                required
                minLength={3}
                maxLength={20}
                pattern="[A-Za-z0-9_]{3,20}"
                aria-label="Username"
                className="min-w-0 flex-1 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:bg-zinc-900 dark:ring-zinc-700 dark:focus:ring-zinc-100"
              />
              <button type="submit" className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
                Save
              </button>
            </form>
            {usernameError && (
              <p role="alert" className="text-sm font-medium text-rose-700 dark:text-rose-400">
                {usernameError}
              </p>
            )}
            {usernameSaved && <p role="status" className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Saved.</p>}
          </section>

          <section aria-label="Account activity" className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Power activity</h2>
            <ul className="divide-y divide-zinc-200 rounded-xl bg-white ring-1 ring-zinc-200 dark:divide-zinc-800 dark:bg-zinc-900 dark:ring-zinc-800">
              {result.data.activity.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                  <span>
                    <span className="font-medium">{ENTRY_LABELS[entry.type]}</span>
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">{formatDateTimeUtc(entry.createdAt)}</span>
                  </span>
                  <span className="font-medium tabular-nums">{formatSignedPower(entry.amount)}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </Shell>
  );
}

const ENTRY_LABELS = { starting_grant: "Starting grant", trade_buy: "Bought shares", trade_sell: "Sold shares", settlement_payout: "Market payout" } as const;

function PortfolioView({ portfolio }: { portfolio: PortfolioResponse }) {
  const gain = (value: string) => (value.startsWith("-") ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400");
  return (
    <>
      <section aria-label="Total Power" className="rounded-xl bg-white p-6 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Total Power · rank {portfolio.rank}
        </p>
        <p className="mt-1 text-3xl font-bold tabular-nums">{formatPower(portfolio.totalPower)}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums sm:grid-cols-4">
          <Stat label="Available" value={formatPower(portfolio.availablePower)} />
          <Stat label="Value of shares" value={formatPower(portfolio.sharesValue)} />
          <Stat label="Realized gain/loss" value={formatSignedPower(portfolio.realizedPnl)} className={gain(portfolio.realizedPnl)} />
          <Stat label="Unrealized gain/loss" value={formatSignedPower(portfolio.unrealizedPnl)} className={gain(portfolio.unrealizedPnl)} />
        </dl>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Total Power = available Power + the marked value of your shares. Shares are valued at the midpoint of the live book when it is tight, otherwise at the best bid.
          Power is virtual: no real money.
        </p>
      </section>

      <section aria-label="Positions" className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Positions</h2>
        {portfolio.positions.length === 0 ? (
          <p className="rounded-xl bg-white p-4 text-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
            You hold no shares yet.{" "}
            <Link href="/?category=politics" className="font-medium underline underline-offset-2">
              Browse political markets
            </Link>
            .
          </p>
        ) : (
          <ul className="divide-y divide-zinc-200 rounded-xl bg-white ring-1 ring-zinc-200 dark:divide-zinc-800 dark:bg-zinc-900 dark:ring-zinc-800">
            {portfolio.positions.map((position) => (
              <li key={`${position.marketId}-${position.outcome}`} className="flex flex-col gap-1 px-4 py-3 text-sm">
                <Link href={`/markets/${position.marketId}`} className="font-medium underline-offset-2 hover:underline">
                  {position.question}
                </Link>
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 tabular-nums">
                  <span>
                    {position.status === "settled" ? "Settled" : `${formatShares(position.quantity)} ${position.outcome === "YES" ? "Yes" : "No"} shares`}
                    {position.averageCost && ` · avg cost ${formatSharePrice(position.averageCost)}`}
                  </span>
                  <span className={gain(position.status === "open" ? position.unrealizedPnl : position.realizedPnl)}>
                    {position.status === "open" ? `${formatSignedPower(position.unrealizedPnl)} unrealized` : `${formatSignedPower(position.realizedPnl)} realized`}
                  </span>
                </div>
                {position.status === "open" && position.mark && (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Valued at {formatSharePrice(position.mark.price)} ({MARK_LABEL[position.mark.source]}
                    {position.mark.asOf ? ` as of ${formatDateTimeUtc(position.mark.asOf)}` : ""}){position.mark.stale && " · live price paused, showing the last known value"}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Fills" className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Recent fills</h2>
        {portfolio.fills.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No trades yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 rounded-xl bg-white ring-1 ring-zinc-200 dark:divide-zinc-800 dark:bg-zinc-900 dark:ring-zinc-800">
            {portfolio.fills.map((fill) => (
              <li key={fill.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <span>
                  <span className="font-medium">
                    {fill.side === "buy" ? "Bought" : "Sold"} {formatShares(fill.quantity)} {fill.outcome === "YES" ? "Yes" : "No"} at {formatSharePrice(fill.price)}
                  </span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                    {fill.question} · {formatDateTimeUtc(fill.createdAt)} · quote {formatDateTimeUtc(fill.quoteObservedAt)}
                  </span>
                </span>
                <span className="font-medium tabular-nums">{formatPower(fill.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

const MARK_LABEL = { mid: "midpoint of the live book", bid: "best bid", last_known: "carried forward", cost_basis: "your cost, not yet priced" } as const;

function Stat({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className={`font-medium ${className}`}>{value}</dd>
    </div>
  );
}

function Shell({ children, signedIn = false }: { children: React.ReactNode; signedIn?: boolean }) {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight">Portfolio</h1>
        <SiteNav signedIn={signedIn} />
      </header>
      {children}
    </main>
  );
}
