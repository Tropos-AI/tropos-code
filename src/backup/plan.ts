// src/backup/plan.ts — which files of TROPOS_HOME go into a backup.
import { lstat, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { workspaceOwnPaths } from "../home/layout";
import { unsafeLinkTarget } from "./manifest";
import { MAX_ENTRY_BYTES } from "./tar";

export interface BackupSelection {
  /** Skip the bulky optional parts: sessions, plugins, learning data. */
  quick: boolean;
  sessions: boolean;
  secrets: boolean;
  /** The managed default project, ~/.tropos/workspace (off unless asked: it is the user's code). */
  workspace: boolean;
}

export interface PlanEntry {
  rel: string;
  abs: string;
  type: "file" | "symlink";
  size: number;
  mode: number;
  target?: string;
}

export interface BackupPlan {
  entries: PlanEntry[];
  skipped: { path: string; reason: string }[];
  includes: string[];
  excludes: string[];
}

const TOP_FILES = ["settings.json", "gateway.json", "models.json", "identity.json", "IDENTITY.md", "SOUL.md", "TROPOS.md"];
const NEVER = new Set(["node_modules", ".cache", "cache", ".DS_Store"]);
const NEVER_SUFFIX = [".tmp", ".lock", ".partial"];

const OWN_FILES_LABEL = "workspace/ (Tropos's own files: AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, BOOTSTRAP.md, memory/, skills/, skills-learned/)";

export const EXCLUDED_ALWAYS = ["index.db*", "snapshots/", "gateway/token", "gateway/devices.json", "gateway/login-codes.json", "gateway/gateway.log", "gateway/state.json", "backups/", "settings.json.bak*", "caches (cache/, .cache/, node_modules/)", "*.tmp, *.lock"];

export function describeSelection(sel: BackupSelection): { includes: string[]; excludes: string[] } {
  // LEGACY_LAYOUT: memories/, skills/, skills-learned/ and projects/*/notes/ go along while a home may still hold them.
  const includes = [...TOP_FILES, "gateway/pairing.json", "gateway/cron/", "memories/", "skills/", "skills-learned/", "SOUL.imported.md", "projects/*/notes/", "agents/"];
  const excludes = [...EXCLUDED_ALWAYS];
  if (sel.secrets) includes.push("credentials.json");
  else excludes.push("credentials.json", "secret values inside settings.json and gateway.json");
  if (sel.sessions && !sel.quick) includes.push("projects/", "history.jsonl", "gateway/sessions.json", "gateway/chats.json");
  else {
    includes.push("projects/*/settings.json");
    excludes.push("sessions: projects/*/*.jsonl", "history.jsonl", "gateway/sessions.json", "gateway/chats.json");
  }
  if (!sel.quick) includes.push("plugins/", "learning/");
  else excludes.push("plugins/", "learning/");
  if (sel.workspace) includes.push("workspace/");
  else {
    // The chief lives in workspace/ and always goes along; the user's own files there only when asked.
    includes.push(OWN_FILES_LABEL);
    excludes.push("workspace/ (your other files there)");
  }
  return { includes, excludes };
}

async function walk(root: string, rel: string, out: PlanEntry[], skipped: BackupPlan["skipped"]): Promise<void> {
  const abs = join(root, rel);
  let st;
  try {
    st = await lstat(abs);
  } catch {
    return;
  }
  const name = rel.split("/").at(-1)!;
  if (NEVER.has(name) || NEVER_SUFFIX.some((s) => name.endsWith(s))) return;
  if (rel.includes("\n")) {
    skipped.push({ path: rel, reason: "newline in the file name" });
    return;
  }
  if (st.isSymbolicLink()) {
    const target = await readlink(abs);
    const bad = unsafeLinkTarget(rel, target);
    if (bad) skipped.push({ path: rel, reason: `symlink not backed up (${bad})` });
    else out.push({ rel, abs, type: "symlink", size: Buffer.byteLength(target), mode: st.mode & 0o777, target });
    return;
  }
  if (st.isDirectory()) {
    for (const child of (await readdir(abs)).sort()) await walk(root, `${rel}/${child}`, out, skipped);
    return;
  }
  // The reader refuses entries over the cap, so an archive holding one could never be verified or restored.
  if (st.isFile() && st.size > MAX_ENTRY_BYTES) skipped.push({ path: rel, reason: `larger than ${MAX_ENTRY_BYTES / 1024 ** 2} MiB, which backups do not hold` });
  else if (st.isFile()) out.push({ rel, abs, type: "file", size: st.size, mode: st.mode & 0o777 });
  else skipped.push({ path: rel, reason: "not a regular file" });
}

/** The first directory above `rel` (below the home) that is a link: walking through it would read outside the home. */
async function linkedParent(root: string, rel: string): Promise<string | undefined> {
  const parts = rel.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    const st = await lstat(join(root, sub)).catch(() => undefined);
    if (st?.isSymbolicLink()) return sub;
  }
  return undefined;
}

/** The files to back up, in a stable order. Never follows symlinks; those that point outside the home are skipped. */
export async function planBackup(home: string, sel: BackupSelection): Promise<BackupPlan> {
  const entries: PlanEntry[] = [];
  const skipped: BackupPlan["skipped"] = [];
  // LEGACY_LAYOUT: the old roots (memories, skills, skills-learned, SOUL.imported.md, project notes) are walked while they exist.
  const roots = [...TOP_FILES, "gateway/pairing.json", "gateway/cron", "memories", "skills", "skills-learned", "SOUL.imported.md", "agents"];
  // The chief's own files and the old project notes are memory, not sessions: they go along whatever `sessions` says.
  if (!sel.workspace) roots.push(...workspaceOwnPaths(home).map((p) => relative(home, p)));
  const wholeProjects = sel.sessions && !sel.quick;
  if (!wholeProjects) {
    for (const key of await readdir(join(home, "projects")).catch(() => [] as string[])) roots.push(`projects/${key}/notes`);
  }
  if (sel.secrets) roots.push("credentials.json");
  const bulky = !sel.quick;
  if (sel.sessions && bulky) roots.push("projects", "history.jsonl", "gateway/sessions.json", "gateway/chats.json");
  else {
    // Without sessions the per-project settings files still go along: they are configuration.
    for (const key of await readdir(join(home, "projects")).catch(() => [] as string[])) roots.push(`projects/${key}/settings.json`);
  }
  if (bulky) roots.push("plugins", "learning");
  if (sel.workspace) roots.push("workspace");
  for (const rel of roots) {
    // A linked folder above a nested root (workspace, projects/<key>) would lead the walk out of the home.
    const link = await linkedParent(home, rel);
    if (link) skipped.push({ path: rel, reason: `not backed up (${link} is a symlink)` });
    else await walk(home, rel, entries, skipped);
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return { entries, skipped, ...describeSelection(sel) };
}
