"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorldSnapshotSchema, type WorldCountry, type WorldSnapshot } from "@league/trading-contract";
import { type Camera, type Viewport, centerOn, fitBounds, lerpCamera, minKFor, resizeKeepingCenter } from "@/lib/camera";
import { layoutWorld, worldBounds } from "@/lib/world-layout";
import { WorldMap } from "./world-map";

/** One shared refresh for the whole page, never one request per country. */
export const WORLD_REFRESH_MS = 5_000;
const FLY_MS = 380;
/** "Find me" and tapping a country zoom in just enough for the circle to be at least this big on screen. */
const FOCUS_RADIUS_PX = 46;

/** Everything about a snapshot EXCEPT its timestamp: if this is unchanged, nothing the viewer sees would change. */
const signature = (snapshot: WorldSnapshot) => JSON.stringify(snapshot.countries);

/**
 * The World: the map, the leaderboard and the controls around them, all drawn from ONE snapshot.
 * The camera (pan and zoom), the selection and the search text are this tab's own state. A background refresh only
 * replaces the countries, so it can never move the viewer or reset their selection. Nothing here can change Power.
 */
export function WorldView({ initial, myCountryId, signedIn }: { initial: WorldSnapshot | null; myCountryId: string | null; signedIn: boolean }) {
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(initial);
  const [stale, setStale] = useState(initial === null);
  // null until the viewer first moves: until then the camera simply shows the whole world. After that it is theirs alone.
  const [viewerCamera, setCamera] = useState<Camera | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const mapAnchor = useRef<HTMLDivElement>(null);
  const flight = useRef<number | null>(null);

  // ---- the one shared refresh -------------------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/world", { cache: "no-store" });
        const parsed = WorldSnapshotSchema.safeParse(await response.json());
        if (cancelled) return;
        if (response.ok && parsed.success) {
          setStale(false);
          // Keep the old object when nothing changed, so React has nothing to redraw and no avatar is touched.
          setSnapshot((current) => (current && signature(current) === signature(parsed.data) ? current : parsed.data));
        } else setStale(true);
      } catch {
        if (!cancelled) setStale(true); // keep showing the last snapshot
      }
    }
    void refresh();
    const timer = setInterval(refresh, WORLD_REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  // ---- derived world (pure): positions come from permanent slots, sizes from area weights -------------------------
  const countries = useMemo(() => new Map((snapshot?.countries ?? []).map((country) => [country.countryId, country] as const)), [snapshot]);
  const placements = useMemo(() => layoutWorld(snapshot?.countries ?? []), [snapshot]);
  const bounds = useMemo(() => worldBounds(placements, 60), [placements]);
  const fitCamera = useMemo(() => (viewport ? fitBounds(bounds, viewport) : null), [bounds, viewport]);
  const minK = fitCamera ? minKFor(fitCamera) : 0.01;
  const placementOf = useMemo(() => new Map(placements.map((p) => [p.countryId, p] as const)), [placements]);

  const camera = viewerCamera ?? fitCamera;
  const fitRef = useRef(fitCamera);
  useEffect(() => {
    fitRef.current = fitCamera;
  });

  const lastViewport = useRef<Viewport | null>(null);
  const handleViewport = useCallback((next: Viewport) => {
    const previous = lastViewport.current;
    if (previous && previous.width === next.width && previous.height === next.height) return;
    lastViewport.current = next;
    setViewport(next);
    // A resize or a phone rotation keeps whatever was at the centre of the view at the centre.
    if (previous) setCamera((c) => (c ? resizeKeepingCenter(c, previous, next) : c));
  }, []);

  /** A gesture from the viewer: it always wins over a running "fly to". */
  const userCamera = useCallback((update: (camera: Camera) => Camera) => {
    if (flight.current !== null) {
      cancelAnimationFrame(flight.current);
      flight.current = null;
    }
    setCamera((current) => {
      const base = current ?? fitRef.current;
      return base ? update(base) : current;
    });
  }, []);

  const flyTo = useCallback(
    (target: Camera) => {
      if (flight.current !== null) cancelAnimationFrame(flight.current);
      if (!camera || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        setCamera(target);
        return;
      }
      const from = camera;
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min((now - start) / FLY_MS, 1);
        setCamera(lerpCamera(from, target, 1 - (1 - t) ** 3));
        flight.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      flight.current = requestAnimationFrame(step);
    },
    [camera],
  );

  useEffect(
    () => () => {
      if (flight.current !== null) cancelAnimationFrame(flight.current);
    },
    [],
  );

  const locate = useCallback(
    (id: string) => {
      const placement = placementOf.get(id);
      if (!placement || !camera || !viewport) return false;
      setSelectedId(id);
      setNotice(null);
      flyTo(centerOn(camera, { x: placement.x, y: placement.y }, viewport, placement.r, FOCUS_RADIUS_PX, minK));
      return true;
    },
    [placementOf, camera, viewport, flyTo, minK],
  );

  const showWholeWorld = useCallback(() => {
    if (fitCamera) flyTo(fitCamera);
  }, [fitCamera, flyTo]);

  const findMe = useCallback(() => {
    if (!myCountryId) return setNotice("Sign in to find your country.");
    if (!locate(myCountryId)) setNotice("Your country is not in the World yet. Open your Portfolio once to create it.");
  }, [myCountryId, locate]);

  function search(event: React.FormEvent) {
    event.preventDefault();
    const wanted = query.trim().toLowerCase();
    if (!wanted) return;
    const all = snapshot?.countries ?? [];
    const match = all.find((c) => c.username.toLowerCase() === wanted) ?? all.find((c) => c.username.toLowerCase().startsWith(wanted)) ?? all.find((c) => c.username.toLowerCase().includes(wanted));
    if (match) locate(match.countryId);
    else setNotice(`No country is named "${query.trim()}".`);
  }

  function pickFromLeaderboard(id: string) {
    locate(id);
    mapAnchor.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  const markImageFailed = useCallback((url: string) => setFailedUrls((current) => new Set(current).add(url)), []);
  const selected: WorldCountry | undefined = selectedId ? countries.get(selectedId) : undefined;

  if (!snapshot) {
    return <p role="alert" className="rounded-xl bg-white p-4 text-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">The World is not available right now. It will load as soon as it can.</p>;
  }
  if (snapshot.countries.length === 0) {
    return <p className="rounded-xl bg-white p-4 text-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">No countries yet. Create an account to claim one.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <form onSubmit={search} className="flex flex-1 gap-2" role="search">
          <label className="sr-only" htmlFor="world-search">
            Find a country by username
          </label>
          <input
            id="world-search"
            list="world-usernames"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setNotice(null);
            }}
            placeholder="Find a country by username"
            autoComplete="off"
            className="min-h-11 min-w-0 flex-1 rounded-lg bg-white px-3 text-sm ring-1 ring-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:bg-zinc-900 dark:ring-zinc-700 dark:focus:ring-zinc-100"
          />
          <datalist id="world-usernames">
            {snapshot.countries.map((country) => (
              <option key={country.countryId} value={country.username} />
            ))}
          </datalist>
          <button type="submit" className="min-h-11 rounded-lg px-4 text-sm font-medium ring-1 ring-zinc-300 hover:bg-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-800">
            Go
          </button>
        </form>
        <button
          type="button"
          onClick={findMe}
          className="min-h-11 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          ◎ Find me
        </button>
      </div>
      {notice && (
        <p role="status" className="text-sm font-medium text-amber-800 dark:text-amber-300">
          {notice}{" "}
          {!signedIn && notice.startsWith("Sign in") && (
            <Link href="/sign-in" className="underline">
              Sign in
            </Link>
          )}
        </p>
      )}

      <div ref={mapAnchor} className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <WorldMap
            placements={placements}
            countries={countries}
            camera={camera}
            viewport={viewport}
            minK={minK}
            onViewport={handleViewport}
            onCamera={userCamera}
            onFit={showWholeWorld}
            onFindMe={myCountryId ? findMe : undefined}
            selectedId={selectedId}
            myId={myCountryId}
            onSelect={(id) => {
              setSelectedId(id);
              setNotice(null);
            }}
            failedUrls={failedUrls}
            onImageError={markImageFailed}
          />
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Every country is fictional and belongs to a player. A circle&apos;s area grows with its player&apos;s total Power. Updated {snapshot.asOf.slice(11, 19)} UTC, refreshed about every{" "}
            {WORLD_REFRESH_MS / 1000} seconds.{stale && " Showing the last update; reconnecting…"}
          </p>

          <SelectionCard country={selected} isMine={selected?.countryId === myCountryId} />
        </div>

        <section aria-label="Leaderboard" className="lg:w-80">
          <h2 className="mb-2 text-lg font-semibold">Leaderboard</h2>
          <ol className="max-h-[60svh] divide-y divide-zinc-200 overflow-y-auto rounded-xl bg-white ring-1 ring-zinc-200 dark:divide-zinc-800 dark:bg-zinc-900 dark:ring-zinc-800">
            {snapshot.countries.map((country) => {
              const mine = country.countryId === myCountryId;
              return (
                <li key={country.countryId}>
                  <button
                    type="button"
                    onClick={() => pickFromLeaderboard(country.countryId)}
                    aria-current={country.countryId === selectedId ? "true" : undefined}
                    className={`flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 ${country.countryId === selectedId ? "bg-zinc-100 dark:bg-zinc-800" : ""}`}
                  >
                    <span className="w-6 text-right font-semibold tabular-nums">{country.rank}</span>
                    <Swatch country={country} failed={country.avatarUrl !== null && failedUrls.has(country.avatarUrl)} />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {country.username}
                      {mine && <span className="ml-1.5 rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white dark:bg-zinc-100 dark:text-zinc-900">You</span>}
                    </span>
                    <span className="tabular-nums text-zinc-600 dark:text-zinc-400">{(country.relativeSize * 100).toFixed(1)}%</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </div>
  );
}

/** The leaderboard's small version of the country circle: picture if it has one, colour otherwise. */
function Swatch({ country, failed }: { country: WorldCountry; failed: boolean }) {
  return (
    <span aria-hidden className="relative h-6 w-6 shrink-0 overflow-hidden rounded-full" style={{ backgroundColor: country.color, boxShadow: `0 0 0 1.5px ${country.color}` }}>
      {country.avatarUrl && !failed && (
        // eslint-disable-next-line @next/next/no-img-element -- a 256 px public Storage thumbnail; Next image optimisation adds nothing here
        <img src={country.avatarUrl} alt="" width={24} height={24} loading="lazy" decoding="async" className="h-full w-full object-cover" />
      )}
    </span>
  );
}

function SelectionCard({ country, isMine }: { country: WorldCountry | undefined; isMine: boolean }) {
  if (!country) {
    return <p className="rounded-xl bg-white p-3 text-sm text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800">Tap a circle, or pick a country from the leaderboard.</p>;
  }
  return (
    <section aria-live="polite" aria-label="Selected country" className="flex flex-col gap-3 rounded-xl bg-white p-3 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-full" style={{ backgroundColor: country.color, boxShadow: `0 0 0 2px ${country.color}` }}>
          {country.avatarUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- see Swatch
            <img src={country.avatarUrl} alt="" width={48} height={48} className="h-full w-full object-cover" onError={(event) => (event.currentTarget.style.display = "none")} />
          )}
        </span>
        <div>
          <p className="text-base font-semibold">
            {country.username}
            {isMine && " (you)"}
          </p>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Rank {country.rank} · {(country.relativeSize * 100).toFixed(1)}% of the World · size ×{country.areaWeight.toFixed(2)}
          </p>
        </div>
      </div>
      {isMine && (
        <Link href="/dashboard#country" className="inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-medium ring-1 ring-zinc-300 hover:bg-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-800">
          Edit my country
        </Link>
      )}
    </section>
  );
}
