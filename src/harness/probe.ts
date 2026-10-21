// src/harness/probe.ts — Harness²'s Probe: run one task with one harness and record what happened. The agent runs as
// `tcode -p` in a fresh copy of the project, with a Tropos home of its own (none of the owner's memory, skills or
// sessions), Bash confined to the copy (`--confine`), and the harness under test as its only overlay (`--harness-dir`).
// The trajectory, the diff and the project's own checks are what the editors and the composer read.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { confinedBackend, confinementAvailable } from "../exec/confined";
import type { DiffAudit } from "./audit";
import type { Domain } from "./domain";
import { behaviourSignals, parseTrajectory, type BehaviourSignals } from "./signals";
import { createWorkspace, runBackendCommand, runHostCommand, workspaceDiff, type CommandResult } from "./workspace";

export interface LabTask {
  id: string;
  /** One line, for listings. */
  title: string;
  prompt: string;
  /** The git repository the task works on, and the revision it starts from. */
  repo: string;
  revision: string;
  domain: Domain;
  /** Installs dependencies in a fresh copy (run on the host, before the agent). */
  setup?: string;
  /** The project's verifiers, run confined after the agent: tests, type checker, build. */
  checks: string[];
  /** "holdout" tasks are measured, never learned from; "replay" ones come from past sessions. */
  split: "dev" | "holdout" | "replay";
}

export interface ProbeResult {
  /** `<run id>-<label>`: what lessons cite as evidence. */
  id: string;
  label: string;
  /** The harness files the probe ran with (the overlay over the built-in base). */
  harness: string[];
  signals: BehaviourSignals;
  checks: CommandResult[];
  audit: DiffAudit | null;
  /** The agent's last answer. */
  finalText: string;
  seconds: number;
  /** Set when the probe itself failed (setup, the agent didn't start); such a probe proves nothing. */
  error: string | null;
  /** The ground truth (ProbeInput.measure), when there was one: for measuring only, never shown to the lab's roles. */
  measured?: CommandResult;
}

export interface ProbeInput {
  task: LabTask;
  /** The overlay folder the agent runs with. */
  harnessDir: string;
  /** The probe's own folder: trajectory.jsonl, patch.diff and probe.json are kept there. */
  dir: string;
  id: string;
  label: string;
  harnessFiles: string[];
  /**
   * Run after everything else: copy `files` from `from` into the copy of the project, then `command`, confined. The
   * eval's hidden tests: the result is kept as `measured` and never reaches the editors, composer or selector.
   */
  measure?: { from: string; files: string[]; command: string };
}

export interface ProbeRunner {
  run(input: ProbeInput, signal: AbortSignal): Promise<ProbeResult>;
}

export interface LocalProbeOptions {
  /** How to start tcode: [binary] when compiled, [bun, script] otherwise. */
  command: string[];
  model: string;
  effort: string;
  maxTurns: number;
  timeoutMs: number;
  /** The model provider's key, passed to the agent by name and never to its commands. */
  key: { name: string; value: string } | null;
  /** Provider settings (base URLs) the agent's fresh home needs to reach the model. */
  providers?: Record<string, unknown>;
  setupTimeoutMs?: number;
  checkTimeoutMs?: number;
  /** Keep the copy of the project after the probe (the selector's winner is kept for its patch only). */
  keepWorkspace?: boolean;
  /** The owner's Tropos home: hidden from the probe's commands and checks, whatever folder it is. */
  ownerHome: string;
}

const RESULT_TEXT_CHARS = 4_000;

/** The last result line's text, from stream-json output. */
function finalText(stdout: string): string {
  const events = parseTrajectory(stdout);
  const result = [...events].reverse().find((e) => e.type === "result");
  const text = typeof result?.result === "string" ? result.result : "";
  return text.length > RESULT_TEXT_CHARS ? `${text.slice(0, RESULT_TEXT_CHARS)}…` : text;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The shell script that puts the hidden files in place. It runs in the sandbox, which writes only inside the copy: a
 * link the agent left in place of a file or a folder can't send the copy anywhere else, even mid-copy.
 */
export function copyScript(from: string, files: string[]): string {
  return files
    .map((rel) => {
      if (rel.split("/").includes("..") || rel.startsWith("/")) throw new Error(`${rel} is not a path inside the project`);
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
      return `mkdir -p ${quote(dir)} && rm -rf ${quote(rel)} && cp ${quote(join(from, rel))} ${quote(rel)}`;
    })
    .join(" && ");
}

/** Probes on this machine: the copy, the agent's commands and the checks all stay inside the sandbox. */
export class LocalProbeRunner implements ProbeRunner {
  constructor(private readonly opts: LocalProbeOptions) {}

  async run(input: ProbeInput, signal: AbortSignal): Promise<ProbeResult> {
    const started = performance.now();
    const { task, dir } = input;
    const result: ProbeResult = {
      id: input.id,
      label: input.label,
      harness: input.harnessFiles,
      signals: behaviourSignals([]),
      checks: [],
      audit: null,
      finalText: "",
      seconds: 0,
      error: null,
    };
    const ws = join(dir, "ws");
    const home = join(dir, "home");
    // The real one: the sandbox's secret paths (~/.ssh, ~/.tropos …) are resolved against it, so they stay denied.
    const userHome = homedir();
    try {
      if (!(await confinementAvailable())) throw new Error("probes need sandbox-exec (macOS) or bwrap (Linux) to run confined");
      await mkdir(home, { recursive: true });
      if (this.opts.providers && Object.keys(this.opts.providers).length > 0) {
        await writeFile(join(home, "settings.json"), `${JSON.stringify({ providers: this.opts.providers }, null, 2)}\n`);
      }
      await createWorkspace(task.repo, task.revision, ws);
      if (task.setup) {
        const setup = await runHostCommand(task.setup, ws, this.opts.setupTimeoutMs ?? 600_000);
        if (!setup.ok) throw new Error(`setup "${task.setup}" failed (${setup.exit}${setup.timedOut ? ", timed out" : ""}): ${setup.tail}`);
      }
      const stdout = await this.agent(input, ws, home, userHome, signal);
      await writeFile(join(dir, "trajectory.jsonl"), stdout);
      result.signals = behaviourSignals(parseTrajectory(stdout));
      result.finalText = finalText(stdout);
      const diff = await workspaceDiff(ws);
      result.audit = diff.audit;
      await writeFile(join(dir, "patch.diff"), diff.patch);
      const backend = confinedBackend({ project: ws, home, userHome, env: process.env, denied: [this.opts.ownerHome] });
      try {
        for (const check of task.checks) {
          if (signal.aborted) break;
          result.checks.push(await runBackendCommand(backend, check, ws, {}, this.opts.checkTimeoutMs ?? 600_000));
        }
        if (input.measure && !signal.aborted) {
          // A sandbox of its own that may also read the hidden files; the copy happens inside it.
          const measuring = confinedBackend({ project: ws, home, userHome, env: process.env, denied: [this.opts.ownerHome], readable: [input.measure.from] });
          try {
            const copied = await runBackendCommand(measuring, copyScript(input.measure.from, input.measure.files), ws, {}, 60_000);
            result.measured = copied.ok ? await runBackendCommand(measuring, input.measure.command, ws, {}, this.opts.checkTimeoutMs ?? 600_000) : { ...copied, command: "copying the hidden files" };
          } finally {
            await measuring.close();
          }
        }
      } finally {
        await backend.close();
      }
    } catch (err) {
      result.error = (err as Error).message;
    } finally {
      result.seconds = Math.round((performance.now() - started) / 1000);
      await writeFile(join(dir, "probe.json"), `${JSON.stringify(result, null, 2)}\n`).catch(() => {});
      // Copies of the project add up fast; only what the lab reads is kept.
      if (!this.opts.keepWorkspace) await rm(ws, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
    return result;
  }

  private async agent(input: ProbeInput, ws: string, home: string, userHome: string, signal: AbortSignal): Promise<string> {
    // A Tropos home of its own (none of the owner's memory, keys or sessions); HOME stays the real one, see run().
    const o = this.opts;
    const args = [
      ...o.command,
      "-p",
      input.task.prompt,
      "--output-format",
      "stream-json",
      // Nobody is there to approve, so nothing asks; --confine is what holds it in. File tools' paths are resolved
      // through links and denied outside the copy before the bypass applies, Bash runs in the sandbox, and a confined
      // session has neither Cron nor TroposSetup. Its home is fresh, so no hooks or MCP servers come with it, and a
      // repository's settings can't add them.
      "--dangerously-skip-permissions",
      "--confine",
      "--harness-dir",
      input.harnessDir,
      "--model",
      o.model,
      "--effort",
      o.effort,
      "--max-turns",
      String(o.maxTurns),
    ];
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: userHome,
      TROPOS_HOME: home,
      TROPOS_CONFINE_DENY: o.ownerHome,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: process.env.LANG ?? "en_US.UTF-8",
    };
    if (o.key) env[o.key.name] = o.key.value;
    const child = Bun.spawn(args, { cwd: ws, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, o.timeoutMs);
    signal.addEventListener("abort", kill, { once: true });
    try {
      const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return stdout;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
    }
  }
}
