"use server";

/**
 * Server Actions behind the sign-in, register and sign-out forms. They run on the Next.js server:
 * the browser POSTs the form, this code forwards the credentials to Supabase Auth, and the
 * resulting session is written to cookies. Passwords are never logged or stored here, and
 * failures redirect with a short error KEY (never raw upstream text) that the page maps to a message.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** Where Supabase's confirmation link should land; derived from the request, so no extra config. */
async function siteOrigin(): Promise<string> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin) return origin;
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${h.get("host") ?? "localhost:3000"}`;
}

export async function signIn(formData: FormData) {
  const email = field(formData, "email").trim();
  const password = field(formData, "password"); // never trimmed: spaces may be part of it
  if (!email || !password) redirect("/sign-in?error=missing_fields");

  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect("/sign-in?error=not_configured");

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const known = ["invalid_credentials", "email_not_confirmed", "over_request_rate_limit"];
    redirect(`/sign-in?error=${known.includes(error.code ?? "") ? error.code : "failed"}`);
  }
  redirect("/dashboard");
}

export async function register(formData: FormData) {
  const email = field(formData, "email").trim();
  const password = field(formData, "password");
  if (!email || !password) redirect("/register?error=missing_fields");

  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect("/register?error=not_configured");

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${await siteOrigin()}/auth/confirm` },
  });
  if (error) {
    const known = ["weak_password", "over_email_send_rate_limit", "signup_disabled", "email_address_invalid"];
    redirect(`/register?error=${known.includes(error.code ?? "") ? error.code : "failed"}`);
  }
  // With email confirmation on, the account exists but there is NO session yet: nobody has proven
  // they own this address. Without it, signUp returns a session and the user is already signed in.
  redirect(data.session ? "/dashboard" : "/register?sent=1");
}

export async function signOut() {
  const supabase = await createSupabaseServerClient();
  await supabase?.auth.signOut(); // revokes the refresh token at Supabase and clears the cookies
  redirect("/");
}
