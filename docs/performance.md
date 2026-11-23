## Why pages can be slow here, and the rules that keep them fast

The database is a hosted Supabase project in another region (measured 2026-11-23, from a Windows dev machine to
`aws-1-eu-west-1.pooler.supabase.com`). Everything below follows from three measured costs:

| Cost | Measured |
|---|---|
| One database statement (a network round trip) | **about 165 ms** |
| Asking Supabase Auth who owns a token | **about 400 ms** (first call 1.4 s: DNS + TLS) |
| Opening a NEW database connection (TLS + login) | **over 1 s** |

So a page's load time is, almost exactly, `(sequential statements x 165 ms) + (Auth checks x 400 ms) + (new connections x 1 s)`.
Next.js and rendering are a few milliseconds: that is why the dev log shows the time under `application-code`.

### What was slow, and what fixed it

| Page | Before | Why | Now |
|---|---|---|---|
| `/dashboard` | ~2.3-2.5 s | create-account call on every view (6 statements) + 3 API calls in a row (3 Auth checks) + the cached valuation thrown away by that call, so 4 more statements | the 3 reads run side by side; one Auth check; 1-statement reads; the valuation stays cached |
| `/world` | ~1.3-1.5 s | the same create-account call on every view | a plain 1-statement read; the creating call only for a brand-new player |
| `/api/world` (polled every 5 s) | 20 ms, with 670 ms spikes | every dashboard/world view invalidated the cache, so the next poll recomputed (4 statements) | ~3 ms: a slightly old snapshot is served at once and refreshed behind the scenes |
| `/` right after a quiet spell | 1.5-2.2 s | the pool closed idle connections after 30 s; the next page paid for a new one | connections are kept (10 min), pre-opened (3) and pinged every 20 s |

### Rules

1. **Count statements.** A new query on a page path costs 165 ms each, sequentially. Prefer ONE statement that returns JSON
   (`json_agg`) over begin/select/select/commit. A single statement is also one consistent snapshot, so nothing is lost.
   `services/trading/test/query-counts.int.test.ts` fails if the account read, the repeat `PUT` or the valuation grow past one statement.
2. **Read first, write only when needed.** `PUT /accounts/:id` reads once; it provisions (a transaction) and invalidates the valuation only
   for a genuinely new player.
3. **Independent reads run together** (`Promise.all`), never one after another.
4. **Never make a page wait on a third party.** Polymarket status lookups are stale-while-revalidate (last known answer for up to 60 s,
   refreshed in the background). The valuation is served from memory when under 30 s old. A trade still shows immediately: it marks
   the valuation dirty, so the next read recomputes first.
5. **Keep connections alive.** `keepPoolWarm` in `services/*/src/db.ts`.

### Trade-off to know about

The API remembers a token that Supabase Auth confirmed for **20 seconds** (`AUTH_CACHE_TTL_MS`, `0` turns it off). So after signing out,
the old token can still be accepted by the API for up to 20 s. Only confirmed tokens are remembered: a forged, expired or rejected token is
checked every time.

### Still slow, by design

- The **first** request after a deploy or restart (cold caches, the first token check, first TLS to Supabase).
- A page that really needs several **sequential** round trips, such as the trade confirm (it checks the quote, then writes in one transaction).
- If this is still too slow for you, the biggest remaining lever is moving the Supabase project to a region near you (or near wherever the
  services will run): every figure above scales with that distance.
