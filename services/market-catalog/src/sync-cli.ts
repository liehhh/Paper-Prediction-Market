/**
 * One-shot sync: `pnpm catalog:sync`. Same application logic as POST /internal/v1/sync.
 * Exit code 0 = succeeded, 2 = partial (published, nothing delisted), 1 = failed or superseded.
 */
import { loadConfig } from "./config.ts";
import { createPool } from "./db.ts";
import { runCatalogSync } from "./sync/run-catalog-sync.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.databaseCaCertPath);

try {
  const summary = await runCatalogSync(
    { pool, gamma: config.gamma, maxPagesPerTag: config.maxPagesPerTag, log: (m) => console.log(m) },
    "cli",
  );

  console.log("");
  console.log(`Run ${summary.runId}: ${summary.status.toUpperCase()}`);
  for (const tag of summary.tags) {
    console.log(
      `  ${tag.category} <- Polymarket tag "${tag.polymarketTagSlug}": ${tag.pagesFetched} page(s), ` +
        `${tag.eventsFetched} events, ${tag.marketsAccepted} open YES/NO markets${tag.truncated ? " (TRUNCATED)" : ""}`,
    );
  }
  console.log(`  published: ${summary.marketsPublished}   delisted: ${summary.marketsDelisted}`);
  console.log(`  skipped: ${JSON.stringify(summary.skipCounts)}`);
  for (const skip of summary.notableSkips) {
    console.log(`    - ${skip.reason} event=${skip.providerEventId} market=${skip.providerMarketId}: ${skip.detail}`);
  }
  if (summary.statusDetail) console.log(`  note: ${summary.statusDetail}`);

  process.exitCode = summary.status === "succeeded" ? 0 : summary.status === "partial" ? 2 : 1;
} catch (error) {
  console.error("Sync failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
