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

/** True when a normalized handle is empty or a phone shape with no digits ("", "+"); never matchable. */
function isDegenerate(normalized: string): boolean {
  return normalized === "" || (PHONE_SHAPE.test(normalized) && !/\d/.test(normalized));
}

/**
 * Every key two spellings of one handle might share: normalized, digits only, last ten digits.
 * Matching must go through `sameHandle`, which also refuses to equate two different country codes.
 */
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

/**
 * True when two spellings are the same person. When both carry a country code (a leading `+`)
 * they must be equal once normalized; otherwise any shared key counts. Empty handles never match.
 */
export function sameHandle(a: string, b: string): boolean {
  const na = normalizeHandle(a);
  const nb = normalizeHandle(b);
  if (isDegenerate(na) || isDegenerate(nb)) return false;
  if (na.startsWith("+") && nb.startsWith("+")) return na === nb;
  const keys = new Set(handleKeys(a));
  return handleKeys(b).some((key) => keys.has(key));
}

/**
 * The permission-rule target for a send: a normalized handle, or `chat:<guid>` for a group.
 * Exactly one of `to` and `chat` must be set, and a handle must not be empty.
 */
export function targetOf(input: { to?: string; chat?: string }): string {
  if (input.to !== undefined && input.chat !== undefined) {
    throw new Error("Give either a recipient (to) or a chat, not both.");
  }
  let handle: string;
  if (input.to !== undefined) {
    handle = normalizeHandle(input.to);
  } else if (input.chat !== undefined) {
    const parts = input.chat.split(";");
    if (parts.length < 3 || parts[1] !== "-") {
      if (input.chat.trim() === "") throw new Error("A message needs a recipient (to) or a chat.");
      return `chat:${input.chat}`;
    }
    handle = normalizeHandle(parts.slice(2).join(";"));
  } else {
    throw new Error("A message needs a recipient (to) or a chat.");
  }
  if (isDegenerate(handle)) throw new Error("The recipient is empty.");
  return handle;
}

const APPLE_EPOCH_SECONDS = 978307200;

/** chat.db dates are seconds, or nanoseconds on newer macOS, since 2001-01-01; returns Unix milliseconds. */
export function appleToUnixMs(value: number): number {
  const seconds = value > 1e12 ? value / 1e9 : value;
  return Math.round((seconds + APPLE_EPOCH_SECONDS) * 1000);
}
