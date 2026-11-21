# Project instructions

Public paper prediction league (virtual credits only — no deposits, withdrawals, wallets, or real-money orders).
Milestone work is incremental: build only the milestone the owner asks for, then stop and wait.

## Git attribution — persistent rule

- Do not commit, push, or open a pull request unless the owner explicitly asks.
- When asked to commit, use the existing Git author configuration.
- Never add Claude, Anthropic, or any other AI as an author or co-author.
- Never add a `Co-authored-by` trailer, "Generated with" footer, or any AI signature to commits or pull requests.
- Before any requested commit, verify the final message contains no attribution footer.
- Commit the lockfile only when the owner asks for a commit.

## Docker-free — persistent rule (applies to every milestone, including tests, CI, and deployment)

- Do not introduce Dockerfiles, Docker Compose, Testcontainers, or `supabase start` / the local Supabase stack.
- The database is a hosted Supabase project. Only the two services that own a schema connect to it, each via its own server-only `DATABASE_URL`: `services/market-catalog` (`market_catalog` schema) and `services/trading` (`trading` schema). `services/api` and `apps/web` never receive a database credential.
- Run Next.js and the Express services as separate Node.js processes; `pnpm dev` starts them all on Windows.
- Database changes live in version-controlled SQL migrations under `supabase/migrations`, applied with `pnpm db:migrate`. Never put a database reset in the setup flow.
- Database integration tests use an isolated, throwaway test database (currently an `embedded-postgres` binary started by the test suite) — never the hosted development project.
- When deploying, choose a host that runs Node.js apps directly from the repository.

## Service boundaries

- `apps/web` talks only to `services/api`. It never calls Polymarket or Postgres. The one exception is Supabase Auth (register, sign-in, sign-out, session cookies), which Next.js calls directly because it must set the session cookies; it uses the public publishable key only.
- `services/api` is the single client-facing API. It never touches Postgres; it calls `services/market-catalog` and `services/trading` over HTTP. It is the only service that verifies Supabase access tokens, and it passes the verified user id (never anything the client supplied) to `services/trading`.
- `services/market-catalog` owns Polymarket integration and the `market_catalog` schema. No other service may read or write those tables.
- `services/trading` owns trading accounts, cash accounting, the ledger, and (later) paper-trade execution, all in the `trading` schema so that a fill, its cash movement and its position change can commit in one transaction. Do not split wallet, ledger or orders into separate services. Credits are exact decimals (`numeric(20, 6)`, strings in JSON): never use JavaScript floats for accounting.
- Extract shared packages only when at least two apps need the same contract (`packages/catalog-contract` and `packages/trading-contract` today).
- Avoid placeholder services, abstract base repositories, generic managers, and pass-through layers.

## Conventions

- TypeScript strict mode everywhere. Services run TypeScript directly on Node 24 (type stripping), so use erasable syntax only (no `enum`, no constructor parameter properties) and import local files with the `.ts` extension.
- Windows PowerShell is the primary shell for documented commands.
