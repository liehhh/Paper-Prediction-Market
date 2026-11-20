import { loadConfig } from "./config.ts";
import { createPool } from "./db.ts";
import { createApp } from "./http/create-app.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.databaseCaCertPath);
const app = createApp({
  pool,
  gamma: config.gamma,
  maxPagesPerTag: config.maxPagesPerTag,
  log: (message) => console.log(`[sync] ${message}`),
});

const server = app.listen(config.port, config.host, () => {
  console.log(`[market-catalog] listening on http://${config.host}:${config.port}`);
});

function shutdown() {
  server.close(() => void pool.end().finally(() => process.exit(0)));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
