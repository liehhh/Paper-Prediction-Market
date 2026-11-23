/** Fixture-based: a fake socket and a fake CLOB REST server. Nothing here touches the network. */
import { describe, expect, it } from "vitest";
import { BookFeed, type SocketLike } from "../src/orderbook/book-feed.ts";

const YES = "111";
const NO = "222";

class FakeSocket implements SocketLike {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  open() {
    this.onopen?.();
  }
  emit(message: unknown) {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
  drop() {
    this.onclose?.();
  }
}

function book(assetId: string, bids: Array<[string, string]>, asks: Array<[string, string]>) {
  return {
    asset_id: assetId,
    market: "0xcondition",
    tick_size: "0.01",
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
  };
}

function setup(books: Record<string, unknown> = {}) {
  let clock = 1_000_000;
  const sockets: FakeSocket[] = [];
  const state = { books, failing: false, requests: 0 };
  const feed = new BookFeed({
    wsUrl: "wss://fake",
    clobBaseUrl: "https://clob.fake",
    now: () => clock,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    fetchImpl: (async (_url: unknown, init?: { body?: string }) => {
      state.requests++;
      if (state.failing) return new Response("down", { status: 503 });
      const wanted = (JSON.parse(init?.body ?? "[]") as Array<{ token_id: string }>).map((entry) => entry.token_id);
      return Response.json(wanted.flatMap((id) => (state.books[id] ? [state.books[id]] : [])));
    }) as unknown as typeof fetch,
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    feed,
    sockets,
    state,
    settle,
    advance: (ms: number) => void (clock += ms),
    /** Starts the feed and opens its first socket (the feed itself stays idle until a market is tracked). */
    async connect() {
      feed.start();
      (feed as unknown as { openSocket(): void }).openSocket();
      sockets.at(-1)!.open();
      await settle();
      return sockets.at(-1)!;
    },
  };
}

const standard = () => ({
  [YES]: book(YES, [["0.49", "100"]], [["0.51", "200"]]),
  [NO]: book(NO, [["0.49", "100"]], [["0.51", "200"]]),
});

describe("BookFeed idle behaviour", () => {
  it("opens no connection while nothing is tracked, then connects and subscribes on the first market", async () => {
    const t = setup(standard());
    t.feed.start();
    await t.settle();
    expect(t.sockets).toHaveLength(0); // Polymarket drops a connection that never subscribes, so we do not open one

    t.feed.track([YES, NO], "view");
    expect(t.sockets).toHaveLength(1);
    t.sockets[0]!.open();
    await t.settle();
    expect(t.sockets[0]!.sent.filter((frame) => frame.includes("assets_ids"))).toHaveLength(1);
    expect(t.feed.read(YES)!.state).toBe("live");
    t.feed.stop();
  });

  it("does not reconnect in a loop when it has nothing to listen to", async () => {
    const t = setup({});
    t.feed.start();
    (t.feed as unknown as { scheduleReconnect(): void }).scheduleReconnect();
    await t.settle();
    expect((t.feed as unknown as { reconnectTimer: unknown }).reconnectTimer).toBeNull();
    expect(t.sockets).toHaveLength(0);
    t.feed.stop();
  });
});

describe("BookFeed", () => {
  it("subscribes once per token however many viewers ask, and becomes live after the snapshot", async () => {
    const t = setup(standard());
    const socket = await t.connect();
    t.feed.track([YES, NO], "view");
    t.feed.track([YES, NO], "view");
    t.feed.track([YES], "pin");
    await t.settle();

    const subscriptions = socket.sent.filter((frame) => frame.includes("assets_ids"));
    expect(subscriptions).toHaveLength(1);
    expect(JSON.parse(subscriptions[0]!)).toEqual({ assets_ids: [YES, NO], type: "market" });
    expect(t.feed.read(YES)).toMatchObject({ state: "live", bids: [{ price: "0.49", size: "100" }], asks: [{ price: "0.51", size: "200" }] });
    t.feed.stop();
  });

  it("applies price_change deltas on top of the snapshot", async () => {
    const t = setup(standard());
    const socket = await t.connect();
    t.feed.track([YES], "view");
    await t.settle();
    socket.emit({
      event_type: "price_change",
      price_changes: [
        { asset_id: YES, price: "0.51", size: "50", side: "SELL" },
        { asset_id: YES, price: "0.49", size: "0", side: "BUY" },
      ],
    });
    expect(t.feed.read(YES)).toMatchObject({ state: "live", bids: [], asks: [{ price: "0.51", size: "50" }] });
    t.feed.stop();
  });

  it("a disconnect pauses (state disconnected) but keeps the last known book and its timestamp", async () => {
    const t = setup(standard());
    const socket = await t.connect();
    t.feed.track([YES], "view");
    await t.settle();
    const before = t.feed.read(YES)!;

    t.advance(5_000);
    socket.drop();
    const during = t.feed.read(YES)!;
    expect(during.state).toBe("disconnected");
    expect(during.asks).toEqual(before.asks);
    expect(during.observedAt).toBe(before.observedAt);
    t.feed.stop();
  });

  it("after a reconnect nothing is trusted until a fresh snapshot arrives", async () => {
    const t = setup(standard());
    const first = await t.connect();
    t.feed.track([YES], "view");
    await t.settle();
    t.state.failing = true; // REST is down too
    first.drop();
    // Skip the backoff: open the next socket directly.
    const internals = t.feed as unknown as { reconnectTimer: ReturnType<typeof setTimeout> | null; openSocket(): void };
    if (internals.reconnectTimer) clearTimeout(internals.reconnectTimer);
    internals.reconnectTimer = null;
    internals.openSocket();
    t.sockets.at(-1)!.open();
    await t.settle();
    expect(t.feed.read(YES)!.state).toBe("recovering"); // connected, but unverified

    t.state.failing = false;
    await t.feed.refreshSnapshots("test");
    expect(t.feed.read(YES)!.state).toBe("live");
    // Re-subscribed on the new connection.
    expect(t.sockets.at(-1)!.sent.some((frame) => frame.includes(YES))).toBe(true);
    t.feed.stop();
  });

  it("a crossed book (bid >= ask) is a missed update: recovering, then healed by a fresh snapshot", async () => {
    const t = setup(standard());
    const socket = await t.connect();
    t.feed.track([YES], "view");
    await t.settle();
    t.state.failing = true;
    socket.emit({ event_type: "price_change", price_changes: [{ asset_id: YES, price: "0.52", size: "10", side: "BUY" }] });
    expect(t.feed.read(YES)!.state).toBe("recovering");
    await t.settle();
    t.state.failing = false;
    await t.feed.refreshSnapshots("test");
    expect(t.feed.read(YES)).toMatchObject({ state: "live", bids: [{ price: "0.49", size: "100" }] });
    t.feed.stop();
  });

  it("a book not confirmed within the freshness window is stale (recovering) until confirmed again", async () => {
    const t = setup(standard());
    await t.connect();
    t.feed.track([YES], "view");
    await t.settle();
    t.state.failing = true;
    t.advance(46_000);
    expect(t.feed.read(YES)!.state).toBe("recovering");
    t.state.failing = false;
    await t.feed.refreshSnapshots("test");
    expect(t.feed.read(YES)!.state).toBe("live");
    t.feed.stop();
  });

  it("an incomplete or malformed snapshot never becomes live", async () => {
    const t = setup({ [YES]: { asset_id: YES, bids: [{ price: "oops", size: "1" }], asks: [] } });
    await t.connect();
    t.feed.track([YES], "view");
    await t.settle();
    expect(t.feed.read(YES)!.state).not.toBe("live");
    t.feed.stop();
  });

  it("a market with no snapshot yet is unavailable, not live", async () => {
    const t = setup({});
    await t.connect();
    t.feed.track([YES], "view");
    await t.settle();
    expect(t.feed.read(YES)!.state).toBe("unavailable");
    t.feed.stop();
  });
});
