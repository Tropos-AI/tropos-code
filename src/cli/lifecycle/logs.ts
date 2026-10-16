// src/cli/lifecycle/logs.ts — `tcode logs [gateway|install|update]`; tailFile/followFile are shared with the web admin API.
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveLayout } from "../../install/layout";
import type { LifecycleContext, LifecycleRun } from "./types";

const HELP = `Usage: tcode logs [gateway|install|update] [-n <lines>] [-f|--follow] [--json]

  gateway   ~/.tropos/gateway/gateway.log (default)
  install   install.log in the installer's state directory
  update    update.log in the installer's state directory
  -n        how many lines from the end (default 50)
  -f        keep printing new lines until Ctrl-C
  --json    one JSON object per line: {"source","line"}
`;

export type LogSource = "gateway" | "install" | "update";
export const LOG_SOURCES: readonly LogSource[] = ["gateway", "install", "update"];

export function logPath(source: LogSource, home: string, env: NodeJS.ProcessEnv, userHome: string): string {
  const layout = resolveLayout(env, userHome);
  if (source === "gateway") return join(home, "gateway", "gateway.log");
  return source === "update" ? layout.log : join(layout.state, "install.log");
}

const HOW: Record<LogSource, string> = {
  gateway: "The gateway writes it while it runs as a background service. Start it with: tcode gateway install",
  install: "The installer writes it during `curl ... | sh` or `tcode install`. Run: tcode install --force",
  update: "The updater writes it when a background update runs. Run: tcode update",
};

const CHUNK = 64 * 1024;

/** The last `lines` lines of a file (fewer if it is shorter), reading from the end; null when the file does not exist. */
export async function tailFile(path: string, lines: number): Promise<string[] | null> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (lines <= 0 || size === 0) return [];
    let pos = size;
    const parts: Buffer[] = [];
    let newlines = 0;
    // One more newline than lines wanted, so the first kept line is whole.
    while (pos > 0 && newlines <= lines) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos);
      for (const b of buf) if (b === 0x0a) newlines++;
      parts.unshift(buf);
    }
    const text = Buffer.concat(parts).toString("utf8");
    const all = text.split("\n");
    if (all.at(-1) === "") all.pop();
    // If we stopped mid-file, the first element may be a partial line.
    return (pos > 0 ? all.slice(1) : all).slice(-lines);
  } finally {
    await fh.close();
  }
}

export interface FollowOptions {
  onLines(lines: string[]): void;
  /** Stops the loop. */
  signal: AbortSignal;
  pollMs?: number;
  /** Start from the beginning of the file instead of its end. */
  fromStart?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Calls `onLines` with each batch of new complete lines until aborted. Survives truncation, rotation and a late-created file. */
export async function followFile(path: string, opts: FollowOptions): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let pos = -1;
  let ino: number | undefined;
  let rest = "";
  const first = await stat(path).catch(() => null);
  if (first) {
    ino = first.ino;
    pos = opts.fromStart ? 0 : first.size;
  }
  while (!opts.signal.aborted) {
    const st = await stat(path).catch(() => null);
    if (st) {
      if (pos < 0 || st.size < pos || (ino !== undefined && st.ino !== ino)) {
        pos = 0; // new, truncated or rotated file: read it from the top
        rest = "";
      }
      ino = st.ino;
      if (st.size > pos) {
        const fh = await open(path, "r").catch(() => null);
        if (fh) {
          try {
            const len = Math.min(st.size - pos, 4 * 1024 * 1024);
            const buf = Buffer.alloc(len);
            const { bytesRead } = await fh.read(buf, 0, len, pos);
            pos += bytesRead;
            const text = rest + buf.toString("utf8", 0, bytesRead);
            const parts = text.split("\n");
            rest = parts.pop() ?? "";
            if (parts.length) opts.onLines(parts);
          } finally {
            await fh.close();
          }
        }
      }
    }
    if (opts.signal.aborted) break;
    await sleep(opts.pollMs ?? 500);
  }
}

export interface LogsHooks {
  /** Defaults to Ctrl-C. */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

export function createLogs(hooks: LogsHooks = {}): LifecycleRun {
  return async (argv: string[], ctx: LifecycleContext) => {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: { n: { type: "string", short: "n" }, follow: { type: "boolean", short: "f" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
      });
    } catch (err) {
      ctx.err(`tcode logs: ${(err as Error).message}\n${HELP}`);
      return 64;
    }
    const { values, positionals } = parsed;
    if (values.help) {
      ctx.out(HELP);
      return 0;
    }
    const source = (positionals[0] ?? "gateway") as LogSource;
    if (positionals.length > 1 || !LOG_SOURCES.includes(source)) {
      ctx.err(`tcode logs: choose one of ${LOG_SOURCES.join(", ")}\n`);
      return 64;
    }
    const count = values.n === undefined ? 50 : Number(values.n);
    if (!Number.isInteger(count) || count < 0) {
      ctx.err(`tcode logs: -n needs a whole number, not "${values.n}"\n`);
      return 64;
    }
    const path = logPath(source, ctx.home, ctx.env, ctx.userHome);
    const show = (lines: string[]) => ctx.out(lines.map((line) => (values.json ? JSON.stringify({ source, line }) : line)).join("\n") + (lines.length ? "\n" : ""));

    const tail = await tailFile(path, count).catch((err: Error) => err);
    if (tail instanceof Error) {
      ctx.err(`tcode logs: cannot read ${path}: ${tail.message}\n`);
      return 1;
    }
    if (tail === null) {
      ctx.err(`tcode logs: ${path} does not exist yet.\n${HOW[source]}\n`);
      return 1;
    }
    show(tail);
    if (!values.follow) return 0;

    const own = new AbortController();
    const onSigint = () => own.abort();
    if (!hooks.signal) process.once("SIGINT", onSigint);
    try {
      await followFile(path, { onLines: show, signal: hooks.signal ?? own.signal, sleep: hooks.sleep });
    } finally {
      process.off("SIGINT", onSigint);
    }
    return 0;
  };
}

export default createLogs();
