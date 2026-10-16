// web/src/lib/admin-format.ts — small formatting helpers for the control-plane pages (times, ages, tolerant parsing).

/** "in 5m" / "5m ago" / "now" for an ISO time or ms epoch; "" when unreadable. */
export function relativeTime(when: string | number | undefined, now: number = Date.now()): string {
  if (when === undefined) return "";
  const at = typeof when === "number" ? when : Date.parse(when);
  if (!Number.isFinite(at)) return "";
  const diff = at - now;
  const seconds = Math.round(Math.abs(diff) / 1000);
  if (seconds < 45) return "now";
  const steps: Array<[string, number]> = [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
  ];
  let text = `${Math.max(1, Math.round(seconds / 60))}m`;
  for (const [suffix, size] of steps) {
    if (seconds >= size) {
      text = `${Math.floor(seconds / size)}${suffix}`;
      break;
    }
  }
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

/** "Oct 15, 09:00" in the viewer's locale; "" when unreadable. */
export function clockTime(when: string | number | undefined): string {
  if (when === undefined) return "";
  const at = typeof when === "number" ? when : Date.parse(when);
  if (!Number.isFinite(at)) return "";
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** The browser's time zone, "UTC" when unknown. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Time zones for a select: the browser's first, then a few common ones. */
export function timeZoneChoices(current: string): string[] {
  const common = ["UTC", "Europe/London", "Europe/Athens", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"];
  return [current, ...common.filter((zone) => zone !== current)];
}

/** Parses "KEY=value" lines or pairs into a record; blank keys are dropped. */
export function pairsToRecord(pairs: { key: string; value: string }[]): Record<string, string> | undefined {
  const entries = pairs.map((p) => [p.key.trim(), p.value] as const).filter(([key]) => key !== "");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Splits a command-line style argument string, honouring simple single and double quotes. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) out.push(match[1] ?? match[2] ?? match[3] ?? "");
  return out;
}
