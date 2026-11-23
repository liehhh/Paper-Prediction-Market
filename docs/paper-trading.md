## Paper trading: the first political trade

Everything below is virtual. "Power" is the currency name users see.

### Run it (Windows PowerShell)

```powershell
cd "C:\Users\<you>\Desktop\Prediction Market Paper"
pnpm install
pnpm db:migrate      # additive: new columns/tables only; never resets anything
pnpm catalog:sync    # re-imports markets so they carry order-book token ids and resolution rules
pnpm dev             # web 3000, api 4000, market-catalog 4100, trading 4200
```

`services/trading/.env` needs nothing new (`MARKET_CATALOG_URL` defaults to `http://127.0.0.1:4100`).
`services/market-catalog/.env` gains optional `POLYMARKET_CLOB_BASE_URL` and `POLYMARKET_WS_URL` (defaults are the real endpoints).

### Two-browser demonstration

1. Browser 1 (normal window) and browser 2 (private window): register or sign in as two different players. Each opens **Portfolio**: 10,000 Power, rank 1, equal size. Optionally set distinct usernames there; they are the country names.
2. Both open **World** (`/world`; the old `/league` redirects): two equal circles, both rank 1.
3. Browser 1: **Markets -> Politics**, open a market that is *Open* and *Live*. Read the rules and the quote time. Choose Yes, Buy, a budget (for example 2000), **Preview order**, read the shares, average price, "most you will spend" and quote time, then **Confirm buy**.
4. Browser 1 **Portfolio**: available Power fell by the cost, shares appear, total Power is available plus marked value. Both browsers' **World** pages update within about 5 seconds: the country sizes move with total Power (a buy at an ask above the midpoint lowers total Power by the half-spread at once).
5. Browser 2 cannot see browser 1's balance, shares or fills anywhere: `/v1/league` carries only country id, username, colour, slot, rank and a rounded relative size.
6. Refresh both, and restart `pnpm dev`: positions, identities and ranks are unchanged (all of it is in Postgres).

### Policies (one decision each)

**Quote and execution.** Execution prices come from the live Polymarket order book of the chosen outcome's own token (YES and NO have separate tokens and books; the catalog maps them by outcome label, never by position). Buys walk the asks cheapest-first, sells walk the bids highest-first. Orders fill completely or not at all (no partial fills, resting orders or reservations yet).

**Live feed and staleness** ([`book-feed.ts`](../services/market-catalog/src/orderbook/book-feed.ts)). One shared WebSocket serves every user; a token is subscribed once however many people look. A book is *live* only if the socket is connected, a snapshot was applied since the last (re)connect or gap, the book is consistent (best bid below best ask) and it was confirmed within 45 s. Every tracked token is re-snapshotted over REST every 20 s, so a quiet market is still confirmed. A stale, disconnected, malformed or crossed book becomes *recovering*: a fresh snapshot is fetched, execution is paused, and the last known book stays visible with its timestamp. Trading adds a stricter 30 s age limit. Ticks live in memory only; Supabase is not written per tick. Markets with open positions are *pinned* (re-asserted by the trading service every 15 s) so they stay tracked with nobody watching and after leaving Trending; after a catalog restart they are re-tracked within one cycle.

**Supported markets.** Active political binary Yes/No markets with both order-book tokens, an enabled order book and published rules of at least 40 characters. A market past its expected end date, closed by the provider, or no longer in the active catalog is not tradable (it can still be valued and settled).

**Price protection.** A buy never spends more than the budget you entered; a sell never receives less than 99.5% of the previewed proceeds. If the price moved outside that, nothing is written and the confirm returns a fresh preview.

**Precision and rounding.** Power and prices are `numeric(20,6)`; shares trade in hundredths. A fill's cost is price times shares, exact for prices on a 0.0001 grid (finer prices are rejected, not rounded). A budget that cannot buy an exact quantity buys the most whole hundredths it can; the remainder is never debited and stays available. Averages, proportional cost basis and fractional valuations round half up to 6 decimals; no rounding ever touches the ledger.

**Paper liquidity.** Portfolios are independent: other players never consume the quantity you see. Within your portfolio, what you can fill at a price level is the displayed size minus what you already filled at that exact (token, side, price) in the last 5 minutes, so re-submitting against an unchanged quote cannot consume the same shares again.

**Idempotency.** `(player, idempotency key)` is unique. A retry of a committed request returns the original receipt (even with the feed down); the same key for a different order is refused. One lock per player serialises their orders, so two tabs cannot overspend Power or oversell shares.

**Valuation.** Total Power = available + reserved for open buys (zero now) + marked value of owned shares, computed once per snapshot on the server. Each position is valued from its own token's book: midpoint when both sides exist and the spread is at most 0.10; otherwise the best bid; with no bid, the last known valuation carried forward; never valued yet, the average cost. A non-live book is still used for its last known prices but flagged stale with its own timestamp. Execution price and valuation price are distinct: buying at an ask above the midpoint lowers total Power immediately; with equal fill and valuation prices (zero spread) buying alone changes nothing. Last known marks are saved only when they move by 0.005 or are over 5 minutes old.

**League.** Ranks use competition ranking (equal totals share a rank; display order is rank then permanent slot). Relative size is a country's share of all Power rounded to 0.1%; the map is an ordered treemap whose cell area is proportional to that share and whose order follows the permanent slot. Colour and slot never change for a country.

**Settlement.** Only a verified provider outcome pays: the market must be closed, officially resolved, with prices exactly 1 and 0. A winning share pays 1 Power, a losing share 0. A closing time, an empty book, a price near 1, a 50/50 or otherwise unsupported outcome never pays: positions are kept. The worker runs at startup and every 30 s, settles each player in their own transaction, and a unique index makes a double payout impossible, so a replay or a restart is harmless. Positions are found by market id in the trading schema, so a market that left the active catalog still settles.

### Trace one trade: clicking Buy to a country growing

1. [`TradePanel`](../apps/web/src/components/trade-panel.tsx) (Preview form) posts to [`tradeAction`](../apps/web/app/markets/%5Bid%5D/actions.ts), which attaches the session's access token and calls [`previewTrade`](../apps/web/src/lib/trading-api.ts) -> `POST /v1/me/trades/preview`.
2. [`services/api create-app.ts`](../services/api/src/create-app.ts): `requireUser` verifies the token with Supabase Auth and sets the user id; the body is validated against [`TradePreviewRequestSchema`](../packages/trading-contract/src/trades.ts); [`previewTrade`](../services/api/src/trading-client.ts) forwards only the order plus that user id to the trading service.
3. [`trade-service.ts` `previewTrade`](../services/trading/src/trades/trade-service.ts): [`loadContext`](../services/trading/src/trades/trade-service.ts) asks [`catalog-client.ts`](../services/trading/src/catalog-client.ts) -> market-catalog `POST /internal/v1/quotes`, which [`QuoteService`](../services/market-catalog/src/orderbook/quote-service.ts) answers from the shared [`BookFeed`](../services/market-catalog/src/orderbook/book-feed.ts). [`buyWithBudget`](../services/trading/src/trades/pricing.ts) walks the asks. Nothing is written.
4. The player confirms: same path to [`confirmTrade`](../services/trading/src/trades/trade-service.ts). It replays an existing order for the key, re-fetches a fresh quote, then in one transaction locks the account, re-walks the book for the previewed quantity, enforces the protection, and inserts the order, the fills, the `trade_buy` ledger entry and the position change.
5. `onChange` invalidates the cached valuation. The next read of [`ValuationService.snapshot`](../services/trading/src/league/valuation.ts) recomputes every player's total with the valuation rule.
6. [`toLeagueSnapshot`](../services/trading/src/league/league.ts) projects the public view; `GET /v1/league` serves it; [`/api/league`](../apps/web/app/api/league/route.ts) relays it; [`LeagueView`](../apps/web/src/components/league-view.tsx) polls it every 5 s and [`layoutCountries`](../apps/web/src/lib/map-layout.ts) resizes the cells.

### Tests: what is what

| Kind | Where | Data |
|---|---|---|
| Fixture, pure | `services/trading/test/money-pricing.test.ts`, `apps/web/src/lib/map-layout.test.ts`, `services/market-catalog/test/order-book.test.ts` | hand-written numbers |
| Fixture, fake socket and fake REST | `services/market-catalog/test/book-feed.test.ts` | scripted feed events |
| Fixture quotes + **throwaway real PostgreSQL** | `services/trading/test/paper-trading.int.test.ts` (acceptance numbers, sells, duplicates, concurrency, atomicity, price protection, disconnects, settlement, privacy), `migration-upgrade.int.test.ts` (existing accounts survive), `services/market-catalog/test/trading-fields.int.test.ts` | deterministic fixture books, never Polymarket |
| Fake HTTP | `services/api/test/trading-routes.test.ts` | fake auth, trading, catalog |
| **Live** (opt-in) | `pnpm test:live` -> `services/market-catalog/test/live/orderbook-live.test.ts` | real Polymarket political market, real WebSocket and REST |
