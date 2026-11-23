import Link from "next/link";
import { signOut } from "../../app/auth/actions";

const LINK = "font-medium underline-offset-2 hover:underline";

/** Shared top navigation. The World map and the markets list work without signing in. */
export function SiteNav({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <Link href="/" className={LINK}>
        Markets
      </Link>
      <Link href="/world" className={LINK}>
        World
      </Link>
      <Link href="/dashboard" className={LINK}>
        Portfolio
      </Link>
      {signedIn && (
        <form action={signOut}>
          <button type="submit" className={LINK}>
            Sign out
          </button>
        </form>
      )}
    </nav>
  );
}
