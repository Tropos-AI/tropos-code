// src/ui/prompt-v2.test.tsx
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import chalk from "chalk";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { BUSY_PLACEHOLDER, lineSegments, PLACEHOLDER, PromptInput } from "./PromptInput";
import type { SuggestCommand } from "./suggest";
import { Suggestions, truncate } from "./Suggestions";
import { DARK } from "./theme";

const tick = () => Bun.sleep(30);
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const TAB = "\t";

const COMMANDS: SuggestCommand[] = [
  { name: "help", description: "Show commands and shortcuts", kind: "builtin" },
  { name: "hooks", description: "List configured hooks", kind: "builtin" },
  { name: "model", description: "Show or set the model", kind: "builtin" },
  { name: "review", description: "Review the diff", kind: "custom", argumentHint: "<ref>", tag: "project" },
  { name: "tdd", description: "Test first", kind: "skill" },
];

async function typed(text: string, props: Partial<Parameters<typeof PromptInput>[0]> = {}) {
  const onSubmit = mock();
  const r = render(<PromptInput onSubmit={onSubmit} history={[]} cwd="/" commands={COMMANDS} {...props} />);
  await tick();
  if (text) r.stdin.write(text);
  await tick();
  return { r, onSubmit };
}

describe("PromptInput v2: slash suggestions", () => {
  test("typing /he shows ranked suggestions instead of the footer", async () => {
    const { r } = await typed("/he", { footer: <Text>FOOTER</Text> });
    const frame = r.lastFrame()!;
    expect(frame).toContain("/help");
    expect(frame).toContain("Show commands and shortcuts");
    expect(frame).not.toContain("FOOTER");
    // Neither the name nor the description of /hooks contains "he"; the prefix match ranks first.
    expect(frame).not.toContain("/hooks");
    expect(frame.split("\n").find((l) => l.includes("Show")) ?? "").toContain("/help");
  });

  test("a lone / lists everything with tags", async () => {
    const { r } = await typed("/");
    const frame = r.lastFrame()!;
    expect(frame).toContain("/review");
    expect(frame).toContain("[project]");
    expect(frame).toContain("[skill]");
  });

  test("enter on a no-argument command submits it", async () => {
    const { r, onSubmit } = await typed("/he");
    r.stdin.write("\r");
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("/help");
  });

  test("↓ moves the selection and enter on an argument command inserts it", async () => {
    const { r, onSubmit } = await typed("/");
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write(UP);
    await tick();
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(r.lastFrame()).toContain("❯ /review");
    expect(r.lastFrame()).not.toContain("Review the diff");
    r.stdin.write("main");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("/review main");
  });

  test("↑ from the top wraps to the last row", async () => {
    const { r } = await typed("/");
    r.stdin.write(UP);
    await tick();
    r.stdin.write(TAB);
    await tick();
    r.stdin.write("x");
    await tick();
    expect(r.lastFrame()).toContain("❯ /tdd x");
  });

  test("tab accepts without submitting", async () => {
    const { r, onSubmit } = await typed("/mo");
    r.stdin.write(TAB);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(r.lastFrame()).toContain("❯ /model");
    expect(r.lastFrame()).not.toContain("Show or set the model");
  });

  test("esc closes until the token changes; tab reopens", async () => {
    const { r, onSubmit } = await typed("/h");
    const onToggle = mock();
    r.rerender(<PromptInput onSubmit={onSubmit} history={[]} cwd="/" commands={COMMANDS} onSuggestionsToggle={onToggle} />);
    await tick();
    r.stdin.write(ESC);
    await tick();
    expect(r.lastFrame()).not.toContain("Show commands");
    expect(onToggle).toHaveBeenLastCalledWith(false);
    r.stdin.write(TAB);
    await tick();
    expect(r.lastFrame()).toContain("Show commands");
    r.stdin.write(ESC);
    await tick();
    r.stdin.write("e");
    await tick();
    expect(r.lastFrame()).toContain("Show commands");
    expect(onToggle).toHaveBeenLastCalledWith(true);
    // With the dropdown closed, enter submits the raw text.
    r.stdin.write(ESC);
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("/he");
  });

  test("unknown command submits as typed", async () => {
    const { r, onSubmit } = await typed("/zzz");
    r.stdin.write("\r");
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("/zzz");
  });
});

describe("PromptInput v2: @ files", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await makeTmpDir();
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "alpha.ts"), "");
    await writeFile(join(dir, "src", "beta.ts"), "");
  });
  afterAll(() => removeDir(dir));

  test("shows + path rows and tab inserts the selection", async () => {
    const { r } = await typed("see @src/", { cwd: dir });
    await tick();
    expect(r.lastFrame()).toContain("+ src/alpha.ts");
    expect(r.lastFrame()).toContain("+ src/beta.ts");
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write(TAB);
    await tick();
    expect(r.lastFrame()).toContain("see @src/beta.ts");
    expect(r.lastFrame()).not.toContain("+ src/alpha.ts");
  });

  test("enter inserts a directory without submitting and keeps completing inside it", async () => {
    const { r, onSubmit } = await typed("@s", { cwd: dir });
    await tick();
    r.stdin.write("\r");
    await tick();
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(r.lastFrame()).toContain("@src/");
    expect(r.lastFrame()).toContain("+ src/alpha.ts");
  });

  test("a missing directory shows nothing", async () => {
    const { r } = await typed("@nope/", { cwd: dir, footer: <Text>FOOTER</Text> });
    await tick();
    expect(r.lastFrame()).toContain("FOOTER");
  });
});

describe("PromptInput v2: help, placeholders, queue", () => {
  test("? on empty input toggles the shortcuts grid without inserting ?", async () => {
    const onToggle = mock();
    const { r, onSubmit } = await typed("?", { onShortcutsToggle: onToggle, footer: <Text>FOOTER</Text> });
    expect(r.lastFrame()).toContain("shift+tab to cycle modes");
    expect(r.lastFrame()).not.toContain("FOOTER");
    expect(onToggle).toHaveBeenLastCalledWith(true);
    r.stdin.write("?");
    await tick();
    expect(r.lastFrame()).toContain("FOOTER");
    expect(onToggle).toHaveBeenLastCalledWith(false);
    r.stdin.write("\r");
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("any other key closes the grid and still types", async () => {
    const { r } = await typed("?");
    r.stdin.write("x");
    await tick();
    expect(r.lastFrame()).not.toContain("shift+tab to cycle modes");
    expect(r.lastFrame()).toContain("❯ x");
  });

  test("esc closes the grid", async () => {
    const { r } = await typed("?");
    r.stdin.write(ESC);
    await tick();
    expect(r.lastFrame()).not.toContain("shift+tab to cycle modes");
  });

  test("? inside text is just a character", async () => {
    const { r } = await typed("why?");
    expect(r.lastFrame()).toContain("why?");
    expect(r.lastFrame()).not.toContain("shift+tab to cycle modes");
  });

  test("placeholder before the first submit, none after, busy placeholder while busy", async () => {
    const { r, onSubmit } = await typed("");
    expect(r.lastFrame()).toContain(PLACEHOLDER);
    r.stdin.write("hi");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("hi");
    expect(r.lastFrame()).not.toContain(PLACEHOLDER);
    r.rerender(<PromptInput onSubmit={onSubmit} history={[]} cwd="/" busy />);
    await tick();
    expect(r.lastFrame()).toContain(BUSY_PLACEHOLDER);
  });

  test("draws only top and bottom rules", async () => {
    const { r } = await typed("");
    const lines = r.lastFrame()!.split("\n").filter((l) => l.trim());
    expect(lines[0]).toMatch(/^─+$/);
    expect(lines[1]!.startsWith("❯ ")).toBe(true);
    expect(lines[2]).toMatch(/^─+$/);
  });

  test("enter while busy still submits (the owner queues it)", async () => {
    const { r, onSubmit } = await typed("later", { busy: true });
    r.stdin.write("\r");
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("later");
  });

  test("↑ on empty input recalls queued messages before history", async () => {
    const onRecall = mock(() => "first\x1b[2J\nsecond");
    const { r } = await typed("", { queued: ["first", "second"], onRecallQueued: onRecall, history: ["old"] });
    r.stdin.write(UP);
    await tick();
    expect(onRecall).toHaveBeenCalledTimes(1);
    expect(r.lastFrame()).toContain("first");
    expect(r.lastFrame()).toContain("second");
    expect(r.lastFrame()).not.toContain("[2J");
    expect(r.lastFrame()).not.toContain("old");
  });

  test("↑ falls back to history when recall returns null or nothing is queued", async () => {
    const { r } = await typed("", { queued: ["x"], onRecallQueued: () => null, history: ["old"] });
    r.stdin.write(UP);
    await tick();
    expect(r.lastFrame()).toContain("old");
    r.stdin.write(DOWN);
    await tick();
    expect(r.lastFrame()).not.toContain("old");
  });
});

describe("PromptInput v2: editing", () => {
  test("history ↑/↓ and multiline with backslash-enter", async () => {
    const onSubmit = mock();
    const r = render(<PromptInput onSubmit={onSubmit} history={["one", "two"]} cwd="/" />);
    await tick();
    r.stdin.write(UP);
    await tick();
    expect(r.lastFrame()).toContain("two");
    r.stdin.write(UP);
    await tick();
    expect(r.lastFrame()).toContain("one");
    r.stdin.write(DOWN);
    await tick();
    expect(r.lastFrame()).toContain("two");
    r.stdin.write("\\");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("three");
    await tick();
    expect(r.lastFrame()).toContain("  three");
    r.stdin.write("\r");
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("two\nthree");
  });

  test("ctrl+a/e/u/w, arrows and backspace", async () => {
    const { r, onSubmit } = await typed("hello world");
    r.stdin.write("\x17"); // ctrl+w
    await tick();
    expect(r.lastFrame()).toContain("hello");
    expect(r.lastFrame()).not.toContain("world");
    r.stdin.write("\x01"); // ctrl+a
    await tick();
    r.stdin.write(">");
    await tick();
    r.stdin.write("\x05"); // ctrl+e
    await tick();
    r.stdin.write("\x1b[D"); // left
    await tick();
    r.stdin.write("\x1b[C"); // right
    await tick();
    r.stdin.write("\x7f"); // backspace
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(onSubmit).toHaveBeenLastCalledWith(">hello");
    r.stdin.write("gone");
    await tick();
    r.stdin.write("\x15"); // ctrl+u
    await tick();
    expect(r.lastFrame()).not.toContain("gone");
  });

  test("whitespace-only input does not submit", async () => {
    const { r, onSubmit } = await typed("   ");
    r.stdin.write("\r");
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("a known command name is drawn in its kind color", async () => {
    const level = chalk.level;
    chalk.level = 3;
    try {
      const { r } = await typed("/tdd now");
      const frame = r.lastFrame()!;
      const [red, green, blue] = [1, 3, 5].map((i) => parseInt(DARK.skill.slice(i, i + 2), 16));
      expect(frame).toContain(`\x1b[38;2;${red};${green};${blue}m/tdd`);
    } finally {
      chalk.level = level;
    }
  });
});

describe("lineSegments", () => {
  test("splits at highlight and cursor", () => {
    expect(lineSegments("/tdd go", 5, 4)).toEqual([
      { text: "/tdd", highlight: true, cursor: false },
      { text: " ", highlight: false, cursor: false },
      { text: "g", highlight: false, cursor: true },
      { text: "o", highlight: false, cursor: false },
    ]);
  });

  test("cursor at the end adds a block; surrogate pairs stay whole", () => {
    expect(lineSegments("ab", 2, 0)).toEqual([
      { text: "ab", highlight: false, cursor: false },
      { text: " ", highlight: false, cursor: true },
    ]);
    expect(lineSegments("😀x", 0, 0)[0]).toEqual({ text: "😀", highlight: false, cursor: true });
    expect(lineSegments("ab", null, 0)).toEqual([{ text: "ab", highlight: false, cursor: false }]);
  });
});

describe("Suggestions", () => {
  test("windows six rows around the selection and truncates descriptions", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      type: "command" as const,
      command: { name: `cmd${i}`, description: "a very long description that will not fit in a narrow terminal", kind: "builtin" as const },
    }));
    const frame = render(<Suggestions items={items} selected={9} width={40} />).lastFrame()!;
    expect(frame).not.toContain("/cmd3");
    expect(frame).toContain("/cmd4");
    expect(frame).toContain("/cmd9");
    expect(frame).toContain("…");
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(40);
  });

  test("sanitizes names and descriptions; renders nothing when empty", () => {
    const evil = { type: "command" as const, command: { name: "x\x1b]0;PWN\x07", description: "d\x1b[2J", kind: "custom" as const } };
    const frame = render(<Suggestions items={[evil]} selected={0} />).lastFrame()!;
    expect(frame).not.toContain("PWN");
    expect(frame).not.toContain("[2J");
    expect(render(<Suggestions items={[]} selected={0} />).lastFrame()).toBe("");
  });

  test("truncate", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abcd", 3)).toBe("ab…");
    expect(truncate("abcd", 1)).toBe("…");
    expect(truncate("abcd", 0)).toBe("");
  });
});
