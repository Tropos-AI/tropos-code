// src/home/migrate.ts — the old home layout -> the workspace layout: lock, backup first, move, import old notes.
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, readlink, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createBackup, stamp } from "../backup/create";
import { BackupError } from "../backup/errors";
import { BOOTSTRAP_TEXT, IDENTITY_STATE_FILE, parseIdentityFile } from "../context/identity";
import { listProjects } from "../gateway/projects";
import { AGENTS_TEMPLATE } from "../memory/agents-file";
import { appendJournalText, DAY_FILE, formatJournalEntry, parseJournal, type JournalEntry } from "../memory/daily";
import { noteEntries } from "../memory/search-index";
import { agentsDir, journalDir, learnedSkillsDir, projectKey, userSkillsDir, workspaceDir, workspaceFile } from "../paths";
import { currentPath, LAYOUT_VERSION, legacyPath, readLayoutState, workspaceOwnPaths, writeLayoutState, type LegacyItem } from "./layout";

export interface LayoutMigration {
  ran: boolean;
  moved: string[];
  setAside: string[];
  notesImported: number;
  notesLeft: string[];
  conflicts: string[];
  backup?: string;
  bootstrapCreated: boolean;
  error?: string;
}

export interface LayoutOptions {
  now: () => number;
  version: string;
  /** Default true. */
  backup?: boolean;
  /** Test seam, passed on to createBackup. */
  tarBin?: string;
}

const ITEMS: LegacyItem[] = ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "skills", "skills-learned"];
const LOCK_STALE_MS = 10 * 60_000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const empty = (): LayoutMigration => ({ ran: false, moved: [], setAside: [], notesImported: 0, notesLeft: [], conflicts: [], bootstrapCreated: false });

/** lstat that reads "absent" as null: a link counts as there and is never followed. */
async function look(path: string) {
  return lstat(path).catch(() => null);
}

const rel = (home: string, path: string): string => relative(home, path).split("\\").join("/");

async function takeLock(file: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const h = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
      await h.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const st = await look(file);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) await unlink(file).catch(() => undefined);
      else return false;
    }
  }
  return false;
}

/** Moves one entry without following links: a link is recreated at the target (absolute) and the old one removed. */
async function moveEntry(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true, mode: DIR_MODE });
  const st = await lstat(from);
  if (st.isSymbolicLink()) {
    const target = await readlink(from);
    await symlink(isAbsolute(target) ? target : resolve(dirname(from), target), to);
    await unlink(from);
    return;
  }
  await rename(from, to);
}

async function setAsideName(path: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = `${path}.before-tropos-layout${n > 1 ? `-${n}` : ""}`;
    if (!(await look(candidate))) return candidate;
  }
}

/** True when `dir` (an existing folder of the home) is not a link, so working inside it stays inside the home. */
async function realFolderOrAbsent(dir: string): Promise<boolean> {
  const st = await look(dir);
  return st === null || st.isDirectory();
}

async function legacyExists(home: string): Promise<boolean> {
  for (const item of ITEMS) if (await look(legacyPath(home, item))) return true;
  if ((await look(join(home, "memories"))) || (await look(join(home, "SOUL.imported.md")))) return true;
  for (const key of await readdir(join(home, "projects")).catch(() => [] as string[])) if (await look(join(home, "projects", key, "notes"))) return true;
  return false;
}

/** The cwd a project folder belongs to, among the places a cwd is recorded; undefined when none hashes to the key. */
async function projectCwd(home: string, key: string, extra: () => Promise<string[]>): Promise<string | undefined> {
  const dir = join(home, "projects", key);
  const candidates: string[] = [];
  for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const fd = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!fd) continue;
    try {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      const line = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
      const meta = JSON.parse(line) as { type?: unknown; cwd?: unknown };
      if (meta.type === "meta" && typeof meta.cwd === "string") candidates.push(meta.cwd);
    } catch {
      // not a session file
    } finally {
      await fd.close();
    }
  }
  const found = candidates.find((c) => projectKey(c) === key);
  if (found) return found;
  return (await extra()).find((c) => projectKey(c) === key);
}

function otherCwds(home: string): () => Promise<string[]> {
  let cached: Promise<string[]> | undefined;
  return () =>
    (cached ??= (async () => {
      const out: string[] = [];
      out.push(...(await listProjects(home).then((ps) => ps.map((p) => p.path), () => [] as string[])));
      out.push(workspaceDir(home));
      const history = await readFile(join(home, "history.jsonl"), "utf8").catch(() => "");
      for (const line of history.split("\n")) {
        try {
          const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
          if (typeof cwd === "string") out.push(cwd);
        } catch {
          // skip
        }
      }
      return out;
    })());
}

function toEntry(raw: string, cwd: string): JournalEntry {
  const [first = "", ...rest] = raw.split("\n");
  const m = /^- (\d{2}:\d{2}) (.*)$/.exec(first);
  const text = m ? m[2]! : first.replace(/^- ?/, "");
  const body = [text, ...rest.map((l) => l.replace(/^ {1,2}/, ""))].join("\n");
  const entry: JournalEntry = { name: basename(cwd) || cwd, path: cwd, body };
  if (m) entry.time = m[1]!;
  return entry;
}

async function appendNewDay(file: string, date: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: DIR_MODE });
  const h = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "EEXIST") return null;
    throw e;
  });
  if (!h) return;
  try {
    await h.write(`# ${date}\n\n`);
  } finally {
    await h.close();
  }
}

/** Old per-project day notes -> the journal, once. Folders whose project can't be traced stay. */
export async function importLegacyNotes(home: string): Promise<{ imported: number; left: string[] }> {
  let imported = 0;
  const left: string[] = [];
  const extra = otherCwds(home);
  for (const key of (await readdir(join(home, "projects")).catch(() => [] as string[])).sort()) {
    const notes = join(home, "projects", key, "notes");
    const st = await look(notes);
    if (!st) continue;
    const cwd = st.isDirectory() ? await projectCwd(home, key, extra) : undefined;
    if (!cwd) {
      left.push(rel(home, notes));
      continue;
    }
    for (const name of (await readdir(notes)).sort()) {
      const date = DAY_FILE.exec(name)?.[1];
      const file = join(notes, name);
      if (!date || !(await look(file))?.isFile()) continue;
      const entries = noteEntries(await readFile(file, "utf8")).map((raw) => toEntry(raw, cwd));
      const dayFile = join(journalDir(home), name);
      const existing = new Set(parseJournal(await readFile(dayFile, "utf8").catch(() => "")).map(formatJournalEntry));
      const fresh = entries.filter((e) => !existing.has(formatJournalEntry(e)));
      // Entries without a time first, then by time; the sort is stable.
      fresh.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
      if (fresh.length > 0) {
        await appendNewDay(dayFile, date);
        await appendJournalText(dayFile, fresh.map(formatJournalEntry).join(""));
        imported += fresh.length;
      }
      await unlink(file);
    }
    await rmdir(notes).catch(() => undefined);
  }
  return { imported, left };
}

/** What a doctor can say about the old layout: home-relative paths. */
export async function legacyLayoutReport(home: string): Promise<{ movable: string[]; conflicts: string[]; notesLeft: string[] }> {
  const movable: string[] = [];
  const conflicts: string[] = [];
  const consider = async (from: string, to: string) => {
    if (!(await look(from))) return;
    (await look(to) ? conflicts : movable).push(rel(home, from));
  };
  for (const item of ITEMS) await consider(legacyPath(home, item), currentPath(home, item));
  const memories = join(home, "memories");
  if ((await look(memories))?.isDirectory()) {
    for (const name of await readdir(memories)) if (name !== "USER.md" && name !== "MEMORY.md") await consider(join(memories, name), join(workspaceDir(home), name));
  }
  await consider(join(home, "SOUL.imported.md"), join(workspaceDir(home), "SOUL.imported.md"));
  const extra = otherCwds(home);
  const notesLeft: string[] = [];
  for (const key of await readdir(join(home, "projects")).catch(() => [] as string[])) {
    const notes = join(home, "projects", key, "notes");
    const st = await look(notes);
    if (!st) continue;
    const traced = st.isDirectory() && (await projectCwd(home, key, extra)) !== undefined;
    (traced ? movable : notesLeft).push(rel(home, notes));
  }
  return { movable, conflicts, notesLeft };
}

/** Real, empty own files and folders, so a sandbox has nothing to cover with a placeholder. Never replaces anything. */
async function createOwnPlaces(home: string): Promise<void> {
  for (const dir of [journalDir(home), userSkillsDir(home), learnedSkillsDir(home)]) if (!(await look(dir))) await mkdir(dir, { recursive: true, mode: DIR_MODE });
  for (const name of ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"] as const) {
    const h = await open(workspaceFile(home, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "EEXIST") return null;
      throw e;
    });
    await h?.close();
  }
}

async function bootstrapped(home: string): Promise<boolean> {
  try {
    return (JSON.parse(await readFile(join(home, IDENTITY_STATE_FILE), "utf8")) as { bootstrapped?: unknown }).bootstrapped === true;
  } catch {
    return false;
  }
}

export async function migrateHomeLayout(home: string, opts: LayoutOptions): Promise<LayoutMigration> {
  const r = empty();
  await mkdir(home, { recursive: true, mode: DIR_MODE });
  const lock = join(home, "layout.lock");
  if (!(await takeLock(lock))) return r;
  try {
    const firstRun = (await readLayoutState(home)) === null;
    // Working inside a linked workspace/ or agents/ could write outside the home.
    for (const dir of [workspaceDir(home), agentsDir(home)]) {
      if (!(await realFolderOrAbsent(dir))) return { ...r, error: `${rel(home, dir)} is a link or a file, not a folder` };
    }
    if (opts.backup !== false && (await legacyExists(home))) {
      try {
        const out = await createBackup({
          home,
          now: opts.now,
          output: join(home, "backups", `tropos-layout-${stamp(opts.now())}.tar.gz`),
          quick: true,
          sessions: false,
          secrets: false,
          workspace: false,
          verify: true,
          troposVersion: opts.version,
          ...(opts.tarBin ? { tarBin: opts.tarBin } : {}),
        });
        if (out.archive) r.backup = out.archive;
      } catch (error) {
        if (!(error instanceof BackupError && error.code === "empty")) return { ...r, ran: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    r.ran = true;
    await mkdir(workspaceDir(home), { recursive: true, mode: DIR_MODE });
    await mkdir(agentsDir(home), { recursive: true, mode: DIR_MODE });

    if (firstRun) {
      // Whatever sits at an own path now came from project work, not from Tropos's stores.
      for (const own of workspaceOwnPaths(home)) {
        if (!(await look(own))) continue;
        const aside = await setAsideName(own);
        await rename(own, aside);
        r.setAside.push(rel(home, own));
      }
    }

    const consider = async (from: string, to: string) => {
      if (!(await look(from))) return;
      if (await look(to)) r.conflicts.push(rel(home, from));
      else {
        await moveEntry(from, to);
        r.moved.push(rel(home, from));
      }
    };
    for (const item of ITEMS) await consider(legacyPath(home, item), currentPath(home, item));
    const memories = join(home, "memories");
    const memoriesInfo = await look(memories);
    if (memoriesInfo?.isDirectory()) {
      for (const name of (await readdir(memories)).sort()) await consider(join(memories, name), join(workspaceDir(home), name));
      await rmdir(memories).catch(() => undefined);
    } else if (memoriesInfo) r.conflicts.push("memories");
    await consider(join(home, "SOUL.imported.md"), join(workspaceDir(home), "SOUL.imported.md"));

    const notes = await importLegacyNotes(home);
    r.notesImported = notes.imported;
    r.notesLeft = notes.left;

    if (!(await look(workspaceFile(home, "AGENTS.md")))) await writeFile(workspaceFile(home, "AGENTS.md"), AGENTS_TEMPLATE, { flag: "wx", mode: FILE_MODE });

    if (firstRun) {
      const identityText = await readFile(workspaceFile(home, "IDENTITY.md"), "utf8").catch(() => "");
      if (!parseIdentityFile(identityText).name && !(await bootstrapped(home)) && !(await look(workspaceFile(home, "BOOTSTRAP.md")))) {
        await writeFile(workspaceFile(home, "BOOTSTRAP.md"), BOOTSTRAP_TEXT, { flag: "wx", mode: FILE_MODE });
        r.bootstrapCreated = true;
      }
    }
    await createOwnPlaces(home);
    await writeLayoutState(home, { version: LAYOUT_VERSION, migratedAt: new Date(opts.now()).toISOString(), ...(r.backup ? { backup: r.backup } : {}) });
    return r;
  } catch (error) {
    return { ...r, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await unlink(lock).catch(() => undefined);
  }
}

export async function ensureHomeLayout(home: string, opts: LayoutOptions): Promise<LayoutMigration> {
  const state = await readLayoutState(home);
  if (state && state.version >= LAYOUT_VERSION) return empty();
  return migrateHomeLayout(home, opts);
}

export function layoutNotice(r: LayoutMigration): string | null {
  const parts: string[] = [];
  if (r.error) {
    parts.push(`Couldn't back up ~/.tropos, so nothing was moved (${r.error}). Tropos keeps using the old places; tcode doctor --fix retries.`);
    return parts.join(" ");
  }
  if (r.moved.length > 0 || r.notesImported > 0) parts.push(`Moved Tropos's memory, identity and skills into ~/.tropos/workspace.${r.backup ? ` Backup: ${r.backup}.` : ""}`);
  if (r.setAside.length > 0) parts.push(`Files that were already in the default workspace were renamed, not used: ${r.setAside.join(", ")}.`);
  if (r.conflicts.length > 0) parts.push(`Both an old and a new copy exist, so these were left as they are: ${r.conflicts.join(", ")}. Run tcode doctor.`);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Lays the home out at a start and says what happened on stderr; a failure is reported and never stops the start. */
export async function layoutAtStart(home: string, version: string, err: (text: string) => void, now: () => number = Date.now): Promise<void> {
  try {
    const notice = layoutNotice(await ensureHomeLayout(home, { now, version }));
    if (notice) err(`tcode: ${notice}\n`);
  } catch (error) {
    err(`tcode: couldn't lay out ~/.tropos: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
