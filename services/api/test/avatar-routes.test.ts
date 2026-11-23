/**
 * Profile pictures through the API over real HTTP. Supabase Auth, Supabase Storage and the trading service are small
 * in-memory fakes. The fake Storage applies the same rule as the real policies (a player can only write inside the
 * folder of the country they own), and the images are REAL files processed by the real image code.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COUNTRY: Record<string, string> = { [A]: "ca000000-0000-4000-8000-00000000000a", [B]: "cb000000-0000-4000-8000-00000000000b" };
const TOKENS: Record<string, string> = { "token-a": A, "token-b": B };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});
const listen = (server: Server): Promise<string> => {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
};
const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

interface Harness {
  apiUrl: string;
  storage: Map<string, { bytes: Buffer; contentType: string }>;
  storageCalls: Array<{ method: string; path: string; apikey?: string; authorization?: string }>;
  avatarKeys: Record<string, string | null>;
  switchCalls: Array<{ userId: string; avatarKey: string | null }>;
  fail: { storageUpload: boolean; storageDelete: boolean; tradingSwitch: boolean };
}

async function startApi(): Promise<Harness> {
  const h: Harness = { apiUrl: "", storage: new Map(), storageCalls: [], avatarKeys: { [A]: null, [B]: null }, switchCalls: [], fail: { storageUpload: false, storageDelete: false, tradingSwitch: false } };

  const authUrl = await listen(
    createServer((req, res) => {
      const userId = TOKENS[(req.headers.authorization ?? "").replace("Bearer ", "")];
      if (!userId) return void res.writeHead(401).end("{}");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: userId }));
    }),
  );

  // Fake Supabase Storage: same observable rule as the real policies.
  const storageUrl = await listen(
    createServer(async (req, res) => {
      const path = decodeURIComponent((req.url ?? "").split("?")[0]!);
      const userId = TOKENS[(req.headers.authorization ?? "").replace("Bearer ", "")];
      h.storageCalls.push({ method: req.method!, path, apikey: req.headers.apikey as string | undefined, authorization: req.headers.authorization });
      const publicPrefix = "/storage/v1/object/public/avatars/";
      if (req.method === "GET" && path.startsWith(publicPrefix)) {
        const object = h.storage.get(path.slice(publicPrefix.length));
        return void (object ? res.writeHead(200, { "content-type": object.contentType }).end(object.bytes) : res.writeHead(404).end());
      }
      const prefix = "/storage/v1/object/avatars/";
      if (!path.startsWith(prefix) || !userId) return void res.writeHead(401).end("{}");
      const name = path.slice(prefix.length);
      const folder = name.split("/")[0];
      if (folder !== COUNTRY[userId]) return void res.writeHead(403).end(JSON.stringify({ message: "new row violates row-level security policy" }));
      if (req.method === "POST") {
        const bytes = await readBody(req);
        if (h.fail.storageUpload) return void res.writeHead(500).end("{}");
        if (h.storage.has(name)) return void res.writeHead(400).end("{}"); // never overwrites
        h.storage.set(name, { bytes, contentType: String(req.headers["content-type"]) });
        return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      }
      if (req.method === "DELETE") {
        if (h.fail.storageDelete) return void res.writeHead(500).end("{}");
        h.storage.delete(name);
        return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      }
      res.writeHead(405).end();
    }),
  );

  const tradingUrl = await listen(
    createServer(async (req, res) => {
      const body = await readBody(req);
      const match = /^\/internal\/v1\/accounts\/([^/]+)(\/avatar)?$/.exec(req.url ?? "");
      const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (req.url === "/internal/v1/league") {
        return json(200, {
          asOf: "2026-11-24T12:00:00.000Z",
          countries: [A, B].map((id, i) => ({
            countryId: COUNTRY[id], username: i === 0 ? "ada" : "bob", avatarKey: h.avatarKeys[id], areaWeight: 1, color: i === 0 ? "#39d065" : "#9139d0", slot: i + 1, rank: 1, relativeSize: 0.5,
            balance: "10000.000000", userId: id, // must never reach a visitor
          })),
        });
      }
      if (!match) return void res.writeHead(404).end("{}");
      const userId = match[1]!;
      if (match[2]) {
        const { avatarKey } = JSON.parse(body.toString()) as { avatarKey: string | null };
        h.switchCalls.push({ userId, avatarKey });
        if (h.fail.tradingSwitch) return void res.writeHead(500).end("{}");
        const previousKey = h.avatarKeys[userId] ?? null;
        h.avatarKeys[userId] = avatarKey;
        return json(200, { previousKey });
      }
      json(200, {
        openedAt: "2026-11-22T10:00:00.000Z", username: userId === A ? "ada" : "bob", countryId: COUNTRY[userId], avatarKey: h.avatarKeys[userId] ?? null,
        cash: { available: "10000.000000" }, activity: [{ id: "1", type: "starting_grant", amount: "10000.000000", createdAt: "2026-11-22T10:00:00.000Z" }],
      });
    }),
  );

  // The API treats SUPABASE_URL as both Auth and Storage; one fake server answers both.
  const combined = await listen(
    createServer((req, res) => {
      const target = (req.url ?? "").startsWith("/auth/") ? authUrl : storageUrl;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const upstream = await fetch(target + req.url, { method: req.method, headers: req.headers as Record<string, string>, body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks) });
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" }).end(Buffer.from(await upstream.arrayBuffer()));
      });
    }),
  );

  h.apiUrl = await listen(
    createServer(
      createApp({
        marketCatalog: { baseUrl: "http://127.0.0.1:1", timeoutMs: 100 },
        trading: { baseUrl: tradingUrl, timeoutMs: 3000 },
        auth: { url: combined, publishableKey: "pk_test", timeoutMs: 3000 },
      }),
    ),
  );
  return h;
}

// ---- real image fixtures ---------------------------------------------------------------------------------------------

/** 600 x 300: red left, GREEN from x=120 to 480, blue right. The centre 300 x 300 square (x 150-450) is green all over. */
const wide = () =>
  sharp({ create: { width: 600, height: 300, channels: 3, background: "#0000ff" } })
    .composite([
      { input: { create: { width: 120, height: 300, channels: 3, background: "#ff0000" } }, left: 0, top: 0 },
      { input: { create: { width: 360, height: 300, channels: 3, background: "#00ff00" } }, left: 120, top: 0 },
    ])
    .jpeg()
    .withExif({ IFD0: { Copyright: "Secret Photographer Name", Software: "private-camera-app" } })
    .toBuffer();
const plain = (format: "jpeg" | "png" | "webp" = "png", size = 300) => sharp({ create: { width: size, height: size, channels: 3, background: "#336699" } })[format]().toBuffer();

const put = (h: Harness, token: string | null, body: Buffer | string, contentType = "image/png") =>
  fetch(`${h.apiUrl}/v1/me/avatar`, { method: "PUT", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": contentType }, body: typeof body === "string" ? body : new Uint8Array(body) });
const world = async (h: Harness) => (await (await fetch(`${h.apiUrl}/v1/world`)).json()) as { countries: Array<Record<string, unknown>> };
const ours = (h: Harness, userId: string) => [...h.storage.keys()].filter((name) => name.startsWith(`${COUNTRY[userId]}/`));

describe("set a picture", () => {
  it("stores a fresh 256 x 256 WebP under the player's own country folder, switches the profile, and the world shows it", async () => {
    const h = await startApi();
    const response = await put(h, "token-a", await plain("png"));
    expect(response.status).toBe(200);
    const { avatarUrl } = (await response.json()) as { avatarUrl: string };

    const [name] = ours(h, A);
    expect(name).toMatch(new RegExp(`^${COUNTRY[A]}/[0-9a-f-]{36}\\.webp$`));
    const meta = await sharp(h.storage.get(name!)!.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 256, 256]);
    expect(h.storage.get(name!)!.contentType).toBe("image/webp");
    expect(h.avatarKeys[A]).toBe(name!.split("/")[1]);
    expect(avatarUrl).toMatch(new RegExp(`/storage/v1/object/public/avatars/${COUNTRY[A]}/[0-9a-f-]{36}\\.webp$`));

    // The write was made with THE PLAYER'S token and the public key: there is no privileged key anywhere.
    expect(h.storageCalls.find((c) => c.method === "POST")).toMatchObject({ apikey: "pk_test", authorization: "Bearer token-a" });
    // Anyone can fetch the public picture; the world snapshot points A's country at it and B's at nothing.
    expect((await fetch(avatarUrl)).status).toBe(200);
    const countries = (await world(h)).countries;
    expect(countries.find((c) => c.username === "ada")!.avatarUrl).toBe(avatarUrl);
    expect(countries.find((c) => c.username === "bob")!.avatarUrl).toBeNull();
  });

  it("center-crops without squashing, and keeps nothing private from the original file", async () => {
    const h = await startApi();
    const original = await wide();
    expect((await sharp(original).metadata()).exif).toBeTruthy(); // the fixture really carries EXIF
    await put(h, "token-a", original, "image/jpeg");
    const stored = h.storage.get(ours(h, A)[0]!)!.bytes;

    const meta = await sharp(stored).metadata();
    expect([meta.width, meta.height]).toEqual([256, 256]);
    expect(meta.exif).toBeUndefined(); // no EXIF: no copyright, camera, GPS or timestamps
    expect(stored.includes(Buffer.from("Secret Photographer Name"))).toBe(false);
    expect(stored.includes(Buffer.from("private-camera-app"))).toBe(false);
    // The 600 x 300 original was cropped from its middle (green), not stretched (which would show red and blue edges).
    const { data, info } = await sharp(stored).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    for (const [x, y] of [[128, 128], [12, 128], [243, 128], [128, 12], [128, 243]] as const) {
      const [r, g, b] = pixel(x!, y!);
      expect(g!).toBeGreaterThan(200);
      expect(r! + b!).toBeLessThan(80);
    }
  });

  it("accepts JPEG, PNG and WebP uploads", async () => {
    const h = await startApi();
    for (const format of ["jpeg", "png", "webp"] as const) expect((await put(h, "token-a", await plain(format), `image/${format}`)).status).toBe(200);
  });

  it("never puts the account id, email, original file name or the old picture's name in public data", async () => {
    const h = await startApi();
    await put(h, "token-a", await plain());
    const text = JSON.stringify(await world(h));
    expect(text).not.toContain(A);
    expect(text).not.toContain("balance");
    expect(Object.keys((await world(h)).countries[0]!).sort()).toEqual(["areaWeight", "avatarUrl", "color", "countryId", "rank", "relativeSize", "slot", "username"]);
  });
});

describe("replace and remove", () => {
  it("replacing uses a NEW name (so caches update), then deletes the old object; id, colour, slot and rank do not change", async () => {
    const h = await startApi();
    const before = (await world(h)).countries.find((c) => c.username === "ada")!;
    const first = ((await (await put(h, "token-a", await plain())).json()) as { avatarUrl: string }).avatarUrl;
    const second = ((await (await put(h, "token-a", await plain("jpeg", 500), "image/jpeg")).json()) as { avatarUrl: string }).avatarUrl;
    expect(second).not.toBe(first);
    expect(ours(h, A)).toHaveLength(1); // the old object is gone
    expect((await fetch(first)).status).toBe(404);
    expect((await fetch(second)).status).toBe(200);
    const after = (await world(h)).countries.find((c) => c.username === "ada")!;
    expect({ ...after, avatarUrl: null }).toEqual({ ...before, avatarUrl: null });
  });

  it("removing restores the colour-only country and deletes the object", async () => {
    const h = await startApi();
    await put(h, "token-a", await plain());
    const before = (await world(h)).countries.find((c) => c.username === "ada")!;
    const response = await fetch(`${h.apiUrl}/v1/me/avatar`, { method: "DELETE", headers: { authorization: "Bearer token-a" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ avatarUrl: null });
    expect(ours(h, A)).toHaveLength(0);
    const after = (await world(h)).countries.find((c) => c.username === "ada")!;
    expect(after).toEqual({ ...before, avatarUrl: null });
    expect(after.color).toBe("#39d065"); // its permanent colour is what shows again
  });

  it("removing still succeeds when the unused object cannot be deleted (the profile is already switched)", async () => {
    const h = await startApi();
    await put(h, "token-a", await plain());
    h.fail.storageDelete = true;
    expect((await fetch(`${h.apiUrl}/v1/me/avatar`, { method: "DELETE", headers: { authorization: "Bearer token-a" } })).status).toBe(200);
    expect(h.avatarKeys[A]).toBeNull();
  });
});

describe("a failed replacement keeps the previous picture", () => {
  it("storage down: plain-language 503, profile and old object untouched", async () => {
    const h = await startApi();
    const before = ((await (await put(h, "token-a", await plain())).json()) as { avatarUrl: string }).avatarUrl;
    const keyBefore = h.avatarKeys[A];
    h.fail.storageUpload = true;
    const response = await put(h, "token-a", await plain("jpeg"), "image/jpeg");
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("avatar_storage_unavailable");
    expect(body.error.message).toMatch(/current picture is unchanged/);
    expect(h.avatarKeys[A]).toBe(keyBefore);
    expect((await fetch(before)).status).toBe(200);
    expect((await world(h)).countries.find((c) => c.username === "ada")!.avatarUrl).toBe(before);
  });

  it("profile switch fails after the upload: the new object is cleaned up and the old picture stays", async () => {
    const h = await startApi();
    const before = ((await (await put(h, "token-a", await plain())).json()) as { avatarUrl: string }).avatarUrl;
    h.fail.tradingSwitch = true;
    expect((await put(h, "token-a", await plain("jpeg"), "image/jpeg")).status).toBe(503);
    expect(ours(h, A)).toHaveLength(1); // no orphan, and still the original
    expect((await fetch(before)).status).toBe(200);
  });

  it("an invalid upload never reaches storage or the profile", async () => {
    const h = await startApi();
    await put(h, "token-a", await plain());
    const key = h.avatarKeys[A];
    const calls = h.storageCalls.length;
    expect((await put(h, "token-a", "not an image at all", "image/png")).status).toBe(400);
    expect(h.avatarKeys[A]).toBe(key);
    expect(h.storageCalls).toHaveLength(calls);
  });
});

describe("who may change a picture", () => {
  it("requires sign-in for both set and remove, and reaches neither storage nor trading", async () => {
    const h = await startApi();
    for (const token of [null, "forged"]) {
      expect((await put(h, token, await plain())).status).toBe(401);
      expect((await fetch(`${h.apiUrl}/v1/me/avatar`, { method: "DELETE", headers: token ? { authorization: `Bearer ${token}` } : {} })).status).toBe(401);
    }
    expect(h.storageCalls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(h.switchCalls).toHaveLength(0);
  });

  it("player B can see A's picture but only ever acts on B's own country", async () => {
    const h = await startApi();
    const aUrl = ((await (await put(h, "token-a", await plain())).json()) as { avatarUrl: string }).avatarUrl;
    const aObject = ours(h, A)[0]!;

    // B uploads, removes: everything lands in B's folder and B's profile.
    await put(h, "token-b", await plain());
    await fetch(`${h.apiUrl}/v1/me/avatar`, { method: "DELETE", headers: { authorization: "Bearer token-b" } });
    expect(h.switchCalls.filter((c) => c.userId === B)).toHaveLength(2);
    expect(h.switchCalls.filter((c) => c.userId === A)).toHaveLength(1); // only A's own upload
    expect(h.storage.has(aObject)).toBe(true);
    expect((await fetch(aUrl)).status).toBe(200); // still publicly viewable

    // Even a hand-made request straight at Storage with B's token cannot touch A's folder (the policy rule).
    const direct = await fetch(`${new URL(aUrl).origin}/storage/v1/object/avatars/${aObject}`, { method: "DELETE", headers: { authorization: "Bearer token-b", apikey: "pk_test" } }).catch(() => null);
    expect(h.storage.has(aObject)).toBe(true);
    expect(direct === null || direct.status !== 200).toBe(true);
    // A body-supplied owner is ignored: the API takes the owner from the token.
    const trick = await fetch(`${h.apiUrl}/v1/me/avatar?userId=${A}&countryId=${COUNTRY[A]}`, { method: "PUT", headers: { authorization: "Bearer token-b", "content-type": "image/png", "x-user-id": A }, body: new Uint8Array(await plain()) });
    expect(trick.status).toBe(200);
    expect(ours(h, B)).toHaveLength(1);
    expect(h.avatarKeys[A]).toBe(aObject.split("/")[1]);
  });
});

describe("what is accepted", () => {
  it.each([
    ["an empty body", () => Promise.resolve(Buffer.alloc(0)), 400, "avatar_invalid_image"],
    ["plain text", () => Promise.resolve(Buffer.from("hello")), 400, "avatar_invalid_image"],
    ["an SVG (scriptable)", () => Promise.resolve(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script></svg>')), 415, "avatar_unsupported_type"],
    ["an animated or plain GIF", () => sharp({ create: { width: 64, height: 64, channels: 3, background: "#fff" } }).gif().toBuffer(), 415, "avatar_unsupported_type"],
    ["a picture under 32 px", () => plain("png", 16), 400, "avatar_invalid_image"],
    ["a file over 2 MB", () => Promise.resolve(Buffer.alloc(2 * 1024 * 1024 + 1, 1)), 413, "avatar_too_large"],
  ])("rejects %s with a plain message", async (_name, make, status, code) => {
    const h = await startApi();
    const response = await put(h, "token-a", await make());
    expect(response.status).toBe(status);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(code);
    expect(body.error.message.length).toBeGreaterThan(10);
    expect(ours(h, A)).toHaveLength(0);
  });

  it("judges the real bytes, not the declared type or file name: a PNG sent as image/jpeg works, text sent as image/png does not", async () => {
    const h = await startApi();
    expect((await put(h, "token-a", await plain("png"), "image/jpeg")).status).toBe(200);
    expect((await put(h, "token-a", "GIF89a nope", "image/png")).status).toBe(400); // unreadable, whatever it claims to be
  });

  it("a hostile huge-dimension image is refused instead of expanding in memory", async () => {
    const h = await startApi();
    const bomb = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024); // small on the wire, 81 megapixels when decoded
    const response = await put(h, "token-a", bomb);
    expect(response.status).toBe(400);
    expect(ours(h, A)).toHaveLength(0);
  });
});
