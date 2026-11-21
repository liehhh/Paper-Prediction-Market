/**
 * Where the link in the confirmation email lands. Clicking it is the moment an account that
 * already exists becomes a signed-in session: Supabase Auth checks the one-time token, marks the
 * email confirmed, and returns a session, which is written to cookies before redirecting.
 *
 * Opening the link later is safe. If it has expired or was already used, the user is sent to
 * sign-in with a clear message; the account itself is unaffected.
 */
import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const SIGNUP_OTP_TYPES: readonly string[] = ["email", "signup"];

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  const code = params.get("code");

  const supabase = await createSupabaseServerClient();
  if (supabase) {
    let failed = true;
    if (tokenHash && type && SIGNUP_OTP_TYPES.includes(type)) {
      // Link built from the email template: {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email
      failed = Boolean((await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash })).error);
    } else if (code) {
      // Default Supabase link (PKCE): only works in the browser that started the signup.
      failed = Boolean((await supabase.auth.exchangeCodeForSession(code)).error);
    }
    if (!failed) redirect("/dashboard");
  }
  redirect("/sign-in?error=confirm_failed");
}
