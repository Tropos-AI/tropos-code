// src/hooks/runner.ts
import type { HookEvent, HooksSetting } from "../config/settings";
import { errorText } from "../error-text";
import { matchesHook } from "./matcher";
import { emptyOutcome, hookLabel, interpretHookResult, mergeHookResults, type HookOutcome } from "./output";

export type { HookOutcome } from "./output";

const DEFAULT_TIMEOUT_S = 60;
const KILL_GRACE_MS = 2_000;
/** After the hook exits, how long a grandchild that inherited its pipes may keep us waiting for output. */
const DRAIN_MS = 200;
const OUTPUT_LIMIT = 64 * 1024;
const PLUGIN_ROOT_VARS = /\$\{(?:TROPOS|CLAUDE)_PLUGIN_ROOT\}/g;

export interface HookRunnerConfig {
  hooks: HooksSetting;
  plugins?: Array<{ name: string; root: string; hooks: HooksSetting }>;
}

export interface HookRunnerBase {
  sessionId(): string;
  transcriptPath(): string;
  cwd: string;
  mode(): string;
  env?: NodeJS.ProcessEnv;
  shell?: string;
}

/** One hook ready to spawn: the command after plugin-root substitution, and where it came from. */
interface PlannedHook {
  command: string;
  timeoutS: number;
  pluginRoot?: string;
}

/** Collects one output stream up to a byte limit, then keeps draining so a chatty hook never blocks on a full pipe. */
class Capture {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly done: Promise<void>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
    this.done = this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) return;
        if (this.size < OUTPUT_LIMIT) {
          const part = value.subarray(0, OUTPUT_LIMIT - this.size);
          this.chunks.push(part);
          this.size += part.length;
        }
      }
    } catch {
      // stream cancelled or broken: keep what arrived
    }
  }

  /** Stops reading; the pipe may still be held open by a grandchild we don't wait for. */
  cancel(): void {
    this.reader.cancel().catch(() => {});
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Runs the command hooks configured for an event (settings first, then plugins) and merges what they say.
 * Hook scripts written for Claude Code work unchanged: same stdin JSON, exit codes and JSON output. Nothing here
 * throws; a hook that cannot start, times out or prints garbage becomes an entry in `errors`.
 */
export class HookRunner {
  private readonly sources: Array<{ hooks: HooksSetting; pluginRoot?: string }>;

  constructor(
    config: HookRunnerConfig,
    private readonly base: HookRunnerBase,
  ) {
    this.sources = [
      { hooks: config.hooks ?? {} },
      ...(config.plugins ?? []).map((p) => ({ hooks: p.hooks ?? {}, pluginRoot: p.root })),
    ];
  }

  /** Whether any hook is configured for the event, so callers can skip building its input. */
  has(event: HookEvent): boolean {
    return this.sources.some((s) => (s.hooks[event] ?? []).some((group) => (group?.hooks ?? []).length > 0));
  }

  async run(event: HookEvent, input: Record<string, unknown>, match?: string, signal?: AbortSignal): Promise<HookOutcome> {
    try {
      const planned = this.plan(event, match);
      if (planned.length === 0) return emptyOutcome();
      const stdin = JSON.stringify({
        session_id: this.base.sessionId(),
        transcript_path: this.base.transcriptPath(),
        cwd: this.base.cwd,
        permission_mode: this.base.mode(),
        hook_event_name: event,
        ...input,
      });
      const results = await Promise.all(planned.map((hook) => this.runOne(event, hook, stdin, signal)));
      return mergeHookResults(results);
    } catch (err) {
      // A throwing sessionId()/transcriptPath() or unserialisable input: still a result, never a crash.
      return { ...emptyOutcome(), errors: [`${event} hooks: ${errorText(err)}`] };
    }
  }

  /** The hooks that apply, in config order, with identical commands kept once (the first occurrence wins). */
  private plan(event: HookEvent, match: string | undefined): PlannedHook[] {
    const seen = new Set<string>();
    const planned: PlannedHook[] = [];
    for (const source of this.sources) {
      for (const group of source.hooks[event] ?? []) {
        if (!group || !matchesHook(group.matcher, match)) continue;
        for (const hook of group.hooks ?? []) {
          if (!hook || typeof hook.command !== "string" || hook.command.trim() === "") continue;
          const root = source.pluginRoot;
          const command = root === undefined ? hook.command : hook.command.replace(PLUGIN_ROOT_VARS, () => root);
          if (seen.has(command)) continue;
          seen.add(command);
          const t = hook.timeout;
          const timeoutS = typeof t === "number" && Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_S;
          planned.push({ command, timeoutS, pluginRoot: root });
        }
      }
    }
    return planned;
  }

  private env(pluginRoot: string | undefined): Record<string, string | undefined> {
    const cwd = this.base.cwd;
    const env: Record<string, string | undefined> = {
      ...(this.base.env ?? process.env),
      TROPOS_PROJECT_DIR: cwd,
      CLAUDE_PROJECT_DIR: cwd,
    };
    if (pluginRoot !== undefined) {
      env.TROPOS_PLUGIN_ROOT = pluginRoot;
      env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    }
    return env;
  }

  private async runOne(event: HookEvent, hook: PlannedHook, stdin: string, signal?: AbortSignal): Promise<HookOutcome> {
    const label = hookLabel(hook.command);
    const fail = (message: string): HookOutcome => ({ ...emptyOutcome(), errors: [`${label}: ${message}`] });
    if (signal?.aborted) return fail("cancelled");

    const shell = this.base.shell ?? "/bin/bash";
    let proc: Bun.Subprocess<Uint8Array, "pipe", "pipe">;
    try {
      proc = Bun.spawn([shell, "-c", hook.command], {
        cwd: this.base.cwd,
        env: this.env(hook.pluginRoot),
        stdin: new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
        // Its own process group, so a timeout also reaches whatever the script started.
        detached: true,
      });
    } catch (err) {
      return fail(`could not start ${shell}: ${errorText(err)}`);
    }

    const stdout = new Capture(proc.stdout);
    const stderr = new Capture(proc.stderr);
    let timedOut = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-proc.pid, sig);
      } catch {
        try {
          proc.kill(sig);
        } catch {
          // already gone
        }
      }
    };
    const groupAlive = (): boolean => {
      try {
        process.kill(-proc.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const terminate = () => {
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, hook.timeoutS * 1000);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (killTimer) {
      // The shell is gone; keep the SIGKILL for anything left in its group, but never let it hold Tropos open.
      if (groupAlive()) killTimer.unref();
      else clearTimeout(killTimer);
    }
    signal?.removeEventListener("abort", onAbort);

    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([stdout.done, stderr.done]),
      new Promise<void>((resolve) => (drainTimer = setTimeout(resolve, DRAIN_MS))),
    ]);
    clearTimeout(drainTimer);
    stdout.cancel();
    stderr.cancel();

    if (timedOut) return fail(`timed out after ${hook.timeoutS}s`);
    if (aborted) return fail("cancelled");
    return interpretHookResult(event, hook.command, { exitCode, stdout: stdout.text(), stderr: stderr.text() });
  }
}
