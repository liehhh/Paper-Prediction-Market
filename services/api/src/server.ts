import { loadConfig } from "./config.ts";
import { createApp } from "./create-app.ts";

const config = loadConfig();
const server = createApp({ marketCatalog: config.marketCatalog }).listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
