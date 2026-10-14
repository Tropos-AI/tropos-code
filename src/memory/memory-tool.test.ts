import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { Ledger } from "../learning/ledger";
import { createMemoryTool } from "./memory-tool";
import { NotesStore } from "./notes";

let home: string;
let store: NotesStore;

beforeEach(async () => {
  home = await makeTmpDir();
  store = new NotesStore(home);
});

afterEach(async () => {
  await removeDir(home);
});

test("metadata", () => {
  const tool = createMemoryTool(store);
  expect(tool.name).toBe("Memory");
  expect(tool.kind).toBe("edit");
  expect(tool.subject({ target: "user", action: "add", content: "x" }, "/")).toEqual({ paths: [store.path("user")] });
  expect(tool.summarize({ target: "user", action: "add", content: "x".repeat(100) })).toMatch(/^add user: x+…$/);
  expect(tool.summarize({ target: "memory", action: "remove", old_text: "foo" })).toBe("remove memory: foo");
  expect(tool.schema.safeParse({ target: "memory", action: "add", content: "x" }).success).toBe(true);
  expect(tool.schema.safeParse({ target: "other", action: "add" }).success).toBe(false);
});

test("add, replace and remove report what changed", async () => {
  const tool = createMemoryTool(store);
  const ctx = makeToolContext();
  const added = await tool.run({ target: "memory", action: "add", content: "uses bun" }, ctx);
  expect(added.isError).toBeUndefined();
  expect(added.display).toEqual({ kind: "text", text: "Added to agent notes: uses bun" });
  expect(added.summary).toBe("added to agent notes");
  expect(added.content).toContain("[0% — 8/2,200 chars]");

  const replaced = await tool.run({ target: "memory", action: "replace", old_text: "bun", content: "uses bun 1.2" }, ctx);
  expect(replaced.content).toContain("Replaced in agent notes: uses bun 1.2");

  const removed = await tool.run({ target: "memory", action: "remove", old_text: "1.2" }, ctx);
  expect(removed.content).toContain("Removed from agent notes: 1.2");
  expect(removed.content).toContain("(empty)");
});

test("missing fields are errors", async () => {
  const tool = createMemoryTool(store);
  const ctx = makeToolContext();
  expect((await tool.run({ target: "user", action: "add" }, ctx)).content).toBe("add needs content.");
  expect((await tool.run({ target: "user", action: "replace" }, ctx)).content).toBe("replace needs old_text and content.");
  expect((await tool.run({ target: "user", action: "remove" }, ctx)).isError).toBe(true);
});

test("a failed write shows the current entries", async () => {
  const tool = createMemoryTool(store);
  const ctx = makeToolContext();
  await tool.run({ target: "user", action: "add", content: "prefers tabs" }, ctx);
  const out = await tool.run({ target: "user", action: "add", content: "x".repeat(2000) }, ctx);
  expect(out.isError).toBe(true);
  expect(out.summary).toBe("not saved");
  expect(out.content).toContain("over the 1,375-char limit");
  expect(out.content).toContain("Current user profile");
  expect(out.content).toContain("prefers tabs");
});

test("disk errors become error results", async () => {
  await mkdir(join(home, "memories", "MEMORY.md"), { recursive: true });
  const out = await createMemoryTool(store).run({ target: "memory", action: "add", content: "x" }, makeToolContext());
  expect(out.isError).toBe(true);
  expect(out.content).toStartWith("Could not update the agent notes:");
});

test("operations apply as one batch and report the count", async () => {
  const tool = createMemoryTool(store);
  const ctx = makeToolContext();
  await tool.run({ target: "memory", action: "add", content: "old one" }, ctx);
  const input = {
    target: "memory" as const,
    operations: [
      { action: "remove" as const, old_text: "old" },
      { action: "add" as const, content: "User prefers concise answers" },
    ],
  };
  expect(tool.schema.safeParse(input).success).toBe(true);
  expect(tool.schema.safeParse({ target: "memory", operations: [] }).success).toBe(false);
  expect(tool.summarize(input)).toBe("batch memory: 2 changes");
  const out = await tool.run(input, ctx);
  expect(out.isError).toBeUndefined();
  expect(out.display).toEqual({ kind: "text", text: "Applied 2 changes to agent notes" });
  expect(out.summary).toBe("2 changes to agent notes");
  expect(out.content).toContain("User prefers concise answers");
  expect(await store.entries("memory")).toEqual(["User prefers concise answers"]);

  const one = await tool.run({ target: "memory", operations: [{ action: "remove", old_text: "concise" }] }, ctx);
  expect(one.summary).toBe("1 change to agent notes");
  expect(tool.summarize({ target: "user", operations: [{ action: "add", content: "x" }] })).toBe("batch user: 1 change");

  const bad = await tool.run({ target: "memory", operations: [{ action: "remove", old_text: "missing" }] }, ctx);
  expect(bad.isError).toBe(true);
  expect(bad.content).toStartWith("Operation 1 (remove):");
});

test("neither action nor operations is an error", async () => {
  const tool = createMemoryTool(store);
  expect(tool.summarize({ target: "memory" })).toBe("change memory: ");
  expect(await tool.run({ target: "memory" }, makeToolContext())).toEqual({ content: "Give either action or operations.", isError: true });
});

test("the acting agent is recorded in the ledger", async () => {
  const ledger = new Ledger(home);
  const tool = createMemoryTool(new NotesStore(home, { ledger }));
  await tool.run({ target: "user", action: "add", content: "x" }, makeToolContext({ actor: "review" }));
  await tool.run({ target: "user", action: "add", content: "y" }, makeToolContext());
  expect((await ledger.list()).map((e) => e.actor)).toEqual(["agent", "review"]);
});

test("the description steers toward declarative facts, skills and batches", () => {
  const { description } = createMemoryTool(store);
  expect(description).toContain('"User prefers concise answers"');
  expect(description).toContain("SkillManage");
  expect(description).toContain("operations");
});
