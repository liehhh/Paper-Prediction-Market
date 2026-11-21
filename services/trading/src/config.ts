import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required (see services/trading/.env.example)"),
  DATABASE_CA_CERT_PATH: z.string().optional(),
  TRADING_HOST: z.string().default("127.0.0.1"),
  TRADING_PORT: z.coerce.number().int().positive().default(4200),
});

/** Reads and validates environment variables. Error messages name variables, never their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid trading configuration:\n  ${problems.join("\n  ")}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    databaseCaCertPath: e.DATABASE_CA_CERT_PATH || undefined,
    host: e.TRADING_HOST,
    port: e.TRADING_PORT,
  };
}
