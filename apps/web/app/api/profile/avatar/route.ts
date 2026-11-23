/**
 * The browser's door for profile pictures. The page cannot call services/api directly (the browser only talks to
 * Next.js, and the sign-in token stays on the server), so this route reads the session, forwards the picture to
 * services/api with the player's token, and relays only the small, known reply shapes.
 *
 * It decides nothing about WHO: services/api verifies the token and takes the owner from it. It decides nothing about
 * WHAT the file is either: services/api checks the real bytes and re-encodes the picture. The size check here is
 * only a cheap early refusal.
 */
import { ErrorResponseSchema } from "@league/catalog-contract";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024;
const apiUrl = () => new URL("/v1/me/avatar", process.env.API_BASE_URL ?? "http://localhost:4000");
const noStore = { "Cache-Control": "no-store" };

const reply = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers: noStore });

async function accessToken(): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  return session?.access_token ?? null;
}

/** Passes through {avatarUrl} or a plain-language error; anything unexpected becomes a generic, safe message. */
async function relay(response: Response): Promise<Response> {
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok && body && typeof body === "object" && "avatarUrl" in body) {
    const url = (body as { avatarUrl: unknown }).avatarUrl;
    if (url === null || typeof url === "string") return Response.json({ avatarUrl: url }, { headers: noStore });
  }
  const error = ErrorResponseSchema.safeParse(body);
  if (error.success && response.status >= 400 && response.status < 500) return Response.json(error.data, { status: response.status, headers: noStore });
  if (error.success && response.status === 503) return Response.json(error.data, { status: 503, headers: noStore });
  return reply(502, "avatar_failed", "We could not save your picture right now. Your current picture is unchanged; try again in a moment.");
}

export async function PUT(request: Request) {
  const token = await accessToken();
  if (!token) return reply(401, "unauthenticated", "Sign in to change your picture.");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return reply(413, "avatar_too_large", "That picture is too large. Choose one under 2 MB.");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) return reply(413, "avatar_too_large", "That picture is too large. Choose one under 2 MB.");
  try {
    return await relay(
      await fetch(apiUrl(), {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "content-type": request.headers.get("content-type") ?? "application/octet-stream" },
        body: bytes,
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      }),
    );
  } catch {
    return reply(502, "avatar_failed", "We could not reach the server. Your current picture is unchanged; try again in a moment.");
  }
}

export async function DELETE() {
  const token = await accessToken();
  if (!token) return reply(401, "unauthenticated", "Sign in to change your picture.");
  try {
    return await relay(await fetch(apiUrl(), { method: "DELETE", headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) }));
  } catch {
    return reply(502, "avatar_failed", "We could not reach the server. Your picture is unchanged; try again in a moment.");
  }
}
