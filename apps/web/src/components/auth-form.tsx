import Link from "next/link";

const INPUT =
  "w-full rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:bg-zinc-900 dark:ring-zinc-700 dark:focus:ring-zinc-100";

/** A plain HTML form posting to a Server Action: works without client-side JavaScript. */
export function AuthForm({
  action,
  submitLabel,
  passwordAutoComplete,
  footer,
}: {
  action: (formData: FormData) => Promise<void>;
  submitLabel: string;
  passwordAutoComplete: "current-password" | "new-password";
  footer: { text: string; linkLabel: string; href: string };
}) {
  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium">
        Email
        <input name="email" type="email" required autoComplete="email" className={INPUT} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Password
        <input name="password" type="password" required autoComplete={passwordAutoComplete} minLength={8} className={INPUT} />
      </label>
      <button
        type="submit"
        className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {submitLabel}
      </button>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {footer.text}{" "}
        <Link href={footer.href} className="font-medium underline-offset-2 hover:underline">
          {footer.linkLabel}
        </Link>
      </p>
    </form>
  );
}
