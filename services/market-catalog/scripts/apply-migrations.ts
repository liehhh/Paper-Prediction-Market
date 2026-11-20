/**
 * `pnpm db:migrate`: applies pending SQL migrations from supabase/migrations to the database
 * in DATABASE_URL, using the Supabase CLI (`supabase db push --remote=<url>`).
 * Already-applied migrations are skipped; the CLI records applied versions in
 * supabase_migrations.schema_migrations. It never resets or drops anything.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set. Create services/market-catalog/.env from .env.example first.");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Use the CLI installed by the `supabase` dev dependency rather than whatever is on PATH.
const supabaseCli = createRequire(import.meta.url).resolve("supabase/dist/supabase.js");

const host = new URL(databaseUrl).hostname;
const isLocal = host === "localhost" || host === "127.0.0.1";

const result = spawnSync(
  process.execPath,
  [supabaseCli, "db", "push", `--remote=${databaseUrl}`, "--workdir", repoRoot, "--include-all", "--yes"],
  {
    stdio: "inherit",
    // Without this the CLI silently falls back to an unencrypted connection if TLS fails.
    // Throwaway local databases (tests) have no TLS, so only remote hosts require it.
    env: { ...process.env, ...(isLocal ? {} : { PGSSLMODE: "require" }) },
  },
);
process.exit(result.status ?? 1);
