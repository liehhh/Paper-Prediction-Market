/**
 * Runs before every matched page request (Next.js 16 calls this "proxy"; it was "middleware").
 *
 * Its one job is keeping the session fresh. An access token lives about an hour. When a request
 * arrives with an expired one, getClaims() uses the refresh token to obtain a new pair from
 * Supabase Auth, and the new tokens are written back as cookies on this response. Server
 * Components cannot write cookies themselves, so this is the place it has to happen.
 *
 * It does NOT decide who may see what: the dashboard page and the API do that.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        // Make the refreshed tokens visible to the page that renders next, and to the browser.
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        // Responses that carry session cookies must never be cached by a shared cache.
        for (const [header, headerValue] of Object.entries(headers)) response.headers.set(header, headerValue);
      },
    },
  });

  await supabase.auth.getClaims();
  return response;
}

// Only the pages that read the session. The public catalog is deliberately not matched.
export const config = {
  matcher: ["/dashboard/:path*", "/sign-in", "/register", "/auth/:path*"],
};
