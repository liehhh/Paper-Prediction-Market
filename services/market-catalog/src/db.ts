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
    // Opening a connection to a remote Supabase pooler (TLS + login) costs over a second, so an idle connection is kept for
    // 10 minutes instead of 30 seconds, and TCP keep-alive stops the network path from silently dropping it.
    idleTimeoutMillis: 10 * 60_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    // Bounds every statement so a stuck query cannot hang a request or a sync forever.
    statement_timeout: 60_000,
  };
}

/**
 * Opens `connections` connections right away and keeps them warm with a trivial query every `everyMs`.
 *
 * Opening a connection to a remote Supabase pooler (TLS + login) costs over a second, and a page that makes several
 * queries at once needs several connections. Without this, the first page view after a restart (or a quiet spell)
 * pays that cost. The price is a few idle connections and one `select 1` each every 20 seconds.
 * Returns a function that stops it.
 */
export function keepPoolWarm(pool: pg.Pool, connections = 3, everyMs = 20_000): () => void {
  // Running the queries AT THE SAME TIME is what makes the pool open that many connections.
  const ping = () => void Promise.all(Array.from({ length: connections }, () => pool.query("select 1"))).catch(() => undefined);
  ping();
  const timer = setInterval(ping, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function createPool(databaseUrl: string, caCertPath?: string): pg.Pool {
  const pool = new pg.Pool(buildPoolConfig(databaseUrl, caCertPath));
  // An idle client can error (e.g. the pooler drops it). Log instead of crashing the process.
  pool.on("error", (error) => console.error("[db] idle client error:", error.message));
  return pool;
}
