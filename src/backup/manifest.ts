// src/backup/manifest.ts — manifest.json inside every archive, and the rules for names inside it.
import { posix } from "node:path";
import { z } from "zod";

export const ARCHIVE_PREFIX = "tropos-home";
export const MANIFEST_NAME = "manifest.json";
export const FORMAT = "tropos-backup";

export const PARTS = ["config", "credentials", "identity", "sessions", "memory", "skills", "plugins", "learning", "gateway", "workspace", "agents"] as const;
export type BackupPart = (typeof PARTS)[number];

export const manifestSchema = z.object({
  format: z.literal(FORMAT),
  version: z.literal(1),
  createdAt: z.string(),
  troposVersion: z.string().optional(),
  platform: z.string().optional(),
  options: z.object({ quick: z.boolean(), sessions: z.boolean(), secrets: z.boolean(), workspace: z.boolean() }),
  includes: z.array(z.string()),
  excludes: z.array(z.string()),
  files: z.array(
    z.object({
      /** Relative to TROPOS_HOME; the archive member is `tropos-home/<path>`. */
      path: z.string().min(1),
      type: z.enum(["file", "symlink"]),
      size: z.number().int().min(0),
      /** sha256 of the contents (of the link text, for a symlink). */
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      mode: z.number().int().min(0).max(0o7777),
      target: z.string().optional(),
      /** Secret entries were removed from this file (--no-secrets). */
      stripped: z.boolean().optional(),
    }),
  ),
});
export type BackupManifest = z.infer<typeof manifestSchema>;
export type ManifestFile = BackupManifest["files"][number];

/** Why `rel` (a path relative to the home) is not acceptable, or undefined. Rejects absolute, `..`, NUL, empty parts. */
export function unsafeRelPath(rel: string): string | undefined {
  if (rel === "" || rel.includes("\0")) return "empty or NUL in the path";
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || rel.includes("\\")) return "absolute or backslash path";
  const parts = rel.split("/");
  if (parts.some((p) => p === ".." )) return "contains ..";
  if (parts.some((p) => p === "" || p === ".")) return "empty or . segment";
  return undefined;
}

/** A symlink target is acceptable when it is relative and, resolved from the link's directory, stays inside the home. */
export function unsafeLinkTarget(relOfLink: string, target: string): string | undefined {
  if (target === "" || target.includes("\0")) return "empty link target";
  if (target.startsWith("/") || /^[A-Za-z]:/.test(target)) return "absolute link target";
  const resolved = posix.normalize(posix.join(posix.dirname(relOfLink), target));
  if (resolved === ".." || resolved.startsWith("../") || resolved === ".") return "link target leaves the Tropos home";
  return undefined;
}

/** What a path directly under workspace/ is: the chief's own files by kind, anything else is the user's project. */
function workspacePart(name: string): BackupPart {
  if (["SOUL.md", "IDENTITY.md", "AGENTS.md", "BOOTSTRAP.md"].includes(name)) return "identity";
  if (name === "USER.md" || name === "MEMORY.md" || name === "memory" || /^imported-.*\.md$/.test(name)) return "memory";
  if (name === "skills" || name === "skills-learned") return "skills";
  return "workspace";
}

export function partOf(rel: string): BackupPart {
  const top = rel.split("/")[0]!;
  // projects/<key>/settings.json is the user's per-project settings (permission rules), not a session.
  if (/^projects\/[^/]+\/settings\.json$/.test(rel)) return "config";
  // Old project notes are memory too (LEGACY_LAYOUT).
  if (/^projects\/[^/]+\/notes\//.test(rel)) return "memory";
  if (top === "workspace") return workspacePart(rel.split("/")[1] ?? "");
  switch (top) {
    case "credentials.json":
      return "credentials";
    case "IDENTITY.md":
    case "SOUL.md":
    case "TROPOS.md":
    case "identity.json":
      return "identity";
    case "projects":
    case "history.jsonl":
      return "sessions";
    case "memories":
      return "memory";
    case "skills":
    case "skills-learned": // LEGACY_LAYOUT
      return "skills";
    case "agents":
      return "agents";
    case "plugins":
      return "plugins";
    case "learning":
      return "learning";
    case "gateway":
      return rel === "gateway/sessions.json" || rel === "gateway/chats.json" ? "sessions" : "gateway";
    default:
      return "config";
  }
}
