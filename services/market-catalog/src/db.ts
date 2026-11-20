import { readFileSync } from "node:fs";
import pg from "pg";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Builds the pg pool configuration from DATABASE_URL.
 *
 * TLS is decided here explicitly rather than through `sslmode` in the URL: node-postgres
 * lets URL parameters override the `ssl` object, and treats `sslmode=require` as full
 * verification, which fails against Supabase's private CA unless that CA is supplied.
 */
export function buildPoolConfig(databaseUrl: string, caCertPath?: string): pg.PoolConfig {
  const url = new URL(databaseUrl);
  for (const param of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) {
    url.searchParams.delete(param);
  }

  let ssl: pg.PoolConfig["ssl"];
  if (LOCAL_HOSTS.has(url.hostname)) {
    ssl = false; // throwaway local test databases only
  } else if (caCertPath) {
    ssl = { ca: readFileSync(caCertPath, "utf8"), rejectUnauthorized: true };
  } else {
    console.warn(
      "[db] DATABASE_CA_CERT_PATH is not set: the connection is encrypted but the server certificate is not verified.",
    );
    ssl = { rejectUnauthorized: false };
  }

  return {
    connectionString: url.toString(),
    ssl,
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // Bounds every statement so a stuck query cannot hang a request or a sync forever.
    statement_timeout: 60_000,
  };
}

export function createPool(databaseUrl: string, caCertPath?: string): pg.Pool {
  const pool = new pg.Pool(buildPoolConfig(databaseUrl, caCertPath));
  // An idle client can error (e.g. the pooler drops it). Log instead of crashing the process.
  pool.on("error", (error) => console.error("[db] idle client error:", error.message));
  return pool;
}
