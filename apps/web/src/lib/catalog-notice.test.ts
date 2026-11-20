import { describe, expect, it } from "vitest";
import type { MarketListResponse } from "@league/catalog-contract";
import { describeCatalog } from "./catalog-notice";

const market: MarketListResponse["markets"][number] = {
  id: "1",
  question: "Q?",
  eventTitle: "E",
  categories: ["politics"],
  expectedEndAt: null,
  snapshotPrices: null,
  sourceUrl: null,
  lastSyncedAt: "2026-11-20T10:00:00.000Z",
};

const page = (catalog: MarketListResponse["catalog"], markets = [market]): MarketListResponse => ({ markets, nextCursor: null, catalog });

describe("describeCatalog", () => {
  it("first sync has not happened", () => {
    expect(describeCatalog(page({ lastSuccessfulRefreshAt: null, latestAttempt: null }, []))).toEqual({
      kind: "not_synced_yet",
      latestAttemptStatus: null,
    });
  });

  it("first sync failed: still 'not synced yet', with the failure surfaced", () => {
    const attempt = { status: "failed" as const, startedAt: "2026-11-20T10:00:00.000Z", finishedAt: "2026-11-20T10:00:05.000Z" };
    expect(describeCatalog(page({ lastSuccessfulRefreshAt: null, latestAttempt: attempt }, []))).toMatchObject({
      kind: "not_synced_yet",
      latestAttemptStatus: "failed",
    });
  });

  it("saved data with a newer failed attempt", () => {
    const notice = describeCatalog(
      page({
        lastSuccessfulRefreshAt: "2026-11-20T10:00:00.000Z",
        latestAttempt: { status: "failed", startedAt: "2026-11-20T11:00:00.000Z", finishedAt: "2026-11-20T11:00:03.000Z" },
      }),
    );
    expect(notice).toEqual({
      kind: "refresh_problem",
      attemptStatus: "failed",
      lastSuccessfulRefreshAt: "2026-11-20T10:00:00.000Z",
      attemptStartedAt: "2026-11-20T11:00:00.000Z",
    });
  });

  it("an empty category after a successful sync is fresh, not 'never synced'", () => {
    const attempt = { status: "succeeded" as const, startedAt: "2026-11-20T09:59:00.000Z", finishedAt: "2026-11-20T10:00:00.000Z" };
    expect(describeCatalog(page({ lastSuccessfulRefreshAt: "2026-11-20T10:00:00.000Z", latestAttempt: attempt }, [])).kind).toBe("fresh");
  });
});
