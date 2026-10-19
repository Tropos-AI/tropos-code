// src/agents/store.ts
import { lstat, mkdir, readdir, readFile, rename, rm, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import { BUILTIN_AGENTS, agentLabel } from "../extensions/agents";
import type { Autonomy } from "../gateway/config";
import { sha256, type Ledger, type UndoResult } from "../learning/ledger";
import { agentsDir } from "../paths";
import { writeFileNoFollow } from "../tools/file-guard";
import type { Actor } from "../tools/types";
import {
  AGENT_FILE,
  ARCHIVE_DIR,
  fieldsProblem,
  loadSpecialists,
  MAX_ACTIVE_SPECIALISTS,
  MAX_ID_CHARS,
  parseSpecialistFile,
  renderSpecialistFile,
  SPECIALIST_ID,
  type Specialist,
  type SpecialistFields,
} from "./specialists";

export class SpecialistError extends Error {}

export const ROLE_CONTRACT_SECTIONS = ["## Purpose", "## Not my job", "## Report", "## Escalate when"] as const;
export const ROLE_CONTRACT_TEMPLATE = [
  "## Purpose\n<one line: the work this specialist owns>",
  "## Not my job\n<what it leaves to the chief or to others>",
  "## Report\n<what its final report contains>",
  "## Escalate when\n<when it stops and hands back to the chief>",
].join("\n");

export interface SpecialistInput {
  id: string;
  description: string;
  prompt: string;
  emoji?: string;
  model?: string;
  tools?: string[];
  autonomy?: Autonomy;
}

/** `null` unsets a field. */
export type SpecialistChange = {
  description?: string;
  prompt?: string;
  emoji?: string | null;
  model?: string | null;
  tools?: string[] | null;
  autonomy?: Autonomy | null;
  paused?: boolean;
};

export function createdByFor(actor: Actor): Specialist["createdBy"] {
  return actor === "agent" ? "chief" : actor === "review" ? "review" : "user";
}

const CONTRACT_PROBLEM = `prompt must be a role contract with the sections ${ROLE_CONTRACT_SECTIONS.slice(0, -1).join(", ")} and ${ROLE_CONTRACT_SECTIONS.at(-1)}.`;

function hasContract(prompt: string): boolean {
  return ROLE_CONTRACT_SECTIONS.every((h) => new RegExp(`^${h}[ \\t]*$`, "m").test(prompt));
}

const fileOf = (home: string, id: string): string => join(agentsDir(home), id, AGENT_FILE);
const exists = async (path: string): Promise<boolean> => (await lstat(path).catch(() => null)) !== null;

function checkId(id: string): void {
  if (!SPECIALIST_ID.test(id) || id.length > MAX_ID_CHARS) {
    throw new SpecialistError(`"${id}" is not a valid name: use kebab-case (lowercase letters, digits, single hyphens), at most ${MAX_ID_CHARS} characters.`);
  }
}

async function activeSpecialists(home: string): Promise<Specialist[]> {
  return (await loadSpecialists(home)).filter((s) => !s.archived);
}

function checkRoom(active: Specialist[]): void {
  if (active.length >= MAX_ACTIVE_SPECIALISTS) {
    throw new SpecialistError(
      `${MAX_ACTIVE_SPECIALISTS} specialists are active, the limit. Archive one or fold this role into the closest one first: ${active.map((s) => s.id).join(", ")}.`,
    );
  }
}

async function checkFree(home: string, id: string): Promise<void> {
  if (BUILTIN_AGENTS.some((b) => b.name === id)) throw new SpecialistError(`${id} is a built-in agent; pick another name.`);
  // Any entry of that name counts, a symlink included: nothing is ever written through one.
  if ((await exists(join(agentsDir(home), `${id}.md`))) || (await exists(join(agentsDir(home), id)))) {
    throw new SpecialistError(`An agent named ${id} already exists.`);
  }
}

function summaryLabel(s: Pick<Specialist, "id" | "emoji">): string {
  return agentLabel({ name: s.id, emoji: s.emoji });
}

export async function createSpecialist(home: string, input: SpecialistInput, opts: { ledger: Ledger; actor: Actor; now?: Date }): Promise<Specialist> {
  checkId(input.id);
  await checkFree(home, input.id);
  const why = fieldsProblem(input);
  if (why) throw new SpecialistError(why);
  if (opts.actor !== "user" && !hasContract(input.prompt)) throw new SpecialistError(CONTRACT_PROBLEM);
  checkRoom(await activeSpecialists(home));
  const fields: SpecialistFields = {
    name: input.id,
    description: input.description.trim(),
    prompt: input.prompt,
    ...(input.emoji ? { emoji: input.emoji.trim() } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
    ...(input.autonomy ? { autonomy: input.autonomy } : {}),
    createdBy: createdByFor(opts.actor),
    createdAt: (opts.now ?? new Date()).getTime(),
    revision: 1,
  };
  const text = renderSpecialistFile(fields);
  const dir = join(agentsDir(home), input.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await opts.ledger.record({
    actor: opts.actor,
    kind: "agent",
    path: fileOf(home, input.id),
    action: "create",
    summary: `created specialist ${summaryLabel({ id: input.id, emoji: fields.emoji })} — ${fields.description}`,
    before: null,
    after: text,
  });
  await writeFileNoFollow(fileOf(home, input.id), text);
  const made = parseSpecialistFile(input.id, dir, text);
  if (typeof made === "string") throw new SpecialistError(made);
  return made;
}

const CONTENT_FIELDS = ["description", "prompt", "emoji", "model", "tools", "autonomy"] as const;

export async function updateSpecialist(
  home: string,
  id: string,
  change: SpecialistChange,
  opts: { ledger: Ledger; actor: Actor; expectedRevision?: number },
): Promise<Specialist> {
  checkId(id);
  const current = (await activeSpecialists(home)).find((s) => s.id === id);
  if (!current) throw new SpecialistError(`No specialist named ${id}.`);
  if (opts.expectedRevision !== undefined && opts.expectedRevision !== current.revision) {
    throw new SpecialistError(`${id} changed since you opened it (now revision ${current.revision}); reload and try again.`);
  }
  const next: Record<string, unknown> = { ...current };
  for (const key of CONTENT_FIELDS) {
    const value = change[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = key === "description" || key === "emoji" ? (value as string).trim() : value;
  }
  const merged = next as unknown as Specialist;
  const why = fieldsProblem(merged);
  if (why) throw new SpecialistError(why);
  if (change.prompt !== undefined && opts.actor !== "user" && !hasContract(merged.prompt)) throw new SpecialistError(CONTRACT_PROBLEM);
  const changed: string[] = CONTENT_FIELDS.filter((k) => JSON.stringify(current[k]) !== JSON.stringify(merged[k]));
  const pausedNow = change.paused ?? (current.paused === true);
  const pauseChanged = pausedNow !== (current.paused === true);
  if (changed.length === 0 && !pauseChanged) return current;

  const file = fileOf(home, id);
  const before = await readFile(file, "utf8");
  const revision = changed.length > 0 ? current.revision + 1 : current.revision;
  const after = renderSpecialistFile({ ...merged, revision, paused: pausedNow || undefined });
  const label = summaryLabel(merged);
  const summary =
    changed.length === 0 ? `${pausedNow ? "paused" : "resumed"} specialist ${label}` : `updated specialist ${label}: ${[...changed, ...(pauseChanged ? ["paused"] : [])].join(", ")}`;
  if (changed.length > 0) {
    await mkdir(join(current.dir, "revisions"), { recursive: true, mode: 0o700 });
    await writeFileNoFollow(join(current.dir, "revisions", `${current.revision}.md`), before);
  }
  await opts.ledger.record({ actor: opts.actor, kind: "agent", path: file, action: "update", summary, before, after });
  await writeFileNoFollow(file, after);
  const saved = parseSpecialistFile(id, current.dir, after);
  if (typeof saved === "string") throw new SpecialistError(saved);
  return saved;
}

async function freeName(archive: string, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = join(archive, n === 1 ? base : `${base}-${n}`);
    if (!(await exists(candidate))) return candidate;
  }
}

/** Moves the folder into .archive/<id>-<date>; returns that folder. Recorded in the ledger like any other write. */
export async function archiveSpecialist(home: string, id: string, opts: { ledger: Ledger; actor: Actor; now?: Date }): Promise<string> {
  checkId(id);
  const current = (await activeSpecialists(home)).find((s) => s.id === id);
  if (!current) throw new SpecialistError(`No specialist named ${id}.`);
  const archive = join(agentsDir(home), ARCHIVE_DIR);
  if ((await lstat(archive).catch(() => null))?.isSymbolicLink()) throw new SpecialistError("The archive folder is a symlink; fix that by hand first.");
  await mkdir(archive, { recursive: true, mode: 0o700 });
  const target = await freeName(archive, `${id}-${(opts.now ?? new Date()).toISOString().slice(0, 10)}`);
  const text = await readFile(fileOf(home, id), "utf8");
  await opts.ledger.record({ actor: opts.actor, kind: "agent", path: fileOf(home, id), action: "archive", summary: `archived specialist ${summaryLabel(current)}`, before: text, after: null });
  await rename(current.dir, target);
  return target;
}

/** `archivedDir` is the folder name inside .archive. */
export async function restoreSpecialist(home: string, archivedDir: string, opts: { ledger: Ledger; actor: Actor }): Promise<Specialist> {
  if (archivedDir === "" || archivedDir === "." || archivedDir === ".." || archivedDir !== basename(archivedDir) || archivedDir.includes("\\")) {
    throw new SpecialistError(`"${archivedDir}" is not an archived specialist folder.`);
  }
  const all = await loadSpecialists(home);
  const found = all.find((s) => s.archived && basename(s.dir) === archivedDir);
  if (!found) throw new SpecialistError(`No archived specialist ${archivedDir}.`);
  await checkFree(home, found.id);
  checkRoom(all.filter((s) => !s.archived));
  const text = await readFile(join(found.dir, AGENT_FILE), "utf8");
  const dest = join(agentsDir(home), found.id);
  await opts.ledger.record({ actor: opts.actor, kind: "agent", path: fileOf(home, found.id), action: "restore", summary: `restored specialist ${summaryLabel(found)}`, before: null, after: text });
  await rename(found.dir, dest);
  // A restore is use: the idle clock starts again.
  const now = new Date();
  await utimes(join(dest, AGENT_FILE), now, now).catch(() => {});
  const restored = parseSpecialistFile(found.id, dest, text);
  if (typeof restored === "string") throw new SpecialistError(restored);
  return restored;
}

/** The archive folder whose AGENT.md hashes to `hash` (a ledger entry's before/after), newest name first. */
async function archivedWith(home: string, hash: string | null): Promise<string | undefined> {
  const archive = join(agentsDir(home), ARCHIVE_DIR);
  const names = (await readdir(archive).catch(() => [] as string[])).sort().reverse();
  for (const name of names) {
    const body = await readFile(join(archive, name, AGENT_FILE), "utf8").catch(() => null);
    if (body !== null && sha256(body) === hash) return join(archive, name);
  }
  return undefined;
}

/** Reverts the newest not-undone ledger entry for the specialist's AGENT.md; an archive or restore moves the whole folder back. */
export async function undoSpecialist(home: string, id: string, ledger: Ledger): Promise<UndoResult> {
  const file = fileOf(home, id);
  const entry = (await ledger.list()).find((e) => e.kind === "agent" && e.action !== "undo" && !e.undone && e.path === file);
  if (!entry) return { ok: false, reason: `Nothing to undo for ${id}.` };
  const dir = join(agentsDir(home), id);

  if (entry.action === "archive") {
    const archived = await archivedWith(home, entry.before);
    const res = await ledger.undo(entry.id);
    if (!res.ok || !archived) return res;
    // The ledger put AGENT.md back; bring the rest of the folder with it.
    for (const name of await readdir(archived)) {
      if (name !== AGENT_FILE && !(await exists(join(dir, name)))) await rename(join(archived, name), join(dir, name));
    }
    await rm(archived, { recursive: true, force: true });
    return res;
  }

  if (entry.action === "restore") {
    const text = await readFile(file, "utf8").catch(() => null);
    const res = await ledger.undo(entry.id);
    if (!res.ok || text === null) return res;
    const archive = join(agentsDir(home), ARCHIVE_DIR);
    await mkdir(archive, { recursive: true, mode: 0o700 });
    const target = await freeName(archive, `${id}-${new Date().toISOString().slice(0, 10)}`);
    await rename(dir, target);
    await writeFileNoFollow(join(target, AGENT_FILE), text);
    return res;
  }

  return ledger.undo(entry.id);
}
