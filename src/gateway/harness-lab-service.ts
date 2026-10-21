// src/gateway/harness-lab-service.ts — the harness lab as a weekly gateway service: when the owner turned it on
// (settings.harness.lab), it replays a few recent sessions of each project through the lab, adopts what measurably
// did better and adds no scripts (when settings.harness.autoAdopt), and tells the owner in one message, with the undo.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadSettings, settingsPaths, type Settings } from "../config/settings";
import { gitRoot } from "../context/memory";
import { labDir } from "../harness/lab";
import { labFromSettings, replayTasks, type LabTaskResult } from "../harness/service";
import type { LabTask } from "../harness/probe";
import type { GatewayService, GatewayServiceDeps } from "./types";

const WEEK_MS = 7 * 24 * 3_600_000;
const CHECK_EVERY_MS = 6 * 3_600_000;
/** Tasks per weekly run, whatever the number of projects: each one runs four times or more. */
const MAX_TASKS = 6;

export interface WeeklyLabSeams {
  /** Runs one task through the lab; the real one builds the runner and the models from settings. */
  runTask?(task: LabTask, settings: Settings, signal: AbortSignal): Promise<LabTaskResult>;
  now?(): Date;
}

function stateFile(home: string): string {
  return join(labDir(home), "weekly.json");
}

async function lastRun(home: string): Promise<number> {
  try {
    const state = JSON.parse(await readFile(stateFile(home), "utf8")) as { lastRun?: string };
    return state.lastRun ? Date.parse(state.lastRun) : 0;
  } catch {
    return 0;
  }
}

/** The owner's message: one line per adopted change with its undo, then what waits for them. */
export function weeklySummary(results: LabTaskResult[]): string | undefined {
  if (results.length === 0) return undefined;
  const adopted = results.filter((r) => r.adopted);
  const waiting = results.filter((r) => !r.adopted && r.run.candidate);
  const cost = results.reduce((sum, r) => sum + (r.run.costUsd ?? 0), 0);
  const lines = [`Harness lab: tested ${results.length} task${results.length === 1 ? "" : "s"} from last week's sessions ($${cost.toFixed(2)}).`];
  for (const r of adopted) lines.push(`Adopted a change that did better on "${r.run.task.title}" (${r.run.verdict.reasons[0] ?? "better"}). Undo: tcode harness revert ${r.adopted!.id}`);
  for (const r of waiting) lines.push(`A change for "${r.run.task.title}" waits for you${r.pending ? ` (${r.pending})` : ""}: tcode harness diff ${r.run.candidate}`);
  if (adopted.length === 0 && waiting.length === 0) lines.push("Nothing did measurably better, so nothing changed.");
  return lines.join("\n");
}

/** The service, and `tick` for running one check now (tests, a "run now" button). */
export type HarnessLabService = GatewayService & { tick(deps: GatewayServiceDeps): Promise<void> };

export function createHarnessLabService(opts: { command: string[]; env: NodeJS.ProcessEnv; everyMs?: number; log?: (m: string) => void } & WeeklyLabSeams): HarnessLabService {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  const controller = new AbortController();

  async function tick(deps: GatewayServiceDeps): Promise<void> {
    if (running) return;
    running = true;
    try {
      // The harness block is the owner's alone (repo layers can't set it), so the home's settings decide.
      const { settings } = await loadSettings(settingsPaths(deps.home, deps.home));
      if (!settings.harness.lab) return;
      if (now().getTime() - (await lastRun(deps.home)) < WEEK_MS) return;
      const tasks: LabTask[] = [];
      for (const project of await deps.projects.list()) {
        if (!gitRoot(project.path)) continue;
        const found = await replayTasks(deps.home, project.path, { recent: settings.harness.tasksPerWeek }).catch((e: unknown) => {
          log(`${project.name}: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        });
        tasks.push(...found);
      }
      // Recorded before running: a crash mid-week must not start the whole week again at the next check.
      await mkdir(dirname(stateFile(deps.home)), { recursive: true, mode: 0o700 });
      await writeFile(stateFile(deps.home), `${JSON.stringify({ lastRun: now().toISOString() })}\n`, { mode: 0o600 });
      const results: LabTaskResult[] = [];
      for (const task of tasks.slice(0, MAX_TASKS)) {
        if (controller.signal.aborted) break;
        try {
          results.push(
            await (opts.runTask
              ? opts.runTask(task, settings, controller.signal)
              : labFromSettings({ home: deps.home, command: opts.command, env: opts.env, settings }, task, { k: 1, autoAdopt: true, signal: controller.signal, log })),
          );
        } catch (e) {
          log(`${task.title}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const summary = weeklySummary(results);
      const owner = await deps.ownerChat?.();
      if (summary && owner) await deps.deliver(owner, summary).catch((e: unknown) => log(`couldn't tell the owner: ${e instanceof Error ? e.message : String(e)}`));
      if (summary) log(summary.replace(/\n/g, " | "));
    } catch (e) {
      log(`failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  }

  return {
    name: "harness-lab",
    tick,
    async start(deps: GatewayServiceDeps) {
      timer = setInterval(() => void tick(deps), opts.everyMs ?? CHECK_EVERY_MS);
      timer.unref();
      // Not at once: a gateway restart shouldn't start a lab before it has settled.
      setTimeout(() => void tick(deps), 60_000).unref();
    },
    async stop() {
      controller.abort();
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
