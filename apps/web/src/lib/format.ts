// Formatting runs on the server; UTC keeps output identical regardless of host timezone.
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const dateTimeFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

export function formatDateTimeUtc(iso: string): string {
  return `${dateTimeFormat.format(new Date(iso))} UTC`;
}

export function formatRelative(iso: string, now: Date = new Date()): string {
  const minutes = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** 0.0375 -> "3.8¢", 0.5 -> "50¢". Polymarket prices are dollars per share in [0, 1]. */
export function formatPriceCents(price: number): string {
  return `${Number((price * 100).toFixed(1))}¢`;
}
