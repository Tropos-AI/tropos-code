// src/web/admin/usage.ts — `usage.summary`: tokens and cost per day/model/session from the stored sessions.
// A session file is a JSONL of {type:"meta"|"message"|"event", ts}. The usage of a reply is read from the message
// itself (`usage`, `model`) or from an event line named "usage" ({model, usage}); a reply with neither counts as a
// turn with no known tokens, and a bucket holding one has no cost rather than a wrong one.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { contextTokens, messageCostUsd } from "../../api/pricing";
import type { UsageDay, UsageSummary } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";

interface Turn {
  ts: number;
  model: string;
  input: number;
  output: number;
  /** Undefined: no usage was recorded, or the model has no price. */
  cost?: number;
  hasUsage: boolean;
}

interface ParsedSession {
  id: string;
  title: string;
  project: string;
  turns: Turn[];
}

const MAX_LINE_CHARS = 8 * 1024 * 1024;
const DAY_MS = 86_400_000;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function turnOf(ts: number, model: unknown, usage: unknown): Turn {
  if (!isObject(usage)) return { ts, model: typeof model === "string" ? model : "unknown", input: 0, output: 0, hasUsage: false };
  const name = typeof model === "string" && model ? model : "unknown";
  const u = {
    input_tokens: num(usage.input_tokens),
    output_tokens: num(usage.output_tokens),
    cache_read_input_tokens: num(usage.cache_read_input_tokens),
    cache_creation_input_tokens: num(usage.cache_creation_input_tokens),
    ...(typeof usage.cost_usd === "number" ? { cost_usd: usage.cost_usd } : {}),
  };
  return { ts, model: name, input: contextTokens(u), output: u.output_tokens, cost: messageCostUsd({ model: name, usage: u }, name), hasUsage: true };
}

/** A readable project name: the working directory's last part, else the dir key without its hash. */
function projectName(dirKey: string, cwd: unknown): string {
  if (typeof cwd === "string" && cwd) return basename(cwd.replace(/[\\/]+$/, "")) || cwd;
  const readable = dirKey.replace(/-[0-9a-f]{12}$/, "");
  return readable.split("-").filter(Boolean).at(-1) ?? readable;
}

/** Streams one file line by line; unreadable or corrupt lines are skipped. */
async function parseFile(path: string, dirKey: string): Promise<ParsedSession> {
  const session: ParsedSession = { id: basename(path, ".jsonl"), title: "(untitled)", project: projectName(dirKey, undefined), turns: [] };
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      if (!raw || raw.length > MAX_LINE_CHARS) continue;
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isObject(line)) continue;
      if (line.type === "meta") {
        if (typeof line.sessionId === "string") session.id = line.sessionId;
        if (typeof line.title === "string" && line.title) session.title = line.title;
        if (typeof line.cwd === "string") session.project = projectName(dirKey, line.cwd);
        continue;
      }
      const ts = typeof line.ts === "string" ? Date.parse(line.ts) : NaN;
      if (Number.isNaN(ts)) continue;
      if (line.type === "message" && isObject(line.message) && line.message.role === "assistant") {
        session.turns.push(turnOf(ts, line.message.model, line.message.usage));
      } else if (line.type === "event" && line.name === "usage" && isObject(line.value)) {
        session.turns.push(turnOf(ts, line.value.model, line.value.usage));
      }
    }
  } finally {
    rl.close();
  }
  return session;
}

interface Bucket {
  input: number;
  output: number;
  cost: number;
  unknownCost: boolean;
}
const emptyBucket = (): Bucket => ({ input: 0, output: 0, cost: 0, unknownCost: false });
function add(b: Bucket, t: Turn): void {
  b.input += t.input;
  b.output += t.output;
  if (t.cost === undefined) b.unknownCost = true;
  else b.cost += t.cost;
}
const costOf = (b: Bucket): number | undefined => (b.unknownCost ? undefined : b.cost);

export function usageHandlers(ctx: AdminContext): AdminHandlers {
  // Keyed by path; valid while the file's mtime and size are unchanged, so repeated calls only read what changed.
  const cache = new Map<string, { mtimeMs: number; size: number; session: ParsedSession }>();

  async function sessions(): Promise<{ session: ParsedSession; updatedAt: number }[]> {
    const root = join(ctx.home, "projects");
    const out: { session: ParsedSession; updatedAt: number }[] = [];
    const seen = new Set<string>();
    for (const dirKey of await readdir(root).catch(() => [] as string[])) {
      for (const name of await readdir(join(root, dirKey)).catch(() => [] as string[])) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(root, dirKey, name);
        const st = await stat(path).catch(() => null);
        if (!st?.isFile()) continue;
        seen.add(path);
        let hit = cache.get(path);
        if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
          const session = await parseFile(path, dirKey).catch(() => null);
          if (!session) continue;
          hit = { mtimeMs: st.mtimeMs, size: st.size, session };
          cache.set(path, hit);
        }
        out.push({ session: hit.session, updatedAt: st.mtimeMs });
      }
    }
    for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
    return out;
  }

  return {
    async "usage.summary"(params) {
      const days = params?.days;
      if (days !== 7 && days !== 30 && days !== 90) throw new AdminError("Choose 7, 30 or 90 days.");
      const since = ctx.now() - days * DAY_MS;
      const total = emptyBucket();
      const byDay = new Map<string, { b: Bucket; sessions: Set<string> }>();
      const byModel = new Map<string, Bucket>();
      const ranked: { id: string; title: string; project: string; updatedAt: string; bucket: Bucket }[] = [];
      let turns = 0;
      let sessionCount = 0;

      for (const { session, updatedAt } of await sessions()) {
        const mine = emptyBucket();
        let any = false;
        for (const t of session.turns) {
          if (t.ts < since) continue;
          any = true;
          turns++;
          const date = new Date(t.ts).toISOString().slice(0, 10);
          const day = byDay.get(date) ?? { b: emptyBucket(), sessions: new Set<string>() };
          byDay.set(date, day);
          day.sessions.add(`${session.project}/${session.id}`);
          const model = byModel.get(t.model) ?? emptyBucket();
          byModel.set(t.model, model);
          for (const b of [total, day.b, model, mine]) add(b, t);
        }
        if (!any) continue;
        sessionCount++;
        ranked.push({ id: session.id, title: session.title, project: session.project, updatedAt: new Date(updatedAt).toISOString(), bucket: mine });
      }

      const result: UsageSummary = {
        days,
        totals: { sessions: sessionCount, turns, inputTokens: total.input, outputTokens: total.output, costUsd: costOf(total) },
        byDay: [...byDay.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([date, d]): UsageDay => ({ date, sessions: d.sessions.size, inputTokens: d.b.input, outputTokens: d.b.output, costUsd: costOf(d.b) })),
        byModel: [...byModel.entries()]
          .map(([model, b]) => ({ model, inputTokens: b.input, outputTokens: b.output, costUsd: costOf(b) }))
          .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
        topSessions: ranked
          .sort((a, b) => (b.bucket.cost - a.bucket.cost) || (b.bucket.input + b.bucket.output - (a.bucket.input + a.bucket.output)))
          .slice(0, 10)
          .map((s) => ({ id: s.id, title: s.title, project: s.project, updatedAt: s.updatedAt, costUsd: costOf(s.bucket), tokens: s.bucket.input + s.bucket.output })),
      };
      return result;
    },
  };
}
