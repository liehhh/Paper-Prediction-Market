"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the server page every few seconds while the tab is visible, so quotes and valuations stay current.
 * It only re-reads data; it never changes anything.
 */
export function AutoRefresh({ everyMs = 10_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(tick, everyMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, everyMs]);
  return null;
}
