/**
 * Polymarket status lookups are a network round trip to a third party. A market page and every valuation refresh needs
 * them, so they must not be paid on every request. Fixture responses, no network.
 */
import { describe, expect, it } from "vitest";
import { ProviderStatus } from "../src/orderbook/provider-status.ts";

const OPEN = { id: "1", closed: false, active: true, acceptingOrders: true };

function setup(ttlMs = 30_000) {
  let clock = 1_000_000;
  const state = { calls: 0, mode: "ok" as "ok" | "fail" | "hang", release: null as null | (() => void), body: OPEN as Record<string, unknown> };
  const provider = new ProviderStatus({
    gammaBaseUrl: "https://gamma.test",
    ttlMs,
    now: () => clock,
    fetchImpl: (async () => {
      state.calls++;
      if (state.mode === "fail") return new Response("down", { status: 503 });
      if (state.mode === "hang") await new Promise<void>((resolve) => (state.release = resolve));
      return Response.json(state.body);
    }) as typeof fetch,
  });
  return { provider, state, advance: (ms: number) => void (clock += ms) };
}

describe("ProviderStatus stays fast", () => {
  it("the first lookup waits; later ones inside the window cost nothing", async () => {
    const t = setup();
    expect((await t.provider.get("1"))?.closed).toBe(false);
    for (let i = 0; i < 5; i++) await t.provider.get("1");
    expect(t.state.calls).toBe(1);
  });

  it("just past the window it answers IMMEDIATELY with the last known status while refreshing in the background", async () => {
    const t = setup();
    await t.provider.get("1");
    t.advance(40_000); // expired, but under twice the window
    t.state.mode = "hang"; // the refresh will not finish
    t.state.body = { ...OPEN, closed: true }; // what the refresh would say
    const started = Date.now();
    const answer = await t.provider.get("1");
    expect(Date.now() - started).toBeLessThan(50); // did not wait for Polymarket
    expect(answer?.closed).toBe(false); // the last known answer
    expect(t.state.calls).toBe(2); // the refresh was started
    t.state.release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await t.provider.get("1"))?.closed).toBe(true); // the refreshed answer is used from then on
    expect(t.state.calls).toBe(2); // and nobody triggered a third request
  });

  it("many callers during one refresh share it", async () => {
    const t = setup();
    await t.provider.get("1");
    t.advance(40_000);
    t.state.mode = "hang";
    await Promise.all([t.provider.get("1"), t.provider.get("1"), t.provider.get("1")]);
    expect(t.state.calls).toBe(2);
    t.state.release?.();
  });

  it("an answer more than two windows old is not shown: the caller waits for a fresh one", async () => {
    const t = setup();
    await t.provider.get("1");
    t.advance(70_000);
    t.state.body = { ...OPEN, closed: true };
    expect((await t.provider.get("1"))?.closed).toBe(true);
  });

  it("a failed refresh keeps serving the last known status and tries again on the next call", async () => {
    const t = setup();
    await t.provider.get("1");
    t.advance(40_000);
    t.state.mode = "fail";
    expect((await t.provider.get("1"))?.closed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.state.calls).toBe(2);
    expect((await t.provider.get("1"))?.closed).toBe(false); // still the last known, never "unknown"
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.state.calls).toBe(3); // it retried
    t.state.mode = "ok";
    t.state.body = { ...OPEN, closed: true };
    await t.provider.get("1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await t.provider.get("1"))?.closed).toBe(true);
  });

  it("a market that was never looked up and cannot be reached is null (unknown), and is retried each time", async () => {
    const t = setup();
    t.state.mode = "fail";
    expect(await t.provider.get("9")).toBeNull();
    expect(await t.provider.get("9")).toBeNull();
    expect(t.state.calls).toBe(2);
  });
});
