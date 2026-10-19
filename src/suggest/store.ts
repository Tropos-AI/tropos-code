// src/suggest/store.ts — what was suggested to the owner and what they said: learning/suggestions.json. A suggestion
// the owner declined (or took) never comes back; one only mentioned waits a week; a pinned test run's result is kept
// so a failing suite can be raised.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { markReminded } from "../onboard/reminders";
import type { OnboardStepId } from "../web/admin/api";

export interface SuggestionState {
  /** Signal id to the time it was declined or accepted. */
  declined: Record<string, number>;
  /** Signal id to the time it was last mentioned. */
  mentioned: Record<string, number>;
  /** Per project: the last run of one of its pinned test commands. */
  tests: Record<string, { ok: boolean; at: number; command: string }>;
}

export type SuggestionOutcome = "mentioned" | "declined" | "accepted";

const SETUP_PREFIX = "setup:";

const times = (v: unknown): Record<string, number> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])));
};

function parse(raw: unknown): SuggestionState {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const tests: SuggestionState["tests"] = {};
  if (o.tests && typeof o.tests === "object" && !Array.isArray(o.tests)) {
    for (const [id, t] of Object.entries(o.tests)) {
      const r = t as { ok?: unknown; at?: unknown; command?: unknown } | null;
      if (r && typeof r.ok === "boolean" && typeof r.at === "number" && typeof r.command === "string") tests[id] = { ok: r.ok, at: r.at, command: r.command };
    }
  }
  return { declined: times(o.declined), mentioned: times(o.mentioned), tests };
}

export class SuggestionStore {
  private readonly path: string;
  /** Writes in this process take turns, so two marks never read the same old file. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly home: string) {
    this.path = join(home, "learning", "suggestions.json");
  }

  async read(): Promise<SuggestionState> {
    try {
      return parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      return { declined: {}, mentioned: {}, tests: {} };
    }
  }

  private update(change: (s: SuggestionState) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const state = await this.read();
      change(state);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.path);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async mark(id: string, outcome: SuggestionOutcome, now: number = Date.now()): Promise<void> {
    await this.update((s) => {
      if (outcome === "mentioned") s.mentioned[id] = now;
      else s.declined[id] = now; // taking a suggestion is done with it, like saying no
    });
    // The onboarding `reminded` list stays the one record of a setup step being raised, so a step is never raised twice.
    if (id.startsWith(SETUP_PREFIX)) await markReminded(this.home, id.slice(SETUP_PREFIX.length) as OnboardStepId);
  }

  recordTest(projectId: string, command: string, ok: boolean, now: number = Date.now()): Promise<void> {
    return this.update((s) => {
      s.tests[projectId] = { ok, at: now, command };
    });
  }
}
