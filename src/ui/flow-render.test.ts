import { describe, expect, test } from "bun:test";
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
  type FlowStyle,
} from "./flow-render";

const PLAIN: FlowStyle = { color: false, unicode: true, columns: 80 };
const COLOR: FlowStyle = { color: true, unicode: true, columns: 80 };
const ASCII: FlowStyle = { color: false, unicode: false, columns: 80 };
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const OPTIONS: FlowOption[] = [
  { value: "anthropic", label: "Anthropic", hint: "recommended" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "mistral", label: "Mistral", disabled: true },
];

describe("flowStyle", () => {
  const tty = { isTTY: true, columns: 100 };
  test("colour on a terminal, off for NO_COLOR, a dumb terminal or a pipe", () => {
    expect(flowStyle({ LANG: "en_US.UTF-8" }, tty).color).toBe(true);
    expect(flowStyle({ LANG: "en_US.UTF-8", NO_COLOR: "1" }, tty).color).toBe(false);
    expect(flowStyle({ LANG: "en_US.UTF-8", NO_COLOR: "" }, tty).color).toBe(true);
    expect(flowStyle({ LANG: "en_US.UTF-8", TERM: "dumb" }, tty).color).toBe(false);
    expect(flowStyle({ LANG: "en_US.UTF-8" }, { isTTY: false }).color).toBe(false);
  });
  test("unicode only when the locale says UTF-8", () => {
    expect(flowStyle({ LANG: "en_US.UTF-8" }, tty).unicode).toBe(true);
    expect(flowStyle({ LC_ALL: "C.utf8", LANG: "C" }, tty).unicode).toBe(true);
    expect(flowStyle({ LANG: "C" }, tty).unicode).toBe(false);
    expect(flowStyle({}, tty).unicode).toBe(false);
  });
  test("columns come from the terminal, with a safe default", () => {
    expect(flowStyle({}, tty).columns).toBe(100);
    expect(flowStyle({}, { isTTY: false }).columns).toBe(80);
  });
});

describe("frames without colour", () => {
  test("intro and outro frame the flow", () => {
    expect(renderIntro(PLAIN, "Set up Tropos Code")).toBe("┌  Set up Tropos Code\n│\n");
    expect(renderOutro(PLAIN, "All set")).toBe("└  All set\n");
  });

  test("an active select: the cursor option is ●, the others ○, a disabled one has its note, then the hint", () => {
    expect(renderSelect(PLAIN, { message: "Connect a model", options: OPTIONS, cursor: 0, status: "active" })).toBe(
      [
        "◆  Connect a model",
        "│  ● Anthropic (recommended)",
        "│  ○ DeepSeek",
        "│  ○ Mistral (coming soon!)",
        "│  ↑/↓ to navigate · Enter: confirm",
        "",
      ].join("\n"),
    );
  });

  test("the hint grows with skip and back; a disabled note can be custom", () => {
    const out = renderSelect(PLAIN, { message: "Pick", options: [{ value: "a", label: "A" }, { value: "b", label: "B", disabled: "needs Docker" }], cursor: 0, status: "active", keys: { skip: true, back: true } });
    expect(out).toContain("│  ○ B (needs Docker)\n");
    expect(out.trimEnd().endsWith("│  ↑/↓ to navigate · Enter: confirm · s: skip · b: back")).toBe(true);
  });

  test("a finished select keeps the title and the answer, with the gutter below", () => {
    expect(renderSelect(PLAIN, { message: "Connect a model", options: OPTIONS, cursor: 1, status: "done" })).toBe("◇  Connect a model\n│  DeepSeek\n│\n");
  });

  test("a cancelled select says so", () => {
    expect(renderSelect(PLAIN, { message: "Connect a model", options: OPTIONS, cursor: 0, status: "cancel" })).toBe("■  Connect a model\n│  Cancelled\n");
  });

  test("a numbered select (no terminal keys) lists the options for a typed answer", () => {
    expect(renderSelect(PLAIN, { message: "Pick", options: OPTIONS, cursor: 0, status: "list" })).toBe(
      ["◆  Pick", "│  1. Anthropic (default)", "│  2. DeepSeek", "│  3. Mistral (coming soon!)", ""].join("\n"),
    );
  });

  test("text: placeholder when empty, the typed value with a cursor, an error line", () => {
    expect(renderText(PLAIN, { message: "Name", value: "", placeholder: "Tropos", status: "active" })).toBe("◆  Name\n│  _Tropos\n│  Enter: confirm\n");
    expect(renderText(PLAIN, { message: "Name", value: "Ada", status: "active", error: "Too long" })).toBe("◆  Name\n│  Ada_\n│  Too long\n│  Enter: confirm\n");
    expect(renderText(PLAIN, { message: "Name", value: "Ada", status: "done" })).toBe("◇  Name\n│  Ada\n│\n");
    expect(renderText(PLAIN, { message: "Name", value: "", status: "done" })).toBe("◇  Name\n│  (empty)\n│\n");
  });

  test("text: a secret is masked while typing and never shown afterwards", () => {
    const active = renderText(PLAIN, { message: "API key", value: "sk-123", secret: true, status: "active", keys: { skip: true } });
    expect(active).toContain("│  ••••••_\n");
    expect(active).not.toContain("sk-123");
    expect(active).toContain("Enter: confirm · Esc: skip");
    const done = renderText(PLAIN, { message: "API key", value: "sk-123", secret: true, status: "done" });
    expect(done).toBe("◇  API key\n│  (hidden)\n│\n");
  });

  test("confirm shows both choices with the current one selected", () => {
    expect(renderConfirm(PLAIN, { message: "Run in the background?", value: true, status: "active" })).toBe(
      "◆  Run in the background?\n│  ● Yes / ○ No\n│  ←/→ to choose · y/n · Enter: confirm\n",
    );
    expect(renderConfirm(PLAIN, { message: "Run in the background?", value: false, status: "done" })).toBe("◇  Run in the background?\n│  No\n│\n");
  });

  test("steps: done with lines, skipped with a reason", () => {
    expect(renderStep(PLAIN, "done", "Telegram", ["Bot connected", "You are the owner"])).toBe("◇  Telegram\n│  Bot connected\n│  You are the owner\n│\n");
    expect(renderStep(PLAIN, "skip", "Phone access", ["Skipped: Tailscale is not installed"])).toBe("◇  Phone access\n│  Skipped: Tailscale is not installed\n│\n");
    expect(renderStep(PLAIN, "skip", "Phone access")).toBe("◇  Phone access\n│  Skipped\n│\n");
  });

  test("notes and log lines sit in the gutter", () => {
    expect(renderNote(PLAIN, ["Open this link:", "https://t.me/x"])).toBe("│  Open this link:\n│  https://t.me/x\n│\n");
    expect(renderLog(PLAIN, "info", ["Fine"])).toBe("●  Fine\n│\n");
    expect(renderLog(PLAIN, "warn", ["Careful", "really"])).toBe("▲  Careful\n│  really\n│\n");
    expect(renderLog(PLAIN, "error", ["No"])).toBe("■  No\n│\n");
  });

  test("the spinner is one line; stopping turns it into a step", () => {
    expect(renderSpinner(PLAIN, 0, "Checking the key")).toBe("◒  Checking the key");
    expect(renderSpinner(PLAIN, 1, "Checking the key")).toBe("◐  Checking the key");
    expect(renderSpinnerStop(PLAIN, "ok", "Key works")).toBe("◇  Key works\n│\n");
    expect(renderSpinnerStop(PLAIN, "fail", "Key rejected")).toBe("■  Key rejected\n│\n");
  });

  test("long messages are clipped to the terminal width", () => {
    const narrow: FlowStyle = { ...PLAIN, columns: 30 };
    const out = renderSelect(narrow, { message: "x".repeat(100), options: [{ value: "a", label: "y".repeat(100) }], cursor: 0, status: "active" });
    for (const line of out.split("\n")) expect([...line].length).toBeLessThan(30);
    expect(out).toContain("…");
  });

  test("a multi-line message continues in the gutter", () => {
    expect(renderText(PLAIN, { message: "First\nSecond", value: "", status: "done" })).toBe("◇  First\n│  Second\n│  (empty)\n│\n");
  });
});

describe("frames in ASCII", () => {
  test("only | * o + and plain words are used", () => {
    const frames = [
      renderIntro(ASCII, "Set up"),
      renderSelect(ASCII, { message: "Pick", options: OPTIONS, cursor: 0, status: "active" }),
      renderSelect(ASCII, { message: "Pick", options: OPTIONS, cursor: 0, status: "done" }),
      renderText(ASCII, { message: "Key", value: "abc", secret: true, status: "active" }),
      renderConfirm(ASCII, { message: "Sure?", value: true, status: "active" }),
      renderLog(ASCII, "warn", ["Careful"]),
      renderOutro(ASCII, "Bye"),
    ].join("");
    expect(frames).toMatch(/^\+  Set up\n\|\n/);
    expect(frames).toContain("*  Pick\n|  * Anthropic (recommended)\n|  o DeepSeek\n|  o Mistral (coming soon!)\n|  up/down to navigate - Enter: confirm\n");
    expect(frames).toContain("o  Pick\n|  DeepSeek\n".replace("DeepSeek", "Anthropic"));
    expect(frames).toContain("|  ***_\n");
    expect(frames).toContain("|  * Yes / o No\n|  left/right to choose - y/n - Enter: confirm\n");
    expect(frames).toContain("!  Careful\n");
    expect(frames.endsWith("+  Bye\n")).toBe(true);
    expect(/[^\x00-\x7f]/.test(frames)).toBe(false);
    expect(renderSpinner(ASCII, 1, "Wait")).toBe("\\  Wait");
  });
});

describe("frames with colour", () => {
  test("the active title is cyan ◆, selected is green ●, unselected and disabled are dim", () => {
    const out = renderSelect(COLOR, { message: "Connect a model", options: OPTIONS, cursor: 0, status: "active" });
    expect(out).toContain("\x1b[36m◆\x1b[39m");
    expect(out).toContain("\x1b[32m●\x1b[39m");
    expect(out).toContain("\x1b[2m○ DeepSeek\x1b[22m");
    expect(out).toContain("\x1b[2m○ Mistral (coming soon!)\x1b[22m");
    expect(out).toContain("\x1b[2m↑/↓ to navigate · Enter: confirm\x1b[22m");
    // colour is the only difference from the NO_COLOR frame
    expect(strip(out)).toBe(renderSelect(PLAIN, { message: "Connect a model", options: OPTIONS, cursor: 0, status: "active" }));
  });

  test("completed steps use a dim ◇; errors are red, warnings yellow, info blue", () => {
    expect(renderSelect(COLOR, { message: "Pick", options: OPTIONS, cursor: 0, status: "done" })).toContain("\x1b[2m◇\x1b[22m");
    expect(renderLog(COLOR, "error", ["No"])).toContain("\x1b[31m■\x1b[39m");
    expect(renderLog(COLOR, "warn", ["Hm"])).toContain("\x1b[33m▲\x1b[39m");
    expect(renderLog(COLOR, "info", ["Ok"])).toContain("\x1b[34m●\x1b[39m");
  });

  test("intro and outro keep their corners dim and the title bold", () => {
    expect(renderIntro(COLOR, "Set up")).toContain("\x1b[1mSet up\x1b[22m");
    expect(strip(renderIntro(COLOR, "Set up"))).toBe(renderIntro(PLAIN, "Set up"));
    expect(strip(renderOutro(COLOR, "Bye"))).toBe(renderOutro(PLAIN, "Bye"));
  });

  test("every coloured frame strips to its NO_COLOR twin", () => {
    const pairs: Array<(s: FlowStyle) => string> = [
      (s) => renderText(s, { message: "Name", value: "Ada", status: "active", error: "Too long" }),
      (s) => renderConfirm(s, { message: "Sure?", value: false, status: "active" }),
      (s) => renderStep(s, "skip", "Phone", ["Skipped"]),
      (s) => renderNote(s, ["a", "b"]),
      (s) => renderSpinner(s, 2, "Wait"),
      (s) => renderSpinnerStop(s, "ok", "Done"),
    ];
    for (const f of pairs) expect(strip(f(COLOR))).toBe(f(PLAIN));
  });
});
