"use client";

import { useActionState, useState } from "react";
import { tradeAction, type TradeState } from "../../app/markets/[id]/actions";
import { formatDateTimeUtc } from "@/lib/format";
import { formatPower, formatSharePrice, formatShares } from "@/lib/format-credits";

const INPUT =
  "w-full rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:bg-zinc-900 dark:ring-zinc-700 dark:focus:ring-zinc-100";
const PRIMARY = "rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";

/**
 * Buy or sell YES/NO with Power. Step 1 previews the order against the live quote (nothing changes);
 * step 2 confirms exactly what was previewed. Works without the World map.
 */
export function TradePanel({ marketId, tradable, pausedReason }: { marketId: string; tradable: boolean; pausedReason: string | null }) {
  const [state, formAction, pending] = useActionState<TradeState, FormData>(tradeAction, { status: "idle" });
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [outcome, setOutcome] = useState<"YES" | "NO">("YES");

  return (
    <section aria-label="Trade" className="flex flex-col gap-4 rounded-xl bg-white p-4 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      <h2 className="text-base font-semibold">Trade with Power</h2>
      {!tradable && (
        <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {pausedReason ?? "Trading is paused for this market."} You can still preview once it resumes.
        </p>
      )}

      {state.status === "receipt" ? (
        <Receipt state={state} />
      ) : (
        <>
          <form action={formAction} className="flex flex-col gap-3">
            <input type="hidden" name="marketId" value={marketId} />
            <input type="hidden" name="intent" value="preview" />
            <fieldset className="grid grid-cols-2 gap-2">
              <legend className="sr-only">Outcome</legend>
              {(["YES", "NO"] as const).map((value) => (
                <label key={value} className={`cursor-pointer rounded-lg px-3 py-2 text-center text-sm font-semibold ring-1 ${outcome === value ? "bg-zinc-900 text-white ring-zinc-900 dark:bg-zinc-100 dark:text-zinc-900" : "ring-zinc-300 dark:ring-zinc-700"}`}>
                  <input type="radio" name="outcome" value={value} checked={outcome === value} onChange={() => setOutcome(value)} className="sr-only" />
                  {value === "YES" ? "Yes" : "No"}
                </label>
              ))}
            </fieldset>
            <fieldset className="grid grid-cols-2 gap-2">
              <legend className="sr-only">Buy or sell</legend>
              {(["buy", "sell"] as const).map((value) => (
                <label key={value} className={`cursor-pointer rounded-lg px-3 py-2 text-center text-sm font-medium ring-1 ${side === value ? "bg-zinc-100 ring-zinc-900 dark:bg-zinc-800 dark:ring-zinc-100" : "ring-zinc-300 dark:ring-zinc-700"}`}>
                  <input type="radio" name="side" value={value} checked={side === value} onChange={() => setSide(value)} className="sr-only" />
                  {value === "buy" ? "Buy" : "Sell"}
                </label>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1 text-sm font-medium">
              {side === "buy" ? "Power to spend (budget)" : "Shares to sell"}
              <input name="amount" inputMode="decimal" required pattern="\d{1,14}(\.\d{1,6})?" placeholder={side === "buy" ? "e.g. 2000" : "e.g. 100"} className={INPUT} />
            </label>
            <button type="submit" disabled={pending} className={PRIMARY}>
              {pending && state.status !== "preview" ? "Pricing…" : "Preview order"}
            </button>
          </form>

          {state.status === "error" && (
            <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
              {state.message}
            </p>
          )}

          {state.status === "preview" && <Preview state={state} formAction={formAction} pending={pending} />}
        </>
      )}
    </section>
  );
}

function Preview({ state, formAction, pending }: { state: Extract<TradeState, { status: "preview" }>; formAction: (formData: FormData) => void; pending: boolean }) {
  const { preview } = state;
  const buying = preview.side === "buy";
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:ring-zinc-800">
      {state.notice && (
        <p role="status" className="text-sm font-medium text-amber-800 dark:text-amber-300">
          {state.notice}
        </p>
      )}
      <h3 className="text-sm font-semibold">
        {buying ? "Buy" : "Sell"} {formatShares(preview.quantity)} {preview.outcome === "YES" ? "Yes" : "No"} shares
      </h3>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm tabular-nums">
        <dt className="text-zinc-600 dark:text-zinc-400">{buying ? "Estimated cost" : "Estimated proceeds"}</dt>
        <dd className="text-right font-medium">{formatPower(preview.amount)} Power</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">Average price</dt>
        <dd className="text-right font-medium">{formatSharePrice(preview.averagePrice)}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">{buying ? "Most you will spend" : "Least you will receive"}</dt>
        <dd className="text-right font-medium">{formatPower(preview.limit.amount)} Power</dd>
        {buying && preview.unspent && (
          <>
            <dt className="text-zinc-600 dark:text-zinc-400">Stays in your balance</dt>
            <dd className="text-right">{formatPower(preview.unspent)} Power</dd>
          </>
        )}
        <dt className="text-zinc-600 dark:text-zinc-400">Quote time</dt>
        <dd className="text-right">{formatDateTimeUtc(preview.quoteObservedAt)}</dd>
      </dl>
      {preview.fills.length > 1 && (
        <ul className="text-xs text-zinc-600 tabular-nums dark:text-zinc-400">
          {preview.fills.map((fill) => (
            <li key={fill.price}>
              {formatShares(fill.quantity)} at {formatSharePrice(fill.price)}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        The order fills completely or not at all. If the price moves past your limit, nothing is traded and you will see a new quote to confirm.
      </p>
      <form action={formAction} className="flex gap-2">
        <input type="hidden" name="intent" value="confirm" />
        <input type="hidden" name="marketId" value={preview.marketId} />
        <input type="hidden" name="outcome" value={preview.outcome} />
        <input type="hidden" name="side" value={preview.side} />
        <input type="hidden" name="quantity" value={preview.quantity} />
        <input type="hidden" name="limit" value={preview.limit.amount} />
        <input type="hidden" name="key" value={state.key} />
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? "Placing…" : `Confirm ${buying ? "buy" : "sell"}`}
        </button>
      </form>
    </div>
  );
}

function Receipt({ state }: { state: Extract<TradeState, { status: "receipt" }> }) {
  const { receipt } = state;
  const buying = receipt.side === "buy";
  return (
    <div role="status" className="flex flex-col gap-2 rounded-lg bg-emerald-50 p-3 text-sm dark:bg-emerald-950/40">
      <h3 className="font-semibold">Order filled</h3>
      <p>
        {buying ? "Bought" : "Sold"} {formatShares(receipt.quantity)} {receipt.outcome === "YES" ? "Yes" : "No"} shares at an average of {formatSharePrice(receipt.averagePrice)} for{" "}
        {formatPower(receipt.amount)} Power.
      </p>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Priced from the order book as of {formatDateTimeUtc(receipt.quoteObservedAt)}. Order {receipt.orderId.slice(0, 8)}
        {receipt.replayed ? " (this order had already been placed)" : ""}.
      </p>
      <a href="/dashboard" className="font-medium underline-offset-2 hover:underline">
        View your portfolio
      </a>
    </div>
  );
}
