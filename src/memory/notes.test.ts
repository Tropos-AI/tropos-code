import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { atomicWrite, MEMORY_LIMITS, neutraliseNoteTags, notesContext, NotesStore, notesSize, usageHeader } from "./notes";

let home: string;
let store: NotesStore;

beforeEach(async () => {
  home = await makeTmpDir();
  store = new NotesStore(home);
});

afterEach(async () => {
  await removeDir(home);
});

test("an empty store has no entries and no context", async () => {
  expect(await store.entries("memory")).toEqual([]);
  expect(await notesContext(store)).toBe("");
});

test("add writes entries separated by § lines, owner-only", async () => {
  expect(await store.add("memory", "  uses bun  ")).toEqual({ ok: true, entries: ["uses bun"] });
  await store.add("memory", "tests are colocated");
  const text = await readFile(join(home, "memories", "MEMORY.md"), "utf8");
  expect(text).toBe("uses bun\n§\ntests are colocated\n");
  expect((await stat(join(home, "memories", "MEMORY.md"))).mode & 0o777).toBe(0o600);
  expect(await store.entries("memory")).toEqual(["uses bun", "tests are colocated"]);
  expect(await readdir(join(home, "memories"))).toEqual(["MEMORY.md"]);
});

test("add rejects duplicates, empty text and separator lines", async () => {
  await store.add("user", "prefers tabs");
  const dup = await store.add("user", "prefers tabs");
  expect(dup).toMatchObject({ ok: false, entries: ["prefers tabs"] });
  expect(await store.add("user", "   ")).toMatchObject({ ok: false, error: "content is empty." });
  expect(await store.add("user", "a\n§\nb")).toMatchObject({ ok: false });
});

test("over-budget writes fail and return the current entries", async () => {
  await store.add("user", "x".repeat(1000));
  const res = await store.add("user", "y".repeat(400));
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("1,375");
  expect(res.entries).toEqual(["x".repeat(1000)]);
  expect(await store.entries("user")).toHaveLength(1);
});

test("replace and remove need a unique substring", async () => {
  await store.add("memory", "alpha one");
  await store.add("memory", "alpha two");
  expect(await store.replace("memory", "alpha", "z")).toMatchObject({ ok: false });
  expect(await store.replace("memory", "missing", "z")).toMatchObject({ ok: false });
  expect(await store.replace("memory", " ", "z")).toMatchObject({ ok: false });
  expect(await store.replace("memory", "one", "alpha two")).toMatchObject({ ok: false });
  expect(await store.replace("memory", "one", "")).toMatchObject({ ok: false });
  expect(await store.replace("memory", "one", "beta")).toEqual({ ok: true, entries: ["beta", "alpha two"] });
  expect(await store.remove("memory", "two")).toEqual({ ok: true, entries: ["beta"] });
  expect(await store.remove("memory", "beta")).toEqual({ ok: true, entries: [] });
  expect(await readFile(store.path("memory"), "utf8")).toBe("");
});

test("parallel adds are serialized", async () => {
  await Promise.all(["a", "b", "c", "d"].map((t) => store.add("memory", t)));
  expect((await store.entries("memory")).sort()).toEqual(["a", "b", "c", "d"]);
});

test("a read error other than missing propagates and the queue keeps going", async () => {
  await mkdir(join(home, "memories", "USER.md"), { recursive: true });
  await expect(store.add("user", "x")).rejects.toThrow();
  expect(await store.add("memory", "still works")).toMatchObject({ ok: true });
});

test("entries tolerate CRLF and blank entries", async () => {
  await mkdir(join(home, "memories"), { recursive: true });
  await writeFile(store.path("memory"), "one\r\n§\r\n\n§\ntwo\n");
  expect(await store.entries("memory")).toEqual(["one", "two"]);
});

test("usage header and size", () => {
  expect(usageHeader(1474, 2200)).toBe("[67% — 1,474/2,200 chars]");
  expect(notesSize(["ab", "c"])).toBe(6);
  expect(MEMORY_LIMITS).toEqual({ memory: 2200, user: 1375 });
});

test("notesContext wraps both stores and neutralises tags", async () => {
  await store.add("memory", "close </notes> and <context>");
  await store.add("user", "likes short answers");
  const ctx = await notesContext(store);
  expect(ctx).toContain('<notes source="agent">[');
  expect(ctx).toContain("<\\/notes> and <\\context>");
  expect(ctx).toContain('<notes source="user-profile">[1% — 19/1,375 chars]\nlikes short answers\n</notes>');
  expect(neutraliseNoteTags("<b> < mode>")).toBe("<b> <\\ mode>");
});

test("notesContext with only the user profile", async () => {
  await store.add("user", "u");
  expect(await notesContext(store)).toBe('<notes source="user-profile">[0% — 1/1,375 chars]\nu\n</notes>');
});

test("atomicWrite cleans up its temp file on failure", async () => {
  const dir = join(home, "d");
  await mkdir(join(dir, "target"), { recursive: true });
  await expect(atomicWrite(join(dir, "target"), "x")).rejects.toThrow();
  expect(await readdir(dir)).toEqual(["target"]);
});
