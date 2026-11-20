/**
 * Decides which catalog state to show, from the API's freshness metadata.
 * Pure function so every UI state can be tested without rendering.
 */
import type { MarketListResponse, SyncRunStatus } from "@league/catalog-contract";

export type CatalogNotice =
  /** No sync has ever published data. */
  | { kind: "not_synced_yet"; latestAttemptStatus: SyncRunStatus | null }
  /** Saved data is shown, but the most recent attempt after it failed or was partial. */
  | { kind: "refresh_problem"; lastSuccessfulRefreshAt: string | null; attemptStatus: "failed" | "partial"; attemptStartedAt: string }
  /** A sync is running right now; saved data is still shown. */
  | { kind: "refreshing"; lastSuccessfulRefreshAt: string | null }
  | { kind: "fresh"; lastSuccessfulRefreshAt: string };

export function describeCatalog(response: MarketListResponse): CatalogNotice {
  const { lastSuccessfulRefreshAt, latestAttempt } = response.catalog;

  // A partial run publishes markets without being a full refresh, so its data counts as "saved".
  const hasSavedData = lastSuccessfulRefreshAt !== null || response.markets.length > 0 || latestAttempt?.status === "partial";
  if (!hasSavedData) return { kind: "not_synced_yet", latestAttemptStatus: latestAttempt?.status ?? null };

  if (latestAttempt && (latestAttempt.status === "failed" || latestAttempt.status === "partial")) {
    const isNewerThanLastSuccess =
      lastSuccessfulRefreshAt === null || Date.parse(latestAttempt.startedAt) > Date.parse(lastSuccessfulRefreshAt);
    if (isNewerThanLastSuccess) {
      return {
        kind: "refresh_problem",
        lastSuccessfulRefreshAt,
        attemptStatus: latestAttempt.status,
        attemptStartedAt: latestAttempt.startedAt,
      };
    }
  }

  if (latestAttempt?.status === "running") return { kind: "refreshing", lastSuccessfulRefreshAt };
  if (lastSuccessfulRefreshAt) return { kind: "fresh", lastSuccessfulRefreshAt };
  return { kind: "refreshing", lastSuccessfulRefreshAt: null };
}
