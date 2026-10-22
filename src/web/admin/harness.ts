// src/web/admin/harness.ts — `harness.*`: the Harness page. What every project's sessions run with (the built-in base and
// the adopted global layer), the candidates the lab left with their evidence, the lab's runs, the library, and the
// owner's switches. Adopting and reverting go through the ledger like any learned change.
import { readdir } from "node:fs/promises";
import { loadSettings, settingsPaths } from "../../config/settings";
import { configFile, setAt, unsetAt, updateConfigFile } from "../../config/store";
import { BASE_TREE } from "../../harness/base";
import { adoptCandidate, candidateRunsCode, discardCandidate, layerDir, listCandidates, readCandidate, revertCandidate, type Candidate } from "../../harness/candidates";
import { DOMAINS } from "../../harness/domain";
import { labDir, readLabRun } from "../../harness/lab";
import { entryLessons, listEntries } from "../../harness/library";
import { ALWAYS_ON_CHARS } from "../../harness/surface";
import { assembleSystem, globalHarnessDir, overlay, readLayer, renderTreeDiff, validateTree } from "../../harness/tree";
import { Ledger } from "../../learning/ledger";
import type { HarnessCandidateView, HarnessOverview, HarnessRunView, HarnessSettingsView } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";

const RUNS_SHOWN = 20;

function candidateView(c: Candidate): HarnessCandidateView {
  return {
    id: c.id,
    createdAt: c.createdAt,
    source: c.source,
    scope: c.scope,
    ...(c.project ? { project: c.project } : {}),
    domain: c.domain,
    task: c.task.title,
    files: Object.entries(c.changes).map(([path, value]) => ({ path, change: value === null ? "remove" : "write" })),
    ...(c.verdict ? { verdict: c.verdict } : {}),
    rationale: c.rationale,
    decisions: c.decisions ?? [],
    status: c.status,
    runsCode: candidateRunsCode(c),
  };
}

function idOf(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(value)) throw new AdminError("That isn't a harness candidate.");
  return value;
}

const SETTING_KEYS = ["lab", "autoAdopt", "tasksPerWeek", "editorModel", "lessons", "suggest"] as const;

export async function harnessOverview(home: string): Promise<HarnessOverview> {
  const global = await readLayer(globalHarnessDir(home));
  const broken = global.tree.size > 0 ? validateTree(overlay(BASE_TREE, global.tree)) : [];
  const tree = broken.length === 0 ? overlay(BASE_TREE, global.tree) : BASE_TREE;
  const ids = (await readdir(labDir(home)).catch(() => [] as string[])).filter((id) => /^[0-9]{8}-/.test(id)).sort().reverse().slice(0, RUNS_SHOWN);
  const runs: HarnessRunView[] = [];
  for (const id of ids) {
    const run = await readLabRun(home, id);
    if (!run) continue;
    runs.push({
      id: run.id,
      startedAt: run.startedAt,
      task: run.task.title,
      outcome: run.verdict.outcome,
      reasons: run.verdict.reasons,
      runs: run.probes.length,
      costUsd: run.costUsd,
      ...(run.candidate ? { candidate: run.candidate } : {}),
    });
  }
  const library: HarnessOverview["library"] = [];
  for (const domain of DOMAINS) {
    const entries = await listEntries(home, domain);
    if (entries.length === 0) continue;
    const lessons = (await Promise.all(entries.map((e) => entryLessons(home, domain, e.id)))).reduce((n, l) => n + l.length, 0);
    library.push({ domain, entries: entries.length, lessons });
  }
  const { settings } = await loadSettings(settingsPaths(home, home));
  return {
    layers: [
      { name: "base", files: [...BASE_TREE.keys()], applied: true, problems: [] },
      { name: "global", dir: globalHarnessDir(home), files: [...global.tree.keys()], applied: broken.length === 0, problems: [...global.problems, ...broken] },
    ],
    alwaysOnChars: assembleSystem(tree).length,
    alwaysOnLimit: ALWAYS_ON_CHARS,
    candidates: (await listCandidates(home)).map(candidateView),
    runs,
    library,
    settings: settings.harness,
  };
}

export function harnessHandlers(ctx: AdminContext): AdminHandlers {
  const ledger = () => new Ledger(ctx.home);
  const settle = async (result: { ok: true } | { ok: false; reason: string }): Promise<HarnessOverview> => {
    if (!result.ok) throw new AdminError(result.reason);
    return harnessOverview(ctx.home);
  };
  return {
    "harness.overview": () => harnessOverview(ctx.home),

    async "harness.diff"(p) {
      const c = await readCandidate(ctx.home, idOf(p?.id));
      if (!c) throw new AdminError("That candidate isn't there any more.");
      const layer = (await readLayer(layerDir(ctx.home, c))).tree;
      const next = new Map(layer);
      for (const [path, value] of Object.entries(c.changes)) {
        if (value === null) next.delete(path);
        else next.set(path, value);
      }
      return { patch: renderTreeDiff(layer, next) };
    },

    async "harness.adopt"(p) {
      return settle(await adoptCandidate(ctx.home, idOf(p?.id), { ledger: ledger(), actor: "user", allowCode: p?.allowCode === true }));
    },

    async "harness.revert"(p) {
      return settle(await revertCandidate(ctx.home, idOf(p?.id), ledger()));
    },

    async "harness.discard"(p) {
      return settle(await discardCandidate(ctx.home, idOf(p?.id)));
    },

    async "harness.settings"(p) {
      const changes = Object.entries(p ?? {}).filter(([key]) => (SETTING_KEYS as readonly string[]).includes(key)) as [keyof HarnessSettingsView, unknown][];
      if (changes.length === 0) throw new AdminError("Say which harness setting to change.");
      try {
        await updateConfigFile(configFile(ctx.home, "settings"), (draft) => {
          let next = draft;
          for (const [key, value] of changes) next = value === null || value === "" ? unsetAt(next, ["harness", key]) : setAt(next, ["harness", key], value);
          return next;
        });
      } catch (err) {
        // The schema's own message names the field and the limit (tasksPerWeek 1–10, …).
        throw new AdminError(err instanceof Error ? err.message.replace(/^Refusing to write [^:]+: /, "") : String(err));
      }
      return harnessOverview(ctx.home);
    },
  };
}
