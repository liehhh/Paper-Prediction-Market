import { z } from "zod";

const EnvSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(4000),
  MARKET_CATALOG_URL: z.url().default("http://127.0.0.1:4100"),
  MARKET_CATALOG_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  TRADING_URL: z.url().default("http://127.0.0.1:4200"),
  TRADING_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  // How long a token confirmed by Supabase Auth is trusted from memory. 0 = ask Supabase on every request.
  AUTH_CACHE_TTL_MS: z.coerce.number().int().min(0).max(300_000).default(20_000),
  // Optional so the public catalog keeps working before sign-in is set up. Both public values.
  SUPABASE_URL: z.url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = EnvSchema.parse({
    ...env,
    // An empty line in .env means "not set", not "invalid".
    SUPABASE_URL: env.SUPABASE_URL || undefined,
    SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY || undefined,
  });
  return {
    port: e.API_PORT,
    marketCatalog: { baseUrl: e.MARKET_CATALOG_URL, timeoutMs: e.MARKET_CATALOG_TIMEOUT_MS },
    trading: { baseUrl: e.TRADING_URL, timeoutMs: e.TRADING_TIMEOUT_MS },
    auth:
      e.SUPABASE_URL && e.SUPABASE_PUBLISHABLE_KEY
        ? { url: e.SUPABASE_URL, publishableKey: e.SUPABASE_PUBLISHABLE_KEY, timeoutMs: e.TRADING_TIMEOUT_MS, cacheTtlMs: e.AUTH_CACHE_TTL_MS }
        : undefined,
  };
}
