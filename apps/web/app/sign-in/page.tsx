import { signIn } from "../auth/actions";
import { AuthForm } from "@/components/auth-form";
import { NoticeBox } from "@/components/notice-box";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Fixed messages keyed by a short code: nothing from the URL is ever echoed back as text.
const MESSAGES: Record<string, string> = {
  invalid_credentials: "That email and password do not match an account.",
  email_not_confirmed: "Confirm your email first: open the link we sent you, then sign in.",
  confirm_failed: "That confirmation link is invalid or has expired. Sign in, or register again to get a new link.",
  missing_fields: "Enter your email and password.",
  over_request_rate_limit: "Too many attempts. Wait a minute and try again.",
  not_configured: "Sign-in is not configured on this server yet.",
  failed: "Sign-in failed. Try again in a moment.",
};

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const { error } = await searchParams;
  const message = typeof error === "string" ? (MESSAGES[error] ?? MESSAGES.failed) : null;
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 px-4 py-12">
      <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
      {message && <NoticeBox tone="error" title={message} />}
      <AuthForm
        action={signIn}
        submitLabel="Sign in"
        passwordAutoComplete="current-password"
        footer={{ text: "New here?", linkLabel: "Create an account", href: "/register" }}
      />
    </main>
  );
}
