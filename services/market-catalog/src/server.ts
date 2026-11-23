import { loadConfig } from "./config.ts";
import { createPool, keepPoolWarm } from "./db.ts";
import { createApp } from "./http/create-app.ts";
import { BookFeed } from "./orderbook/book-feed.ts";
import { ProviderStatus } from "./orderbook/provider-status.ts";
import { QuoteService } from "./orderbook/quote-service.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.databaseCaCertPath);
keepPoolWarm(pool);
// One shared connection to Polymarket's order-book feed for every user (see orderbook/book-feed.ts).
const feed = new BookFeed({ wsUrl: config.wsUrl, clobBaseUrl: config.clobBaseUrl, log: (message) => console.log(`[feed] ${message}`) });
feed.start();
const quotes = new QuoteService({ pool, feed, provider: new ProviderStatus({ gammaBaseUrl: config.gamma.baseUrl }) });
const app = createApp({
  pool,
  quotes,
  gamma: config.gamma,
  log: (message) => console.log(`[sync] ${message}`),
});

const server = app.listen(config.port, config.host, () => {
  console.log(`[market-catalog] listening on http://${config.host}:${config.port}`);
});

function shutdown() {
  feed.stop();
  server.close(() => void pool.end().finally(() => process.exit(0)));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
