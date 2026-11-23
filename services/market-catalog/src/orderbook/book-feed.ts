/**
 * Shared live order books for every tracked outcome token.
 *
 * ONE WebSocket connection to Polymarket's market channel serves every user; a token is subscribed
 * once no matter how many people look at it. Verified 2026-11-23 against docs.polymarket.com:
 *   wss://ws-subscriptions-clob.polymarket.com/ws/market   send {"assets_ids":[...],"type":"market"}
 *   add/remove later with {"operation":"subscribe"|"unsubscribe","assets_ids":[...]}
 *   keep alive: send the text "PING" every 10 s, the server answers "PONG"
 *   messages: event_type "book" (full snapshot), "price_change" (level updates), "tick_size_change", ...
 *   REST snapshot: POST https://clob.polymarket.com/books  [{"token_id": "..."}]  -> array of books
 *
 * HOW A BOOK IS JUDGED (the rule execution and valuation both rely on):
 *   live          = the socket is connected AND a snapshot was applied since the last (re)connect or gap
 *                   AND the book is consistent (best bid < best ask) AND it was confirmed within `freshnessMs`.
 *   "confirmed"   = a feed event for the token arrived, or a REST snapshot was applied. A quiet market sends no
 *                   events, so every tracked token is re-snapshotted each `reconcileEveryMs`; a healthy token
 *                   is therefore never older than that, and a token that cannot be confirmed goes stale.
 *   recovering    = stale, inconsistent, malformed, or waiting for the snapshot after a reconnect. A fresh REST
 *                   snapshot is requested immediately. Execution is paused; the last known book stays readable
 *                   with its observedAt so valuation can keep showing a timestamped figure.
 *   disconnected  = the socket is down. Reconnects with backoff; on reopen every token is re-snapshotted.
 *
 * Nothing here touches Postgres: ticks live in memory only.
 */
import type { BookLevel, FeedState } from "@league/catalog-contract";
import { MalformedBookError, OrderBook, type RawLevel } from "./order-book.ts";

/** The slice of the WebSocket API used here, so tests can inject a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface BookFeedOptions {
  wsUrl: string;
  clobBaseUrl: string;
  /** A token not confirmed for this long is stale. Default 45 s. */
  freshnessMs?: number;
  /** Re-snapshot every tracked token this often, which also confirms quiet markets. Default 20 s. */
  reconcileEveryMs?: number;
  pingEveryMs?: number;
  /** No PONG/message for this long means the connection is dead. Default 25 s. */
  silenceLimitMs?: number;
  /** A viewer's interest lapses this long after their last request. Default 10 min. */
  viewTtlMs?: number;
  /** A pin (open positions) lapses this long after its last renewal. Default 3 min. */
  pinTtlMs?: number;
  now?: () => number;
  createSocket?: (url: string) => SocketLike;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

interface TokenState {
  book: OrderBook;
  /** Local clock time of the last confirmation; null if never. Kept after a disconnect as the "last known" time. */
  observedAt: number | null;
  /** False after (re)connect or any detected gap until a snapshot is applied. */
  verified: boolean;
  lastViewedAt: number;
  pinnedUntil: number;
}

export interface TokenReading {
  state: FeedState;
  bids: BookLevel[];
  asks: BookLevel[];
  observedAt: number | null;
  tickSize: string | null;
}

export class BookFeed {
  private readonly tokens = new Map<string, TokenState>();
  private readonly tickSizes = new Map<string, string>();
  private socket: SocketLike | null = null;
  private connected = false;
  private lastHeardAt = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private snapshotRunning = false;
  private snapshotAgain = false;
  private stopped = true;

  private readonly o: Required<Omit<BookFeedOptions, "createSocket" | "fetchImpl" | "log">> & Pick<BookFeedOptions, "createSocket" | "fetchImpl" | "log">;

  constructor(options: BookFeedOptions) {
    this.o = {
      freshnessMs: 45_000,
      reconcileEveryMs: 20_000,
      pingEveryMs: 10_000,
      silenceLimitMs: 25_000,
      viewTtlMs: 10 * 60_000,
      pinTtlMs: 3 * 60_000,
      now: () => Date.now(),
      ...options,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Polymarket closes a connection that never subscribes to anything, so connect only once a market is tracked.
    if (this.tokens.size > 0) this.openSocket();
    this.timers = [
      setInterval(() => this.heartbeat(), this.o.pingEveryMs),
      setInterval(() => void this.refreshSnapshots("reconcile"), this.o.reconcileEveryMs),
      setInterval(() => this.sweep(), 30_000),
    ];
    for (const timer of this.timers) timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (socket) {
      socket.onclose = socket.onerror = socket.onmessage = socket.onopen = null;
      socket.close();
    }
  }

  /**
   * Starts (or keeps) tracking tokens. Idempotent and cheap: many users asking for one market produce one subscription.
   * "pin" is for markets with open positions: it keeps them tracked with nobody watching, as long as it is renewed.
   */
  track(tokenIds: readonly string[], intent: "view" | "pin"): void {
    const now = this.o.now();
    const added: string[] = [];
    for (const tokenId of tokenIds) {
      let state = this.tokens.get(tokenId);
      if (!state) {
        state = { book: new OrderBook(), observedAt: null, verified: false, lastViewedAt: now, pinnedUntil: 0 };
        this.tokens.set(tokenId, state);
        added.push(tokenId);
      }
      if (intent === "pin") state.pinnedUntil = now + this.o.pinTtlMs;
      else state.lastViewedAt = now;
    }
    if (added.length > 0) {
      if (!this.socket && !this.reconnectTimer) this.openSocket(); // first market: connect (subscribes on open)
      this.sendSubscription("subscribe", added);
      void this.refreshSnapshots("new", added);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** What is known about one token right now, including its last known book when it is not live. */
  read(tokenId: string): TokenReading | null {
    const state = this.tokens.get(tokenId);
    if (!state) return null;
    const { bids, asks } = state.book.levels();
    return { state: this.stateOf(state), bids, asks, observedAt: state.observedAt, tickSize: this.tickSizes.get(tokenId) ?? null };
  }

  private stateOf(state: TokenState): FeedState {
    if (!this.connected) return "disconnected";
    if (state.observedAt === null && !state.verified) return "unavailable";
    const fresh = state.observedAt !== null && this.o.now() - state.observedAt <= this.o.freshnessMs;
    return state.verified && fresh && state.book.isConsistent() ? "live" : "recovering";
  }

  // ---- connection ---------------------------------------------------------------------------------

  private openSocket(): void {
    if (this.stopped) return;
    const socket = (this.o.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike))(this.o.wsUrl);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.connected = true;
      this.reconnectAttempt = 0;
      this.lastHeardAt = this.o.now();
      this.o.log?.(`feed connected (${this.tokens.size} tokens)`);
      // Events may have been missed while down: nothing is trusted until a fresh snapshot is applied.
      for (const state of this.tokens.values()) state.verified = false;
      const ids = [...this.tokens.keys()];
      // A connection starts with the initial subscribe form; later changes use {"operation": ...}.
      // With nothing tracked yet, the first track() sends the initial form instead.
      this.subscribedOnce = ids.length > 0;
      if (ids.length > 0) socket.send(JSON.stringify({ assets_ids: ids, type: "market" }));
      void this.refreshSnapshots("reconnect");
    };
    socket.onmessage = (event) => this.onMessage(event.data);
    const lost = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connected = false;
      this.o.log?.("feed disconnected; reconnecting");
      this.scheduleReconnect();
    };
    socket.onclose = lost;
    socket.onerror = lost;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.tokens.size === 0) return; // nothing to listen to: stay idle
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt++) + Math.floor(Math.random() * 250);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private heartbeat(): void {
    if (!this.socket || !this.connected) return;
    if (this.o.now() - this.lastHeardAt > this.o.silenceLimitMs) {
      // Silent too long: a half-open connection. Drop it; onclose handling reconnects.
      this.o.log?.("feed silent; dropping connection");
      const socket = this.socket;
      this.socket = null;
      this.connected = false;
      socket.onclose = socket.onerror = socket.onmessage = socket.onopen = null;
      socket.close();
      this.scheduleReconnect();
      return;
    }
    this.socket.send("PING");
  }

  private sendSubscription(operation: "subscribe" | "unsubscribe", ids: readonly string[]): void {
    if (!this.socket || !this.connected || ids.length === 0) return; // after reconnect everything is re-subscribed
    // The first subscription of a connection that opened with zero tokens must use the initial form.
    this.socket.send(JSON.stringify(this.subscribedOnce ? { operation, assets_ids: ids } : { assets_ids: ids, type: "market" }));
    this.subscribedOnce = true;
  }
  private subscribedOnce = false;

  // ---- messages -----------------------------------------------------------------------------------

  /** Exposed for tests: feed one raw WebSocket frame. */
  onMessage(data: unknown): void {
    this.lastHeardAt = this.o.now();
    if (typeof data !== "string" || data === "PONG") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) this.handle(message);
  }

  private handle(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const m = message as Record<string, unknown>;
    const now = this.o.now();
    try {
      if (m.event_type === "book" && typeof m.asset_id === "string") {
        const state = this.tokens.get(m.asset_id);
        if (!state) return;
        state.book.replace(asLevels(m.bids), asLevels(m.asks));
        state.verified = true;
        state.observedAt = now;
        this.checkConsistency(state);
      } else if (m.event_type === "price_change" && Array.isArray(m.price_changes)) {
        for (const change of m.price_changes as Array<Record<string, unknown>>) {
          const state = typeof change.asset_id === "string" ? this.tokens.get(change.asset_id) : undefined;
          if (!state || !state.verified) continue; // a delta is only meaningful on top of a snapshot
          if ((change.side !== "BUY" && change.side !== "SELL") || typeof change.price !== "string" || typeof change.size !== "string") {
            throw new MalformedBookError("bad price_change");
          }
          state.book.applyChange(change.side, change.price, change.size);
          state.observedAt = now;
          this.checkConsistency(state);
        }
      } else if (m.event_type === "tick_size_change" && typeof m.asset_id === "string" && typeof m.new_tick_size === "string") {
        this.tickSizes.set(m.asset_id, m.new_tick_size);
        const state = this.tokens.get(m.asset_id);
        if (state) this.markGap(state);
      }
    } catch (error) {
      // A malformed update means we can no longer trust the book: drop trust and re-snapshot.
      this.o.log?.(`bad feed message: ${error instanceof Error ? error.message : error}`);
      for (const state of this.tokens.values()) this.markGap(state);
    }
  }

  private checkConsistency(state: TokenState): void {
    if (!state.book.isConsistent()) this.markGap(state);
  }

  private markGap(state: TokenState): void {
    state.verified = false;
    void this.refreshSnapshots("gap");
  }

  // ---- snapshots (the recovery path) --------------------------------------------------------------

  /**
   * Fetches fresh REST snapshots and applies them. `only` limits it to specific tokens; otherwise every tracked
   * token. Overlapping calls coalesce into one follow-up run, so a burst of gaps causes one request, not many.
   */
  async refreshSnapshots(reason: string, only?: readonly string[]): Promise<void> {
    if (this.snapshotRunning) {
      this.snapshotAgain = true;
      return;
    }
    this.snapshotRunning = true;
    try {
      const ids = (only ?? [...this.tokens.keys()]).filter((id) => this.tokens.has(id));
      for (let start = 0; start < ids.length; start += 50) await this.fetchBooks(ids.slice(start, start + 50), reason);
    } finally {
      this.snapshotRunning = false;
      if (this.snapshotAgain) {
        this.snapshotAgain = false;
        void this.refreshSnapshots("coalesced");
      }
    }
  }

  private async fetchBooks(ids: string[], reason: string): Promise<void> {
    try {
      const response = await (this.o.fetchImpl ?? fetch)(new URL("/books", this.o.clobBaseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(ids.map((token_id) => ({ token_id }))),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`CLOB /books responded ${response.status}`);
      }
      const books: unknown = await response.json();
      if (!Array.isArray(books)) throw new Error("CLOB /books did not return an array");
      const now = this.o.now();
      for (const raw of books as Array<Record<string, unknown>>) {
        const state = typeof raw.asset_id === "string" ? this.tokens.get(raw.asset_id) : undefined;
        if (!state || typeof raw.asset_id !== "string") continue;
        try {
          state.book.replace(asLevels(raw.bids), asLevels(raw.asks));
        } catch (error) {
          this.o.log?.(`snapshot for a token was malformed (${reason}): ${error instanceof Error ? error.message : error}`);
          continue; // stays unverified, so execution stays paused
        }
        if (typeof raw.tick_size === "string") this.tickSizes.set(raw.asset_id, raw.tick_size);
        state.observedAt = now;
        state.verified = state.book.isConsistent();
      }
    } catch (error) {
      // Leave tokens unverified/stale. The next reconcile tick (or the next gap) tries again.
      this.o.log?.(`snapshot failed (${reason}): ${error instanceof Error ? error.message : error}`);
    }
  }

  // ---- housekeeping -------------------------------------------------------------------------------

  /** Stops tracking tokens nobody is watching and no position needs. */
  private sweep(): void {
    const now = this.o.now();
    const drop: string[] = [];
    for (const [id, state] of this.tokens) {
      if (state.pinnedUntil < now && now - state.lastViewedAt > this.o.viewTtlMs) drop.push(id);
    }
    for (const id of drop) this.tokens.delete(id);
    if (drop.length > 0) this.sendSubscription("unsubscribe", drop);
    if (this.tokens.size === 0 && this.socket) {
      // Nothing left to track: close quietly (no reconnect) until the next market is requested.
      const socket = this.socket;
      this.socket = null;
      this.connected = false;
      socket.onclose = socket.onerror = socket.onmessage = socket.onopen = null;
      socket.close();
    }
  }
}

function asLevels(value: unknown): RawLevel[] {
  if (!Array.isArray(value)) throw new MalformedBookError("levels is not an array");
  return value.map((level) => {
    const l = level as { price?: unknown; size?: unknown };
    if (typeof l?.price !== "string" || typeof l?.size !== "string") throw new MalformedBookError("level without price/size");
    return { price: l.price, size: l.size };
  });
}
