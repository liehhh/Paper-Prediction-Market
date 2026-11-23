import { getWorld } from "@/lib/public-api";

// A same-origin relay for the World page's shared refresh: the browser talks to Next.js, Next.js talks to services/api.
// The data is the public World snapshot only (country id, username, avatar address, colour, rank, rounded sizes).
// Exact Power, holdings, orders and email never pass through here.
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await getWorld();
  if (!result.ok) return Response.json({ error: "world_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  return Response.json(result.data, { headers: { "Cache-Control": "no-store" } });
}
