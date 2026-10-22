// src/cli/lifecycle/names.ts — the words `tcode <word>` treats as lifecycle commands.
export const LIFECYCLE_NAMES = ["uninstall", "reset", "doctor", "status", "backup", "logs", "config", "security", "cron", "onboard", "dashboard", "migrate", "harness"] as const;
export type LifecycleName = (typeof LIFECYCLE_NAMES)[number];

export function isLifecycleName(word: string | undefined): word is LifecycleName {
  return word !== undefined && (LIFECYCLE_NAMES as readonly string[]).includes(word);
}
