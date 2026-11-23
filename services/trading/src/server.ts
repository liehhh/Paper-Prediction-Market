import { createHttpCatalog } from "./catalog-client.ts";
import { loadConfig } from "./config.ts";
import { createPool, keepPoolWarm } from "./db.ts";
import { createApp } from "./http/create-app.ts";
import { ValuationService } from "./league/valuation.ts";
import { runSettlementPass } from "./settlement/settlement.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.databaseCaCertPath);
keepPoolWarm(pool);
const catalog = createHttpCatalog({ baseUrl: config.catalogUrl, timeoutMs: config.catalogTimeoutMs });
const log = (message: string) => console.log(`[trading] ${message}`);
const valuation = new ValuationService({ pool, catalog, log });

const server = createApp({ pool, catalog, valuation }).listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port}`);
});

// Background work. Both loops are safe to repeat and safe after a restart: everything they need is in Postgres.
//  - valuation: every 15 s recompute totals, ask market-catalog to keep every held market tracked ("pin"), and save a
//    position's last known mark only when it moved meaningfully (never one write per tick);
//  - settlement: every 30 s ask the provider about every market that still has open positions and pay out the ones
//    that officially resolved. The first pass runs at startup, so a crash between resolution and payout self-heals.
const timers = [
  setInterval(() => void valuation.refresh(true).catch((error) => console.error("[trading] valuation failed:", error)), 15_000),
  setInterval(
    () => void runSettlementPass({ pool, catalog, onChange: () => valuation.invalidate(), log }).catch((error) => console.error("[trading] settlement failed:", error)),
    30_000,
  ),
];
for (const timer of timers) timer.unref();
void valuation.refresh(true).catch((error) => console.error("[trading] first valuation failed:", error));
void runSettlementPass({ pool, catalog, onChange: () => valuation.invalidate(), log }).catch((error) => console.error("[trading] first settlement pass failed:", error));

function shutdown() {
  for (const timer of timers) clearInterval(timer);
  server.close(() => void pool.end().finally(() => process.exit(0)));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
