// src/ui/flow.ts — a terminal flow in the look of @clack/prompts, built in (no dependency): `createFlow(io, style)`
// draws the frames from flow-render.ts and reads answers either key by key (a real terminal) or line by line
// (anything else, such as a pipe or the tests' scripted prompts), so a wizard is written once.
import { emitKeypressEvents } from "node:readline";
import type { LifecycleContext } from "../cli/lifecycle/types";
import {
  flowStyle,
  renderConfirm,
  renderIntro,
  renderLog,
  renderNote,
  renderOutro,
  renderSelect,
  renderSpinner,
  renderSpinnerStop,
  renderStep,
  renderText,
  type FlowOption,
  type FlowStatus,
  type FlowStyle,
  type LogKind,
  type NavKeys,
} from "./flow-render";

export * from "./flow-render";

/** What a question answers with when the person skips it or asks to go back (only when the question allows it). */
export const SKIP = Symbol("flow.skip");
export const BACK = Symbol("flow.back");
export type Nav = typeof SKIP | typeof BACK;

/** Ctrl+C / Ctrl+D: the person aborted the flow. */
export class FlowCancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "FlowCancelled";
  }
}

export interface Key {
  name: "up" | "down" | "left" | "right" | "enter" | "escape" | "backspace" | "tab" | "cancel" | "ctrl-b" | "char";
  char?: string;
}

export interface KeySession {
  next(): Promise<Key>;
  close(): void;
}

export interface FlowIO {
  write(text: string): void;
  /** Raw keys from a terminal. Absent: line mode, where every question is a plain line (no cursor movement). */
  keys?: () => KeySession;
  /** Line mode: asks one line (`secret` is not echoed). */
  readLine(question: string, opts?: { secret?: boolean; default?: string }): Promise<string>;
  /** Line mode: a yes/no question; used when no skip/back is offered, so the host's own confirm keeps working. */
  confirm?(question: string, defaultYes: boolean): Promise<boolean>;
  /** Calls `fn` every `ms` until the returned function is called. */
  timer?: { every(fn: () => void, ms: number): () => void };
}

export interface SelectOptions<T extends string> extends NavKeys {
  message: string;
  options: readonly FlowOption<T>[];
  initial?: T;
}
export interface TextOptions extends NavKeys {
  message: string;
  placeholder?: string;
  initial?: string;
  /** Hidden input (keys, tokens). */
  secret?: boolean;
  /** Returns the reason an answer is not acceptable, or nothing. */
  validate?(value: string): string | undefined;
}
export interface ConfirmOptions extends NavKeys {
  message: string;
  initial?: boolean;
}
type Plain = { skip?: false; back?: false };

export interface Spinner {
  start(text: string): void;
  update(text: string): void;
  stop(text: string): void;
  fail(text: string): void;
}

export interface Flow {
  intro(title: string): void;
  outro(text: string): void;
  select<T extends string>(o: SelectOptions<T> & Plain): Promise<T>;
  select<T extends string>(o: SelectOptions<T>): Promise<T | Nav>;
  text(o: TextOptions & Plain): Promise<string>;
  text(o: TextOptions): Promise<string | Nav>;
  confirm(o: ConfirmOptions & Plain): Promise<boolean>;
  confirm(o: ConfirmOptions): Promise<boolean | Nav>;
  /** Plain lines in the gutter (a link, a code, an instruction). */
  note(lines: string | readonly string[]): void;
  info(lines: string | readonly string[]): void;
  success(lines: string | readonly string[]): void;
  warn(lines: string | readonly string[]): void;
  error(lines: string | readonly string[]): void;
  /** A finished step with what came of it. */
  stepDone(title: string, lines?: string | readonly string[]): void;
  /** A skipped step, with the reason if there is one. */
  stepSkip(title: string, reason?: string): void;
  spinner(): Spinner;
}

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const MAX_MISSES = 3;
const SPIN_MS = 80;
const lines = (v: string | readonly string[]): readonly string[] => (typeof v === "string" ? v.split("\n") : v);

/** The frame on screen, so the next one can replace it (the cursor sits on the line after it). */
class Screen {
  private height = 0;
  constructor(private readonly io: FlowIO) {}
  erase(): void {
    if (this.height) this.io.write(`\x1b[${this.height}A\x1b[0J`);
    this.height = 0;
  }
  show(frame: string, keep = true): void {
    const up = this.height ? `\x1b[${this.height}A\x1b[0J` : "";
    this.io.write(`${up}${frame}`);
    this.height = keep ? frame.split("\n").length - 1 : 0;
  }
}

type Outcome<T> = { value: T } | { nav: Nav } | undefined;

export function createFlow(io: FlowIO, st: FlowStyle): Flow {
  const out = (frame: string) => io.write(frame);
  const timer = io.timer ?? { every: (fn: () => void, ms: number) => {
    const id = setInterval(fn, ms);
    id.unref?.();
    return () => clearInterval(id);
  } };

  /** Runs one question on a terminal: `draw` renders the current state; `handle` reacts to a key. */
  async function onTerminal<T>(message: string, draw: (status: FlowStatus) => string, handle: (key: Key) => Outcome<T>): Promise<T | Nav> {
    const session = io.keys!();
    const screen = new Screen(io);
    out(HIDE_CURSOR);
    try {
      screen.show(draw("active"));
      for (;;) {
        const key = await session.next();
        if (key.name === "cancel") {
          screen.show(draw("cancel"), false);
          throw new FlowCancelled();
        }
        const result = handle(key);
        if (!result) {
          screen.show(draw("active"));
        } else if ("value" in result) {
          screen.show(draw("done"), false);
          return result.value;
        } else if (result.nav === SKIP) {
          screen.show(renderStep(st, "skip", message), false);
          return SKIP;
        } else {
          screen.erase();
          return BACK;
        }
      }
    } finally {
      out(SHOW_CURSOR);
      session.close();
    }
  }

  const navAsk = (keys: NavKeys, skip: string, back: string) => [keys.skip ? skip : "", keys.back ? back : ""].filter(Boolean).join(", ");
  const suffix = (keys: NavKeys, skip: string, back: string) => {
    const asked = navAsk(keys, skip, back);
    return asked ? ` (${asked})` : "";
  };
  const misses = (n: number) => {
    if (n >= MAX_MISSES) throw new FlowCancelled();
  };

  async function select<T extends string>(o: SelectOptions<T>): Promise<T | Nav> {
    const enabled = (i: number) => !o.options[i]!.disabled;
    let cursor = o.options.findIndex((x, i) => x.value === o.initial && enabled(i));
    if (cursor < 0) cursor = o.options.findIndex((_, i) => enabled(i));
    if (cursor < 0) throw new Error("select: no option can be chosen");
    const view = (status: FlowStatus) => renderSelect(st, { message: o.message, options: o.options, cursor, status, keys: o });
    const answer = (): T => o.options[cursor]!.value;

    if (io.keys) {
      const step = (dir: 1 | -1) => {
        const n = o.options.length;
        let i = cursor;
        do i = (i + dir + n) % n;
        while (!enabled(i));
        cursor = i;
      };
      return onTerminal<T>(o.message, view, (key) => {
        if (key.name === "up" || key.name === "left") step(-1);
        else if (key.name === "down" || key.name === "right" || key.name === "tab") step(1);
        else if (key.name === "enter") return { value: answer() };
        else if (key.name === "char" && key.char === "s" && o.skip) return { nav: SKIP };
        else if (key.name === "char" && key.char === "b" && o.back) return { nav: BACK };
        return undefined;
      });
    }

    out(view("list"));
    for (let miss = 0; ; miss++) {
      misses(miss);
      const text = (await io.readLine(`${o.message}${suffix(o, "s to skip", "b to go back")}`, { default: String(cursor + 1) })).trim();
      const word = text.toLowerCase();
      if (o.skip && word === "s") return SKIP;
      if (o.back && word === "b") return BACK;
      const index = text === "" ? cursor : /^\d+$/.test(text) ? Number(text) - 1 : o.options.findIndex((x) => x.value.toLowerCase() === word || x.label.toLowerCase() === word);
      const picked = o.options[index];
      if (!picked) {
        out(renderLog(st, "error", [`Choose a number from 1 to ${o.options.length}`]));
      } else if (picked.disabled) {
        out(renderLog(st, "error", [`${picked.label} is not available yet (${typeof picked.disabled === "string" ? picked.disabled : "coming soon!"})`]));
      } else {
        cursor = index;
        out(view("done"));
        return answer();
      }
    }
  }

  async function text(o: TextOptions): Promise<string | Nav> {
    let value = o.initial ?? "";
    let error: string | undefined;
    const view = (status: FlowStatus) => renderText(st, { message: o.message, value, placeholder: o.placeholder, secret: o.secret, error: status === "active" ? error : undefined, status, keys: o });

    if (io.keys) {
      return onTerminal<string>(o.message, view, (key) => {
        if (key.name === "char" && key.char) {
          value += key.char;
          error = undefined;
        } else if (key.name === "backspace") {
          value = [...value].slice(0, -1).join("");
          error = undefined;
        } else if (key.name === "enter") {
          error = o.validate?.(value);
          if (!error) return { value };
        } else if (key.name === "escape" && o.skip) return { nav: SKIP };
        else if (key.name === "ctrl-b" && o.back) return { nav: BACK };
        return undefined;
      });
    }

    for (let miss = 0; ; miss++) {
      misses(miss);
      const asked = await io.readLine(`${o.message}${suffix(o, "/skip to skip", "/back to go back")}`, { secret: o.secret, default: o.initial });
      if (o.skip && asked.trim() === "/skip") return SKIP;
      if (o.back && asked.trim() === "/back") return BACK;
      value = asked;
      error = o.validate?.(value);
      if (!error) {
        out(view("done"));
        return value;
      }
      out(renderLog(st, "error", [error]));
    }
  }

  async function confirm(o: ConfirmOptions): Promise<boolean | Nav> {
    let value = o.initial ?? true;
    const view = (status: FlowStatus) => renderConfirm(st, { message: o.message, value, status, keys: o });

    if (io.keys) {
      return onTerminal<boolean>(o.message, view, (key) => {
        if (key.name === "left" || key.name === "up") value = true;
        else if (key.name === "right" || key.name === "down") value = false;
        else if (key.name === "tab") value = !value;
        else if (key.name === "enter") return { value };
        else if (key.name === "char" && key.char?.toLowerCase() === "y") return { value: true };
        else if (key.name === "char" && key.char?.toLowerCase() === "n") return { value: false };
        else if (key.name === "char" && key.char === "s" && o.skip) return { nav: SKIP };
        else if (key.name === "char" && key.char === "b" && o.back) return { nav: BACK };
        return undefined;
      });
    }

    if (!o.skip && !o.back && io.confirm) {
      value = await io.confirm(o.message, value);
      out(view("done"));
      return value;
    }
    for (let miss = 0; ; miss++) {
      misses(miss);
      const word = (await io.readLine(`${o.message} ${value ? "[Y/n" : "[y/N"}${o.skip ? "/s" : ""}${o.back ? "/b" : ""}]`)).trim().toLowerCase();
      if (o.skip && word === "s") return SKIP;
      if (o.back && word === "b") return BACK;
      if (word === "y" || word === "yes") value = true;
      else if (word === "n" || word === "no") value = false;
      else if (word !== "") {
        out(renderLog(st, "error", ["Answer y or n"]));
        continue;
      }
      out(view("done"));
      return value;
    }
  }

  function spinner(): Spinner {
    let stopTimer: (() => void) | null = null;
    let label = "";
    let frame = 0;
    let running = false;
    const finish = (kind: "ok" | "fail", text: string) => {
      if (!running) return;
      running = false;
      stopTimer?.();
      stopTimer = null;
      out(`${io.keys ? "\r\x1b[2K" : ""}${renderSpinnerStop(st, kind, text)}${io.keys ? SHOW_CURSOR : ""}`);
    };
    return {
      start(text) {
        running = true;
        label = text;
        frame = 0;
        if (!io.keys) return out(`${renderSpinner(st, 0, text)}\n`);
        out(`${HIDE_CURSOR}${renderSpinner(st, 0, text)}`);
        stopTimer = timer.every(() => out(`\r\x1b[2K${renderSpinner(st, ++frame, label)}`), SPIN_MS);
      },
      update(text) {
        label = text;
      },
      stop: (text) => finish("ok", text),
      fail: (text) => finish("fail", text),
    };
  }

  return {
    intro: (title) => out(renderIntro(st, title)),
    outro: (text) => out(renderOutro(st, text)),
    select: select as Flow["select"],
    text: text as Flow["text"],
    confirm: confirm as Flow["confirm"],
    note: (v) => out(renderNote(st, lines(v))),
    info: (v) => out(renderLog(st, "info", lines(v))),
    success: (v) => out(renderLog(st, "success", lines(v))),
    warn: (v) => out(renderLog(st, "warn", lines(v))),
    error: (v) => out(renderLog(st, "error", lines(v))),
    stepDone: (title, v = []) => out(renderStep(st, "done", title, lines(v))),
    stepSkip: (title, reason) => out(renderStep(st, "skip", title, reason ? [`Skipped: ${reason}`] : [])),
    spinner,
  };
}

/** What readline's `keypress` reports, reduced to the keys a flow uses (null: ignore it). */
export function keyFromPress(str: string | undefined, key?: { name?: string; ctrl?: boolean; meta?: boolean }): Key | null {
  if (key?.ctrl) {
    if (key.name === "c" || key.name === "d") return { name: "cancel" };
    if (key.name === "b") return { name: "ctrl-b" };
    return null;
  }
  if (key?.meta) return null;
  switch (key?.name) {
    case "up":
    case "down":
    case "left":
    case "right":
    case "escape":
    case "backspace":
    case "tab":
      return { name: key.name };
    case "return":
    case "enter":
      return { name: "enter" };
  }
  // eslint-disable-next-line no-control-regex
  return str && [...str].length === 1 && !/[\x00-\x1f\x7f]/.test(str) ? { name: "char", char: str } : null;
}

/** Raw keys from a TTY input; raw mode is on only while a question is open. */
function ttyKeys(input: NodeJS.ReadStream): () => KeySession {
  return () => {
    emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    const queue: Key[] = [];
    let waiting: ((key: Key) => void) | null = null;
    const onPress = (str: string | undefined, press?: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      const key = keyFromPress(str, press);
      if (!key) return;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(key);
      } else queue.push(key);
    };
    input.on("keypress", onPress);
    return {
      next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise<Key>((resolve) => void (waiting = resolve))),
      close() {
        input.off("keypress", onPress);
        input.setRawMode(wasRaw);
        input.pause();
      },
    };
  };
}

/**
 * A flow on the lifecycle context: keys on a real terminal, otherwise the context's own `prompt` / `confirm`
 * (so scripted answers in tests, and piped input, keep working).
 */
export function flowForContext(ctx: LifecycleContext, term: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream } = {}): Flow {
  const stdin = term.stdin ?? process.stdin;
  const stdout = term.stdout ?? process.stdout;
  const raw = ctx.interactive && Boolean(stdin.isTTY && stdout.isTTY) && typeof stdin.setRawMode === "function";
  const style = flowStyle(ctx.env, { isTTY: Boolean(stdout.isTTY), columns: stdout.columns });
  return createFlow(
    {
      write: (text) => ctx.out(text),
      ...(raw ? { keys: ttyKeys(stdin) } : {}),
      readLine: (question, opts) => ctx.prompt(question, { secret: opts?.secret, default: opts?.default }),
      confirm: (question, defaultYes) => ctx.confirm(question, defaultYes),
    },
    style,
  );
}
