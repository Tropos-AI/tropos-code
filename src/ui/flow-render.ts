// src/ui/flow-render.ts — the look of a terminal flow (intro, steps in a left gutter, radio options, inputs, outro),
// as pure functions: state in, frame string out. No Node imports and no I/O, so the frames are easy to test and
// the interactive driver in flow.ts stays thin. The look follows @clack/prompts, built in so there is no dependency.
//
// Every frame ends with a newline (the spinner line is the one exception) and, once finished, with a gutter line,
// so frames can simply be written one after another.

export interface FlowStyle {
  /** ANSI colours. Off for NO_COLOR, a dumb terminal and anything that is not a terminal. */
  color: boolean;
  /** Box-drawing and symbol characters; off falls back to `| * o +` and plain words. */
  unicode: boolean;
  columns: number;
}

/** `NO_COLOR` (set and not empty) and non-UTF-8 locales are respected; a pipe gets neither colour nor cursor tricks. */
export function flowStyle(env: NodeJS.ProcessEnv, term: { isTTY: boolean; columns?: number }): FlowStyle {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return {
    color: term.isTTY && !env.NO_COLOR && env.TERM !== "dumb",
    unicode: /utf-?8/i.test(locale) || Boolean(env.WT_SESSION),
    columns: term.columns && term.columns > 20 ? term.columns : 80,
  };
}

export interface FlowOption<T extends string = string> {
  value: T;
  label: string;
  /** Shown dim next to the option while the cursor is on it. */
  hint?: string;
  /** Not selectable: dim, with a note (`true` reads "coming soon!"). */
  disabled?: boolean | string;
}

/** Which extra keys the question answers to. */
export interface NavKeys {
  skip?: boolean;
  back?: boolean;
}

/** `list` is the numbered form for input without a terminal; `cancel` replaces the frame when the flow is aborted. */
export type FlowStatus = "active" | "done" | "cancel" | "list";

export interface SelectView {
  message: string;
  options: readonly FlowOption[];
  cursor: number;
  status: FlowStatus;
  keys?: NavKeys;
}

export interface TextView {
  message: string;
  value: string;
  placeholder?: string;
  secret?: boolean;
  error?: string;
  status: FlowStatus;
  keys?: NavKeys;
}

export interface ConfirmView {
  message: string;
  value: boolean;
  status: FlowStatus;
  keys?: NavKeys;
}

export type LogKind = "info" | "success" | "warn" | "error";

const UNI = { top: "┌", bar: "│", end: "└", active: "◆", done: "◇", on: "●", off: "○", info: "●", success: "◆", warn: "▲", error: "■", dot: "·", updown: "↑/↓", leftright: "←/→", mask: "•", ellipsis: "…", spin: ["◒", "◐", "◓", "◑"] };
const ASC = { top: "+", bar: "|", end: "+", active: "*", done: "o", on: "*", off: "o", info: "i", success: "+", warn: "!", error: "x", dot: "-", updown: "up/down", leftright: "left/right", mask: "*", ellipsis: "...", spin: ["-", "\\", "|", "/"] };
const sym = (st: FlowStyle) => (st.unicode ? UNI : ASC);

const ESC = "\x1b[";
const paint = (st: FlowStyle, open: number, close: number, text: string) => (st.color && text ? `${ESC}${open}m${text}${ESC}${close}m` : text);
const dim = (st: FlowStyle, t: string) => paint(st, 2, 22, t);
const bold = (st: FlowStyle, t: string) => paint(st, 1, 22, t);
const cyan = (st: FlowStyle, t: string) => paint(st, 36, 39, t);
const green = (st: FlowStyle, t: string) => paint(st, 32, 39, t);
const red = (st: FlowStyle, t: string) => paint(st, 31, 39, t);
const yellow = (st: FlowStyle, t: string) => paint(st, 33, 39, t);
const blue = (st: FlowStyle, t: string) => paint(st, 34, 39, t);

/** The gutter bar: cyan while a question is open, dim otherwise. */
const bar = (st: FlowStyle, active = false) => (active ? cyan(st, sym(st).bar) : dim(st, sym(st).bar));

/** Clips plain text so a frame line never wraps (a wrapped line would break the redraw's line count). */
function clip(st: FlowStyle, text: string, used: number): string {
  const room = Math.max(8, st.columns - used - 1);
  const chars = [...text];
  const ell = sym(st).ellipsis;
  return chars.length <= room ? text : `${chars.slice(0, Math.max(1, room - [...ell].length)).join("")}${ell}`;
}

/** Lines of a block: the first after `lead` (a symbol), the rest in the gutter. */
function block(st: FlowStyle, lead: string, activeBar: boolean, lines: readonly string[], paintLine: (s: string) => string = (s) => s): string[] {
  return lines.map((line, i) => `${i === 0 ? lead : bar(st, activeBar)}  ${paintLine(clip(st, line, 3))}`);
}

const gutter = (st: FlowStyle, activeBar: boolean, text: string) => `${bar(st, activeBar)}  ${text}`;
const done = (st: FlowStyle) => dim(st, sym(st).done);
const end = (lines: string[]) => `${lines.join("\n")}\n`;

export function renderIntro(st: FlowStyle, title: string): string {
  return end([`${dim(st, sym(st).top)}  ${bold(st, clip(st, title, 3))}`, bar(st)]);
}

export function renderOutro(st: FlowStyle, text: string): string {
  return end([`${dim(st, sym(st).end)}  ${clip(st, text, 3)}`]);
}

function hintLine(st: FlowStyle, parts: string[], keys: NavKeys | undefined, own: { skip: string; back: string }): string {
  const s = sym(st);
  const all = [...parts, ...(keys?.skip ? [own.skip] : []), ...(keys?.back ? [own.back] : [])];
  return gutter(st, true, dim(st, clip(st, all.join(` ${s.dot} `), 3)));
}

const messageLines = (message: string) => message.split("\n");
const titleOf = (st: FlowStyle, status: FlowStatus, message: string, paintMore?: (s: string) => string): string[] => {
  const lead = status === "done" ? done(st) : status === "cancel" ? red(st, sym(st).error) : cyan(st, sym(st).active);
  const out = block(st, lead, status === "active", messageLines(message), paintMore);
  return out;
};
const finished = (st: FlowStyle, status: FlowStatus, message: string, answer: string): string =>
  end([...titleOf(st, status, message), ...(status === "cancel" ? [gutter(st, false, dim(st, "Cancelled"))] : [gutter(st, false, dim(st, clip(st, answer, 3))), bar(st)])]);

function optionNote(o: FlowOption): string | undefined {
  return o.disabled ? (typeof o.disabled === "string" ? o.disabled : "coming soon!") : undefined;
}

export function renderSelect(st: FlowStyle, v: SelectView): string {
  const s = sym(st);
  if (v.status === "done" || v.status === "cancel") return finished(st, v.status, v.message, v.options[v.cursor]?.label ?? "");
  const rows = v.options.map((o, i) => {
    const note = optionNote(o);
    const text = clip(st, `${o.label}${note ? ` (${note})` : ""}`, 5);
    if (v.status === "list") return gutter(st, true, `${i + 1}. ${text}${i === v.cursor && !note ? dim(st, " (default)") : ""}`);
    if (note) return gutter(st, true, dim(st, `${s.off} ${text}`));
    if (i === v.cursor) return gutter(st, true, `${green(st, s.on)} ${text}${o.hint ? dim(st, ` (${clip(st, o.hint, 7 + [...text].length)})`) : ""}`);
    return gutter(st, true, dim(st, `${s.off} ${text}`));
  });
  const hint = v.status === "list" ? [] : [hintLine(st, [`${s.updown} to navigate`, "Enter: confirm"], v.keys, { skip: "s: skip", back: "b: back" })];
  return end([...titleOf(st, v.status, v.message), ...rows, ...hint]);
}

const CURSOR = "_";

export function renderText(st: FlowStyle, v: TextView): string {
  const s = sym(st);
  if (v.status === "done" || v.status === "cancel") return finished(st, v.status, v.message, v.secret && v.value ? "(hidden)" : v.value || "(empty)");
  const shown = v.secret ? s.mask.repeat([...v.value].length) : clip(st, v.value, 5);
  const input = v.value ? `${shown}${CURSOR}` : `${CURSOR}${v.placeholder ? dim(st, clip(st, v.placeholder, 6)) : ""}`;
  return end([
    ...titleOf(st, v.status, v.message),
    gutter(st, true, input),
    ...(v.error ? [gutter(st, true, red(st, clip(st, v.error, 5)))] : []),
    hintLine(st, ["Enter: confirm"], v.keys, { skip: "Esc: skip", back: "Ctrl+B: back" }),
  ]);
}

export function renderConfirm(st: FlowStyle, v: ConfirmView): string {
  const s = sym(st);
  if (v.status === "done" || v.status === "cancel") return finished(st, v.status, v.message, v.value ? "Yes" : "No");
  const pick = (on: boolean, label: string) => (on ? `${green(st, s.on)} ${label}` : dim(st, `${s.off} ${label}`));
  return end([
    ...titleOf(st, v.status, v.message),
    gutter(st, true, `${pick(v.value, "Yes")} ${dim(st, "/")} ${pick(!v.value, "No")}`),
    hintLine(st, [`${s.leftright} to choose`, "y/n", "Enter: confirm"], v.keys, { skip: "s: skip", back: "b: back" }),
  ]);
}

/** A finished step: its title and what came of it, or "Skipped" (with a reason when given). */
export function renderStep(st: FlowStyle, kind: "done" | "skip", title: string, lines: readonly string[] = []): string {
  const body = kind === "skip" && !lines.length ? ["Skipped"] : lines;
  const paintLine = kind === "skip" ? (t: string) => dim(st, t) : undefined;
  return end([
    ...block(st, done(st), false, messageLines(title), paintLine),
    ...body.map((l) => gutter(st, false, kind === "skip" ? dim(st, clip(st, l, 3)) : clip(st, l, 3))),
    bar(st),
  ]);
}

/** Plain lines in the gutter: a link, a code, an instruction. */
export function renderNote(st: FlowStyle, lines: readonly string[]): string {
  return end([...lines.map((l) => gutter(st, false, clip(st, l, 3))), bar(st)]);
}

/** A status line (info, success, warning, error) with a symbol, and its continuation lines in the gutter. */
export function renderLog(st: FlowStyle, kind: LogKind, lines: readonly string[]): string {
  const s = sym(st);
  const colour = { info: blue, success: green, warn: yellow, error: red }[kind];
  return end([...block(st, colour(st, s[kind]), false, lines), bar(st)]);
}

/** One spinner line (no newline, no gutter bar after it: the driver rewrites it in place). */
export function renderSpinner(st: FlowStyle, frame: number, text: string): string {
  const frames = sym(st).spin;
  return `${cyan(st, frames[frame % frames.length]!)}  ${clip(st, text, 3)}`;
}

export function renderSpinnerStop(st: FlowStyle, kind: "ok" | "fail", text: string): string {
  const lead = kind === "ok" ? done(st) : red(st, sym(st).error);
  return end([`${lead}  ${clip(st, text, 3)}`, bar(st)]);
}
