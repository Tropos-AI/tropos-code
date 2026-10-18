import { describe, expect, test } from "bun:test";
import { BACK, FlowCancelled, SKIP, createFlow, flowForContext, keyFromPress, type FlowIO, type Key } from "./flow";
import type { FlowOption, FlowStyle } from "./flow-render";

const PLAIN: FlowStyle = { color: false, unicode: true, columns: 80 };
const OPTIONS: FlowOption[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "mistral", label: "Mistral", disabled: true },
];

const k = (name: Key["name"], char?: string): Key => ({ name, ...(char ? { char } : {}) });
const typed = (text: string): Key[] => [...text].map((c) => k("char", c));

interface Rig {
  flow: ReturnType<typeof createFlow>;
  out(): string;
  lines: string[];
  asked: string[];
  confirmed: string[];
  ticks: Array<() => void>;
  closed: { keys: number; timers: number };
}

/** A terminal that feeds the given keys (`keys`) or, without them, a scripted line mode (`answers`). */
function rig(o: { keys?: Key[]; answers?: string[]; confirms?: boolean[] }): Rig {
  const written: string[] = [];
  const lines = [...(o.answers ?? [])];
  const queue = [...(o.keys ?? [])];
  const state: Rig = { flow: undefined as never, out: () => written.join(""), lines, asked: [], confirmed: [], ticks: [], closed: { keys: 0, timers: 0 } };
  const confirms = [...(o.confirms ?? [])];
  const io: FlowIO = {
    write: (t) => void written.push(t),
    readLine: async (q) => {
      state.asked.push(q);
      return lines.shift() ?? "";
    },
    confirm: async (q, def) => {
      state.confirmed.push(q);
      return confirms.shift() ?? def;
    },
    timer: {
      every(fn) {
        state.ticks.push(fn);
        return () => void state.closed.timers++;
      },
    },
    ...(o.keys
      ? {
          keys: () => ({
            next: async () => {
              const key = queue.shift();
              if (!key) throw new Error("the test ran out of keys");
              return key;
            },
            close: () => void state.closed.keys++,
          }),
        }
      : {}),
  };
  state.flow = createFlow(io, PLAIN);
  return state;
}

describe("select with a terminal", () => {
  test("arrows move over enabled options (wrapping past the disabled one) and Enter answers", async () => {
    const t = rig({ keys: [k("down"), k("down"), k("up"), k("enter")] });
    expect(await t.flow.select({ message: "Connect a model", options: OPTIONS })).toBe("deepseek");
  });

  test("the first frame, the redraw and the final frame", async () => {
    const t = rig({ keys: [k("down"), k("enter")] });
    await t.flow.select({ message: "Pick", options: OPTIONS });
    const out = t.out();
    expect(out.startsWith("\x1b[?25l◆  Pick\n│  ● Anthropic\n")).toBe(true);
    // the 5-line active frame is erased before each redraw, and the answer replaces it
    expect(out).toContain("\x1b[5A\x1b[0J◆  Pick\n│  ○ Anthropic\n│  ● DeepSeek\n");
    expect(out).toContain("\x1b[5A\x1b[0J◇  Pick\n│  DeepSeek\n│\n");
    expect(out.endsWith("\x1b[?25h")).toBe(true);
    expect(t.closed.keys).toBe(1);
  });

  test("initial picks where the cursor starts", async () => {
    const t = rig({ keys: [k("enter")] });
    expect(await t.flow.select({ message: "Pick", options: OPTIONS, initial: "deepseek" })).toBe("deepseek");
  });

  test("s skips and b goes back only when asked for; otherwise they do nothing", async () => {
    expect(await rig({ keys: [k("char", "s")] }).flow.select({ message: "Pick", options: OPTIONS, skip: true })).toBe(SKIP);
    expect(await rig({ keys: [k("char", "b")] }).flow.select({ message: "Pick", options: OPTIONS, back: true })).toBe(BACK);
    const t = rig({ keys: [k("char", "s"), k("char", "b"), k("enter")] });
    expect(await t.flow.select({ message: "Pick", options: OPTIONS })).toBe("anthropic");
    const hinted = rig({ keys: [k("char", "s")] });
    await hinted.flow.select({ message: "Pick", options: OPTIONS, skip: true, back: true });
    expect(hinted.out()).toContain("s: skip · b: back");
  });

  test("skipping leaves a skipped step behind; going back leaves nothing", async () => {
    const skipped = rig({ keys: [k("char", "s")] });
    await skipped.flow.select({ message: "Telegram", options: OPTIONS, skip: true });
    expect(skipped.out()).toContain("◇  Telegram\n│  Skipped\n│\n");
    const back = rig({ keys: [k("char", "b")] });
    await back.flow.select({ message: "Telegram", options: OPTIONS, back: true });
    expect(back.out().endsWith("\x1b[5A\x1b[0J\x1b[?25h")).toBe(true);
  });

  test("Ctrl+C cancels: the frame says so, the cursor is restored and the keys are released", async () => {
    const t = rig({ keys: [k("cancel")] });
    await expect(t.flow.select({ message: "Pick", options: OPTIONS })).rejects.toBeInstanceOf(FlowCancelled);
    expect(t.out()).toContain("■  Pick\n│  Cancelled\n");
    expect(t.out().endsWith("\x1b[?25h")).toBe(true);
    expect(t.closed.keys).toBe(1);
  });

  test("a list with nothing to pick is a programming error, not a hang", async () => {
    const t = rig({ keys: [] });
    await expect(t.flow.select({ message: "Pick", options: [{ value: "a", label: "A", disabled: true }] })).rejects.toThrow("no option");
  });
});

describe("text with a terminal", () => {
  test("typing, backspace and Enter", async () => {
    const t = rig({ keys: [...typed("Adaa"), k("backspace"), k("enter")] });
    expect(await t.flow.text({ message: "Name" })).toBe("Ada");
    expect(t.out()).toContain("◇  Name\n│  Ada\n│\n");
  });

  test("validate keeps the question open with the reason, until the answer passes", async () => {
    const t = rig({ keys: [...typed("x"), k("enter"), k("backspace"), ...typed("Ada"), k("enter")] });
    const name = await t.flow.text({ message: "Name", validate: (v) => (v.length < 2 ? "At least 2 characters" : undefined) });
    expect(name).toBe("Ada");
    expect(t.out()).toContain("│  At least 2 characters\n");
  });

  test("a secret never reaches the screen", async () => {
    const t = rig({ keys: [...typed("sk-live-123"), k("enter")] });
    expect(await t.flow.text({ message: "API key", secret: true })).toBe("sk-live-123");
    expect(t.out()).not.toContain("sk-");
    expect(t.out()).not.toContain("123");
    expect(t.out()).toContain("(hidden)");
  });

  test("Esc skips and Ctrl+B goes back when allowed", async () => {
    expect(await rig({ keys: [k("escape")] }).flow.text({ message: "Token", skip: true })).toBe(SKIP);
    expect(await rig({ keys: [k("ctrl-b")] }).flow.text({ message: "Token", back: true })).toBe(BACK);
  });

  test("initial prefills the value", async () => {
    expect(await rig({ keys: [k("enter")] }).flow.text({ message: "Name", initial: "Tropos" })).toBe("Tropos");
  });
});

describe("confirm with a terminal", () => {
  test("y, n, arrows and Enter", async () => {
    expect(await rig({ keys: [k("char", "n")] }).flow.confirm({ message: "Sure?", initial: true })).toBe(false);
    expect(await rig({ keys: [k("char", "y")] }).flow.confirm({ message: "Sure?", initial: false })).toBe(true);
    expect(await rig({ keys: [k("right"), k("enter")] }).flow.confirm({ message: "Sure?", initial: true })).toBe(false);
    expect(await rig({ keys: [k("enter")] }).flow.confirm({ message: "Sure?", initial: false })).toBe(false);
    expect(await rig({ keys: [k("char", "s")] }).flow.confirm({ message: "Sure?", initial: true, skip: true })).toBe(SKIP);
  });
});

describe("without a terminal (line mode)", () => {
  test("select lists numbered options and reads a number, a name, or Enter for the default", async () => {
    const t = rig({ answers: ["2", "", "anthropic", "DeepSeek"] });
    expect(await t.flow.select({ message: "Pick", options: OPTIONS })).toBe("deepseek");
    expect(await t.flow.select({ message: "Pick", options: OPTIONS, initial: "deepseek" })).toBe("deepseek");
    expect(await t.flow.select({ message: "Pick", options: OPTIONS })).toBe("anthropic");
    expect(await t.flow.select({ message: "Pick", options: OPTIONS })).toBe("deepseek");
    expect(t.out()).toContain("◆  Pick\n│  1. Anthropic (default)\n│  2. DeepSeek\n│  3. Mistral (coming soon!)\n");
    expect(t.out()).toContain("◇  Pick\n│  DeepSeek\n│\n");
    expect(t.asked[0]).toBe("Pick");
  });

  test("no cursor movement or escape codes at all", async () => {
    const t = rig({ answers: ["1", "Ada", "sk-1"] });
    await t.flow.intro("Set up");
    await t.flow.select({ message: "Pick", options: OPTIONS });
    await t.flow.text({ message: "Name" });
    await t.flow.text({ message: "Key", secret: true });
    await t.flow.note(["a"]);
    const s = t.flow.spinner();
    s.start("Working");
    s.stop("Done");
    await t.flow.outro("Bye");
    expect(t.out()).not.toContain("\x1b");
    expect(t.out()).not.toContain("\r");
    expect(t.out()).not.toContain("sk-1");
  });

  test("a disabled or unknown answer is refused with the reason, then asked again; three misses cancel", async () => {
    const t = rig({ answers: ["mistral", "9", "1"] });
    expect(await t.flow.select({ message: "Pick", options: OPTIONS })).toBe("anthropic");
    expect(t.out()).toContain("■  Mistral is not available yet (coming soon!)");
    expect(t.out()).toContain("■  Choose a number from 1 to 3");
    const stuck = rig({ answers: ["x", "y", "z"] });
    await expect(stuck.flow.select({ message: "Pick", options: OPTIONS })).rejects.toBeInstanceOf(FlowCancelled);
  });

  test("s and b are read as words when allowed", async () => {
    expect(await rig({ answers: ["s"] }).flow.select({ message: "Pick", options: OPTIONS, skip: true })).toBe(SKIP);
    expect(await rig({ answers: ["b"] }).flow.select({ message: "Pick", options: OPTIONS, back: true })).toBe(BACK);
    expect(await rig({ answers: ["b"] }).flow.confirm({ message: "Sure?", back: true })).toBe(BACK);
  });

  test("text validates and re-asks; secret goes to readLine", async () => {
    const t = rig({ answers: ["x", "Ada"] });
    expect(await t.flow.text({ message: "Name", validate: (v) => (v.length < 2 ? "Too short" : undefined) })).toBe("Ada");
    expect(t.out()).toContain("■  Too short");
  });

  test("confirm goes through the context's confirm unless s/b are offered", async () => {
    const t = rig({ confirms: [true], answers: ["n"] });
    expect(await t.flow.confirm({ message: "Install?", initial: false })).toBe(true);
    expect(t.confirmed).toEqual(["Install?"]);
    expect(await t.flow.confirm({ message: "Install?", initial: true, skip: true })).toBe(false);
    expect(t.confirmed).toEqual(["Install?"]);
  });
});

describe("the rest of the API", () => {
  test("intro, outro, note, log lines and steps write their frames", async () => {
    const t = rig({ answers: [] });
    t.flow.intro("Set up Tropos Code");
    t.flow.note(["Open this link", "https://t.me/x"]);
    t.flow.info("Fine");
    t.flow.warn("Careful");
    t.flow.error("No");
    t.flow.success("Yes");
    t.flow.stepDone("Telegram", ["Bot connected"]);
    t.flow.stepSkip("Phone access", "Tailscale is not installed");
    t.flow.outro("All set");
    expect(t.out()).toBe(
      [
        "┌  Set up Tropos Code\n│\n",
        "│  Open this link\n│  https://t.me/x\n│\n",
        "●  Fine\n│\n",
        "▲  Careful\n│\n",
        "■  No\n│\n",
        "◆  Yes\n│\n",
        "◇  Telegram\n│  Bot connected\n│\n",
        "◇  Phone access\n│  Skipped: Tailscale is not installed\n│\n",
        "└  All set\n",
      ].join(""),
    );
  });

  test("the spinner redraws in place on a terminal and stops into a step", () => {
    const t = rig({ keys: [] });
    const s = t.flow.spinner();
    s.start("Checking");
    expect(t.out()).toBe("\x1b[?25l◒  Checking");
    t.ticks[0]!();
    expect(t.out()).toContain("\r\x1b[2K◐  Checking");
    s.update("Still checking");
    t.ticks[0]!();
    expect(t.out()).toContain("\r\x1b[2K◓  Still checking");
    s.stop("Key works");
    expect(t.out().endsWith("\r\x1b[2K◇  Key works\n│\n\x1b[?25h")).toBe(true);
    expect(t.closed.timers).toBe(1);
    s.stop("again"); // a second stop is ignored
    expect(t.out().endsWith("\x1b[?25h")).toBe(true);
    const failed = rig({ keys: [] });
    const f = failed.flow.spinner();
    f.start("x");
    f.fail("Rejected");
    expect(failed.out()).toContain("■  Rejected\n│\n");
  });

  test("without a terminal the spinner is two plain lines", () => {
    const t = rig({ answers: [] });
    const s = t.flow.spinner();
    s.start("Checking");
    s.stop("Done");
    expect(t.out()).toBe("◒  Checking\n◇  Done\n│\n");
  });
});

describe("keyFromPress", () => {
  test("maps what readline reports onto the few keys a flow understands", () => {
    expect(keyFromPress("\r", { name: "return" })).toEqual({ name: "enter" });
    expect(keyFromPress(undefined, { name: "up" })).toEqual({ name: "up" });
    expect(keyFromPress("\x7f", { name: "backspace" })).toEqual({ name: "backspace" });
    expect(keyFromPress("\x03", { name: "c", ctrl: true })).toEqual({ name: "cancel" });
    expect(keyFromPress("\x04", { name: "d", ctrl: true })).toEqual({ name: "cancel" });
    expect(keyFromPress("\x02", { name: "b", ctrl: true })).toEqual({ name: "ctrl-b" });
    expect(keyFromPress("\x1b", { name: "escape" })).toEqual({ name: "escape" });
    expect(keyFromPress("a", { name: "a" })).toEqual({ name: "char", char: "a" });
    expect(keyFromPress("é", { name: undefined })).toEqual({ name: "char", char: "é" });
    expect(keyFromPress("a", { name: "a", meta: true })).toBeNull();
    expect(keyFromPress("\x1b[15~", { name: "f5" })).toBeNull();
  });
});

describe("flowForContext", () => {
  test("without a raw terminal the questions go through the context's prompt and confirm", async () => {
    const out: string[] = [];
    const asked: string[] = [];
    const ctx = {
      interactive: true,
      env: { NO_COLOR: "1", LANG: "en_US.UTF-8" },
      out: (t: string) => void out.push(t),
      prompt: async (q: string) => (asked.push(q), "2"),
      confirm: async (q: string) => (asked.push(q), true),
    } as never;
    const flow = flowForContext(ctx, { stdin: { isTTY: false } as never, stdout: { isTTY: false } as never });
    expect(await flow.select({ message: "Pick", options: OPTIONS })).toBe("deepseek");
    expect(await flow.confirm({ message: "Sure?" })).toBe(true);
    expect(asked).toEqual(["Pick", "Sure?"]);
    expect(out.join("")).toContain("◇  Pick\n│  DeepSeek\n│\n");
    expect(out.join("")).not.toContain("\x1b");
  });
});
