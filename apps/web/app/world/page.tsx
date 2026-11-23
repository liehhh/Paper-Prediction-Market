import Link from "next/link";
import { NoticeBox } from "@/components/notice-box";
import { SiteNav } from "@/components/site-nav";
import { WorldView } from "@/components/world-view";
import { getWorld } from "@/lib/public-api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureTradingAccount, fetchTradingAccount } from "@/lib/trading-api";

export const dynamic = "force-dynamic";

export const metadata = { title: "World — Paper Prediction League" };

const QUICK_LINK = "inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-medium ring-1 ring-zinc-300 hover:bg-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-800";

/**
 * The shared World. Anyone can look. When signed in, the page also learns which country is yours (so "Find me" can
 * highlight it); opening it also makes sure your account exists, which is how a brand-new player appears with their
 * assigned colour straight after registering. Reading the World never changes Power.
 */
export default async function WorldPage() {
  const supabase = await createSupabaseServerClient();
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  // Two reads side by side. Looking up "my country" is a plain read; the creating call is only for a brand-new player.
  let [world, account] = await Promise.all([getWorld(), session ? fetchTradingAccount(session.access_token) : Promise.resolve(null)]);
  if (session && account && !account.ok && account.problem === "not_found") {
    account = await ensureTradingAccount(session.access_token);
    world = await getWorld(); // the new country now exists
  }
  const mine = account?.ok ? account.data.countryId : null;
  const snapshot = world;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Paper Prediction League</p>
          <SiteNav signedIn={Boolean(session)} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">World</h1>
          {/* Trading never requires navigating the map. */}
          <div className="flex gap-2">
            <Link href="/?category=politics" className={QUICK_LINK}>
              Markets
            </Link>
            <Link href="/dashboard" className={QUICK_LINK}>
              Portfolio
            </Link>
          </div>
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Every player owns a fictional country. Its size is its player&apos;s total Power: available Power plus the value of the shares they hold. Power is virtual; no real money is
          involved.
        </p>
      </header>

      {!snapshot.ok && (
        <NoticeBox tone="warning" title="The World could not be loaded just now.">
          It will keep trying. Markets and your Portfolio still work.
        </NoticeBox>
      )}
      <WorldView initial={snapshot.ok ? snapshot.data : null} myCountryId={mine} signedIn={Boolean(session)} />
    </main>
  );
}
