// src/cli/lifecycle/context.ts — the real LifecycleContext: terminal prompts over node:readline.
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { troposHome } from "../../paths";
import { VERSION } from "../../version";
import type { LifecycleContext } from "./types";

export interface LifecycleDeps {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  execPath: string;
  scriptPath?: string;
  /** The terminal behind the prompts; defaults to stdin/stdout over readline. Tests inject one. */
  terminal?: LifecycleTerminal;
}

export interface LifecycleTerminal {
  interactive: boolean;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
}

/** Prompts over node:readline on the given streams. */
export function readlineTerminal(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout, interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)): LifecycleTerminal {
  const ask = async (question: string): Promise<string> => {
    const rl = createInterface({ input, output });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
  // A secret is read with the terminal's echo muted, so a key never appears on screen or in scrollback.
  const askSecret = async (question: string): Promise<string> => {
    let muted = false;
    const muteable = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) output.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input, output: muteable, terminal: true });
    try {
      const pending = rl.question(question);
      muted = true;
      return await pending;
    } finally {
      muted = false;
      rl.close();
      output.write("\n");
    }
  };
  return { interactive, ask, askSecret };
}

export function createLifecycleContext(deps: LifecycleDeps, over: Partial<LifecycleContext> = {}): LifecycleContext {
  const { interactive, ask, askSecret } = deps.terminal ?? readlineTerminal();
  return {
    out: deps.out,
    err: deps.err,
    env: deps.env,
    cwd: deps.cwd,
    home: troposHome(deps.env),
    userHome: homedir(),
    execPath: deps.execPath,
    scriptPath: deps.scriptPath,
    version: VERSION,
    interactive,
    confirm: async (question, defaultYes = false) => {
      if (!interactive) return defaultYes;
      const answer = (await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
      return answer === "" ? defaultYes : answer === "y" || answer === "yes";
    },
    prompt: async (question, opts = {}) => {
      if (!interactive) return opts.default ?? "";
      const text = `${question}${opts.default ? ` [${opts.default}]` : ""} `;
      const answer = opts.secret ? await askSecret(text) : await ask(text);
      return answer.trim() === "" ? (opts.default ?? "") : answer.trim();
    },
    now: Date.now,
    ...over,
  };
}
