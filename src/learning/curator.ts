// src/learning/curator.ts
import { lstat, mkdir, readFile, realpath, rename, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { resolveLayoutPath } from "../home/layout";
import { fmBool, parseFrontmatter } from "../extensions/frontmatter";
import { atomicWrite } from "../memory/notes";
import { readRuns } from "../agents/runs";
import { archiveSpecialist } from "../agents/store";
import { AGENT_FILE, loadSpecialists, SPECIALIST_IDLE_MS } from "../agents/specialists";
import { agentLabel } from "../extensions/agents";
import { type Ledger, sha256 } from "./ledger";
import { readSkillUsage } from "./skill-usage";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The curator runs at most this often. */
export const CURATOR_INTERVAL_MS = 7 * DAY_MS;
/** An agent-made skill nobody loaded for this long is archived. */
export const CURATOR_STALE_MS = 30 * DAY_MS;

export interface CuratorResult {
  archived: string[];
  /** Ids of the specialists archived for lack of use, and their labels ("🔍 reviewer"). */
  specialists: string[];
  specialistLabels: string[];
  ran: boolean;
}

function statePath(home: string): string {
  return join(home, "learning", "curator.json");
}

async function lastRun(home: string): Promise<number | undefined> {
  try {
    const state = JSON.parse(await readFile(statePath(home), "utf8")) as { lastRun?: unknown };
    const ms = typeof state.lastRun === "string" ? Date.parse(state.lastRun) : NaN;
    return Number.isNaN(ms) ? undefined : ms;
  } catch {
    return undefined;
  }
}

/** The skill folder a ledger path belongs to and the path inside it, when it lies inside one of `roots`. */
function skillOf(path: string, roots: string[]): { name: string; file: string } | undefined {
  for (const root of roots) {
    const rel = relative(root, path);
    if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) continue;
    const [name, ...rest] = rel.split(sep);
    if (rest.length > 0 && !name!.startsWith(".")) return { name: name!, file: rest.join("/") };
  }
  return undefined;
}

interface AgentSkill {
  /** When the agent created it. */
  createdMs: number;
  /** The SKILL.md hash the ledger last recorded (null: deleted), when it recorded one. */
  lastAfter?: string | null;
}

/**
 * Skills the agent (or the background review) created and the user never took over, with when
 * they were created and the SKILL.md contents the ledger saw last. The ledger is the only proof of
 * authorship: a skill it doesn't know about is the user's, and so is one the user changed after it
 * was created.
 */
async function agentSkills(ledger: Ledger, roots: string[]): Promise<Map<string, AgentSkill>> {
  const created = new Map<string, AgentSkill>();
  const lastAfter = new Map<string, string | null>();
  for (const e of (await ledger.list()).reverse()) {
    if (e.kind !== "skill") continue;
    const skill = skillOf(e.path, roots);
    if (!skill) continue;
    // Undo entries count here: an undone patch puts the older text back.
    if (skill.file === "SKILL.md") lastAfter.set(skill.name, e.after);
    if (e.action === "undo" || e.undone) continue;
    if (e.action === "create" && e.actor !== "user") created.set(skill.name, { createdMs: Date.parse(e.ts) });
    else if (e.action === "delete" || e.actor === "user") created.delete(skill.name);
  }
  for (const [name, skill] of created) {
    if (lastAfter.has(name)) skill.lastAfter = lastAfter.get(name);
  }
  return created;
}

/**
 * Whether the skill in `dir` may be archived: its SKILL.md is readable, not pinned, and still holds
 * exactly what the ledger last recorded for it (anything else is a hand edit, now the user's).
 */
async function archivable(dir: string, lastAfter: string | null | undefined): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(dir, "SKILL.md"), "utf8");
  } catch {
    // unreadable: leave it where it is
    return false;
  }
  if (lastAfter === undefined || sha256(text) !== lastAfter) return false;
  return fmBool(parseFrontmatter(text).data, "pinned") !== true;
}

async function freeName(archive: string, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = join(archive, n === 1 ? base : `${base}-${n}`);
    if (!(await lstat(candidate).catch(() => null))) return candidate;
  }
}

/**
 * Skill hygiene, at most weekly: moves agent-created skills that went unused for 30 days to
 * `<skillsDir>/.archive/<name>-<date>/`. `skillsDir` is where the agent's skills live (default: the workspace's
 * skills-learned folder); usage is always read from the user's skills folder, `.usage.json`, keyed by skill name. It never deletes anything and never touches a
 * skill the user wrote, edited (through a tool or by hand), or pinned (`pinned: true` in its
 * frontmatter).
 */
export async function runCurator(home: string, opts: { ledger: Ledger; now?: Date; skillsDir?: string }): Promise<CuratorResult> {
  const now = opts.now ?? new Date();
  const last = await lastRun(home);
  if (last !== undefined && now.getTime() - last < CURATOR_INTERVAL_MS && now.getTime() >= last) return { archived: [], specialists: [], specialistLabels: [], ran: false };

  const skillsDir = opts.skillsDir ?? resolveLayoutPath(home, "skills-learned");
  const roots = [...new Set([skillsDir, await realpath(skillsDir).catch(() => skillsDir)])];
  const archived: string[] = [];
  let idle: { ids: string[]; labels: string[] } = { ids: [], labels: [] };
  try {
    const candidates = await agentSkills(opts.ledger, roots);
    const usage = await readSkillUsage(home);
    const archive = join(skillsDir, ".archive");
    const date = now.toISOString().slice(0, 10);
    for (const [name, { createdMs, lastAfter }] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
      const used = Date.parse(usage[name]?.lastUsed ?? "");
      const lastTouched = Math.max(Number.isNaN(createdMs) ? 0 : createdMs, Number.isNaN(used) ? 0 : used);
      if (now.getTime() - lastTouched < CURATOR_STALE_MS) continue;
      const dir = join(skillsDir, name);
      // A symlinked folder isn't the agent's to move.
      if (!(await lstat(dir).catch(() => null))?.isDirectory()) continue;
      if (!(await archivable(dir, lastAfter))) continue;
      try {
        await mkdir(archive, { recursive: true, mode: 0o700 });
        await rename(dir, await freeName(archive, `${name}-${date}`));
        archived.push(name);
      } catch {
        // leave this one in place; the next run tries again
      }
    }
    idle = await archiveIdleSpecialists(home, now, opts.ledger);
  } finally {
    await mkdir(join(home, "learning"), { recursive: true, mode: 0o700 });
    await atomicWrite(statePath(home), `${JSON.stringify({ lastRun: now.toISOString() })}\n`);
  }
  return { archived, specialists: idle.ids, specialistLabels: idle.labels, ran: true };
}

/**
 * Archives specialists unused for 60 days (the newest of: creation, last delegation, last edit of AGENT.md) into
 * agents/.archive/, folder and memory intact, with a ledger entry so it can be undone. A paused one counts too.
 * One that can't be moved stays where it is.
 */
export async function archiveIdleSpecialists(home: string, now: Date, ledger: Ledger): Promise<{ ids: string[]; labels: string[] }> {
  const out = { ids: [] as string[], labels: [] as string[] };
  for (const spec of (await loadSpecialists(home).catch(() => [])).filter((s) => !s.archived)) {
    try {
      const runs = await readRuns(home, { agent: spec.id });
      const lastRun = Math.max(0, ...runs.map((r) => Date.parse(r.ts) || 0));
      const edited = (await stat(join(spec.dir, AGENT_FILE))).mtimeMs;
      const lastUse = Math.max(spec.createdAt, lastRun, edited);
      if (now.getTime() - lastUse < SPECIALIST_IDLE_MS) continue;
      await archiveSpecialist(home, spec.id, { ledger, actor: "review", now });
      out.ids.push(spec.id);
      out.labels.push(agentLabel(spec));
    } catch {
      // leave this one in place; the next run tries again
    }
  }
  return out;
}
