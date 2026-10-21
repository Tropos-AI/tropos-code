// src/messages/handles.ts — message handles (phone/email), permission targets and Apple timestamps

const PHONE_SHAPE = /^[+\d\s\-.()]+$/;

/** One canonical spelling of a phone number or email, so the same person always compares equal. */
export function normalizeHandle(raw: string): string {
  const text = raw.trim();
  if (text.includes("@")) return text.toLowerCase();
  if (!PHONE_SHAPE.test(text)) return text;
  const compact = text.replace(/[\s\-.()]/g, "");
  return compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
}

/** Every key two spellings of one handle might share: normalized, digits only, last ten digits. */
export function handleKeys(raw: string): string[] {
  const normalized = normalizeHandle(raw);
  // Emails and names never get digit keys; "maria1@x.com" must not match "+1".
  if (!PHONE_SHAPE.test(normalized)) return [normalized];
  const keys = [normalized];
  const digits = normalized.replace(/\D/g, "");
  if (digits && !keys.includes(digits)) keys.push(digits);
  if (digits.length >= 10) {
    const last = digits.slice(-10);
    if (!keys.includes(last)) keys.push(last);
  }
  return keys;
}

/** True when two spellings share any key. */
export function sameHandle(a: string, b: string): boolean {
  const keys = new Set(handleKeys(a));
  return handleKeys(b).some((key) => keys.has(key));
}

/** The permission-rule target for a send: a normalized handle, or `chat:<guid>` for a group. */
export function targetOf(input: { to?: string; chat?: string }): string {
  if (input.to !== undefined) return normalizeHandle(input.to);
  if (input.chat !== undefined) {
    const parts = input.chat.split(";");
    if (parts.length >= 3 && parts[1] === "-") return normalizeHandle(parts.slice(2).join(";"));
    return `chat:${input.chat}`;
  }
  throw new Error("A message needs a recipient (to) or a chat.");
}

const APPLE_EPOCH_SECONDS = 978307200;

/** chat.db dates are seconds, or nanoseconds on newer macOS, since 2001-01-01; returns Unix milliseconds. */
export function appleToUnixMs(value: number): number {
  const seconds = value > 1e12 ? value / 1e9 : value;
  return Math.round((seconds + APPLE_EPOCH_SECONDS) * 1000);
}
