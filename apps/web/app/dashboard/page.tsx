import Link from "next/link";
import { redirect } from "next/navigation";
import { NoticeBox } from "@/components/notice-box";
import { formatCredits, formatSignedCredits } from "@/lib/format-credits";
import { formatDateTimeUtc } from "@/lib/format";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureTradingAccount } from "@/lib/trading-api";
import { signOut } from "../auth/actions";

// Per-user and always fresh: never cached, never shared.
export const dynamic = "force-dynamic";

const ENTRY_LABELS = { starting_grant: "Starting grant" } as const;

export default async function DashboardPage() {
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

  const result = await ensureTradingAccount(session.access_token);
  if (!result.ok && result.problem === "unauthenticated") redirect("/sign-in");

  return (
    <Shell signedIn>
      {!result.ok ? (
        // Deliberately no balance of any kind: a failed request must not look like "0" or "10,000".
        <NoticeBox tone="error" title="We could not load your trading account.">
          {result.problem === "unavailable" ? "The trading service is temporarily unavailable." : "Something went wrong on our side."} You are
          still signed in and nothing was lost.{" "}
          <Link href="/dashboard" className="font-medium underline">
            Try again
          </Link>
        </NoticeBox>
      ) : (
        <>
          <section aria-label="Paper cash" className="rounded-xl bg-white p-6 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Available paper cash</p>
            <p className="mt-1 text-3xl font-bold tabular-nums">{formatCredits(result.data.cash.available)} credits</p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Virtual credits only. Account opened {formatDateTimeUtc(result.data.openedAt)}.
            </p>
          </section>

          <section aria-label="Account activity" className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Activity</h2>
            <ul className="divide-y divide-zinc-200 rounded-xl bg-white ring-1 ring-zinc-200 dark:divide-zinc-800 dark:bg-zinc-900 dark:ring-zinc-800">
              {result.data.activity.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                  <span>
                    <span className="font-medium">{ENTRY_LABELS[entry.type]}</span>
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">{formatDateTimeUtc(entry.createdAt)}</span>
                  </span>
                  <span className="font-medium tabular-nums">{formatSignedCredits(entry.amount)}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </Shell>
  );
}

function Shell({ children, signedIn = false }: { children: React.ReactNode; signedIn?: boolean }) {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight">My account</h1>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/" className="font-medium underline-offset-2 hover:underline">
            Markets
          </Link>
          {signedIn && (
            <form action={signOut}>
              <button type="submit" className="font-medium underline-offset-2 hover:underline">
                Sign out
              </button>
            </form>
          )}
        </nav>
      </header>
      {children}
    </main>
  );
}
