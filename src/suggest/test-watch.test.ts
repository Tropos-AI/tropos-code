import { afterEach, beforeEach, expect, test } from "bun:test";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { SuggestionStore } from "./store";
import { createTestWatcher } from "./test-watch";

let home: string;
let store: SuggestionStore;
beforeEach(async () => {
  home = await makeTmpDir("suggest-watch-");
  store = new SuggestionStore(home);
});
afterEach(() => removeDir(home));

const end = (id: string, status: "done" | "error", name = "Bash") => ({ type: "tool_end" as const, id, name, status, output: { content: "" } });

test("a pinned test command that fails is recorded for its project", async () => {
  const w = createTestWatcher(store, "app", ["bun test"]);
  w.observe({ type: "tool_start", id: "1", name: "Bash", summary: "bun test", input: {} });
  w.observe(end("1", "error"));
  await Bun.sleep(20);
  expect((await store.read()).tests.app).toMatchObject({ ok: false, command: "bun test" });
});

test("a passing run clears it; other commands and tools are ignored", async () => {
  const w = createTestWatcher(store, "app", ["bun test"]);
  w.observe({ type: "tool_start", id: "1", name: "Bash", summary: "bun test", input: {} });
  w.observe(end("1", "done"));
  w.observe({ type: "tool_start", id: "2", name: "Bash", summary: "ls", input: {} });
  w.observe(end("2", "error"));
  w.observe({ type: "tool_start", id: "3", name: "Read", summary: "bun test", input: {} });
  w.observe(end("3", "error", "Read"));
  await Bun.sleep(20);
  expect((await store.read()).tests.app).toMatchObject({ ok: true });
});

test("a project with no pinned commands records nothing", async () => {
  const w = createTestWatcher(store, "app", []);
  w.observe({ type: "tool_start", id: "1", name: "Bash", summary: "bun test", input: {} });
  w.observe(end("1", "error"));
  await Bun.sleep(20);
  expect((await store.read()).tests).toEqual({});
});
