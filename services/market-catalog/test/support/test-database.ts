/**
 * Isolated, throwaway PostgreSQL for integration tests — no Docker, no hosted project.
 * `embedded-postgres` ships real PostgreSQL 17 binaries via npm. Each test file gets its own
 * server in a temp directory, with the repository's migrations applied in filename order.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../supabase/migrations");

export interface TestDatabase {
  pool: pg.Pool;
  databaseUrl: string;
  /** Empties the catalog tables between tests. */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "league-test-pg-"));
  const port = await findFreePort();
  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: "postgres",
    password: "postgres",
    persistent: false,
    // Match hosted Supabase (UTF-8). Without this, initdb on Windows inherits WIN1252 and
    // rejects real market titles such as "Erdoğan".
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => undefined,
  });
  await server.initialise();
  await server.start();

  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  await applyMigrations(pool);

  return {
    pool,
    databaseUrl,
    async reset() {
      await pool.query("truncate market_catalog.markets, market_catalog.sync_runs restart identity cascade");
    },
    async stop() {
      await pool.end();
      await server.stop();
      // Right after Postgres stops, Windows can still hold a lock on its folder (EBUSY). Retry, and never fail a test run over
      // a leftover temp directory.
      await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined);
    },
  };
}

async function applyMigrations(pool: pg.Pool): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    await pool.query(await readFile(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}
