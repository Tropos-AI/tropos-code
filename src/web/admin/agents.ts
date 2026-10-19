// src/web/admin/agents.ts — `agents.*`: the dashboard's roster of the chief and its specialists. The dashboard is an
// owner surface, so every edit here is the owner's ("user" actor), ledgered and undoable like any other specialist write.
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { readRuns } from "../../agents/runs";
import { loadSpecialists, AGENT_FILE, MAX_ACTIVE_SPECIALISTS, SPECIALIST_ID, type Specialist } from "../../agents/specialists";
import {
  archiveSpecialist,
  restoreSpecialist,
  SpecialistError,
  undoSpecialist,
  updateSpecialist,
  type SpecialistChange,
} from "../../agents/store";
import { DEFAULT_MODEL } from "../../config/constants";
import { readUserSettingsRaw } from "../../config/store";
import { loadIdentity } from "../../context/identity";
import { Ledger, sha256 } from "../../learning/ledger";
import type { AgentRoster, SpecialistEdit, SpecialistView } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";

const RUNS_SHOWN = 5;

async function folderNames(dir: string, wantDirs: boolean): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: string[] = [];
  for (const name of names.sort()) {
    const info = await lstat(join(dir, name)).catch(() => null);
    if (info && !info.isSymbolicLink() && info.isDirectory() === wantDirs) out.push(name);
  }
  return out;
}

async function revisionsOf(spec: Specialist): Promise<SpecialistView["revisions"]> {
  const dir = join(spec.dir, "revisions");
  const out: SpecialistView["revisions"] = [];
  for (const name of await folderNames(dir, false)) {
    const m = /^(\d+)\.md$/.exec(name);
    const info = m ? await lstat(join(dir, name)).catch(() => null) : null;
    if (m && info) out.push({ revision: Number(m[1]), savedAt: info.mtimeMs });
  }
  return out.sort((a, b) => b.revision - a.revision);
}

async function viewOf(ctx: AdminContext, ledger: Ledger, spec: Specialist): Promise<SpecialistView> {
  const file = join(spec.dir, AGENT_FILE);
  const [runs, skills, memory, revisions] = await Promise.all([
    readRuns(ctx.home, { agent: spec.id, limit: RUNS_SHOWN }),
    folderNames(join(spec.dir, "skills"), true),
    readFile(join(spec.dir, "MEMORY.md"), "utf8").catch(() => ""),
    revisionsOf(spec),
  ]);
  let undoable: SpecialistView["undoable"];
  if (!spec.archived) {
    const current = await readFile(file, "utf8").catch(() => null);
    const entry = (await ledger.list()).find((e) => e.kind === "agent" && e.action !== "undo" && !e.undone && e.path === file);
    if (entry && current !== null && entry.after === sha256(current)) undoable = { summary: entry.summary };
  }
  return {
    id: spec.id,
    name: spec.name,
    ...(spec.emoji ? { emoji: spec.emoji } : {}),
    description: spec.description,
    contract: spec.prompt,
    ...(spec.model ? { model: spec.model } : {}),
    tools: spec.tools ?? null,
    ...(spec.autonomy ? { autonomy: spec.autonomy } : {}),
    createdBy: spec.createdBy,
    createdAt: spec.createdAt,
    revision: spec.revision,
    paused: spec.paused === true,
    archived: spec.archived === true,
    ...(spec.archived ? { archivedDir: basename(spec.dir) } : {}),
    skills,
    memoryChars: memory.length,
    runs: runs.map((r) => ({ ts: r.ts, task: r.task, ok: r.ok, result: r.result, durationMs: r.durationMs, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) })),
    revisions,
    ...(undoable ? { undoable } : {}),
  };
}

export function agentsHandlers(ctx: AdminContext): AdminHandlers {
  const ledger = new Ledger(ctx.home);

  const roster = async (): Promise<AgentRoster> => {
    const [identity, settings, all] = await Promise.all([loadIdentity(ctx.home), readUserSettingsRaw(ctx.home).catch((): Record<string, unknown> => ({})), loadSpecialists(ctx.home)]);
    const views = await Promise.all(all.map((s) => viewOf(ctx, ledger, s)));
    const model = typeof settings.model === "string" && settings.model ? settings.model : DEFAULT_MODEL;
    return {
      chief: { name: identity.name ?? "Tropos", ...(identity.emoji ? { emoji: identity.emoji } : {}), model },
      specialists: views.filter((v) => !v.archived),
      archived: views.filter((v) => v.archived),
      limit: MAX_ACTIVE_SPECIALISTS,
    };
  };

  /** Store errors are written for the owner; anything else is reported generically by the dispatcher. */
  const act = async (work: () => Promise<unknown>): Promise<AgentRoster> => {
    try {
      await work();
    } catch (err) {
      throw err instanceof SpecialistError ? new AdminError(err.message) : err;
    }
    return roster();
  };
  const idOf = (id: unknown): string => {
    if (typeof id !== "string" || !SPECIALIST_ID.test(id)) throw new AdminError("That isn't a specialist name.");
    return id;
  };
  const opts = { ledger, actor: "user" as const };

  const change = (c: SpecialistEdit): SpecialistChange => {
    const { contract, ...rest } = c;
    return { ...rest, ...(contract !== undefined ? { prompt: contract } : {}) };
  };

  return {
    "agents.roster": () => roster(),
    "agents.update": (p) => {
      if (!Number.isInteger(p?.revision) || typeof p.changes !== "object" || p.changes === null) throw new AdminError("Nothing to change.");
      return act(() => updateSpecialist(ctx.home, idOf(p.id), change(p.changes), { ...opts, expectedRevision: p.revision }));
    },
    "agents.setPaused": (p) => act(() => updateSpecialist(ctx.home, idOf(p?.id), { paused: p.paused === true }, opts)),
    "agents.archive": (p) => act(() => archiveSpecialist(ctx.home, idOf(p?.id), { ...opts, now: new Date(ctx.now()) })),
    "agents.restore": (p) => act(() => restoreSpecialist(ctx.home, typeof p?.dir === "string" ? p.dir : "", opts)),
    "agents.undo": (p) =>
      act(async () => {
        const id = idOf(p?.id);
        const out = await undoSpecialist(ctx.home, id, ledger);
        if (!out.ok) throw new AdminError(out.reason);
      }),
  };
}
