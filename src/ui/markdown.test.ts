import { expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";

test("renders markdown for the terminal", () => {
  const out = renderMarkdown("# Title\n\nSome **bold** text and `code`.\n\n- one\n- two", 60);
  const plain = Bun.stripANSI(out);
  expect(plain).toContain("Title");
  expect(plain).toContain("bold");
  expect(plain).not.toContain("**");
  expect(plain).toContain("one");
});

test("strips terminal control sequences from the input before rendering", () => {
  const out = renderMarkdown("# T\n\x1b]52;c;aGk=\x07", 60);
  expect(out).not.toContain("\x1b]");
  expect(Bun.stripANSI(out)).toContain("T");
});

test("sequences inside a paragraph never reach the terminal", () => {
  for (const input of ["para \x1b]0;PWNED\x07 end", "para \x1b[2J\x1b[H end", "a\rb"]) {
    const out = renderMarkdown(input, 60);
    expect(out).not.toContain("\x1b]");
    expect(out).not.toContain("\x1b[2J");
    expect(out).not.toContain("\r");
  }
});

test("links never emit OSC 8 hyperlinks, even when the terminal supports them", () => {
  const saved = process.env.FORCE_HYPERLINK;
  process.env.FORCE_HYPERLINK = "1";
  try {
    // Fresh width: the renderer is cached per width, so no earlier render can mask the setting.
    const spoof = renderMarkdown("[https://github.com/x](https://evil.example/p)", 77);
    expect(spoof).not.toContain("\x1b]8");
    expect(spoof).toContain("evil.example");
    const labelled = Bun.stripANSI(renderMarkdown("see [the docs](https://example.com/docs) now", 78));
    expect(labelled).toContain("the docs (https://example.com/docs)");
    const bare = Bun.stripANSI(renderMarkdown("[https://example.com](https://example.com)", 79));
    expect(bare.trim()).toBe("https://example.com");
  } finally {
    if (saved === undefined) delete process.env.FORCE_HYPERLINK;
    else process.env.FORCE_HYPERLINK = saved;
  }
});

test("links never emit OSC 8 even when hyperlink support is forced before the module loads", () => {
  // supports-hyperlinks decides once, at import time, so this needs a fresh process.
  const script = `import { renderMarkdown } from ${JSON.stringify(import.meta.dir + "/markdown")};
    process.stdout.write(JSON.stringify(renderMarkdown("[https://github.com/x](https://evil.example/p)")));`;
  const proc = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, FORCE_HYPERLINK: "1" } });
  expect(proc.exitCode).toBe(0);
  const out = JSON.parse(proc.stdout.toString()) as string;
  expect(out).not.toContain("\x1b]8");
  expect(out).toContain("evil.example");
});

test("renders inline markup inside list items", () => {
  const plain = Bun.stripANSI(renderMarkdown("- **`src/format.ts`**: new `formatJson()`\n- plain *item*\n\n1. **first** step", 60));
  expect(plain).not.toContain("**");
  expect(plain).not.toContain("`");
  expect(plain).not.toContain("*item*");
  expect(plain).toContain("* src/format.ts: new formatJson()");
  expect(plain).toContain("1. first step");
});

test("wraps long list items within the width, under the item's text", () => {
  const item = "writes the orders as an indented JSON array with the same four columns as the table output";
  const lines = Bun.stripANSI(renderMarkdown(`- ${item}\n- short`, 40)).split("\n");
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
  expect(lines[0]!.startsWith("  * writes")).toBe(true);
  expect(lines[1]!.startsWith("    ")).toBe(true);
  expect(lines.map((l) => l.trim()).join(" ")).toContain(item);
});

test("nests lists under the parent item's text and keeps task boxes and numbering", () => {
  const plain = Bun.stripANSI(renderMarkdown("9. nine\n10. ten\n    - child\n\n- [x] done\n- [ ] open", 60));
  expect(plain).toContain("  9.  nine");
  expect(plain).toContain("  10. ten");
  expect(plain).toContain("      * child");
  expect(plain).toContain("* [X] done");
  expect(plain).toContain("* [ ] open");
});
