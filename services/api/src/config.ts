import { z } from "zod";

const EnvSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(4000),
  MARKET_CATALOG_URL: z.url().default("http://127.0.0.1:4100"),
  MARKET_CATALOG_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = EnvSchema.parse(env);
  return {
    port: e.API_PORT,
    marketCatalog: { baseUrl: e.MARKET_CATALOG_URL, timeoutMs: e.MARKET_CATALOG_TIMEOUT_MS },
  };
}
