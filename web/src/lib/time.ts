// web/src/lib/time.ts

const STEPS: Array<[suffix: string, seconds: number]> = [
  ["y", 31_536_000],
  ["mo", 2_592_000],
  ["w", 604_800],
  ["d", 86_400],
  ["h", 3_600],
  ["m", 60],
];

/** A compact age for lists: "now", "5m", "2h", "3d", "4w", "2mo", "1y". Accepts a Date or anything Date.parse reads. */
export function shortAge(when: Date | string | number, now: number = Date.now()): string {
  const at = when instanceof Date ? when.getTime() : typeof when === "number" ? when : Date.parse(when);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  for (const [suffix, size] of STEPS) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${suffix}`;
  }
  return "now";
}

/** "$0.42" below $10, "$12.3" above; four decimals under a cent so tiny turns still move. */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(1)}`;
}

/** "12.4k" style token counts. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
