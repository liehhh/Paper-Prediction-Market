import Link from "next/link";
import { register } from "../auth/actions";
import { AuthForm } from "@/components/auth-form";
import { NoticeBox } from "@/components/notice-box";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const MESSAGES: Record<string, string> = {
  weak_password: "That password is too weak. Use at least 8 characters.",
  email_address_invalid: "That email address is not valid.",
  over_email_send_rate_limit: "Too many emails were sent recently. Wait a while and try again.",
  signup_disabled: "Registration is currently closed.",
  missing_fields: "Enter an email and a password.",
  not_configured: "Registration is not configured on this server yet.",
  failed: "Registration failed. Try again in a moment.",
};

export default async function RegisterPage({ searchParams }: { searchParams: SearchParams }) {
  const { error, sent } = await searchParams;

  if (sent === "1") {
    return (
      <main className="mx-auto flex max-w-sm flex-col gap-6 px-4 py-12">
        <h1 className="text-2xl font-bold tracking-tight">Check your email</h1>
        <NoticeBox tone="info" title="Your account is created, but you are not signed in yet.">
          We sent a confirmation link. Open it to finish signing in. If it expires, register again with the same email to get a new one.
        </NoticeBox>
        <Link href="/sign-in" className="text-sm font-medium underline-offset-2 hover:underline">
          Already confirmed? Sign in
        </Link>
      </main>
    );
  }

  const message = typeof error === "string" ? (MESSAGES[error] ?? MESSAGES.failed) : null;
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 px-4 py-12">
      <h1 className="text-2xl font-bold tracking-tight">Create an account</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">Paper trading only. You start with 10,000 virtual credits. No real money.</p>
      {message && <NoticeBox tone="error" title={message} />}
      <AuthForm
        action={register}
        submitLabel="Create account"
        passwordAutoComplete="new-password"
        footer={{ text: "Already registered?", linkLabel: "Sign in", href: "/sign-in" }}
      />
    </main>
  );
}
