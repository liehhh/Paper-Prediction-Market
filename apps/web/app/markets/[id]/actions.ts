"use server";

/**
 * The trade form's Server Action. It runs on the Next.js server: the browser posts the form, this code forwards
 * the ORDER (never a user id) with the signed-in player's access token, and services/api works out who that is.
 *
 * Two steps, one action:
 *   intent "preview"  -> price the order; changes nothing; returns the quote to review plus a fresh idempotency key
 *   intent "confirm"  -> place exactly what was previewed, using that key (so a double click or a retry is safe)
 */
import { randomUUID } from "node:crypto";
import type { TradePreview, TradeReceipt } from "@league/trading-contract";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { confirmTrade, previewTrade } from "@/lib/trading-api";

export type TradeState =
  | { status: "idle" }
  | { status: "preview"; preview: TradePreview; key: string; notice?: string }
  | { status: "receipt"; receipt: TradeReceipt }
  | { status: "error"; message: string; code?: string };

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
};

export async function tradeAction(_previous: TradeState, formData: FormData): Promise<TradeState> {
  const supabase = await createSupabaseServerClient();
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  if (!session) return { status: "error", message: "Sign in to trade.", code: "unauthenticated" };

  const marketId = text(formData, "marketId");
  const outcome = text(formData, "outcome") === "NO" ? "NO" : "YES";
  const side = text(formData, "side") === "sell" ? "sell" : "buy";

  if (text(formData, "intent") === "confirm") {
    const result = await confirmTrade(session.access_token, {
      marketId,
      outcome,
      side,
      quantity: text(formData, "quantity"),
      limit: text(formData, "limit"),
      idempotencyKey: text(formData, "key"),
    });
    if (result.ok) return { status: "receipt", receipt: result.data };
    // The price moved outside what the player accepted: show the new quote to confirm, under a NEW key (the order differs).
    if (result.refusal.code === "price_moved" && result.refusal.preview) {
      return { status: "preview", preview: result.refusal.preview, key: randomUUID(), notice: result.refusal.message };
    }
    return { status: "error", message: result.refusal.message, code: result.refusal.code };
  }

  const amount = text(formData, "amount");
  const result = await previewTrade(session.access_token, side === "buy" ? { marketId, outcome, side, budget: amount } : { marketId, outcome, side, quantity: amount });
  if (!result.ok) return { status: "error", message: result.refusal.message, code: result.refusal.code };
  return { status: "preview", preview: result.data, key: randomUUID() };
}
