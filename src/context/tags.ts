// src/context/tags.ts
import { createHash } from "node:crypto";

/**
 * Every tag Tropos itself wraps text in. Untrusted text (memory files, skills, commands, notes,
 * inlined files) must not open or close one of these, or it could pose as the harness.
 */
const HARNESS_TAGS = [
  "context",
  "memory",
  "environment",
  "mode",
  "skills?",
  "notes",
  "daily-notes",
  "reminder",
  "hook-context",
  "harness-nonce",
  "command",
  "file",
  "identity",
  "bootstrap",
  "specialists",
  "delegations",
  "suggestions",
];
const TAG = new RegExp(`<(?=\\s*\\/?\\s*(?:${HARNESS_TAGS.join("|")})(?![\\w-]))`, "gi");

/** Breaks any harness tag in `text` by inserting a backslash after its "<"; everything else stays as written. */
export function neutraliseHarnessTags(text: string): string {
  return text.replace(TAG, "<\\");
}

/**
 * A per-session value that genuine <hook-context> and <reminder> blocks carry. Text in a file or web
 * page can't know it, so it can't pass itself off as a hook's or Tropos's own message. Derived from the
 * session id, so a resumed session keeps the nonce its history already shows.
 */
export function harnessNonce(sessionId: string): string {
  return createHash("sha256").update(`tropos-harness:${sessionId}`).digest("hex").slice(0, 12);
}

export function nonceBlock(nonce: string): string {
  return `<harness-nonce>${nonce}</harness-nonce>`;
}
