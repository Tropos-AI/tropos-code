// src/error-text.ts

/**
 * One-line text for a thrown value, for notices and tool results. Never throws: an Error's
 * message, otherwise the value as a string, falling back to its type tag (`Object.create(null)`
 * has no `toString`) and finally to a fixed phrase (a revoked Proxy refuses even that).
 */
export function errorText(err: unknown): string {
  try {
    return err instanceof Error ? String(err.message) : String(err);
  } catch {
    try {
      return Object.prototype.toString.call(err);
    } catch {
      return "an unprintable value";
    }
  }
}
