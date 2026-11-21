import { loadConfig } from "./config.ts";
import { createApp } from "./create-app.ts";

const config = loadConfig();
if (!config.auth) console.warn("[api] SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY not set: /v1/me/* will answer 503 until sign-in is configured.");
const server = createApp({ marketCatalog: config.marketCatalog, trading: config.trading, auth: config.auth }).listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
