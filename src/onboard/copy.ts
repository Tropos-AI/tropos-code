// src/onboard/copy.ts — the words setup shows, shared by the terminal wizard and the web page. No Node imports, so
// the web app can import it as `@core/onboard/copy`.

export interface IdentitySuggestion {
  name: string;
  emoji: string;
  vibe: string;
}

/** Starting points for "who should I be?"; every one passes the same checks as a typed answer. */
export const IDENTITY_SUGGESTIONS: readonly IdentitySuggestion[] = [
  { name: "Tropos", emoji: "🧭", vibe: "calm, direct, gets things done" },
  { name: "Atlas", emoji: "🗺️", vibe: "patient, thorough, explains as it goes" },
  { name: "Nova", emoji: "✨", vibe: "quick, upbeat, likes to try things" },
];
