/**
 * The Supabase Auth client for server code (Server Components, Server Actions, Route Handlers).
 *
 * The session lives in COOKIES that Next.js reads from the incoming request and writes on the
 * response (the `@supabase/ssr` package chunks the access + refresh tokens into `sb-…-auth-token`
 * cookies). A new client is built per request; never reuse one across requests.
 *
 * SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are public values, but they are read server-side only.
 */
import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export function getSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  return url && key ? { url, key } : null;
}

/** Null when Supabase is not configured, so the catalog keeps working without sign-in set up. */
export async function createSupabaseServerClient() {
  const config = getSupabaseConfig();
  if (!config) return null;
  const cookieStore = await cookies();
  return createServerClient(config.url, config.key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // A Server Component cannot set cookies. That is fine: proxy.ts already refreshed the
          // session for this request, and Server Actions / Route Handlers can write them.
        }
      },
    },
  });
}
