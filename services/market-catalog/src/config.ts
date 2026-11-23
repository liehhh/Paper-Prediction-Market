import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required (see services/market-catalog/.env.example)"),
  DATABASE_CA_CERT_PATH: z.string().optional(),
  CATALOG_HOST: z.string().default("127.0.0.1"),
  CATALOG_PORT: z.coerce.number().int().positive().default(4100),
  POLYMARKET_GAMMA_BASE_URL: z.url().default("https://gamma-api.polymarket.com"),
  POLYMARKET_CLOB_BASE_URL: z.url().default("https://clob.polymarket.com"),
  POLYMARKET_WS_URL: z.string().regex(/^wss?:\/\//).default("wss://ws-subscriptions-clob.polymarket.com/ws/market"),
  SYNC_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  SYNC_MAX_ATTEMPTS_PER_REQUEST: z.coerce.number().int().min(1).max(10).default(4),
});

export type CatalogConfig = ReturnType<typeof loadConfig>;

/** Reads and validates environment variables. Error messages name variables, never their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid market-catalog configuration:\n  ${problems.join("\n  ")}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    databaseCaCertPath: e.DATABASE_CA_CERT_PATH || undefined,
    host: e.CATALOG_HOST,
    port: e.CATALOG_PORT,
    clobBaseUrl: e.POLYMARKET_CLOB_BASE_URL,
    wsUrl: e.POLYMARKET_WS_URL,
    gamma: {
      baseUrl: e.POLYMARKET_GAMMA_BASE_URL,
      requestTimeoutMs: e.SYNC_REQUEST_TIMEOUT_MS,
      maxAttemptsPerRequest: e.SYNC_MAX_ATTEMPTS_PER_REQUEST,
    },
  };
}
