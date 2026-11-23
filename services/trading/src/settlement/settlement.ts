/**
 * Official outcome -> payout.
 *
 * ONLY a verified provider outcome authorises a payout (catalog `resolutions`: state "resolved" with a winner).
 * A closing time, an empty book or a price near 1 can stop trading but never pays anyone.
 *
 * For an ordinary YES/NO resolution each winning share pays exactly 1 Power and each losing share pays 0.
 * An ambiguous or unsupported outcome (e.g. 50/50) changes nothing: positions are kept pending reconciliation.
 *
 * Safe to retry and to run after a crash:
 *  - each player is settled in their OWN transaction (position -> settled, payout ledger entry);
 *  - a position that is already settled has quantity 0, so a replay finds nothing to pay;
 *  - the unique index ledger_one_payout_per_market makes a double payout impossible even if the code were wrong;
 *  - positions are found by market id in OUR tables, so a market that left the active catalog is still settled.
 */
import type pg from "pg";
import type { Outcome } from "@league/trading-contract";
import { CatalogUnavailableError, type CatalogPort } from "../catalog-client.ts";
import { formatMicro, numericToCs, parseMicro } from "../trades/money.ts";

/** One centishare pays 1/100 of a Power = 10,000 micro. */
const PAYOUT_MICRO_PER_CS = 10_000n;

export interface SettleMarketResult {
  playersSettled: number;
  /** Total Power paid out across all players in this call. */
  paidMicro: bigint;
}

export async function settleMarket(pool: pg.Pool, marketId: string, winner: Outcome, detail: string): Promise<SettleMarketResult> {
  // Record the official outcome once. A different outcome for the same market is never accepted.
  const recorded = await pool.query<{ winning_outcome: Outcome }>(
    `insert into trading.settlements (market_id, winning_outcome, detail) values ($1, $2, $3)
     on conflict (market_id) do update set market_id = excluded.market_id
     returning winning_outcome`,
    [marketId, winner, detail],
  );
  if (recorded.rows[0]!.winning_outcome !== winner) {
    throw new Error(`Settlement conflict for market ${marketId}: already settled as ${recorded.rows[0]!.winning_outcome}, provider now says ${winner}`);
  }

  const holders = await pool.query<{ account_id: string }>(
    "select distinct account_id from trading.positions where market_id = $1 and quantity > 0 and status = 'open' order by account_id",
    [marketId],
  );
  let playersSettled = 0;
  let paidMicro = 0n;
  for (const { account_id: accountId } of holders.rows) {
    const paid = await settleOne(pool, accountId, marketId, winner);
    if (paid !== null) {
      playersSettled++;
      paidMicro += paid;
    }
  }
  return { playersSettled, paidMicro };
}

/** Settles one player's positions in one market. Returns null when there was nothing left to settle (a replay). */
async function settleOne(pool: pg.Pool, accountId: string, marketId: string, winner: Outcome): Promise<bigint | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select 1 from trading.accounts where user_id = $1 for update", [accountId]); // serialises with their trades
    const { rows } = await client.query<{ token_id: string; outcome: Outcome; quantity: string; cost_basis: string }>(
      `select token_id, outcome, quantity::text, cost_basis::text from trading.positions
        where account_id = $1 and market_id = $2 and quantity > 0 and status = 'open' for update`,
      [accountId, marketId],
    );
    if (rows.length === 0) {
      await client.query("rollback");
      return null;
    }
    let payout = 0n;
    for (const row of rows) {
      const winning = row.outcome === winner;
      const rowPayout = winning ? numericToCs(row.quantity) * PAYOUT_MICRO_PER_CS : 0n;
      payout += rowPayout;
      await client.query(
        `update trading.positions
            set realized_pnl = realized_pnl + $3, quantity = 0, cost_basis = 0, status = 'settled', settled_at = now(),
                last_mark = $4, last_mark_at = now(), updated_at = now()
          where account_id = $1 and token_id = $2`,
        [accountId, row.token_id, formatMicro(rowPayout - parseMicro(row.cost_basis)), winning ? "1.000000" : "0.000000"],
      );
    }
    if (payout > 0n) {
      await client.query("insert into trading.ledger_entries (account_id, entry_type, amount, settlement_market_id) values ($1, 'settlement_payout', $2, $3)", [accountId, formatMicro(payout), marketId]);
    }
    await client.query("commit");
    return payout;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface SettlementPassResult {
  marketsChecked: number;
  marketsSettled: string[];
  /** Markets with positions that are not (yet) settled, and why. Positions in them are kept untouched. */
  waiting: Array<{ marketId: string; state: string }>;
  catalogUnavailable: boolean;
}

/** One sweep: ask the provider about every market that still has open positions, settle those officially resolved. */
export async function runSettlementPass(deps: { pool: pg.Pool; catalog: CatalogPort; onChange?: () => void; log?: (message: string) => void }): Promise<SettlementPassResult> {
  const { rows } = await deps.pool.query<{ market_id: string }>("select distinct market_id from trading.positions where quantity > 0 and status = 'open' order by market_id");
  const result: SettlementPassResult = { marketsChecked: rows.length, marketsSettled: [], waiting: [], catalogUnavailable: false };
  if (rows.length === 0) return result;

  try {
    for (let start = 0; start < rows.length; start += 200) {
      const ids = rows.slice(start, start + 200).map((row) => row.market_id);
      for (const resolution of await deps.catalog.resolutions(ids)) {
        if (resolution.state === "resolved" && resolution.winningOutcome) {
          await settleMarket(deps.pool, resolution.marketId, resolution.winningOutcome, resolution.detail);
          result.marketsSettled.push(resolution.marketId);
          deps.onChange?.();
        } else {
          result.waiting.push({ marketId: resolution.marketId, state: resolution.state });
        }
      }
    }
  } catch (error) {
    if (!(error instanceof CatalogUnavailableError)) throw error;
    result.catalogUnavailable = true;
    deps.log?.(`settlement: provider unreachable, will retry (${error.message})`);
  }
  return result;
}
