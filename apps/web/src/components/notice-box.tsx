import type { ReactNode } from "react";

const TONES = {
  info: "bg-sky-50 text-sky-900 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-100 dark:ring-sky-900",
  warning: "bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-100 dark:ring-amber-900",
  error: "bg-rose-50 text-rose-900 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-100 dark:ring-rose-900",
  neutral: "bg-white text-zinc-700 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800",
} as const;

export function NoticeBox({ tone, title, children }: { tone: keyof typeof TONES; title: string; children?: ReactNode }) {
  return (
    <div role={tone === "error" || tone === "warning" ? "alert" : "status"} className={`rounded-xl p-4 ring-1 ${TONES[tone]}`}>
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1 text-sm opacity-90">{children}</div>}
    </div>
  );
}
