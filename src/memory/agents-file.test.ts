import { expect, test } from "bun:test";
import { AGENTS_TEMPLATE, sectionEntries, stripAgentSections, withSectionEntries } from "./agents-file";

test("the template has two empty sections", () => {
  expect(sectionEntries(AGENTS_TEMPLATE, "Lessons")).toEqual([]);
  expect(sectionEntries(AGENTS_TEMPLATE, "Heartbeat")).toEqual([]);
});

test("withSectionEntries rewrites one section and keeps every other byte", () => {
  const text = "# AGENTS.md\n\nRules.\n\n## Lessons\n\nintro line\n- old\n\n## Heartbeat\n- check CI\n\n## Mine\nkeep me\n";
  const out = withSectionEntries(text, "Lessons", ["new one", "two\nlines"]);
  expect(sectionEntries(out, "Lessons")).toEqual(["new one", "two\nlines"]);
  expect(out).toContain("intro line");
  expect(out).toContain("## Heartbeat\n- check CI\n\n## Mine\nkeep me\n");
  expect(out.startsWith("# AGENTS.md\n\nRules.\n\n## Lessons\n\nintro line\n- new one\n- two\n  lines\n\n## Heartbeat")).toBe(true);
  expect(sectionEntries(out, "Heartbeat")).toEqual(["check CI"]);
});

test("indented lines continue an item, and a section ends at the next ## heading only", () => {
  const text = "## Lessons\n- a\n  more\n### sub\n- b\n## Other\n- c\n";
  expect(sectionEntries(text, "Lessons")).toEqual(["a\nmore", "b"]);
});

test("a missing section is appended; null starts from the template", () => {
  expect(withSectionEntries("# Mine\nhello\n", "Lessons", ["x"])).toBe("# Mine\nhello\n\n## Lessons\n- x\n");
  expect(withSectionEntries("no newline", "Heartbeat", ["x"])).toBe("no newline\n\n## Heartbeat\n- x\n");
  const out = withSectionEntries(null, "Heartbeat", ["check CI"]);
  expect(out).toBe(`${AGENTS_TEMPLATE.trimEnd()}\n- check CI\n`);
  expect(sectionEntries(out, "Lessons")).toEqual([]);
  expect(withSectionEntries(null, "Lessons", ["l"])).toContain("## Lessons\n- l\n\n## Heartbeat");
});

test("removing every item leaves the heading", () => {
  const out = withSectionEntries("## Lessons\n- a\n\n## Heartbeat\n- h\n", "Lessons", []);
  expect(out).toBe("## Lessons\n\n## Heartbeat\n- h\n");
});

test("stripAgentSections removes only Lessons and Heartbeat", () => {
  const text = "# AGENTS.md\n\nRules.\n\n## Lessons\n- l\n\n## Style\nbe brief\n\n## Heartbeat\n- h\n";
  const out = stripAgentSections(text);
  expect(out).toContain("Rules.");
  expect(out).toContain("## Style\nbe brief");
  expect(out).not.toContain("Lessons");
  expect(out).not.toContain("- l");
  expect(out).not.toContain("Heartbeat");
  expect(out).not.toContain("- h");
});
