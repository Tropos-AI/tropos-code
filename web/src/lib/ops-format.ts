// web/src/lib/ops-format.ts — formatting and browser helpers for the operations pages (status, system, logs, config,
// usage). Pure functions except downloadTextFile, which touches the DOM.

/** "1.4 MB", "812 B". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** A readable local date and time, or the input unchanged when it does not parse. */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  return new Date(at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "Mar 4" for a YYYY-MM-DD (or ISO) day. */
export function formatDay(date: string): string {
  const at = Date.parse(date.length === 10 ? `${date}T00:00:00` : date);
  if (!Number.isFinite(at)) return date;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "12.4k", "1.2M"; whole numbers below a thousand. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(abs < 10_000_000 ? 2 : 1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

/** "$0.42"; "—" when the cost is unknown (a model without a price took part). */
export function formatUsd(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}

export type LogLevel = "error" | "warn" | "plain";

/** Error and warning lines get a colour in the log viewer. */
export function logLevel(line: string): LogLevel {
  if (/\b(error|err|fatal|fail(ed|ure)?|exception|panic)\b/i.test(line)) return "error";
  if (/\bwarn(ing)?\b/i.test(line)) return "warn";
  return "plain";
}

/** Saves text as a file through a Blob (client side only). Returns false when the browser cannot. */
export function downloadTextFile(filename: string, text: string): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
