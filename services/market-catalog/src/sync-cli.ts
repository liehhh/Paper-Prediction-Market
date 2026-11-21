/**
 * One-shot sync: `pnpm catalog:sync`. Same application logic as POST /internal/v1/sync.
 * Exit code 0 = succeeded, 1 = failed, partial, or superseded (the previous catalog is kept).
 */
import { loadConfig } from "./config.ts";
import { createPool } from "./db.ts";
import { runCatalogSync } from "./sync/run-catalog-sync.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.databaseCaCertPath);

try {
  const summary = await runCatalogSync({ pool, gamma: config.gamma, log: (m) => console.log(m) }, "cli");

  console.log("");
  console.log(`Run ${summary.runId}: ${summary.status.toUpperCase()} in ${(summary.durationMs / 1000).toFixed(1)}s`);
  console.log(`  requests made:     ${summary.requestsMade} (event pages, retries excluded)`);
  console.log(`  events fetched:    ${summary.eventsFetched}`);
  console.log(`  eligible markets:  ${summary.marketsEligible} (open binary YES/NO)`);
  console.log(`  rows written:      ${summary.marketsWritten} (new or changed)   delisted: ${summary.marketsDelisted}`);
  console.log(`  skipped markets:   ${JSON.stringify(summary.skipCounts)}`);
  for (const skip of summary.notableSkips) {
    console.log(`    - ${skip.reason} event=${skip.providerEventId} market=${skip.providerMarketId}: ${skip.detail}`);
  }
  if (summary.statusDetail) console.log(`  note: ${summary.statusDetail}`);

  process.exitCode = summary.status === "succeeded" ? 0 : 1;
} catch (error) {
  console.error("Sync failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
