// src/learning/ledger.ts
import { createHash, randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, realpath, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { surfaceKind } from "../harness/surface";
import { legacyToCurrent } from "../home/layout";
import { atomicWrite } from "../memory/notes";
import { LEARNED_SKILLS_DIR } from "../extensions/sources";
import { configFile, getAt, parsePath, readConfigRaw, sameJson, setAt, stripSecrets, unsetAt, updateConfigFile, type ConfigFileName } from "../config/store";
import { isInside } from "../paths";
import type { Actor } from "../tools/types";

export type LedgerKind = "memory" | "user" | "skill" | "identity" | "daily" | "agent" | "setup" | "harness";

/**
 * One change to a learned file. `before` and `after` are sha256 hashes of the file's contents
 * (stored as blobs next to the ledger), or null when the file was absent.
 */
export interface LedgerEntry {
  id: string;
  ts: string;
  actor: Actor;
  kind: LedgerKind;
  path: string;
  action: string;
  summary: string;
  before: string | null;
  after: string | null;
  /** A "setup" entry: the dotted path of the changed value inside the config file at `path`. */
  configPath?: string;
  /** Why undo refuses this entry (shown instead of an Undo button). */
  noUndo?: string;
  /** On an "undo" entry: the id of the entry it reverted. */
  undoes?: string;
  /** Set by list(): a later "undo" entry reverted this one. */
  undone?: boolean;
}

/** What a caller records: the file's contents before and after the change, not hashes. */
export type LedgerRecord = Omit<LedgerEntry, "id" | "ts" | "before" | "after" | "undone"> & {
  before: string | null;
  after: string | null;
};

export type UndoResult = { ok: true; entry: LedgerEntry } | { ok: false; reason: string };

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const HASH = /^[0-9a-f]{64}$/;
const DAY_NOTE = /^\d{4}-\d{2}-\d{2}\.md$/;
// LEGACY_LAYOUT: the first two are the pre-workspace roots.
const SKILL_ROOTS = [["skills"], [LEARNED_SKILLS_DIR], ["workspace", "skills"], ["workspace", LEARNED_SKILLS_DIR]];

/** A path inside a specialist's folder agents/<id>/…; dot-folders such as .archive are not specialists. */
const inSpecialist = (parts: string[]): boolean => parts.length >= 3 && parts[0] === "agents" && !parts[1]!.startsWith(".");

/**
 * Whether `path` is a file the learning loop writes for an entry of `kind`, under the Tropos home:
 * memory and user notes in the workspace, skill files inside a skill folder, the identity files, and
 * day notes. Undo only ever writes such a path. Purely lexical: the caller checks symlinks.
 */
export function isLearnedPath(home: string, kind: LedgerKind, path: string): boolean {
  const rel = relative(resolve(home), resolve(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  const parts = rel.split(sep);
  switch (kind) {
    case "memory":
      // The lessons are items in the workspace AGENTS.md.
      if (parts.length === 2 && parts[0] === "workspace" && parts[1] === "AGENTS.md") return true;
      if (inSpecialist(parts) && parts.length === 3 && parts[2] === "MEMORY.md") return true;
    // falls through
    case "user":
      // LEGACY_LAYOUT: memories/ until the migration moves the notes into the workspace.
      return parts.length === 2 && (parts[0] === "memories" || parts[0] === "workspace") && (parts[1] === "MEMORY.md" || parts[1] === "USER.md");
    case "skill":
      // <root>/<skill>/<file…>; dot-folders (.archive) are not skills.
      if (inSpecialist(parts) && parts[2] === "skills") return parts.length >= 5 && !parts[3]!.startsWith(".");
      return SKILL_ROOTS.some((root) => parts.length >= root.length + 2 && root.every((part, i) => parts[i] === part) && !parts[root.length]!.startsWith("."));
    case "identity":
      // LEGACY_LAYOUT: the home root until the migration moves them into the workspace.
      return (
        (parts.length === 1 || (parts.length === 2 && parts[0] === "workspace")) &&
        (parts[parts.length - 1] === "IDENTITY.md" || parts[parts.length - 1] === "SOUL.md")
      );
    case "daily":
      if (inSpecialist(parts)) return parts.length === 4 && parts[2] === "memory" && DAY_NOTE.test(parts[3]!);
      // LEGACY_LAYOUT: projects/<key>/notes/ until the migration moves the day notes into the journal.
      return (
        (parts.length === 4 && parts[0] === "projects" && parts[2] === "notes" && DAY_NOTE.test(parts[3]!)) ||
        (parts.length === 3 && parts[0] === "workspace" && parts[1] === "memory" && DAY_NOTE.test(parts[2]!))
      );
    case "setup":
      // Config values only; the entry's configPath says which one.
      return parts.length === 1 && (parts[0] === "settings.json" || parts[0] === "gateway.json");
    case "agent":
      if (inSpecialist(parts)) return parts.length === 3 && parts[2] === "AGENT.md";
      return parts.length === 2 && parts[0] === "agents" && parts[1]!.endsWith(".md") && !parts[1]!.startsWith(".");
    case "harness": {
      // A file on the harness surface inside an adopted layer: harness/active/… or harness/projects/<key>/active/….
      const layer = parts[1] === "active" ? 2 : parts[1] === "projects" && parts.length > 3 && parts[3] === "active" ? 4 : 0;
      return parts[0] === "harness" && layer > 0 && parts.length > layer && surfaceKind(parts.slice(layer).join("/")) !== null;
    }
    default:
      return false;
  }
}

function isEntry(value: unknown): value is LedgerEntry {
  const e = value as Partial<LedgerEntry> | null;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.id === "string" &&
    typeof e.ts === "string" &&
    typeof e.path === "string" &&
    typeof e.action === "string" &&
    (e.before === null || (typeof e.before === "string" && HASH.test(e.before))) &&
    (e.after === null || (typeof e.after === "string" && HASH.test(e.after)))
  );
}

/**
 * The learning ledger: an append-only log of every change to what the agent learned (notes, user
 * profile, skills, identity, daily notes), with content-addressed copies of each version, so the
 * user can see who changed what and undo it. Undo only restores a file that still holds exactly
 * what the entry wrote; anything edited since is left alone.
 */
export class Ledger {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(
    private readonly home: string,
    opts: { now?: () => Date } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  get dir(): string {
    return join(this.home, "learning");
  }

  get file(): string {
    return join(this.dir, "ledger.jsonl");
  }

  private blobPath(hash: string): string {
    return join(this.dir, "blobs", hash);
  }

  /** Stores contents as a blob (once per distinct contents) and returns its hash. */
  private async putBlob(text: string | null): Promise<string | null> {
    if (text === null) return null;
    const hash = sha256(text);
    const path = this.blobPath(hash);
    if (!(await lstat(path).catch(() => null))) {
      await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
      await atomicWrite(path, text);
    }
    return hash;
  }

  private async getBlob(hash: string): Promise<string> {
    const text = await readFile(this.blobPath(hash), "utf8");
    if (sha256(text) !== hash) throw new Error(`blob ${hash} is corrupt`);
    return text;
  }

  private async append(entry: LedgerEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    const { undone: _undone, ...stored } = entry;
    await appendFile(this.file, `${JSON.stringify(stored)}\n`, { mode: FILE_MODE });
  }

  private async readAll(): Promise<LedgerEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: LedgerEntry[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isEntry(parsed)) entries.push(parsed);
      } catch {
        // a torn or hand-mangled line: skip it, keep the rest
      }
    }
    const undone = new Set(entries.flatMap((e) => (e.undoes ? [e.undoes] : [])));
    return entries.map((e) => (undone.has(e.id) ? { ...e, undone: true } : e));
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Records a change. Call it before writing the file: a failed write then leaves an entry undo refuses. */
  record(e: LedgerRecord): Promise<LedgerEntry> {
    return this.serial(async () => {
      const entry: LedgerEntry = {
        id: randomBytes(6).toString("hex"),
        ts: this.now().toISOString(),
        actor: e.actor,
        kind: e.kind,
        path: e.path,
        action: e.action,
        summary: e.summary,
        before: await this.putBlob(e.before),
        after: await this.putBlob(e.after),
        ...(e.undoes ? { undoes: e.undoes } : {}),
        ...(e.configPath ? { configPath: e.configPath } : {}),
        ...(e.noUndo ? { noUndo: e.noUndo } : {}),
      };
      await this.append(entry);
      return entry;
    });
  }

  /** Entries, newest first; `limit` keeps the newest that many. */
  async list(limit?: number): Promise<LedgerEntry[]> {
    const newest = (await this.readAll()).reverse();
    return limit === undefined ? newest : newest.slice(0, Math.max(0, limit));
  }

  /**
   * Reverts one entry and records the undo. With no id: the newest entry not yet undone whose file
   * still holds exactly what it wrote, so an entry stuck behind a hand edit, a curator move or a
   * failed write doesn't block every later one.
   */
  undo(id?: string): Promise<UndoResult> {
    return this.serial(async () => {
      const all = await this.readAll();
      let entry: LedgerEntry | undefined;
      let current: string | null | undefined;
      if (id === undefined) {
        const open = all.filter((e) => e.action !== "undo" && !e.undone).reverse();
        if (open.length === 0) return { ok: false, reason: "Nothing to undo." };
        for (const raw of open) {
          const e = await this.moved(raw);
          if (await this.refusal(e)) continue;
          if (e.kind === "setup") {
            if (await this.setupRefusal(e)) continue;
            entry = e;
            break;
          }
          const now = await readCurrent(resolve(e.path)).catch(() => undefined);
          if (now === undefined || hashOf(now) !== e.after) continue;
          entry = e;
          current = now;
          break;
        }
        if (!entry) {
          return { ok: false, reason: "Nothing to undo: every learned change left was edited, moved or never written since. Undo one by id to see why." };
        }
      } else {
        const found = all.find((e) => e.id === id);
        if (!found) return { ok: false, reason: `No ledger entry ${id}.` };
        entry = await this.moved(found);
        if (entry.action === "undo") return { ok: false, reason: `${entry.id} is itself an undo.` };
        if (entry.undone) return { ok: false, reason: `${entry.id} was already undone.` };
        const refused = await this.refusal(entry);
        if (refused) return { ok: false, reason: refused };
        if (entry.kind === "setup") {
          const why = await this.setupRefusal(entry);
          if (why) return { ok: false, reason: why };
          return this.undoSetup(entry);
        }
        current = await readCurrent(resolve(entry.path));
        if (current === undefined) return { ok: false, reason: `${entry.path} is not a regular file.` };
        if (hashOf(current) !== entry.after) {
          return { ok: false, reason: `${entry.path} changed since ${entry.id}; nothing was undone.` };
        }
      }

      if (entry.kind === "setup") return this.undoSetup(entry);
      const target = resolve(entry.path);
      if (entry.before === null) {
        if (current !== null) await rm(target, { force: true });
        // A skill created from nothing leaves an empty folder behind; drop it (never a skills root).
        if (entry.kind === "skill" && target.endsWith(`${sep}SKILL.md`) && (await this.isSkillFolder(dirname(target)))) {
          await rmdir(dirname(target)).catch(() => {});
        }
        // A specialist created from nothing leaves its folder; drop it when empty (never agents/ itself).
        if (entry.kind === "agent" && target.endsWith(`${sep}AGENT.md`) && (await this.isSpecialistFolder(dirname(target)))) {
          await rmdir(dirname(target)).catch(() => {});
        }
      } else {
        const text = await this.getBlob(entry.before);
        await mkdir(dirname(target), { recursive: true, mode: DIR_MODE });
        await atomicWrite(target, text);
      }

      const undo: LedgerEntry = {
        id: randomBytes(6).toString("hex"),
        ts: this.now().toISOString(),
        actor: "user",
        kind: entry.kind,
        path: entry.path,
        action: "undo",
        summary: `undo ${entry.action}: ${entry.summary}`,
        before: entry.after,
        after: entry.before,
        undoes: entry.id,
      };
      await this.append(undo);
      return { ok: true, entry: { ...entry, undone: true } };
    });
  }

  /** Why a setup entry cannot be undone now, or undefined: it holds no secret, and the value is still what the entry wrote. */
  private async setupRefusal(entry: LedgerEntry): Promise<string | undefined> {
    if (entry.noUndo) return entry.noUndo;
    if (!entry.configPath) return "It does not name a setting; nothing was undone.";
    const file = this.configFileOf(entry);
    if (!file) return `${entry.path} is not a settings file.`;
    try {
      const current = stripAt(entry.configPath, getAt(await readConfigRaw(file), entry.configPath));
      const after: unknown = entry.after === null ? null : JSON.parse(await this.getBlob(entry.after));
      return sameJson(current ?? null, after) ? undefined : SETUP_MOVED;
    } catch {
      return `Couldn't read ${basename(entry.path)}; nothing was undone.`;
    }
  }

  private configFileOf(entry: LedgerEntry) {
    const name = basename(entry.path).replace(/\.json$/, "");
    return name === "settings" || name === "gateway" ? configFile(this.home, name as ConfigFileName) : undefined;
  }

  /** Writes the entry's `before` value back (null removes the key) and records the undo. Call it only after setupRefusal. */
  private async undoSetup(entry: LedgerEntry): Promise<UndoResult> {
    const file = this.configFileOf(entry)!;
    const path = entry.configPath!;
    const before: unknown = entry.before === null ? null : JSON.parse(await this.getBlob(entry.before));
    await updateConfigFile(file, (draft) => (before === null ? unsetAt(draft, path) : setAt(draft, path, before)));
    await this.append({
      id: randomBytes(6).toString("hex"),
      ts: this.now().toISOString(),
      actor: "user",
      kind: "setup",
      path: entry.path,
      configPath: path,
      action: "undo",
      summary: `undo ${entry.action}: ${entry.summary}`,
      before: entry.after,
      after: entry.before,
      undoes: entry.id,
    });
    return { ok: true, entry: { ...entry, undone: true } };
  }

  /**
   * The entry with its path where the file lives now: a change recorded before the layout change names the old place,
   * and the migration has since moved the file.
   */
  private async moved(entry: LedgerEntry): Promise<LedgerEntry> {
    if (await lstat(resolve(entry.path)).then(() => true, () => false)) return entry;
    for (const home of [resolve(this.home), await realpath(this.home).catch(() => this.home)]) {
      // LEGACY_LAYOUT
      const rel = relative(home, resolve(entry.path));
      const now = rel.startsWith("..") ? undefined : legacyToCurrent(rel.split(sep).join("/"));
      if (now === undefined) continue;
      const path = join(home, now);
      if ((await lstat(path).catch(() => null))?.isFile()) return { ...entry, path };
    }
    return entry;
  }

  /** A skill folder directly inside a skills root (not the root itself). */
  private async isSkillFolder(dir: string): Promise<boolean> {
    const homes = [this.home, await realpath(this.home).catch(() => this.home)];
    return homes.some(
      (home) =>
        SKILL_ROOTS.some((root) => dirname(dir) === resolve(home, ...root)) ||
        // agents/<id>/skills/<skill>
        (basename(dirname(dir)) === "skills" && dirname(dirname(dirname(dir))) === resolve(home, "agents") && !basename(dirname(dirname(dir))).startsWith(".")),
    );
  }

  /** A specialist folder directly inside agents/ (not the folder itself, not a dot-folder). */
  private async isSpecialistFolder(dir: string): Promise<boolean> {
    const homes = [this.home, await realpath(this.home).catch(() => this.home)];
    return !basename(dir).startsWith(".") && homes.some((home) => dirname(dir) === resolve(home, "agents"));
  }

  /** Why undo may not touch the entry's file, or undefined: it must be a learned file of its kind, inside the home. */
  private async refusal(entry: LedgerEntry): Promise<string | undefined> {
    const where = await this.checkPath(entry.path);
    if (where) return where;
    const home = await realpath(this.home).catch(() => this.home);
    if (!isLearnedPath(this.home, entry.kind, entry.path) && !isLearnedPath(home, entry.kind, entry.path)) {
      return `${entry.path} is not a learned file; refusing to touch it.`;
    }
    return undefined;
  }

  /** Why `path` may not be touched by undo, or undefined: it must live under the home, through no symlinks. */
  private async checkPath(path: string): Promise<string | undefined> {
    const home = await realpath(this.home).catch(() => this.home);
    const target = resolve(path);
    if (!isInside(target, resolve(this.home)) && !isInside(target, home)) return `${path} is outside ${this.home}; refusing to touch it.`;
    // The deepest existing ancestor must resolve inside the home, so a symlinked folder can't redirect the write.
    let dir = dirname(target);
    for (;;) {
      const real = await realpath(dir).catch(() => null);
      if (real !== null) {
        if (!isInside(real, home)) return `${path} resolves outside ${this.home}; refusing to touch it.`;
        return undefined;
      }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
}

const SETUP_MOVED = "It changed since; nothing was undone.";
const SECRET_NOTE = "It held a secret, which Tropos never copies into the ledger.";

/** `value` (the setting at the dotted `configPath`) without its secrets; stripped in place, so mcpServers.<name> loses its env. */
function stripAt(configPath: string | undefined, value: unknown): unknown {
  if (!configPath) return stripSecrets(value);
  const segments = parsePath(configPath);
  const wrapped = segments.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
  return getAt(stripSecrets(wrapped), segments);
}

/**
 * Records a change to settings.json or gateway.json, one value per entry. The blobs hold the value without secrets;
 * a change that removed or replaced a secret cannot be undone (the old value was never kept).
 */
export async function recordSetupChange(
  ledger: Ledger,
  r: { actor: Actor; path: string; configPath?: string; action: string; summary: string; before?: unknown; after?: unknown; noUndo?: string },
): Promise<LedgerEntry> {
  const blob = (v: unknown): string => JSON.stringify(stripAt(r.configPath, v) ?? null);
  const heldSecret = r.before !== undefined && !sameJson(stripAt(r.configPath, r.before) ?? null, r.before ?? null);
  const noUndo = r.noUndo ?? (heldSecret ? SECRET_NOTE : undefined);
  return ledger.record({
    actor: r.actor,
    kind: "setup",
    path: r.path,
    ...(r.configPath ? { configPath: r.configPath } : {}),
    action: r.action,
    summary: r.summary,
    before: blob(r.before),
    after: blob(r.after),
    ...(noUndo ? { noUndo } : {}),
  });
}

function hashOf(text: string | null): string | null {
  return text === null ? null : sha256(text);
}

/** A file's contents, null when absent, undefined when it is a symlink, directory or other non-file. */
async function readCurrent(path: string): Promise<string | null | undefined> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return null;
  if (!info.isFile()) return undefined;
  return readFile(path, "utf8");
}
